-- P1 outcome-learning loop (part 2): turn realized outcomes into selection intelligence.
-- idre_scorecard: per certified IDRE, how often selected/reselected AND how often the PLAN prevailed
--   when that IDRE ruled (payer_win_rate) — the signal that should drive IDRE selection, not just usage.
-- offer_acceptance_curve: for the plan's negotiation offers, how disputes resolved by offer-as-%-of-QPA
--   band — the empirical basis for the optimal-offer recommendation. Both org-scoped via current_org().
-- Verified on demo: idre_scorecard differentiates (Federal IDRE Alpha 80%, Meridian/National 75%).

CREATE OR REPLACE FUNCTION public.idre_scorecard(p_org uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with sel as (
    select s.idre_id, s.batch_id, s.reselection_of
    from public.idre_selections s
    where s.org_id = coalesce(p_org, public.current_org())
  ),
  outcomes as (
    select s.idre_id,
           count(distinct s.batch_id)                              as selections,
           count(*) filter (where s.reselection_of is not null)     as reselections,
           count(distinct d.id) filter (where a.prevailing_party is not null)                          as resolved,
           count(distinct d.id) filter (where a.prevailing_party is not null and a.prevailing_party <> 'initiator') as payer_wins
    from sel s
    left join public.batch_disputes bd on bd.batch_id = s.batch_id
    left join public.disputes d on d.id = bd.dispute_id
    left join public.awards a on a.dispute_id = d.id
    group by s.idre_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'idre', e.name, 'selections', o.selections, 'reselections', o.reselections,
    'resolved', o.resolved, 'payer_wins', o.payer_wins,
    'payer_win_rate', case when o.resolved > 0 then round(o.payer_wins::numeric/o.resolved, 3) else null end
  ) order by (case when o.resolved>0 then o.payer_wins::numeric/o.resolved else -1 end) desc, o.selections desc), '[]')
  from outcomes o join public.idre_entities e on e.id = o.idre_id;
$function$;

CREATE OR REPLACE FUNCTION public.offer_acceptance_curve(p_org uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with plan_offers as (
    select o.dispute_id, o.pct_of_qpa, d.disposition,
           least(5, floor(coalesce(o.pct_of_qpa,100)/25.0))::int as band
    from public.offers o join public.disputes d on d.id = o.dispute_id
    where o.org_id = coalesce(p_org, public.current_org())
      and o.party = 'plan' and o.pct_of_qpa is not null
      and d.disposition in ('settled','plan_win','provider_win','eligibility_challenged')
  ),
  agg as (
    select band, count(*) n,
           round(avg(pct_of_qpa),1) avg_pct,
           round(avg(case when disposition in ('settled') then 1 else 0 end),3) settled_rate,
           round(avg(case when disposition in ('plan_win','eligibility_challenged') then 1 else 0 end),3) plan_win_rate,
           round(avg(case when disposition = 'provider_win' then 1 else 0 end),3) provider_win_rate
    from plan_offers group by band
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'offer_pct_band', (band*25)||'-'||((band+1)*25)||'% of QPA', 'n', n, 'avg_pct', avg_pct,
    'settled_rate', settled_rate, 'plan_win_rate', plan_win_rate, 'provider_win_rate', provider_win_rate
  ) order by band), '[]') from agg;
$function$;
