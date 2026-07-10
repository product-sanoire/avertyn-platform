-- ============================================================
-- Bucket 2 #1 — Payment Integrity
-- DRG validation, clinical validation, NCCI/PTP, MUE editing
-- Reference data is an ILLUSTRATIVE subset; load official CMS
-- quarterly files before production adjudication.
-- ============================================================

create table if not exists public.pi_edit_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.orgs(id) on delete cascade,  -- null = global
  rule_code   text not null,
  category    text not null check (category in (
                'drg_validation','clinical_validation','ncci_ptp','mue','unbundling',
                'duplicate','upcoding','medical_necessity','readmission','never_event')),
  name        text not null,
  description text,
  authority   text,
  logic       jsonb not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists pi_edit_rules_uk on public.pi_edit_rules
  (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), rule_code);

insert into public.pi_edit_rules (rule_code,category,name,description,authority) values
 ('DRG_MCC_DOWNGRADE','drg_validation','MCC/CC not clinically supported',
   'A secondary diagnosis driving MCC/CC assignment is not supported by the clinical documentation; reassign to the lower-weighted DRG in the same family.',
   'CMS MS-DRG Definitions Manual; 42 CFR 412 (IPPS)'),
 ('CLIN_VAL_SEPSIS','clinical_validation','Sepsis without Sepsis-3 criteria',
   'Sepsis diagnosis not supported by Sepsis-3 criteria (suspected infection + SOFA increase >=2 / lactate); remove and re-sequence, revalidate DRG.',
   'Sepsis-3 (JAMA 2016); CMS clinical validation guidance; AHA Coding Clinic'),
 ('NCCI_PTP','ncci_ptp','Procedure-to-procedure unbundling',
   'Column-2 code is a component of the column-1 code under NCCI PTP edits and no appropriate bypass modifier is present; deny the component line.',
   'CMS National Correct Coding Initiative Policy Manual, Ch. I'),
 ('MUE_EXCEEDED','mue','Units exceed Medically Unlikely Edit',
   'Reported units exceed the CMS MUE for the HCPCS/CPT code; deny units above the MUE (MAI-dependent).',
   'CMS Medically Unlikely Edits program'),
 ('DUP_LINE','duplicate','Duplicate service line',
   'Same code, modifiers and date of service billed more than once with no distinguishing modifier; deny the duplicate.',
   'CMS Claims Processing Manual (Pub. 100-04)'),
 ('READMIT_30D','readmission','Potentially preventable 30-day readmission',
   'Readmission within 30 days for a related condition may be clinically related to the index stay; route for readmission review/bundling.',
   'CMS Hospital Readmissions Reduction Program methodology'),
 ('HAC_NEVER_EVENT','never_event','Hospital-acquired condition / never event',
   'Condition was hospital-acquired (POA = N/U) or is a listed serious reportable event; deny incremental payment attributable to the HAC.',
   '42 CFR 412.2; SSA 1886(d)(4)(D); NQF Serious Reportable Events'),
 ('EM_UPCODE','upcoding','E/M level not supported',
   'Evaluation & Management level billed exceeds the level supported by history/exam/MDM or time; downcode to supported level.',
   'CMS E/M documentation guidelines; CPT E/M criteria')
on conflict do nothing;

create table if not exists public.drg_reference (
  id              uuid primary key default gen_random_uuid(),
  drg_code        text not null,
  drg_type        text not null default 'MS-DRG',
  version         text not null default 'illustrative',
  title           text not null,
  mdc             text,
  drg_family      text not null,
  tier            text not null check (tier in ('w_mcc','w_cc','wo_cc_mcc','base')),
  relative_weight numeric not null,
  gmlos           numeric,
  amlos           numeric,
  active          boolean not null default true,
  source          text default 'CMS MS-DRG Definitions Manual (illustrative subset — replace with official FY table)',
  unique (drg_code, version)
);
insert into public.drg_reference (drg_code,title,mdc,drg_family,tier,relative_weight,gmlos,amlos) values
 ('291','Heart Failure & Shock w MCC','05','HF_SHOCK','w_mcc',1.3454,4.5,5.5),
 ('292','Heart Failure & Shock w CC','05','HF_SHOCK','w_cc',0.9385,3.4,4.0),
 ('293','Heart Failure & Shock w/o CC/MCC','05','HF_SHOCK','wo_cc_mcc',0.6708,2.6,3.0),
 ('871','Septicemia w/o MV >96h w MCC','18','SEPSIS','w_mcc',1.8577,5.0,6.2),
 ('872','Septicemia w/o MV >96h w/o MCC','18','SEPSIS','wo_cc_mcc',1.0479,3.9,4.6),
 ('193','Simple Pneumonia & Pleurisy w MCC','04','PNEUMONIA','w_mcc',1.3308,4.3,5.2),
 ('194','Simple Pneumonia & Pleurisy w CC','04','PNEUMONIA','w_cc',0.9024,3.5,4.1),
 ('195','Simple Pneumonia & Pleurisy w/o CC/MCC','04','PNEUMONIA','wo_cc_mcc',0.6764,2.8,3.2),
 ('469','Major Hip & Knee Joint Replacement w MCC','08','JOINT_REPL','w_mcc',3.1637,5.9,6.8),
 ('470','Major Hip & Knee Joint Replacement w/o MCC','08','JOINT_REPL','wo_cc_mcc',1.8850,2.2,2.5)
