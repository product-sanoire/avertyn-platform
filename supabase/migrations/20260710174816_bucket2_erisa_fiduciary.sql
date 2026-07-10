-- ============================================================
-- Bucket 2 #4 — ERISA Fiduciary Tooling
-- Compliance requirement catalog, per-plan assessments, and a
-- prudent-process decision log (the core ERISA fiduciary defense).
-- Authorities are real; confirm current CFR text before filing.
-- ============================================================

create table if not exists public.fiduciary_requirements (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  category    text not null check (category in ('claims_procedure','appeals','disclosure','reporting','prudence','loyalty')),
  title       text not null,
  description text,
  authority   text not null,
  cadence     text,                       -- 'per_claim' | 'annual' | 'ongoing' | 'on_change'
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.fiduciary_requirements (code,category,title,description,authority,cadence) values
 ('CLAIMS_TIMEFRAMES','claims_procedure','Benefit claim decision timeframes',
   'Decide claims within ERISA timeframes (e.g., 30 days post-service, 72h urgent, 15-day extensions).','29 CFR 2560.503-1(f)','per_claim'),
 ('ADVERSE_NOTICE','claims_procedure','Adverse benefit determination notice content',
   'Adverse determinations state the specific reason, plan provisions, and appeal rights.','29 CFR 2560.503-1(g)','per_claim'),
 ('FULL_FAIR_REVIEW','appeals','Full and fair appeal review',
   'Provide a full and fair review of denied claims by a different, impartial decision-maker.','29 CFR 2560.503-1(h)','per_claim'),
 ('EXTERNAL_REVIEW','appeals','External review rights',
   'Offer federal/state external review for eligible adverse determinations.','29 CFR 2590.715-2719','per_claim'),
 ('PRUDENCE','prudence','Prudent expert standard',
   'Act with the care, skill, prudence, and diligence of a prudent expert; document the process.','ERISA 404(a)(1)(B); 29 USC 1104','ongoing'),
 ('EXCLUSIVE_BENEFIT','loyalty','Exclusive benefit / duty of loyalty',
   'Act solely in the interest of participants and beneficiaries for the exclusive purpose of providing benefits.','ERISA 404(a)(1)(A)','ongoing'),
 ('FEE_408B2','disclosure','Service-provider fee disclosure (408(b)(2))',
   'Obtain and review covered service-provider fee disclosures; assess reasonableness of compensation.','ERISA 408(b)(2); 29 CFR 2550.408b-2','on_change'),
 ('SPD','disclosure','Summary Plan Description',
   'Furnish an accurate, current SPD to participants.','ERISA 102; 29 CFR 2520.102-3','on_change'),
 ('FORM_5500','reporting','Form 5500 annual report',
   'File the plan annual report (Form 5500) timely.','ERISA 104; 29 CFR 2520.104','annual'),
 ('MHPAEA_NQTL','reporting','MHPAEA NQTL comparative analysis',
   'Maintain a comparative analysis of non-quantitative treatment limitations for mental health/SUD parity.','MHPAEA; CAA 2021 sec.203; 29 CFR 2590.712','annual'),
 ('GAG_CLAUSE','reporting','Gag-clause prohibition attestation (GCPCA)',
   'Annually attest that the plan''s contracts contain no prohibited gag clauses.','CAA 2021 sec.201','annual'),
 ('RXDC','reporting','Prescription drug data collection (RxDC)',
   'Submit annual RxDC prescription drug and health care spending report.','CAA 2021 sec.204','annual'),
 ('FIDUCIARY_COMMITTEE','prudence','Documented fiduciary committee & charter',
   'Maintain a named fiduciary/committee, charter, and minutes evidencing prudent process.','ERISA 402(a), 404(a)','ongoing'),
 ('NSA_PAYMENT_TIMELINESS','claims_procedure','No Surprises Act post-IDR payment',
   'Pay the additional amount within 30 business days after an IDR determination.','45 CFR 149.510(c)(4)(vii)','per_claim')
on conflict (code) do update set category=excluded.category, title=excluded.title,
  description=excluded.description, authority=excluded.authority, cadence=excluded.cadence;

create table if not exists public.fiduciary_assessments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  plan_id         uuid not null references public.plans(id) on delete cascade,
  requirement_code text not null references public.fiduciary_requirements(code) on delete cascade,
  status          text not null default 'gap' check (status in ('compliant','gap','in_progress','na')),
  evidence        text,
  due_date        date,
  owner           text,
  notes           text,
  assessed_at     timestamptz not null default now(),
  unique (org_id, plan_id, requirement_code)
);
create index if not exists fiduciary_assessments_plan_idx on public.fiduciary_assessments(org_id, plan_id);

