-- ============================================================
-- Payment Integrity — deepen #1: real NCCI/MUE ingestion + MAI-aware engine
-- Adds quarter versioning, bulk loaders (mirroring ingest_run_start/finish),
-- MUE MAI semantics (line vs date-of-service), dedup ordering, larger edit set,
-- and a coverage RPC. Full CMS files load through ingest_ncci_ptp / ingest_mue.
-- ============================================================

-- ---- Schema hardening --------------------------------------
alter table public.ncci_edits add column if not exists quarter text;
alter table public.ncci_edits add column if not exists ptp_edit_type smallint;   -- 1 = comprehensive/component; 2 = mutually exclusive
alter table public.ncci_edits add column if not exists source_file text;
alter table public.mue_values add column if not exists quarter text;
alter table public.mue_values add column if not exists rationale text;

update public.ncci_edits set quarter = coalesce(quarter,'2026Q3'), ptp_edit_type = coalesce(ptp_edit_type,1);
update public.mue_values set quarter = coalesce(quarter,'2026Q3');

-- register CMS sources (mirrors code_sources convention)
insert into public.code_sources (system, label, url, format, cadence, active, notes) values
 ('NCCI_PTP','CMS NCCI PTP Edits (Practitioner + Hospital)','https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits','csv','quarterly',true,'Column1/Column2 PTP pairs + modifier indicator (0/1/9). Load via ingest_ncci_ptp.'),
 ('MUE','CMS Medically Unlikely Edits','https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits','csv','quarterly',true,'HCPCS + MUE value + MAI (1/2/3) per service type. Load via ingest_mue.')
on conflict do nothing;

-- ---- Larger, established NCCI PTP subset (verify vs official quarterly file) ----
insert into public.ncci_edits (column1_code,column2_code,modifier_allowed,ptp_edit_type,quarter,rationale) values
 -- Comprehensive Metabolic Panel (80053) components
 ('80053','82374',0,1,'2026Q3','CO2 is a component of the CMP'),
 ('80053','82435',0,1,'2026Q3','Chloride is a component of the CMP'),
 ('80053','84132',0,1,'2026Q3','Potassium is a component of the CMP'),
 ('80053','84520',0,1,'2026Q3','BUN is a component of the CMP'),
 ('80053','82947',0,1,'2026Q3','Glucose is a component of the CMP'),
 ('80053','82310',0,1,'2026Q3','Calcium is a component of the CMP'),
 ('80053','84155',0,1,'2026Q3','Total protein is a component of the CMP'),
 ('80053','82040',0,1,'2026Q3','Albumin is a component of the CMP'),
 ('80053','84450',0,1,'2026Q3','AST is a component of the CMP'),
 ('80053','84460',0,1,'2026Q3','ALT is a component of the CMP'),
 -- Basic Metabolic Panel (80048) components
 ('80048','82947',0,1,'2026Q3','Glucose is a component of the BMP'),
 ('80048','84132',0,1,'2026Q3','Potassium is a component of the BMP'),
 ('80048','84520',0,1,'2026Q3','BUN is a component of the BMP'),
 -- Endoscopy: diagnostic bundled into therapeutic
 ('43239','43235',0,1,'2026Q3','Diagnostic EGD is a component of EGD with biopsy'),
 ('45385','45378',0,1,'2026Q3','Diagnostic colonoscopy is a component of colonoscopy with snare'),
 -- Arthroscopy
 ('29881','29874',0,1,'2026Q3','Loose body removal bundled into arthroscopic meniscectomy'),
 -- ECG
 ('93000','93010',0,1,'2026Q3','ECG interpretation-only is a component of the global ECG')
on conflict (column1_code, column2_code) do update
  set modifier_allowed=excluded.modifier_allowed, ptp_edit_type=excluded.ptp_edit_type,
      quarter=excluded.quarter, rationale=excluded.rationale;

