-- ============================================================
-- Bucket 2 shared spine: product module registry + bill-review core
-- Shared by payment-integrity (#1), RBP repricing (#2), WC/auto bill review (#3)
-- ERISA (#4) has its own model (separate migration).
-- ============================================================

-- ---- Product module catalog (global) -----------------------
create table if not exists public.product_modules (
  code       text primary key,
  name       text not null,
  tagline    text,
  category   text,
  sort       int not null default 100,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.product_modules (code,name,tagline,category,sort) values
  ('payment_integrity','Payment Integrity','DRG & clinical validation, NCCI/PTP, MUE editing','bill_review',10),
  ('rbp_repricing','RBP Repricing & Open Negotiation','Reference-based pricing to a defensible allowed amount','bill_review',20),
  ('wc_auto_bill_review','Workers'' Comp & Auto Bill Review','State fee-schedule adjudication for WC and auto medical','bill_review',30),
  ('erisa_fiduciary','ERISA Fiduciary Tooling','Plan-fiduciary compliance, prudent-process documentation','governance',40)
on conflict (code) do update set name=excluded.name, tagline=excluded.tagline, category=excluded.category, sort=excluded.sort;

create table if not exists public.org_product_modules (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  module_code text not null references public.product_modules(code) on delete cascade,
  enabled     boolean not null default true,
  config      jsonb not null default '{}',
  enabled_at  timestamptz not null default now(),
  primary key (org_id, module_code)
);

-- Enable all four modules for the demo org so the UI shows them populated
insert into public.org_product_modules (org_id, module_code)
select 'a0000000-0000-0000-0000-000000000001'::uuid, code from public.product_modules
on conflict do nothing;

-- ---- Shared bill-review case -------------------------------
create table if not exists public.review_cases (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  review_type   text not null check (review_type in ('payment_integrity','rbp_repricing','wc_bill_review','auto_bill_review')),
  claim_id      uuid references public.claims(id) on delete set null,
  dispute_id    uuid references public.disputes(id) on delete set null,
  plan_id       uuid references public.plans(id) on delete set null,
  provider_name text,
  provider_npi  text,
  provider_tin  text,
  jurisdiction  text,                       -- state (WC/auto)
  line_of_business text,                     -- 'group_health' | 'workers_comp' | 'auto'
  date_of_service date,
  billed_total  numeric,
  allowed_total numeric,
  savings       numeric,
  savings_pct   numeric,
  status        text not null default 'open' check (status in ('open','in_review','determined','accepted','closed')),
  determination text,
  confidence    numeric,
  assignee      uuid,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists review_cases_org_idx on public.review_cases(org_id);
create index if not exists review_cases_type_idx on public.review_cases(org_id, review_type, status);
create index if not exists review_cases_claim_idx on public.review_cases(claim_id);
create index if not exists review_cases_dispute_idx on public.review_cases(dispute_id);

create table if not exists public.review_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  review_case_id uuid not null references public.review_cases(id) on delete cascade,
  line_no        int,
  code_system    text not null default 'CPT',   -- CPT | HCPCS | REV | DRG | ICD10
  code           text,
  description    text,
  modifiers      text,
  revenue_code   text,
  units          numeric default 1,
  billed         numeric,
  allowed        numeric,
  method         text,                           -- how 'allowed' was derived
  flagged        boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists review_lines_case_idx on public.review_lines(review_case_id);
create index if not exists review_lines_org_idx on public.review_lines(org_id);

create table if not exists public.review_adjustments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  review_case_id uuid not null references public.review_cases(id) on delete cascade,
  review_line_id uuid references public.review_lines(id) on delete cascade,  -- null = case level
  rule_code      text,
  category       text not null check (category in (
                   'drg_validation','clinical_validation','ncci_ptp','mue','unbundling','duplicate',
                   'upcoding','medical_necessity','readmission','never_event',
                   'rbp_benchmark','fee_schedule','wc_ground_rule','auto_ground_rule','other')),
  severity       text not null default 'info' check (severity in ('info','low','medium','high')),
  description    text,
  amount         numeric not null default 0,     -- dollars of savings vs billed
  authority      text,                            -- citation / source
  confidence     numeric,
  status         text not null default 'proposed' check (status in ('proposed','accepted','overturned','waived')),
  meta           jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists review_adj_case_idx on public.review_adjustments(review_case_id);
create index if not exists review_adj_org_idx on public.review_adjustments(org_id);
create index if not exists review_adj_cat_idx on public.review_adjustments(category);

-- ---- RLS: demo-readable, tenant-writable -------------------
do $$
declare t text;
begin
  foreach t in array array['product_modules','org_product_modules','review_cases','review_lines','review_adjustments'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- catalog is world-readable
drop policy if exists product_modules_read on public.product_modules;
create policy product_modules_read on public.product_modules for select using (true);

drop policy if exists org_modules_read on public.org_product_modules;
create policy org_modules_read on public.org_product_modules for select
  using (auth_org_id() is null or org_id = auth_org_id());
drop policy if exists org_modules_write on public.org_product_modules;
create policy org_modules_write on public.org_product_modules for all
  using (org_id = auth_org_id()) with check (org_id = auth_org_id());

do $$
declare t text;
begin
  foreach t in array array['review_cases','review_lines','review_adjustments'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (auth_org_id() is null or org_id = auth_org_id())', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all using (org_id = auth_org_id()) with check (org_id = auth_org_id())', t, t);
  end loop;
end $$;

-- ---- Grants (match existing convention) --------------------
grant select on public.product_modules, public.org_product_modules, public.review_cases, public.review_lines, public.review_adjustments to anon;
grant all on public.org_product_modules, public.review_cases, public.review_lines, public.review_adjustments to authenticated, service_role;
grant select on public.product_modules to authenticated, service_role;

-- ---- Realtime ----------------------------------------------
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.review_cases'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table public.review_adjustments'; exception when others then null; end;
end $$;
