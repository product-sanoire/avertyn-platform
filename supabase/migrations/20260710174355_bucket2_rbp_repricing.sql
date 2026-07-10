-- ============================================================
-- Bucket 2 #2 — RBP Repricing + Open Negotiation link
-- Reference-based pricing to a defensible allowed amount, written
-- into repricer_determinations and (optionally) the negotiation flow.
-- Medicare rates are ILLUSTRATIVE — load the official PFS/OPPS files.
-- ============================================================

create table if not exists public.rbp_schedules (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.current_org() references public.orgs(id) on delete cascade,
  name             text not null,
  basis            text not null default 'medicare' check (basis in ('medicare','cost_to_charge','custom')),
  multiplier       numeric not null default 1.50,     -- e.g. 1.50 = 150% of Medicare
  rate_column      text not null default 'facility' check (rate_column in ('facility','nonfacility')),
  floor_multiplier numeric,
  ceiling_multiplier numeric,
  effective_date   date default current_date,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
create index if not exists rbp_schedules_org_idx on public.rbp_schedules(org_id);

create table if not exists public.medicare_rates (
  id               uuid primary key default gen_random_uuid(),
  hcpcs            text not null,
  locality         text not null default 'NATIONAL',
  facility_rate    numeric,
  nonfacility_rate numeric,
  year             int not null default 2026,
  source           text default 'CMS PFS (illustrative national amounts — replace with official locality file)',
  unique (hcpcs, locality, year)
);
insert into public.medicare_rates (hcpcs,locality,facility_rate,nonfacility_rate) values
 ('70551','NATIONAL',62.00,224.00),
 ('70450','NATIONAL',48.00,148.00),
 ('70553','NATIONAL',96.00,340.00),
 ('72110','NATIONAL',18.00,52.00),
 ('74177','NATIONAL',118.00,392.00),
 ('74178','NATIONAL',132.00,436.00),
 ('99285','NATIONAL',182.00,182.00),
 ('99284','NATIONAL',124.00,124.00),
 ('29881','NATIONAL',612.00,1120.00)
on conflict do nothing;

-- demo org default RBP schedule (150% Medicare, facility basis)
insert into public.rbp_schedules (id, org_id, name, basis, multiplier, rate_column)
values ('5b900000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','150% Medicare (facility) — default','medicare',1.50,'nonfacility')
on conflict (id) do nothing;

-- RLS + grants
alter table public.rbp_schedules enable row level security;
alter table public.medicare_rates enable row level security;
drop policy if exists rbp_schedules_read on public.rbp_schedules;
create policy rbp_schedules_read on public.rbp_schedules for select using (auth_org_id() is null or org_id = auth_org_id());
drop policy if exists rbp_schedules_write on public.rbp_schedules;
create policy rbp_schedules_write on public.rbp_schedules for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());
drop policy if exists medicare_rates_read on public.medicare_rates;
create policy medicare_rates_read on public.medicare_rates for select using (true);

grant select on public.rbp_schedules, public.medicare_rates to anon, authenticated, service_role;
grant all on public.rbp_schedules to authenticated, service_role;

