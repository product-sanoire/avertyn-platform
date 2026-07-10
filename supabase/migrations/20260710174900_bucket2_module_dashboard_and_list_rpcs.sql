-- ============================================================
-- Bucket 2 — unified module dashboard + list/detail RPCs for UI
-- ============================================================

create or replace function public.module_dashboard()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_org uuid := public.current_org(); v jsonb;
begin
  v := jsonb_build_object(
    'org_id', v_org,
    'enabled_modules', (
      select coalesce(jsonb_agg(jsonb_build_object('code',m.code,'name',m.name,'tagline',m.tagline,'category',m.category) order by m.sort),'[]'::jsonb)
      from public.org_product_modules o join public.product_modules m on m.code=o.module_code
      where o.org_id=v_org and o.enabled and m.active),
    'payment_integrity', (
      select jsonb_build_object('cases',count(*),'billed',coalesce(sum(billed_total),0),'savings',coalesce(sum(savings),0))
      from public.review_cases where org_id=v_org and review_type='payment_integrity'),
    'rbp_repricing', (
      select jsonb_build_object('cases',count(*),'billed',coalesce(sum(billed_total),0),'savings',coalesce(sum(savings),0),
             'offers',(select count(*) from public.offers where org_id=v_org and kind='open_negotiation' and party='plan'))
      from public.review_cases where org_id=v_org and review_type='rbp_repricing'),
    'wc_auto_bill_review', (
      select jsonb_build_object('cases',count(*),'billed',coalesce(sum(billed_total),0),'savings',coalesce(sum(savings),0),
             'wc',count(*) filter (where review_type='wc_bill_review'),'auto',count(*) filter (where review_type='auto_bill_review'))
      from public.review_cases where org_id=v_org and review_type in ('wc_bill_review','auto_bill_review')),
    'erisa_fiduciary', (
      select jsonb_build_object(
        'plans_assessed',count(distinct plan_id),
        'requirements',count(*),
        'compliant',count(*) filter (where status='compliant'),
        'open_gaps',count(*) filter (where status='gap'),
        'in_progress',count(*) filter (where status='in_progress'),
        'avg_score', case when count(*) filter (where status<>'na')>0
                       then round(100.0*count(*) filter (where status='compliant')/count(*) filter (where status<>'na'),0) else null end,
        'decisions',(select count(*) from public.fiduciary_decisions where org_id=v_org))
      from public.fiduciary_assessments where org_id=v_org)
  );
  return v;
end $fn$;

create or replace function public.list_review_cases(p_type text default null, p_limit int default 100)
returns jsonb
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(jsonb_agg(row_to_json(t) order by t.updated_at desc),'[]'::jsonb) from (
    select c.id, c.review_type, c.provider_name, c.jurisdiction, c.line_of_business,
           c.billed_total, c.allowed_total, c.savings, c.savings_pct, c.status, c.determination,
           c.date_of_service, c.updated_at,
           (select count(*) from public.review_lines l where l.review_case_id=c.id) as lines,
           (select count(*) from public.review_adjustments a where a.review_case_id=c.id) as adjustments
    from public.review_cases c
    where c.org_id = public.current_org()
      and (p_type is null or c.review_type = p_type)
    order by c.updated_at desc
    limit greatest(p_limit,1)
  ) t;
$fn$;

create or replace function public.get_review_case(p_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public'
as $fn$
  select case when c.id is null then null else jsonb_build_object(
    'case', row_to_json(c),
    'lines', (select coalesce(jsonb_agg(row_to_json(l) order by l.line_no),'[]'::jsonb) from public.review_lines l where l.review_case_id=c.id),
    'adjustments', (select coalesce(jsonb_agg(row_to_json(a) order by a.amount desc),'[]'::jsonb) from public.review_adjustments a where a.review_case_id=c.id)
  ) end
  from (select * from public.review_cases where id=p_id and org_id=public.current_org()) c;
$fn$;

create or replace function public.list_fiduciary_assessments(p_plan_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(jsonb_agg(row_to_json(t) order by t.category, t.requirement_code),'[]'::jsonb) from (
    select a.requirement_code, r.title, r.category, r.authority, r.cadence,
           a.status, a.evidence, a.owner, a.due_date, a.assessed_at
    from public.fiduciary_assessments a join public.fiduciary_requirements r on r.code=a.requirement_code
    where a.org_id=public.current_org() and a.plan_id=p_plan_id
  ) t;
$fn$;

grant execute on function public.module_dashboard() to anon, authenticated, service_role;
grant execute on function public.list_review_cases(text,int) to anon, authenticated, service_role;
grant execute on function public.get_review_case(uuid) to anon, authenticated, service_role;
grant execute on function public.list_fiduciary_assessments(uuid) to anon, authenticated, service_role;