on conflict do nothing;

create table if not exists public.ncci_edits (
  id               uuid primary key default gen_random_uuid(),
  column1_code     text not null,
  column2_code     text not null,
  modifier_allowed smallint not null default 0,
  effective_date   date,
  deletion_date    date,
  rationale        text,
  source           text default 'CMS NCCI PTP edits (illustrative subset)',
  unique (column1_code, column2_code)
);
insert into public.ncci_edits (column1_code,column2_code,modifier_allowed,rationale) values
 ('29881','29875',0,'Limited synovectomy is a component of arthroscopic meniscectomy'),
 ('29827','29826',1,'Subacromial decompression may be separate with modifier if distinct'),
 ('93000','93005',0,'ECG tracing-only is a component of the global ECG service'),
 ('80053','82565',0,'Creatinine is a component of the comprehensive metabolic panel'),
 ('80053','84295',0,'Sodium is a component of the comprehensive metabolic panel'),
 ('45385','45380',1,'Colonoscopy with biopsy may be separate with modifier if distinct lesion'),
 ('11042','97597',0,'Active wound care management is a component of surgical debridement'),
 ('99285','99284',0,'Only one E/M level per encounter')
on conflict do nothing;

create table if not exists public.mue_values (
  id           uuid primary key default gen_random_uuid(),
  hcpcs        text not null,
  mue_value    int not null,
  mai          smallint not null default 1,
  service_type text default 'practitioner',
  source       text default 'CMS MUE (illustrative subset)',
  unique (hcpcs, service_type)
);
insert into public.mue_values (hcpcs,mue_value,mai,service_type) values
 ('99285',1,2,'practitioner'),
 ('99284',1,2,'practitioner'),
 ('36415',2,3,'practitioner'),
 ('70551',1,3,'practitioner'),
 ('74177',1,3,'practitioner'),
 ('29881',1,2,'practitioner'),
 ('93000',1,3,'practitioner'),
 ('J1885',80,3,'practitioner')
on conflict do nothing;