-- ---- Larger MUE subset (verify vs official quarterly file) ----
insert into public.mue_values (hcpcs,mue_value,mai,service_type,quarter,rationale) values
 ('99281',1,2,'practitioner','2026Q3','One E/M per encounter'),
 ('99282',1,2,'practitioner','2026Q3','One E/M per encounter'),
 ('99283',1,2,'practitioner','2026Q3','One E/M per encounter'),
 ('99213',1,2,'practitioner','2026Q3','One office E/M per encounter'),
 ('99214',1,2,'practitioner','2026Q3','One office E/M per encounter'),
 ('99215',1,2,'practitioner','2026Q3','One office E/M per encounter'),
 ('80053',1,2,'practitioner','2026Q3','One CMP per date of service'),
 ('80048',1,2,'practitioner','2026Q3','One BMP per date of service'),
 ('93010',1,3,'practitioner','2026Q3','ECG interpretation per day'),
 ('72148',1,3,'practitioner','2026Q3','MRI lumbar spine per day'),
 ('73721',1,3,'practitioner','2026Q3','MRI lower extremity joint per day'),
 ('74178',1,3,'practitioner','2026Q3','CT abdomen/pelvis per day')
on conflict (hcpcs, service_type) do update
  set mue_value=excluded.mue_value, mai=excluded.mai, quarter=excluded.quarter, rationale=excluded.rationale;