create table if not exists public.fiduciary_decisions (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  plan_id               uuid references public.plans(id) on delete set null,
  decision_type         text,             -- 'vendor_selection','fee_reasonableness','claim_appeal','plan_amendment', etc.
  summary               text not null,
  rationale             text,
  alternatives_considered text,
  authority             text,
  decided_by            text,
  decided_at            timestamptz not null default now(),
  created_at            timestamptz not null default now()
);
create index if not exists fiduciary_decisions_plan_idx on public.fiduciary_decisions(org_id, plan_id);

-- RLS + grants
alter table public.fiduciary_requirements enable row level security;
alter table public.fiduciary_assessments enable row level security;
alter table public.fiduciary_decisions enable row level security;
drop policy if exists fiduciary_requirements_read on public.fiduciary_requirements;
create policy fiduciary_requirements_read on public.fiduciary_requirements for select using (true);
do $$
declare t text;
begin
  foreach t in array array['fiduciary_assessments','fiduciary_decisions'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (auth_org_id() is null or org_id = auth_org_id())', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all using (org_id = auth_org_id()) with check (org_id = auth_org_id())', t, t);
  end loop;
end $$;
grant select on public.fiduciary_requirements to anon, authenticated, service_role;
grant select on public.fiduciary_assessments, public.fiduciary_decisions to anon;
grant all on public.fiduciary_assessments, public.fiduciary_decisions to authenticated, service_role;