do $$
declare t text;
begin
  foreach t in array array['pi_edit_rules','drg_reference','ncci_edits','mue_values'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    if t = 'pi_edit_rules' then
      execute 'create policy pi_edit_rules_read on public.pi_edit_rules for select using (org_id is null or auth_org_id() is null or org_id = auth_org_id())';
      execute 'drop policy if exists pi_edit_rules_write on public.pi_edit_rules';
      execute 'create policy pi_edit_rules_write on public.pi_edit_rules for all using (org_id = auth_org_id()) with check (org_id = auth_org_id())';
    else
      execute format('create policy %I_read on public.%I for select using (true)', t, t);
    end if;
  end loop;
end $$;

grant select on public.pi_edit_rules, public.drg_reference, public.ncci_edits, public.mue_values to anon, authenticated, service_role;
grant all on public.pi_edit_rules to authenticated, service_role;

create or replace function public.run_payment_integrity_review(p_claim_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org   uuid := public.current_org();
  v_case  uuid;
  v_claim public.claims%rowtype;
  v_billed numeric;
  v_saved  numeric;
begin
  select * into v_claim from public.claims where id = p_claim_id and org_id = v_org;
  if not found then raise exception 'claim not found in current org'; end if;

  insert into public.review_cases (org_id, review_type, claim_id, dispute_id, plan_id,
       provider_name, provider_npi, provider_tin, line_of_business, date_of_service, billed_total, status)
  values (v_org,'payment_integrity', v_claim.id, v_claim.dispute_id, v_claim.plan_id,
       v_claim.provider_name, v_claim.provider_npi, v_claim.provider_tin, 'group_health',
       v_claim.service_date, v_claim.billed_total, 'in_review')
  returning id into v_case;

  insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, modifiers, units, billed)
  select v_org, v_case, row_number() over (order by cl.created_at), 'CPT', cl.cpt,
         (select short_desc from public.medical_codes mc where mc.code = cl.cpt limit 1),
         cl.modifiers, coalesce((cl.raw->>'units')::numeric, 1), cl.billed
  from public.claim_lines cl
  where cl.claim_id = v_claim.id;

  if not exists (select 1 from public.review_lines where review_case_id = v_case) then
    insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, units, billed)
    values (v_org, v_case, 1, 'CPT', v_claim.cpt_code,
            (select short_desc from public.medical_codes mc where mc.code = v_claim.cpt_code limit 1),
            1, v_claim.billed_total);
  end if;

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, v_case, l2.id, 'NCCI_PTP','ncci_ptp','high',
         format('CPT %s is a component of %s under NCCI PTP (no bypass modifier); component line denied.', l2.code, l1.code),
         coalesce(l2.billed,0), 'CMS NCCI Policy Manual, Ch. I', 0.90
  from public.review_lines l1
  join public.review_lines l2 on l2.review_case_id = l1.review_case_id and l2.id <> l1.id
  join public.ncci_edits e on e.column1_code = l1.code and e.column2_code = l2.code
  where l1.review_case_id = v_case and e.modifier_allowed = 0 and coalesce(nullif(trim(l2.modifiers),''),'') = '';

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, v_case, l.id, 'MUE_EXCEEDED','mue','medium',
         format('Units %s exceed MUE of %s for %s (MAI %s); excess units denied.', l.units, m.mue_value, l.code, m.mai),
         round(coalesce(l.billed,0)/nullif(l.units,0) * (l.units - m.mue_value), 2),
         'CMS Medically Unlikely Edits', 0.85
  from public.review_lines l join public.mue_values m on m.hcpcs = l.code
  where l.review_case_id = v_case and coalesce(l.units,1) > m.mue_value;

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, v_case, d.id, 'DUP_LINE','duplicate','medium',
         format('Duplicate of line %s (%s); duplicate denied.', d.keep_no, d.code), coalesce(d.billed,0),
         'CMS Claims Processing Manual (Pub. 100-04)', 0.8
  from (
    select l.*, row_number() over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) rn,
           first_value(l.line_no) over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) keep_no
    from public.review_lines l where l.review_case_id = v_case
  ) d where d.rn > 1;

  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, v_case, l.id, 'DRG_MCC_DOWNGRADE','drg_validation','high',
         format('Billed %s (%s, RW %s). Same-family alternative %s (%s, RW %s) if MCC/CC not clinically validated - potential downgrade.',
                d.drg_code, d.tier, d.relative_weight, alt.drg_code, alt.tier, alt.relative_weight),
         round(coalesce(l.billed,0) * (1 - alt.relative_weight/d.relative_weight), 2),
         'CMS MS-DRG Definitions Manual; 42 CFR 412', 0.6
  from public.review_lines l
  join public.drg_reference d on d.drg_code = l.code and l.code_system = 'DRG'
  join lateral (
     select a.* from public.drg_reference a
     where a.drg_family = d.drg_family and a.relative_weight < d.relative_weight
     order by a.relative_weight desc limit 1
  ) alt on true
  where l.review_case_id = v_case;

  update public.review_lines l set
     allowed = greatest(coalesce(l.billed,0) - coalesce((
        select sum(a.amount) from public.review_adjustments a
        where a.review_line_id = l.id and a.status in ('proposed','accepted')),0), 0),
     flagged = exists (select 1 from public.review_adjustments a where a.review_line_id = l.id)
  where l.review_case_id = v_case;

  select coalesce(sum(billed),0) into v_billed from public.review_lines where review_case_id = v_case;
  select coalesce(sum(amount),0) into v_saved from public.review_adjustments
     where review_case_id = v_case and status in ('proposed','accepted');

  update public.review_cases set
     billed_total = v_billed,
     allowed_total = greatest(v_billed - v_saved, 0),
     savings = v_saved,
     savings_pct = case when v_billed > 0 then round(v_saved / v_billed * 100, 1) else 0 end,
     determination = format('%s edit(s) identified; $%s potential savings (%s%% of billed).',
        (select count(*) from public.review_adjustments where review_case_id = v_case),
        to_char(v_saved,'FM999,999,990.00'),
        case when v_billed>0 then round(v_saved/v_billed*100,1) else 0 end),
     status = 'determined', updated_at = now()
  where id = v_case;

  return v_case;
end $fn$;

grant execute on function public.run_payment_integrity_review(uuid) to anon, authenticated, service_role;
