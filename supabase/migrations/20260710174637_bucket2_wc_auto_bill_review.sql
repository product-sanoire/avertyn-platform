-- ============================================================
-- Bucket 2 #3 — Workers' Comp & Auto Bill Review
-- Jurisdictional fee-schedule adjudication with ground rules.
-- Fee amounts are ILLUSTRATIVE — load official state OMFS/PFS files.
-- ============================================================

create table if not exists public.fee_schedules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid references public.orgs(id) on delete cascade,
  jurisdiction   text not null,
  line_of_business text not null check (line_of_business in ('workers_comp','auto')),
  name           text not null,
  version        text default '2026',
  effective_date date default current_date,
  ground_rules   jsonb not null default '{}',
  source         text default 'State fee schedule (illustrative — replace with official file)',
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists fee_schedules_lookup_idx on public.fee_schedules(jurisdiction, line_of_business, active);

create table if not exists public.fee_schedule_items (
  id               uuid primary key default gen_random_uuid(),
  fee_schedule_id  uuid not null references public.fee_schedules(id) on delete cascade,
  hcpcs            text not null,
  modifier         text,
  amount           numeric not null,
  unit_basis       text not null default 'per_unit' check (unit_basis in ('per_unit','per_procedure')),
  note             text,
  unique (fee_schedule_id, hcpcs, modifier)
);
create index if not exists fee_schedule_items_lookup on public.fee_schedule_items(fee_schedule_id, hcpcs);

insert into public.fee_schedules (id, jurisdiction, line_of_business, name, ground_rules) values
 ('f5c00000-0000-0000-0000-000000000001','CA','workers_comp','California OMFS (Physician) 2026','{"mppr":{"family":"radiology","reduction":0.5,"applies_to":"second_plus"}}'),
 ('f5c00000-0000-0000-0000-000000000002','FL','workers_comp','Florida WC Physician Schedule 2026','{"mppr":{"family":"radiology","reduction":0.5,"applies_to":"second_plus"}}'),
 ('f5c00000-0000-0000-0000-000000000003','TX','workers_comp','Texas WC Medical Fee Guideline 2026','{"mppr":{"family":"radiology","reduction":0.5,"applies_to":"second_plus"}}'),
 ('f5c00000-0000-0000-0000-000000000004','CA','auto','California Auto Medical (approx 120% OMFS) 2026','{"mppr":{"family":"radiology","reduction":0.5,"applies_to":"second_plus"}}')
on conflict (id) do nothing;

insert into public.fee_schedule_items (fee_schedule_id, hcpcs, amount) values
 ('f5c00000-0000-0000-0000-000000000001','70551',285.00),('f5c00000-0000-0000-0000-000000000001','99285',210.00),
 ('f5c00000-0000-0000-0000-000000000001','72110',68.00),('f5c00000-0000-0000-0000-000000000001','29881',1350.00),
 ('f5c00000-0000-0000-0000-000000000001','74177',480.00),
 ('f5c00000-0000-0000-0000-000000000002','70551',240.00),('f5c00000-0000-0000-0000-000000000002','99285',175.00),
 ('f5c00000-0000-0000-0000-000000000002','72110',55.00),('f5c00000-0000-0000-0000-000000000002','29881',1180.00),
 ('f5c00000-0000-0000-0000-000000000002','74177',415.00),
 ('f5c00000-0000-0000-0000-000000000003','70551',262.00),('f5c00000-0000-0000-0000-000000000003','99285',190.00),
 ('f5c00000-0000-0000-0000-000000000003','72110',60.00),('f5c00000-0000-0000-0000-000000000003','29881',1240.00),
 ('f5c00000-0000-0000-0000-000000000003','74177',448.00),
 ('f5c00000-0000-0000-0000-000000000004','70551',342.00),('f5c00000-0000-0000-0000-000000000004','99285',252.00),
 ('f5c00000-0000-0000-0000-000000000004','72110',82.00),('f5c00000-0000-0000-0000-000000000004','29881',1620.00),
 ('f5c00000-0000-0000-0000-000000000004','74177',576.00)
