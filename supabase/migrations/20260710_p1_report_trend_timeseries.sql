-- P1 reporting: time-series complement to report_custom (which is metric-by-dimension).
-- report_trend buckets the same metrics chronologically (month/week/quarter) so the UI can chart trends
-- and exports. Org-guarded (an authenticated caller can only report on its own org).
-- Verified on demo: report_trend(demo_org,'count','month') → monthly series Feb..Jul 2026 [5,7,8,8,12,17];
-- 'defended' returns the dollar series. UI (app/dashboard/admin.js ReportsView) adds a bucket selector,
-- an inline trend bar chart, a CSV export, and a printable .html report (Print → Save as PDF).
CREATE OR REPLACE FUNCTION public.report_trend(p_org uuid, p_metric text, p_bucket text DEFAULT 'month')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare met_sql text; bkt_sql text; q text; res jsonb;
begin
  if public.auth_org_id() is not null and p_org <> public.auth_org_id() then
    raise exception 'not authorized';
  end if;
  bkt_sql := case p_bucket
     when 'week'    then 'to_char(date_trunc(''week'',  d.created_at),''YYYY-MM-DD'')'
     when 'quarter' then 'to_char(d.created_at,''YYYY'')||''-Q''||extract(quarter from d.created_at)::text'
     else                'to_char(date_trunc(''month'', d.created_at),''YYYY-MM'')' end;
  met_sql := case p_metric
     when 'count'     then 'count(*)::numeric'
     when 'defended'  then 'coalesce(sum(d.demand_amount-d.qpa_amount),0)'
     when 'demand'    then 'coalesce(sum(d.demand_amount),0)'
     when 'qpa'       then 'coalesce(sum(d.qpa_amount),0)'
     when 'avg_score' then 'coalesce(round(avg(d.eligibility_score)),0)'
     else                  'count(*)::numeric' end;
  q := format('select coalesce(jsonb_agg(jsonb_build_object(''label'',label,''value'',val) order by label),''[]''::jsonb)
               from (select %s as label, %s as val from public.disputes d where d.org_id=%L group by 1) z',
              bkt_sql, met_sql, p_org);
  execute q into res;
  return jsonb_build_object('metric',p_metric,'bucket',p_bucket,'series',res);
end $function$;