-- ============================================================
-- Engine: run_rbp_repricing(dispute, schedule?, make_offer?) -> jsonb
-- ============================================================
create or replace function public.run_rbp_repricing(
  p_dispute_id uuid,
  p_schedule_id uuid default null,
  p_make_offer boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org  uuid := public.current_org();
  v_disp public.disputes%rowtype;
  v_sch  public.rbp_schedules%rowtype;
  v_rate public.medicare_rates%rowtype;
  v_base numeric;
  v_repriced numeric;
  v_billed numeric;
  v_case uuid;
  v_line uuid;
  v_det uuid;
  v_offer uuid;
  v_neg uuid;
begin
  select * into v_disp from public.disputes where id = p_dispute_id and org_id = v_org;
  if not found then raise exception 'dispute not found in current org'; end if;

  select * into v_sch from public.rbp_schedules
    where org_id = v_org and (p_schedule_id is null or id = p_schedule_id) and active
    order by (id = p_schedule_id) desc, effective_date desc limit 1;
  if not found then raise exception 'no active RBP schedule for org'; end if;

  select * into v_rate from public.medicare_rates where hcpcs = v_disp.cpt_code order by year desc limit 1;
  v_base := case when v_sch.rate_column = 'facility' then coalesce(v_rate.facility_rate, v_rate.nonfacility_rate)
                 else coalesce(v_rate.nonfacility_rate, v_rate.facility_rate) end;
  if v_base is null then
    raise exception 'no Medicare reference rate for CPT %', coalesce(v_disp.cpt_code,'(none)');
  end if;

  v_repriced := round(v_base * v_sch.multiplier, 2);
  if v_sch.floor_multiplier is not null then v_repriced := greatest(v_repriced, round(v_base*v_sch.floor_multiplier,2)); end if;
  if v_sch.ceiling_multiplier is not null then v_repriced := least(v_repriced, round(v_base*v_sch.ceiling_multiplier,2)); end if;
  v_billed := coalesce(v_disp.billed_amount, 0);

  -- write into the existing repricer_determinations table (reused, not duplicated)
  insert into public.repricer_determinations (org_id, dispute_id, repricer, methodology, repriced_amount, percentile_basis, non_statutory, raw)
  values (v_org, v_disp.id, 'Avertyn RBP',
          format('%sx Medicare (%s), CPT %s @ $%s base', v_sch.multiplier, v_sch.rate_column, v_disp.cpt_code, v_base),
          v_repriced, null, true,
          jsonb_build_object('schedule_id',v_sch.id,'schedule',v_sch.name,'base_rate',v_base,'multiplier',v_sch.multiplier,'locality',coalesce(v_rate.locality,'NATIONAL')))
  returning id into v_det;

  -- create a review_case for the repricing so it appears in the bill-review surface
  insert into public.review_cases (org_id, review_type, dispute_id, plan_id, line_of_business, date_of_service, billed_total, allowed_total, savings, savings_pct, status, determination, confidence, meta)
  values (v_org,'rbp_repricing', v_disp.id, v_disp.plan_id, 'group_health', v_disp.service_date, v_billed, v_repriced,
          greatest(v_billed - v_repriced,0),
          case when v_billed>0 then round((v_billed-v_repriced)/v_billed*100,1) else 0 end,
          'determined',
          format('Repriced to $%s (%sx Medicare, %s basis). Billed $%s -> savings $%s.',
                 to_char(v_repriced,'FM999,999,990.00'), v_sch.multiplier, v_sch.rate_column,
                 to_char(v_billed,'FM999,999,990.00'), to_char(greatest(v_billed-v_repriced,0),'FM999,999,990.00')),
          0.9, jsonb_build_object('repricer_determination', v_det))
  returning id into v_case;

  insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, units, billed, allowed, method, flagged)
  values (v_org, v_case, 1, 'CPT', v_disp.cpt_code,
          (select short_desc from public.medical_codes mc where mc.code = v_disp.cpt_code limit 1),
          1, v_billed, v_repriced, format('%sx Medicare %s', v_sch.multiplier, v_sch.rate_column), true)
  returning id into v_line;

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence, status)
  values (v_org, v_case, v_line, 'RBP_REPRICE','rbp_benchmark','high',
          format('Reference-based price: %sx Medicare (%s) = $%s vs billed $%s.', v_sch.multiplier, v_sch.rate_column, v_repriced, v_billed),
          greatest(v_billed - v_repriced,0),
          format('%s; %s', v_sch.name, coalesce(v_rate.source,'CMS PFS')), 0.9, 'proposed');

  -- optionally push a plan offer into the open-negotiation flow
  if p_make_offer then
    select id into v_neg from public.negotiations where dispute_id = v_disp.id and status = 'open' order by opened_at desc limit 1;
    if v_neg is null then
      insert into public.negotiations (org_id, dispute_id, closes_at, status, rounds)
      values (v_org, v_disp.id, now() + interval '30 days', 'open', 0) returning id into v_neg;
    end if;
    insert into public.offers (org_id, dispute_id, party, kind, amount, note, round_no, pct_of_qpa, status)
    values (v_org, v_disp.id, 'plan','open_negotiation', v_repriced,
            format('RBP-supported offer: %sx Medicare = $%s', v_sch.multiplier, v_repriced),
            coalesce((select max(round_no) from public.offers where dispute_id=v_disp.id),0)+1,
            case when v_disp.qpa_amount is not null and v_disp.qpa_amount>0 then round(v_repriced/v_disp.qpa_amount*100,1) else null end,
            'open')
    returning id into v_offer;
    update public.negotiations set rounds = rounds + 1, updated_at = now() where id = v_neg;
  end if;

  return jsonb_build_object(
    'review_case', v_case, 'repricer_determination', v_det, 'offer', v_offer,
    'base_rate', v_base, 'repriced_amount', v_repriced, 'billed', v_billed,
    'savings', greatest(v_billed - v_repriced,0));
end $fn$;

grant execute on function public.run_rbp_repricing(uuid, uuid, boolean) to anon, authenticated, service_role;

-- demo: reprice a demo dispute and push an offer
select public.run_rbp_repricing('fcf5fafd-69ac-4348-a1e4-239df743fe24'::uuid, null, true);
