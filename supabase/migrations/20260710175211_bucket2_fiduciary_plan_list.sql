create or replace function public.list_fiduciary_plans()
returns jsonb
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(jsonb_agg(row_to_json(t) order by t.plan_name),'[]'::jsonb) from (
    select p.id as plan_id, p.name as plan_name,
           count(a.*) as total,
           count(a.*) filter (where a.status='compliant') as compliant,
           count(a.*) filter (where a.status='gap') as gaps,
           count(a.*) filter (where a.status='in_progress') as in_progress,
           case when count(a.*) filter (where a.status<>'na') > 0
             then round(100.0*count(a.*) filter (where a.status='compliant')/count(a.*) filter (where a.status<>'na'),0)
             else null end as score_pct
    from public.plans p
    join public.fiduciary_assessments a on a.plan_id=p.id and a.org_id=public.current_org()
    where p.org_id=public.current_org()
    group by p.id, p.name
  ) t;
$fn$;
grant execute on function public.list_fiduciary_plans() to anon, authenticated, service_role;
