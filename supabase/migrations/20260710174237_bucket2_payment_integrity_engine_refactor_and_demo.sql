-- Refactor edit application into a reusable function + seed a demo review case.

create or replace function public.pi_apply_edits(p_case uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_org uuid;
  v_billed numeric;
  v_saved numeric;
begin
  select org_id into v_org from public.review_cases where id = p_case;
  if v_org is null then raise exception 'review case not found'; end if;

  -- clear any prior computed adjustments (idempotent re-run)
  delete from public.review_adjustments where review_case_id = p_case;

  -- NCCI PTP
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l2.id, 'NCCI_PTP','ncci_ptp','high',
         format('CPT %s is a component of %s under NCCI PTP (no bypass modifier); component line denied.', l2.code, l1.code),
         coalesce(l2.billed,0), 'CMS NCCI Policy Manual, Ch. I', 0.90
  from public.review_lines l1
  join public.review_lines l2 on l2.review_case_id = l1.review_case_id and l2.id <> l1.id
  join public.ncci_edits e on e.column1_code = l1.code and e.column2_code = l2.code
  where l1.review_case_id = p_case and e.modifier_allowed = 0 and coalesce(nullif(trim(l2.modifiers),''),'') = '';

  -- MUE
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l.id, 'MUE_EXCEEDED','mue','medium',
         format('Units %s exceed MUE of %s for %s (MAI %s); excess units denied.', l.units, m.mue_value, l.code, m.mai),
         round(coalesce(l.billed,0)/nullif(l.units,0) * (l.units - m.mue_value), 2),
         'CMS Medically Unlikely Edits', 0.85
  from public.review_lines l join public.mue_values m on m.hcpcs = l.code
  where l.review_case_id = p_case and coalesce(l.units,1) > m.mue_value;

  -- Duplicate
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, d.id, 'DUP_LINE','duplicate','medium',
         format('Duplicate of line %s (%s); duplicate denied.', d.keep_no, d.code), coalesce(d.billed,0),
         'CMS Claims Processing Manual (Pub. 100-04)', 0.8
  from (
    select l.*, row_number() over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) rn,
           first_value(l.line_no) over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) keep_no
    from public.review_lines l where l.review_case_id = p_case
  ) d where d.rn > 1;

  -- DRG validation
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l.id, 'DRG_MCC_DOWNGRADE','drg_validation','high',
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
  where l.review_case_id = p_case;

  -- Roll up
  update public.review_lines l set
     allowed = greatest(coalesce(l.billed,0) - coalesce((
        select sum(a.amount) from public.review_adjustments a
        where a.review_line_id = l.id and a.status in ('proposed','accepted')),0), 0),
     flagged = exists (select 1 from public.review_adjustments a where a.review_line_id = l.id)
  where l.review_case_id = p_case;

  select coalesce(sum(billed),0) into v_billed from public.review_lines where review_case_id = p_case;
  select coalesce(sum(amount),0) into v_saved from public.review_adjustments
     where review_case_id = p_case and status in ('proposed','accepted');

  update public.review_cases set
     billed_total = v_billed,
     allowed_total = greatest(v_billed - v_saved, 0),
     savings = v_saved,
     savings_pct = case when v_billed > 0 then round(v_saved / v_billed * 100, 1) else 0 end,
     determination = format('%s edit(s) identified; $%s potential savings (%s%% of billed).',
        (select count(*) from public.review_adjustments where review_case_id = p_case),
        to_char(v_saved,'FM999,999,990.00'),
        case when v_billed>0 then round(v_saved/v_billed*100,1) else 0 end),
     status = 'determined', updated_at = now()
  where id = p_case;
end $fn$;

-- Rebuild the claim-driven engine to call the shared edit function (and not reference a non-existent column)
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
         cl.modifiers, 1, cl.billed
  from public.claim_lines cl
  where cl.claim_id = v_claim.id;

  if not exists (select 1 from public.review_lines where review_case_id = v_case) then
    insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, units, billed)
    values (v_org, v_case, 1, 'CPT', v_claim.cpt_code,
            (select short_desc from public.medical_codes mc where mc.code = v_claim.cpt_code limit 1),
            1, v_claim.billed_total);
  end if;

  perform public.pi_apply_edits(v_case);
  return v_case;
end $fn$;

grant execute on function public.pi_apply_edits(uuid) to anon, authenticated, service_role;
grant execute on function public.run_payment_integrity_review(uuid) to anon, authenticated, service_role;

-- ---- Demo payment-integrity case (facility claim, multiple edit types) ----
insert into public.review_cases (id, org_id, review_type, plan_id, provider_name, provider_npi, line_of_business, jurisdiction, date_of_service, status)
values ('de100000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','payment_integrity',
        'b0000000-0000-0000-0000-000000000001','Cascade Regional Medical Center','1962748391','group_health','WA', date '2026-05-14','in_review')
on conflict (id) do nothing;

delete from public.review_lines where review_case_id = 'de100000-0000-0000-0000-000000000001';
insert into public.review_lines (org_id, review_case_id, line_no, code_system, code, description, modifiers, units, billed) values
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',1,'DRG','291','Heart Failure & Shock w MCC',null,1,18500),
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',2,'CPT','29881','Arthroscopy, knee, w/ meniscectomy',null,1,4200),
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',3,'CPT','29875','Arthroscopy, knee, synovectomy, limited',null,1,1600),
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',4,'CPT','36415','Collection of venous blood by venipuncture',null,5,300),
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',5,'CPT','70551','MRI brain w/o contrast',null,1,1400),
 ('a0000000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000001',6,'CPT','70551','MRI brain w/o contrast',null,1,1400);

select public.pi_apply_edits('de100000-0000-0000-0000-000000000001');