on conflict (fee_schedule_id, hcpcs, modifier) do nothing;

alter table public.fee_schedules enable row level security;
alter table public.fee_schedule_items enable row level security;
drop policy if exists fee_schedules_read on public.fee_schedules;
create policy fee_schedules_read on public.fee_schedules for select using (org_id is null or auth_org_id() is null or org_id = auth_org_id());
drop policy if exists fee_schedules_write on public.fee_schedules;
create policy fee_schedules_write on public.fee_schedules for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());
drop policy if exists fee_schedule_items_read on public.fee_schedule_items;
create policy fee_schedule_items_read on public.fee_schedule_items for select using (true);
grant select on public.fee_schedules, public.fee_schedule_items to anon, authenticated, service_role;
grant all on public.fee_schedules to authenticated, service_role;

create or replace function public.fs_apply(p_case uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org uuid; v_juris text; v_lob text;
  v_sched public.fee_schedules%rowtype;
  v_billed numeric; v_saved numeric;
begin
  select org_id, jurisdiction, line_of_business into v_org, v_juris, v_lob
    from public.review_cases where id = p_case;
  if v_org is null then raise exception 'review case not found'; end if;

  select * into v_sched from public.fee_schedules
    where jurisdiction = v_juris and line_of_business = v_lob and active and (org_id = v_org or org_id is null)
    order by (org_id = v_org) desc, effective_date desc limit 1;
  if not found then raise exception 'no % fee schedule for %', v_lob, v_juris; end if;

  delete from public.review_adjustments where review_case_id = p_case;

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence, status)
  select v_org, p_case, l.id, 'FS_CAP','fee_schedule','high',
         format('Billed $%s exceeds %s allowance $%s for %s (x%s units); reduced to fee schedule.',
                to_char(l.billed,'FM999,999,990.00'), v_sched.name, to_char(fi.amount*coalesce(l.units,1),'FM999,999,990.00'), l.code, coalesce(l.units,1)),
         round(l.billed - fi.amount*coalesce(l.units,1),2),
         format('%s (%s %s)', v_sched.name, v_sched.jurisdiction, v_sched.line_of_business), 0.95, 'proposed'
  from public.review_lines l
  join public.fee_schedule_items fi on fi.fee_schedule_id = v_sched.id and fi.hcpcs = l.code
  where l.review_case_id = p_case and coalesce(l.billed,0) > fi.amount*coalesce(l.units,1);

  update public.review_lines l set
     allowed = least(coalesce(l.billed,0), coalesce(fi.amount*coalesce(l.units,1), l.billed)),
     method  = v_sched.name, flagged = true
  from public.fee_schedule_items fi
  where l.review_case_id = p_case and fi.fee_schedule_id = v_sched.id and fi.hcpcs = l.code;

  if (v_sched.ground_rules ? 'mppr') then
    with rad as (
      select l.id, l.allowed, row_number() over (order by l.allowed desc) rk
      from public.review_lines l
      where l.review_case_id = p_case and l.code ~ '^7[0-6][0-9]{3}$'
    )
    insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence, status)
    select v_org, p_case, r.id, 'MPPR','other','medium',
           format('Multiple Procedure Payment Reduction: subsequent imaging procedure reduced %s%%.',
                  ((v_sched.ground_rules->'mppr'->>'reduction')::numeric*100)::int),
           round(r.allowed * (v_sched.ground_rules->'mppr'->>'reduction')::numeric, 2),
           format('%s ground rule (MPPR)', v_sched.name), 0.9, 'proposed'
    from rad r where r.rk >= 2;

    update public.review_lines l set
       allowed = greatest(l.allowed - coalesce((select sum(a.amount) from public.review_adjustments a
                          where a.review_line_id = l.id and a.rule_code='MPPR'),0),0)
    where l.review_case_id = p_case
      and exists (select 1 from public.review_adjustments a where a.review_line_id=l.id and a.rule_code='MPPR');
  end if;

  select coalesce(sum(billed),0) into v_billed from public.review_lines where review_case_id = p_case;
  select coalesce(sum(amount),0) into v_saved from public.review_adjustments where review_case_id = p_case and status in ('proposed','accepted');

  update public.review_cases set
     billed_total = v_billed, allowed_total = greatest(v_billed - v_saved,0), savings = v_saved,
     savings_pct = case when v_billed>0 then round(v_saved/v_billed*100,1) else 0 end,
     determination = format('%s lines reviewed under %s. Billed $%s -> allowed $%s (savings $%s).',
        (select count(*) from public.review_lines where review_case_id=p_case), v_sched.name,
        to_char(v_billed,'FM999,999,990.00'), to_char(greatest(v_billed-v_saved,0),'FM999,999,990.00'),
        to_char(v_saved,'FM999,999,990.00')),
     status = 'determined', updated_at = now()
  where id = p_case;