-- ============================================================
-- Bulk ingestion RPCs (accept parsed CSV rows as jsonb arrays)
-- ============================================================
create or replace function public.ingest_ncci_ptp(p_quarter text, p_rows jsonb, p_source_url text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_run bigint; v_parsed int; v_up int;
begin
  if auth.uid() is not null then perform public._require_admin(); end if;
  v_parsed := jsonb_array_length(coalesce(p_rows,'[]'::jsonb));
  v_run := public.ingest_run_start('NCCI_PTP', coalesce(p_source_url,'manual'));
  with rows as (
    select (r->>'column1_code') c1, (r->>'column2_code') c2,
           coalesce((r->>'modifier_allowed')::smallint,0) ma,
           coalesce((r->>'ptp_edit_type')::smallint,1) et,
           nullif(r->>'effective_date','')::date eff,
           nullif(r->>'deletion_date','')::date del,
           r->>'rationale' rat
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r
    where (r->>'column1_code') is not null and (r->>'column2_code') is not null
  ), up as (
    insert into public.ncci_edits (column1_code,column2_code,modifier_allowed,ptp_edit_type,effective_date,deletion_date,rationale,quarter,source,source_file)
    select c1,c2,ma,et,eff,del,rat,p_quarter,'CMS NCCI PTP', p_source_url from rows
    on conflict (column1_code,column2_code) do update
      set modifier_allowed=excluded.modifier_allowed, ptp_edit_type=excluded.ptp_edit_type,
          effective_date=excluded.effective_date, deletion_date=excluded.deletion_date,
          rationale=excluded.rationale, quarter=excluded.quarter, source_file=excluded.source_file
    returning 1
  ) select count(*) into v_up from up;
  perform public.ingest_run_finish(v_run,'ok',v_parsed,v_up,null);
  return jsonb_build_object('run_id',v_run,'parsed',v_parsed,'upserted',v_up,'quarter',p_quarter);
end $fn$;

create or replace function public.ingest_mue(p_quarter text, p_rows jsonb, p_service_type text default 'practitioner', p_source_url text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_run bigint; v_parsed int; v_up int;
begin
  if auth.uid() is not null then perform public._require_admin(); end if;
  v_parsed := jsonb_array_length(coalesce(p_rows,'[]'::jsonb));
  v_run := public.ingest_run_start('MUE', coalesce(p_source_url,'manual'));
  with rows as (
    select (r->>'hcpcs') hcpcs, coalesce((r->>'mue_value')::int,0) mue,
           coalesce((r->>'mai')::smallint,1) mai, r->>'rationale' rat
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r
    where (r->>'hcpcs') is not null
  ), up as (
    insert into public.mue_values (hcpcs,mue_value,mai,service_type,rationale,quarter,source)
    select hcpcs,mue,mai,p_service_type,rat,p_quarter,'CMS MUE' from rows
    on conflict (hcpcs,service_type) do update
      set mue_value=excluded.mue_value, mai=excluded.mai, rationale=excluded.rationale, quarter=excluded.quarter
    returning 1
  ) select count(*) into v_up from up;
  perform public.ingest_run_finish(v_run,'ok',v_parsed,v_up,null);
  return jsonb_build_object('run_id',v_run,'parsed',v_parsed,'upserted',v_up,'quarter',p_quarter,'service_type',p_service_type);
end $fn$;

create or replace function public.ncci_mue_coverage()
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select jsonb_build_object(
    'ncci_pairs', (select count(*) from public.ncci_edits),
    'ncci_quarters', (select coalesce(jsonb_agg(distinct quarter),'[]'::jsonb) from public.ncci_edits where quarter is not null),
    'mue_codes', (select count(*) from public.mue_values),
    'mue_quarters', (select coalesce(jsonb_agg(distinct quarter),'[]'::jsonb) from public.mue_values where quarter is not null),
    'drg_rows', (select count(*) from public.drg_reference),
    'last_ingest', (select jsonb_agg(row_to_json(t)) from (
        select system, status, parsed, upserted, finished_at
        from public.ingest_runs where system in ('NCCI_PTP','MUE') order by started_at desc limit 5) t)
  );
$fn$;

grant execute on function public.ingest_ncci_ptp(text,jsonb,text) to authenticated, service_role;
grant execute on function public.ingest_mue(text,jsonb,text,text) to authenticated, service_role;
grant execute on function public.ncci_mue_coverage() to anon, authenticated, service_role;

-- ============================================================
-- MAI-aware edit engine (replaces pi_apply_edits)
--   Order: duplicates -> MUE (excl. dupes; MAI 1 line, MAI 2/3 date-of-service)
--          -> NCCI PTP (excl. dupes, date-aware) -> DRG. Prevents double counting.
-- ============================================================
create or replace function public.pi_apply_edits(p_case uuid)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare v_org uuid; v_dos date; v_billed numeric; v_saved numeric;
begin
  select org_id, date_of_service into v_org, v_dos from public.review_cases where id = p_case;
  if v_org is null then raise exception 'review case not found'; end if;
  delete from public.review_adjustments where review_case_id = p_case;

  -- 1) Duplicate lines (same code+modifiers) — keep first
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, d.id, 'DUP_LINE','duplicate','medium',
         format('Duplicate of line %s (%s); duplicate denied.', d.keep_no, d.code), coalesce(d.billed,0),
         'CMS Claims Processing Manual (Pub. 100-04)', 0.8
  from (
    select l.*, row_number() over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) rn,
           first_value(l.line_no) over (partition by l.code, coalesce(l.modifiers,'') order by l.line_no) keep_no
    from public.review_lines l where l.review_case_id = p_case
  ) d where d.rn > 1;

  -- 2a) MUE MAI 1 (line edit) on non-duplicate lines
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l.id, 'MUE_LINE','mue','medium',
         format('Units %s exceed MUE %s for %s (MAI 1, line edit); excess denied.', l.units, m.mue_value, l.code),
         round(coalesce(l.billed,0)/nullif(l.units,0) * (l.units - m.mue_value), 2),
         'CMS Medically Unlikely Edits (MAI 1)', 0.85
  from public.review_lines l join public.mue_values m on m.hcpcs = l.code and m.mai = 1
  where l.review_case_id = p_case and coalesce(l.units,1) > m.mue_value
    and l.id not in (select review_line_id from public.review_adjustments where review_case_id=p_case and rule_code='DUP_LINE' and review_line_id is not null);

  -- 2b) MUE MAI 2/3 (date-of-service edit): sum units per code across non-duplicate lines
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, x.line_id, 'MUE_DOS','mue', case when x.mai=2 then 'high' else 'medium' end,
         format('%s units of %s on the date of service exceed MUE %s (MAI %s, %s); excess denied.',
                x.total_units, x.code, x.mue_value, x.mai,
                case when x.mai=2 then 'absolute per-day' else 'per-day, overridable with documentation' end),
         round(x.avg_per_unit * (x.total_units - x.mue_value), 2),
         format('CMS Medically Unlikely Edits (MAI %s)', x.mai), case when x.mai=2 then 0.9 else 0.8 end
  from (
    select l.code, m.mai, m.mue_value,
           sum(coalesce(l.units,1)) total_units,
           (array_agg(l.id order by l.billed desc nulls last))[1] line_id,
           coalesce(sum(coalesce(l.billed,0)) / nullif(sum(coalesce(l.units,1)),0),0) avg_per_unit
    from public.review_lines l join public.mue_values m on m.hcpcs = l.code and m.mai in (2,3)
    where l.review_case_id = p_case
      and l.id not in (select review_line_id from public.review_adjustments where review_case_id=p_case and rule_code='DUP_LINE' and review_line_id is not null)
    group by l.code, m.mai, m.mue_value
    having sum(coalesce(l.units,1)) > m.mue_value
  ) x;

  -- 3) NCCI PTP on non-duplicate lines, respecting modifier + effective/deletion dating
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l2.id, 'NCCI_PTP','ncci_ptp','high',
         format('CPT %s is a component of %s under NCCI PTP%s (no bypass modifier); component line denied.',
                l2.code, l1.code, case when e.quarter is not null then ' '||e.quarter else '' end),
         coalesce(l2.billed,0), 'CMS NCCI Policy Manual, Ch. I', 0.90
  from public.review_lines l1
  join public.review_lines l2 on l2.review_case_id = l1.review_case_id and l2.id <> l1.id
  join public.ncci_edits e on e.column1_code = l1.code and e.column2_code = l2.code
  where l1.review_case_id = p_case and e.modifier_allowed = 0
    and coalesce(nullif(trim(l2.modifiers),''),'') = ''
    and (e.effective_date is null or v_dos is null or v_dos >= e.effective_date)
    and (e.deletion_date is null or v_dos is null or v_dos < e.deletion_date)
    and l2.id not in (select review_line_id from public.review_adjustments where review_case_id=p_case and rule_code='DUP_LINE' and review_line_id is not null);

  -- 4) DRG validation (MCC/CC downgrade)
  insert into public.review_adjustments (org_id, review_case_id, review_line_id, rule_code, category, severity, description, amount, authority, confidence)
  select v_org, p_case, l.id, 'DRG_MCC_DOWNGRADE','drg_validation','high',
         format('Billed %s (%s, RW %s). Same-family alternative %s (%s, RW %s) if MCC/CC not clinically validated - potential downgrade.',
                d.drg_code, d.tier, d.relative_weight, alt.drg_code, alt.tier, alt.relative_weight),
         round(coalesce(l.billed,0) * (1 - alt.relative_weight/d.relative_weight), 2),
         'CMS MS-DRG Definitions Manual; 42 CFR 412', 0.6
  from public.review_lines l
  join public.drg_reference d on d.drg_code = l.code and l.code_system = 'DRG'
  join lateral (select a.* from public.drg_reference a where a.drg_family=d.drg_family and a.relative_weight<d.relative_weight order by a.relative_weight desc limit 1) alt on true
  where l.review_case_id = p_case;

  -- Roll up
  update public.review_lines l set
     allowed = greatest(coalesce(l.billed,0) - coalesce((select sum(a.amount) from public.review_adjustments a
        where a.review_line_id = l.id and a.status in ('proposed','accepted')),0), 0),
     flagged = exists (select 1 from public.review_adjustments a where a.review_line_id = l.id)
  where l.review_case_id = p_case;

  select coalesce(sum(billed),0) into v_billed from public.review_lines where review_case_id = p_case;
  select coalesce(sum(amount),0) into v_saved from public.review_adjustments where review_case_id = p_case and status in ('proposed','accepted');

  update public.review_cases set
     billed_total = v_billed, allowed_total = greatest(v_billed - v_saved,0), savings = v_saved,
     savings_pct = case when v_billed>0 then round(v_saved/v_billed*100,1) else 0 end,
     determination = format('%s edit(s) identified; $%s potential savings (%s%% of billed).',
        (select count(*) from public.review_adjustments where review_case_id = p_case),
        to_char(v_saved,'FM999,999,990.00'), case when v_billed>0 then round(v_saved/v_billed*100,1) else 0 end),
     status = 'determined', updated_at = now()
  where id = p_case;
end $fn$;

-- refresh the demo case under the new engine
select public.pi_apply_edits('de100000-0000-0000-0000-000000000001');