-- ============================================================
-- assess_plan_fiduciary(plan) -> jsonb scorecard
-- Ensures an assessment row per active requirement, returns rollup.
-- ============================================================
create or replace function public.assess_plan_fiduciary(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org uuid := public.current_org();
  v_res jsonb;
begin
  if not exists (select 1 from public.plans where id = p_plan_id and org_id = v_org) then
    raise exception 'plan not found in current org';
  end if;

  insert into public.fiduciary_assessments (org_id, plan_id, requirement_code, status,
     due_date)
  select v_org, p_plan_id, r.code, 'gap',
     case when r.cadence='annual' then date_trunc('year', now())::date + interval '1 year' - interval '1 day' else null end::date
  from public.fiduciary_requirements r
  where r.active
    and not exists (select 1 from public.fiduciary_assessments a
                    where a.org_id=v_org and a.plan_id=p_plan_id and a.requirement_code=r.code);

  select jsonb_build_object(
    'plan_id', p_plan_id,
    'total', count(*),
    'compliant', count(*) filter (where status='compliant'),
    'gap', count(*) filter (where status='gap'),
    'in_progress', count(*) filter (where status='in_progress'),
    'na', count(*) filter (where status='na'),
    'score_pct', case when count(*) filter (where status<>'na') > 0
                   then round(100.0*count(*) filter (where status='compliant')/count(*) filter (where status<>'na'),0)
                   else null end,
    'by_category', (
      select jsonb_object_agg(cat, cnt) from (
        select r.category cat, count(*) filter (where a.status='compliant')||'/'||count(*) cnt
        from public.fiduciary_assessments a join public.fiduciary_requirements r on r.code=a.requirement_code
        where a.org_id=v_org and a.plan_id=p_plan_id group by r.category
      ) s)
  ) into v_res
  from public.fiduciary_assessments where org_id=v_org and plan_id=p_plan_id;

  return v_res;
end $fn$;

create or replace function public.set_fiduciary_status(p_plan_id uuid, p_code text, p_status text, p_evidence text default null, p_owner text default null)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare v_org uuid := public.current_org();
begin
  perform public.assess_plan_fiduciary(p_plan_id);
  update public.fiduciary_assessments
     set status=p_status, evidence=coalesce(p_evidence,evidence), owner=coalesce(p_owner,owner), assessed_at=now()
   where org_id=v_org and plan_id=p_plan_id and requirement_code=p_code;
end $fn$;

create or replace function public.log_fiduciary_decision(
  p_plan_id uuid, p_type text, p_summary text, p_rationale text default null,
  p_alternatives text default null, p_authority text default null, p_decided_by text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $fn$
declare v_org uuid := public.current_org(); v_id uuid;
begin
  insert into public.fiduciary_decisions (org_id, plan_id, decision_type, summary, rationale, alternatives_considered, authority, decided_by)
  values (v_org, p_plan_id, p_type, p_summary, p_rationale, p_alternatives, p_authority, p_decided_by)
  returning id into v_id;
  return v_id;
end $fn$;

grant execute on function public.assess_plan_fiduciary(uuid) to anon, authenticated, service_role;
grant execute on function public.set_fiduciary_status(uuid,text,text,text,text) to anon, authenticated, service_role;
grant execute on function public.log_fiduciary_decision(uuid,text,text,text,text,text,text) to anon, authenticated, service_role;

-- ---- Demo: assess a demo plan with a realistic mix of statuses ----
select public.assess_plan_fiduciary('b0000000-0000-0000-0000-000000000001');
update public.fiduciary_assessments a set status = v.status, evidence = v.evidence, owner = v.owner
from (values
  ('CLAIMS_TIMEFRAMES','compliant','TPA SLA report Q2 2026: 99.2% decided within timeframe','Claims Ops'),
  ('ADVERSE_NOTICE','compliant','Denial letter template legal-reviewed 2026-03','Compliance'),
  ('FULL_FAIR_REVIEW','compliant','Independent appeals panel charter on file','Compliance'),
  ('EXTERNAL_REVIEW','compliant','IRO contract active (MAXIMUS)','Compliance'),
  ('PRUDENCE','in_progress','Committee minutes current through Q1; Q2 pending','Fiduciary Committee'),
  ('EXCLUSIVE_BENEFIT','compliant','Conflict-of-interest policy signed by all fiduciaries','Legal'),
  ('FEE_408B2','gap','408(b)(2) disclosures not yet collected from 2 new vendors','Finance'),
  ('SPD','compliant','SPD restated 2026-01-01','Legal'),
  ('FORM_5500','compliant','2025 Form 5500 filed 2026-07-01 with auditor opinion','Finance'),
  ('MHPAEA_NQTL','gap','NQTL comparative analysis not updated for 2026 network changes','Compliance'),
  ('GAG_CLAUSE','compliant','GCPCA attestation submitted 2025-12-28','Compliance'),
  ('RXDC','in_progress','RxDC D1-D8 files staged; submission due 2026-06-01 (late)','Finance'),
  ('FIDUCIARY_COMMITTEE','compliant','Committee charter v3 adopted 2025-11','Fiduciary Committee'),
  ('NSA_PAYMENT_TIMELINESS','in_progress','2 IDR determinations approaching 30-day pay window','Claims Ops')
) as v(code,status,evidence,owner)
where a.plan_id='b0000000-0000-0000-0000-000000000001'
  and a.org_id='a0000000-0000-0000-0000-000000000001'
  and a.requirement_code = v.code;

select public.log_fiduciary_decision(
  'b0000000-0000-0000-0000-000000000001','vendor_selection',
  'Selected Avertyn as NSA/IDR defense vendor for the plan',
  'Payer-side eligibility and QPA-defense automation reduces improper IDR payouts; fees reasonable vs. avoided 3-9x awards.',
  'Considered status quo (manual review) and two competing vendors; Avertyn scored highest on hard-dollar ROI and audit trail.',
  'ERISA 404(a)(1)(B) prudent process; 408(b)(2) reasonableness','Fiduciary Committee');
