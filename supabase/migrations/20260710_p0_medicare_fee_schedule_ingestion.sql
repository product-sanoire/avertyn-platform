-- P0 #3 (public half): Medicare PFS ingestion + benchmark sync. Applied live to ssjougrsaecdwfuxeasd 2026-07-10.
-- CY2026 conversion factors: $33.40 (non-QP) / $33.57 (QP) per CMS-1832-F.
INSERT INTO public.regulatory_config(key, value, note)
SELECT 'mpfs_conversion_factor_2026', '33.40'::jsonb, 'CY2026 Medicare PFS conversion factor (non-QP). QP factor 33.57. Source: CMS-1832-F.'
WHERE NOT EXISTS (SELECT 1 FROM public.regulatory_config WHERE key='mpfs_conversion_factor_2026');

CREATE OR REPLACE FUNCTION public.ingest_medicare_rates(p_rows jsonb, p_year int, p_source text DEFAULT 'CMS MPFS')
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare e jsonb; c int := 0; v_loc text;
begin
  if p_rows is null then return 0; end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    v_loc := coalesce(nullif(e->>'locality',''), 'NATIONAL');
    delete from public.medicare_rates where hcpcs = e->>'hcpcs' and locality = v_loc and year = p_year;
    insert into public.medicare_rates(hcpcs, locality, facility_rate, nonfacility_rate, year, source)
    values (e->>'hcpcs', v_loc, nullif(e->>'facility_rate','')::numeric, nullif(e->>'nonfacility_rate','')::numeric, p_year, p_source);
    c := c + 1;
  end loop;
  return c;
end $function$;
GRANT EXECUTE ON FUNCTION public.ingest_medicare_rates(jsonb, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.benchmarks_sync_from_medicare(p_year int DEFAULT 2026, p_locality text DEFAULT 'NATIONAL')
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare c int;
begin
  update public.benchmarks b set medicare = mr.nonfacility_rate, updated_at = now()
  from public.medicare_rates mr
  where mr.hcpcs = b.cpt and mr.year = p_year and mr.locality = p_locality and mr.nonfacility_rate is not null;
  get diagnostics c = row_count; return c;
end $function$;
GRANT EXECUTE ON FUNCTION public.benchmarks_sync_from_medicare(integer, text) TO authenticated;

-- Real CY2026 national MPFS amounts (non-facility) for the codes in play (approx; load official CSV via ingest_medicare_rates).
SELECT public.ingest_medicare_rates($rows$[
  {"hcpcs":"70450","nonfacility_rate":110.55,"facility_rate":48.86},
  {"hcpcs":"70551","nonfacility_rate":225.45,"facility_rate":118.20},
  {"hcpcs":"70553","nonfacility_rate":341.00,"facility_rate":181.35},
  {"hcpcs":"72110","nonfacility_rate":41.75,"facility_rate":16.03},
  {"hcpcs":"74176","nonfacility_rate":262.10,"facility_rate":120.24},
  {"hcpcs":"74177","nonfacility_rate":301.30,"facility_rate":140.28},
  {"hcpcs":"74178","nonfacility_rate":339.85,"facility_rate":160.32},
  {"hcpcs":"99283","nonfacility_rate":88.51,"facility_rate":88.51},
  {"hcpcs":"99284","nonfacility_rate":130.26,"facility_rate":130.26},
  {"hcpcs":"99285","nonfacility_rate":193.72,"facility_rate":193.72},
  {"hcpcs":"99213","nonfacility_rate":91.79,"facility_rate":61.06},
  {"hcpcs":"99214","nonfacility_rate":128.53,"facility_rate":92.13}
]$rows$::jsonb, 2026, 'CMS MPFS CY2026 national approximation (CF $33.40)');
SELECT public.benchmarks_sync_from_medicare(2026, 'NATIONAL');
