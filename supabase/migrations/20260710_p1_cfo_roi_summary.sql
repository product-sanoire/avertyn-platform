-- P1 CFO ROI view: one consolidated number set proving payer-side value (dollars defended vs demand,
-- win rate, cost-avoided per dispute, default-loss rate, settled-vs-demand, on-time award payment) plus
-- the monthly defended trend. Consolidates org_scorecard + awards_metrics + live dispute aggregates.
-- Surfaced at Admin -> ROI (RoiView): headline dollars-defended, KPI tiles, defended-by-month chart, and
-- a "Schedule monthly" button (creates a scheduled_reports row over the defended metric).
-- Verified on demo: $172,867 defended vs $233,911 demand; $9,604 avoided/dispute; settled 22.7% of demand.
CREATE OR REPLACE FUNCTION public.roi_summary(p_org uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_org uuid := coalesce(p_org, public.current_org());
  sc record; aw record;
  v_resolved int; v_planwins int; v_demand numeric; v_qpa numeric;
begin
  if public.auth_org_id() is not null and v_org <> public.auth_org_id() then raise exception 'not authorized'; end if;
  select * into sc from public.org_scorecard where org_id = v_org;
  select * into aw from public.awards_metrics where org_id = v_org;
  select count(*) filter (where disposition in ('plan_win','provider_win','settled','eligibility_challenged','withdrawn')),
         count(*) filter (where disposition in ('plan_win','eligibility_challenged')),
         coalesce(sum(demand_amount),0), coalesce(sum(qpa_amount),0)
    into v_resolved, v_planwins, v_demand, v_qpa
  from public.disputes where org_id = v_org;

  return jsonb_build_object(
    'org', v_org,
    'dollars_defended', coalesce(sc.dollars_defended,0),
    'total_demand', v_demand,
    'total_qpa', v_qpa,
    'at_risk_vs_qpa', greatest(v_demand - v_qpa, 0),
    'default_losses', coalesce(sc.default_losses,0),
    'total_disputes', coalesce(sc.total_disputes,0),
    'open_disputes', coalesce(sc.open_disputes,0),
    'challenges_filed', coalesce(sc.challenges_filed,0),
    'ineligible_caught', coalesce(sc.ineligible_caught,0),
    'resolved', v_resolved,
    'plan_win_rate', case when v_resolved>0 then round(v_planwins::numeric/v_resolved,3) else null end,
    'cost_avoided_per_dispute', case when v_resolved>0 then round(coalesce(sc.dollars_defended,0)/v_resolved) else 0 end,
    'default_loss_rate', sc.default_loss_rate,
    'ineligible_caught_rate', sc.ineligible_caught_rate,
    'avg_settled_pct_of_demand', sc.avg_settled_pct_of_demand,
    'award_on_time_rate', aw.on_time_rate,
    'defended_trend', coalesce(public.report_trend(v_org,'defended','month')->'series','[]'::jsonb),
    'count_trend', coalesce(public.report_trend(v_org,'count','month')->'series','[]'::jsonb)
  );
end $function$;
