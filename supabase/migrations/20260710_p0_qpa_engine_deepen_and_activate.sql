-- P0 #4: deepen + activate the QPA computation engine (compute from real contracted-rate inputs).
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10.
-- (a) §149.140(c)(3) insufficient-information guard on compute_qpa; (b) bulk rate-input loader;
-- (c) demo activation seeded 6 contracted rates on 8 demo disputes + ran compute_qpa (live only; not in this mirror).

INSERT INTO public.regulatory_config(key, value, note)
SELECT 'qpa_min_contracted_rates', '3'::jsonb,
       'Minimum contracted rates required to compute a median QPA; below this, 45 CFR §149.140(c)(3) requires an eligible database.'
WHERE NOT EXISTS (SELECT 1 FROM public.regulatory_config WHERE key='qpa_min_contracted_rates');

-- compute_qpa: existing median + CPI-U/CMS-factor logic, PLUS the §149.140(c)(3) insufficient-information guard.
CREATE OR REPLACE FUNCTION public.compute_qpa(p_dispute uuid, p_apply boolean DEFAULT true)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  d record; n int; med numeric; base_year int := 2019; svc_year int;
  base_idx numeric; svc_idx numeric; used_year int; cpi_factor numeric; cpi_qpa numeric;
  cms_f numeric; cms_src text; cms_qpa numeric; qpa numeric; basis text; delta numeric; meth text; v_min int;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  select count(*), percentile_cont(0.5) within group (order by contracted_rate)
    into n, med from public.qpa_rate_inputs where dispute_id = p_dispute;
  if n = 0 then return jsonb_build_object('ok', false, 'reason', 'no_rates'); end if;

  select coalesce((value#>>'{}')::int, 3) into v_min from public.regulatory_config where key='qpa_min_contracted_rates';
  v_min := coalesce(v_min, 3);
  if n < v_min then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_information', 'n', n, 'min_required', v_min, 'median', med,
      'note', 'Only ' || n || ' contracted rate(s) on file (need ' || v_min || '). Under 45 CFR §149.140(c)(3) the QPA must be determined from an eligible database rather than a median of insufficient rates. Add rates or set an eligible-database benchmark before applying.');
  end if;

  svc_year := coalesce(extract(year from d.service_date)::int, extract(year from now())::int);
  select index_value into base_idx from public.cpi_u_index where year = base_year;
  select year, index_value into used_year, svc_idx from public.cpi_u_index where year <= svc_year order by year desc limit 1;
  if svc_idx is null then select year, index_value into used_year, svc_idx from public.cpi_u_index order by year desc limit 1; end if;
  cpi_factor := case when base_idx is null or base_idx = 0 or svc_idx is null then 1 else round(svc_idx / base_idx, 5) end;
  cpi_qpa := round(med * cpi_factor, 2);
  select cms_factor, cms_source into cms_f, cms_src from public.cpi_u_index where year = svc_year;

  if cms_f is not null then
    cms_qpa := round(med * cms_f, 2);
    qpa := cms_qpa; basis := 'cms'; delta := round(cpi_qpa - cms_qpa, 2);
    meth := 'Median $' || to_char(med,'FM999999990.00') || ' × CMS ' || svc_year || ' factor '
          || to_char(cms_f,'FM990.0000000000') || ' → QPA $' || to_char(cms_qpa,'FM999999990.00')
          || ' (' || coalesce(cms_src,'CMS guidance') || '). CPI-U estimate $' || to_char(cpi_qpa,'FM999999990.00')
          || ' (Δ $' || to_char(delta,'FM999999990.00') || ').';
  else
    qpa := cpi_qpa; basis := 'cpi'; delta := null;
    meth := 'Median $' || to_char(med,'FM999999990.00') || ' × CPI-U trend ×' || to_char(cpi_factor,'FM990.00000')
          || ' to ' || used_year || ' → QPA $' || to_char(cpi_qpa,'FM999999990.00')
          || '. No CMS-published factor on file for ' || svc_year || ' — using CPI-U estimate.';
  end if;

  if p_apply then
    if exists (select 1 from public.qpa_records where dispute_id = p_dispute) then
      update public.qpa_records set contracted_median = med, plan_qpa = qpa, indexing_current = true,
        methodology = case when basis='cms' then 'CMS-published QPA factor' else 'NSA median + CPI-U (estimate)' end, notes = meth
        where dispute_id = p_dispute;
    else
      insert into public.qpa_records(org_id, dispute_id, contracted_median, plan_qpa, indexing_current, methodology, notes)
        values (d.org_id, p_dispute, med, qpa, true,
          case when basis='cms' then 'CMS-published QPA factor' else 'NSA median + CPI-U (estimate)' end, meth);
    end if;
    update public.disputes set qpa_amount = qpa, updated_at = now() where id = p_dispute;
  end if;

  return jsonb_build_object('ok', true, 'n', n, 'median', med, 'base_year', base_year, 'service_year', svc_year,
    'index_year', used_year, 'cpi_factor', cpi_factor, 'cpi_qpa', cpi_qpa,
    'cms_factor', cms_f, 'cms_source', cms_src, 'cms_qpa', cms_qpa,
    'basis', basis, 'delta', delta, 'qpa', qpa, 'methodology', meth);
end $function$;

-- Bulk rate-input loader — the ingestion path for a plan's contracted-rate sheet.
CREATE OR REPLACE FUNCTION public.add_qpa_rates_bulk(p_dispute uuid, p_rates numeric[], p_source text DEFAULT 'bulk import', p_base_year int DEFAULT 2019)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare d record; c int := 0; r numeric;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if p_rates is null then return 0; end if;
  foreach r in array p_rates loop
    insert into public.qpa_rate_inputs(org_id, dispute_id, source, contracted_rate, base_year, note)
    values (d.org_id, p_dispute, coalesce(p_source,'bulk import'), r, coalesce(p_base_year,2019), 'bulk');
    c := c + 1;
  end loop;
  return c;
end $function$;
GRANT EXECUTE ON FUNCTION public.add_qpa_rates_bulk(uuid, numeric[], text, integer) TO anon, authenticated;
