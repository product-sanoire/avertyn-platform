-- Plan/payer-grouped view: aggregate exposure per plan, per-plan case list, and bulk actions.

-- 1) Rollup: one row per plan with exposure, ceiling policy, phase mix, top initiators.
CREATE OR REPLACE FUNCTION public.payer_rollup()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
declare g uuid := public.auth_org_id(); res jsonb;
begin
  with od as (
    select d.id, d.plan_id, d.employer_id, d.initiator_id, d.demand_amount, d.qpa_amount,
           d.eligibility_score, d.win_prob, d.respond_by, d.workflow_state,
           coalesce(q.plan_qpa, d.qpa_amount) as eff_qpa, q.defensible_ceiling
    from public.disputes d
    left join lateral (select plan_qpa, defensible_ceiling from public.qpa_records where dispute_id=d.id order by created_at desc limit 1) q on true
    where coalesce(d.workflow_state,'') <> 'closed' and d.plan_id is not null and (g is null or d.org_id=g)
  ),
  ph as (select plan_id, jsonb_object_agg(ws, c) ph from (select plan_id, coalesce(workflow_state,'?') ws, count(*) c from od group by 1,2) a group by plan_id),
  ini as (select plan_id, jsonb_agg(jsonb_build_object('name',nm,'cases',c,'demand',dem) order by dem desc nulls last) ini
          from (select o.plan_id, coalesce(i.name,'—') nm, count(*) c, sum(o.demand_amount) dem
                from od o left join public.initiators i on i.id=o.initiator_id group by 1,2) b group by plan_id),
  agg as (
    select o.plan_id, count(*) open_cases,
      sum(o.demand_amount) total_demand, sum(o.eff_qpa) total_qpa, sum(o.defensible_ceiling) total_ceiling,
      sum(greatest(coalesce(o.demand_amount,0)-coalesce(o.eff_qpa,0),0)) at_risk,
      round(avg(o.win_prob),2) avg_win,
      count(*) filter (where o.eligibility_score>=80) challengeable,
      count(*) filter (where o.respond_by < now()) overdue
    from od o group by o.plan_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'plan_id', p.id, 'plan_name', p.name, 'plan_type', p.plan_type, 'employer', e.name,
    'ceiling_mode', p.ceiling_mode, 'ceiling_value', p.ceiling_value,
    'open_cases', a.open_cases, 'total_demand', a.total_demand, 'total_qpa', a.total_qpa,
    'total_ceiling', a.total_ceiling, 'at_risk', a.at_risk, 'avg_win', a.avg_win,
    'challengeable', a.challengeable, 'overdue', a.overdue,
    'phases', coalesce(ph.ph,'{}'::jsonb), 'initiators', coalesce(ini.ini,'[]'::jsonb)
  ) order by a.at_risk desc nulls last), '[]'::jsonb)
  into res
  from agg a join public.plans p on p.id=a.plan_id
       left join public.employers e on e.id=p.employer_id
       left join ph on ph.plan_id=a.plan_id
       left join ini on ini.plan_id=a.plan_id;
  return jsonb_build_object('ok',true,
    'global_pct', coalesce((select (value#>>'{}')::numeric from public.regulatory_config where key='defensible_ceiling_pct_of_qpa'),125),
    'plans', res);
end $function$;

-- 2) The open cases for one plan (drives the expanded view + click-through).
CREATE OR REPLACE FUNCTION public.plan_cases(p_plan uuid)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'ref', d.external_ref, 'cpt', d.cpt_code, 'initiator', i.name,
    'demand', d.demand_amount, 'qpa', coalesce(q.plan_qpa, d.qpa_amount), 'ceiling', q.defensible_ceiling,
    'above_bench', q.ceiling_above_benchmark, 'win', d.win_prob, 'elig', d.eligibility_score,
    'phase', coalesce(d.phase, d.workflow_state), 'respond_by', d.respond_by, 'rec_offer', pr.recommended_offer
  ) order by d.demand_amount desc nulls last), '[]'::jsonb)
  from public.disputes d
  left join public.initiators i on i.id = d.initiator_id
  left join lateral (select plan_qpa, defensible_ceiling, ceiling_above_benchmark from public.qpa_records where dispute_id=d.id order by created_at desc limit 1) q on true
  left join lateral (select recommended_offer from public.predictions where dispute_id=d.id order by created_at desc limit 1) pr on true
  where d.plan_id = p_plan and coalesce(d.workflow_state,'') <> 'closed'
    and (public.auth_org_id() is null or d.org_id = public.auth_org_id());
$function$;

-- 3) Bulk action across a plan's open cases (recompute ceilings / regenerate offers).
CREATE OR REPLACE FUNCTION public.plan_bulk(p_plan uuid, p_action text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g uuid := public.auth_org_id(); n int := 0; r record;
begin
  perform 1 from public.plans where id = p_plan and (g is null or org_id = g);
  if not found then raise exception 'plan not found or not authorized'; end if;
  if p_action not in ('recompute','predict') then raise exception 'unknown action'; end if;
  for r in select id from public.disputes where plan_id = p_plan and coalesce(workflow_state,'') <> 'closed' loop
    if p_action = 'recompute' then perform public.compute_qpa_defense(r.id);
    elsif p_action = 'predict' then perform public.predict_win(r.id);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'action', p_action, 'count', n);
end $function$;
