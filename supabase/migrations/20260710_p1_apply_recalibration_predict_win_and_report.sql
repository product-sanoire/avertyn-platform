-- Apply the learned recalibration: predict_win sets the dispute's official win_prob to the CALIBRATED
-- value (predictions.win_prob stays RAW so re-fits never double-apply); model_calibration reports raw vs
-- calibrated metrics + the active recalibration params so the learning loop is visible in the Model panel.
-- Depends on 20260710_p1_outcome_learning_win_model_recalibration.sql (calibrated_win_prob + params table).

CREATE OR REPLACE FUNCTION public.predict_win(p_dispute uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  d public.disputes%rowtype; g uuid;
  f_inelig numeric; f_qpa_bb numeric; f_overreach numeric; f_iwr numeric; f_onp numeric; f_nsa numeric;
  fair numeric; z numeric; wp numeric;
  iwins int; itotal int;
  rec text; offer numeric; ceil numeric; ev numeric; drivers jsonb;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  g := d.org_id;

  f_inelig := coalesce(d.eligibility_score,15)::numeric / 100.0;
  select regional_median into fair from public.benchmarks where cpt = d.cpt_code;
  f_qpa_bb := case when fair is not null and fair > 0 and d.qpa_amount is not null
                   then greatest(0, least(1, 1 - (d.qpa_amount/fair))) else 0 end;
  f_overreach := case when coalesce(d.qpa_amount,0) > 0
                   then least(6, greatest(0, (coalesce(d.demand_amount,0)/d.qpa_amount) - 1))/6.0 else 0 end;
  select count(*) filter (where a.prevailing_party='initiator'), count(*)
    into iwins, itotal
  from public.disputes dd join public.awards a on a.dispute_id = dd.id
  where dd.org_id = g and dd.initiator_id = d.initiator_id;
  f_iwr := case when itotal >= 2 then iwins::numeric/itotal else 0.55 end;
  select case when exists (
      select 1 from public.eligibility_findings ef join public.eligibility_rules r on r.id=ef.rule_id
      where ef.dispute_id=d.id and r.category='open_negotiation' and ef.result='pass') then 1 else 0 end
    into f_onp;
  f_nsa := case when d.rarc is not null and public.classify_nsa(d.carc, d.rarc)='ineligible' then 1 else 0 end;

  z := public._w('intercept')
     + public._w('ineligibility')       * f_inelig
     + public._w('qpa_below_benchmark')  * f_qpa_bb
     + public._w('demand_overreach')     * f_overreach
     + public._w('initiator_winrate')    * f_iwr
     + public._w('onp_complete')         * f_onp
     + public._w('nsa_ineligible_signal')* f_nsa;
  wp := round((1.0/(1.0+exp(-z)))::numeric, 4);   -- RAW model probability

  ceil := coalesce((select defensible_ceiling from public.qpa_records where dispute_id=d.id order by created_at desc limit 1),
                   coalesce(fair, d.qpa_amount*1.25));
  offer := round(least(ceil, coalesce(d.qpa_amount,0) * (1 + (1-wp)*0.15)), 0);
  ev := round(coalesce(d.demand_amount,0) - (wp*offer + (1-wp)*coalesce(d.demand_amount,0)), 0);

  rec := case when f_inelig >= 0.80 then 'challenge'
              when wp >= 0.55 then 'defend'
              else 'settle' end;

  drivers := jsonb_build_array(
    jsonb_build_object('feature','ineligibility','value',round(f_inelig,2),'contribution',round(public._w('ineligibility')*f_inelig,2)),
    jsonb_build_object('feature','qpa_below_benchmark','value',round(f_qpa_bb,2),'contribution',round(public._w('qpa_below_benchmark')*f_qpa_bb,2)),
    jsonb_build_object('feature','demand_overreach','value',round(f_overreach,2),'contribution',round(public._w('demand_overreach')*f_overreach,2)),
    jsonb_build_object('feature','initiator_winrate','value',round(f_iwr,2),'contribution',round(public._w('initiator_winrate')*f_iwr,2)),
    jsonb_build_object('feature','nsa_ineligible_signal','value',f_nsa,'contribution',round(public._w('nsa_ineligible_signal')*f_nsa,2))
  );

  -- Official number on the dispute = CALIBRATED; predictions row keeps the RAW score.
  update public.disputes set win_prob = public.calibrated_win_prob(wp, g, 'v1') where id = d.id;
  insert into public.predictions (org_id, dispute_id, win_prob, recommended, recommended_offer, expected_value, drivers)
  values (g, d.id, wp, rec, offer, ev, drivers);

  return jsonb_build_object('ok',true,'dispute',d.external_ref,'win_prob',public.calibrated_win_prob(wp,g,'v1'),
    'win_prob_raw',wp,'recommended',rec,'recommended_offer',offer,'expected_value',ev,'drivers',drivers);
end $function$;

CREATE OR REPLACE FUNCTION public.model_calibration(p_org uuid, p_model_version text DEFAULT NULL, p_record boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_n int; v_base numeric; v_mean numeric; v_brier numeric; v_acc numeric; v_sep numeric;
  v_brier_cal numeric; v_acc_cal numeric; v_buckets jsonb; v_id uuid; v_recal jsonb;
begin
  if public.auth_org_id() is not null and p_org <> public.auth_org_id() then raise exception 'not authorized'; end if;

  with latest as (
    select distinct on (dispute_id) dispute_id, win_prob
    from public.predictions
    where org_id = p_org and (p_model_version is null or model_version is not distinct from p_model_version)
    order by dispute_id, created_at desc
  ),
  labeled as (
    select l.win_prob,
           public.calibrated_win_prob(l.win_prob, p_org, coalesce(p_model_version,'v1')) as cal,
           case when d.disposition in ('plan_win','eligibility_challenged') then 1
                when d.disposition = 'provider_win' then 0 end as actual
    from latest l join public.disputes d on d.id = l.dispute_id
    where d.disposition in ('plan_win','eligibility_challenged','provider_win') and l.win_prob is not null
  )
  select count(*), round(avg(actual),4), round(avg(win_prob),4),
         round(avg((win_prob - actual)^2),4),
         round(avg(case when (win_prob >= 0.5) = (actual = 1) then 1 else 0 end),4),
         round(coalesce(avg(win_prob) filter (where actual=1),0) - coalesce(avg(win_prob) filter (where actual=0),0),4),
         round(avg((cal - actual)^2),4),
         round(avg(case when (cal >= 0.5) = (actual = 1) then 1 else 0 end),4)
    into v_n, v_base, v_mean, v_brier, v_acc, v_sep, v_brier_cal, v_acc_cal
  from labeled;

  if coalesce(v_n,0) = 0 then
    return jsonb_build_object('ok',true,'n',0,'note','no terminal-outcome disputes with a prediction to score yet');
  end if;

  with latest as (
    select distinct on (dispute_id) dispute_id, win_prob from public.predictions
    where org_id = p_org and (p_model_version is null or model_version is not distinct from p_model_version)
    order by dispute_id, created_at desc
  ),
  labeled as (
    select l.win_prob,
           case when d.disposition in ('plan_win','eligibility_challenged') then 1
                when d.disposition = 'provider_win' then 0 end as actual
    from latest l join public.disputes d on d.id = l.dispute_id
    where d.disposition in ('plan_win','eligibility_challenged','provider_win') and l.win_prob is not null
  ),
  bucketed as (
    select least(3, floor(win_prob*4))::int as b, count(*) n, round(avg(win_prob),3) avg_pred, round(avg(actual),3) avg_actual
    from labeled group by 1
  )
  select jsonb_agg(jsonb_build_object('range',(b*25)||'-'||((b+1)*25)||'%','n',n,'avg_predicted',avg_pred,'avg_actual',avg_actual) order by b)
    into v_buckets from bucketed;

  select jsonb_build_object('a',a,'b',b,'accepted',accepted,'n',n,'log_loss_raw',log_loss_raw,'log_loss_calibrated',log_loss_cal,'fitted_at',fitted_at)
    into v_recal from public.model_calibration_params
   where org_id=p_org and version=coalesce(p_model_version,'v1') and active order by fitted_at desc limit 1;

  if p_record then
    insert into public.model_calibration_snapshots(org_id, model_version, n, base_rate, mean_pred, brier, accuracy, separation, buckets)
    values (p_org, coalesce(p_model_version,'v1'), v_n, v_base, v_mean, v_brier, v_acc, v_sep, v_buckets)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok',true,'model_version',coalesce(p_model_version,'v1'),'n',v_n,
    'base_rate',v_base,'mean_predicted',v_mean,
    'brier_score',v_brier,'accuracy_at_0_5',v_acc,'separation',v_sep,
    'brier_calibrated',v_brier_cal,'accuracy_calibrated',v_acc_cal,
    'recalibration', coalesce(v_recal, jsonb_build_object('accepted',false,'note','not fit yet — run refit_win_model')),
    'calibration_buckets',v_buckets,'recorded',p_record,'snapshot_id',v_id);
end $function$;