end $fn$;

create or replace function public.run_fee_schedule_review(p_claim_id uuid, p_jurisdiction text, p_lob text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org uuid := public.current_org();
  v_claim public.claims%rowtype;
  v_case uuid;
begin
  if p_lob not in ('workers_comp','auto') then raise exception 'line_of_business must be workers_comp or auto'; end if;
  select * into v_claim from public.claims where id = p_claim_id and org_id = v_org;
  if not found then raise exception 'claim not found in current org'; end if;

  insert into public.review_cases (org_id, review_type, claim_id, plan_id, provider_name, provider_npi, jurisdiction, line_of_business, date_of_service, billed_total, status)
  values (v_org, case when p_lob='auto' then 'auto_bill_review' else 'wc_bill_review' end,
          v_claim.id, v_claim.plan_id, v_claim.provider_name, v_claim.provider_npi, p_jurisdiction, p_lob, v_claim.service_date, v_claim.billed_total, 'in_review')
  returning id into v_case;

  insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, modifiers, units, billed)
  select v_org, v_case, row_number() over (order by cl.created_at), 'CPT', cl.cpt,
         (select short_desc from public.medical_codes mc where mc.code = cl.cpt limit 1), cl.modifiers, 1, cl.billed
  from public.claim_lines cl where cl.claim_id = v_claim.id;

  if not exists (select 1 from public.review_lines where review_case_id=v_case) then
    insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, units, billed)
    values (v_org, v_case, 1, 'CPT', v_claim.cpt_code, 1, v_claim.billed_total);
  end if;

  perform public.fs_apply(v_case);
  return v_case;
end $fn$;

grant execute on function public.fs_apply(uuid) to anon, authenticated, service_role;
grant execute on function public.run_fee_schedule_review(uuid, text, text) to anon, authenticated, service_role;

insert into public.review_cases (id, org_id, review_type, plan_id, provider_name, provider_npi, jurisdiction, line_of_business, date_of_service, status)
values ('de300000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','wc_bill_review',
        'b0000000-0000-0000-0000-000000000002','Bayview Orthopedic & Imaging','1548903271','CA','workers_comp', date '2026-06-02','in_review')
on conflict (id) do nothing;

delete from public.review_lines where review_case_id='de300000-0000-0000-0000-000000000001';
insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, units, billed) values
 ('a0000000-0000-0000-0000-000000000001','de300000-0000-0000-0000-000000000001',1,'CPT','70551','MRI brain w/o contrast',1,1900),
 ('a0000000-0000-0000-0000-000000000001','de300000-0000-0000-0000-000000000001',2,'CPT','74177','CT abdomen & pelvis w/ contrast',1,2100),
 ('a0000000-0000-0000-0000-000000000001','de300000-0000-0000-0000-000000000001',3,'CPT','72110','X-ray lumbar spine, complete',1,520),
 ('a0000000-0000-0000-0000-000000000001','de300000-0000-0000-0000-000000000001',4,'CPT','99285','Emergency dept visit, high complexity',1,900);

select public.fs_apply('de300000-0000-0000-0000-000000000001');
