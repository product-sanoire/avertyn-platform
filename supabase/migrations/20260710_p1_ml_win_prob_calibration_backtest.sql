-- P1 ML productionization: measure the win-probability model against realized outcomes.
-- predict_win writes predictions but nothing ever scored them, so the model was unmeasurable (can't
-- productionize what you can't measure). This adds a backtest: for disputes with a terminal outcome,
-- compare the latest predicted win_prob against the realized plan-win label and report Brier score,
-- accuracy, discrimination (separation), base rate, and calibration buckets — optionally snapshotting
-- the summary so accuracy/drift is trackable across model versions over time.
--
-- Label (plan prevailed): disposition plan_win|eligibility_challenged => 1; provider_win => 0;
-- settled/withdrawn/open are excluded (non-terminal or not a clean win/loss).
--
-- Verified on demo (n=11): base_rate 0.45, mean_predicted 0.43 (well-calibrated on average),
-- brier 0.188 (< 0.25 coin-flip → real skill), accuracy@0.5 0.73, separation +0.23 (discriminating);
-- buckets 25-50% pred 0.324/actual 0.333, 75-100% pred 0.93/actual 1.0. Snapshot recorded.

CREATE TABLE IF NOT EXISTS public.model_calibration_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.orgs(id),
  model_version text,
  n             integer NOT NULL,
  base_rate     numeric,
  mean_pred     numeric,
  brier         numeric,
  accuracy      numeric,
  separation    numeric,
  buckets       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.model_calibration_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcs_read ON public.model_calibration_snapshots;
CREATE POLICY mcs_read ON public.model_calibration_snapshots FOR SELECT
  USING (public.auth_org_id() is null or org_id = public.auth_org_id());

CREATE OR REPLACE FUNCTION public.model_calibration(p_org uuid, p_model_version text DEFAULT NULL, p_record boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_n int; v_base numeric; v_mean numeric; v_brier numeric; v_acc numeric; v_sep numeric;
  v_buckets jsonb; v_id uuid;
begin
  if public.auth_org_id() is not null and p_org <> public.auth_org_id() then raise exception 'not authorized'; end if;

  with latest as (
    select distinct on (dispute_id) dispute_id, win_prob, model_version
    from public.predictions
    where org_id = p_org and (p_model_version is null or model_version is not distinct from p_model_version)
    order by dispute_id, created_at desc
  ),
  labeled as (
    select l.win_prob,
           case when d.disposition in ('plan_win','eligibility_challenged') then 1
                when d.disposition = 'provider_win' then 0 end as actual
    from latest l join public.disputes d on d.id = l.dispute_id
    where d.disposition in ('plan_win','eligibility_challenged','provider_win')
      and l.win_prob is not null
  )
  select count(*),
         round(avg(actual),4),
         round(avg(win_prob),4),
         round(avg((win_prob - actual)^2),4),
         round(avg(case when (win_prob >= 0.5) = (actual = 1) then 1 else 0 end),4),
         round(coalesce(avg(win_prob) filter (where actual=1),0) - coalesce(avg(win_prob) filter (where actual=0),0),4)
    into v_n, v_base, v_mean, v_brier, v_acc, v_sep
  from labeled;

  if coalesce(v_n,0) = 0 then
    return jsonb_build_object('ok',true,'n',0,'note','no terminal-outcome disputes with a prediction to score yet');
  end if;

  with latest as (
    select distinct on (dispute_id) dispute_id, win_prob
    from public.predictions
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
  select jsonb_agg(jsonb_build_object(
           'range', (b*25)||'-'||((b+1)*25)||'%', 'n', n, 'avg_predicted', avg_pred, 'avg_actual', avg_actual)
           order by b)
    into v_buckets from bucketed;

  if p_record then
    insert into public.model_calibration_snapshots(org_id, model_version, n, base_rate, mean_pred, brier, accuracy, separation, buckets)
    values (p_org, coalesce(p_model_version,'v1'), v_n, v_base, v_mean, v_brier, v_acc, v_sep, v_buckets)
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'model_version', coalesce(p_model_version,'v1'), 'n', v_n,
    'base_rate', v_base, 'mean_predicted', v_mean,
    'brier_score', v_brier,               -- lower is better; 0=perfect, 0.25=coin flip at 50%
    'accuracy_at_0_5', v_acc,
    'separation', v_sep,                  -- avg pred on wins minus avg pred on losses; >0 = discriminating
    'calibration_buckets', v_buckets,
    'recorded', p_record, 'snapshot_id', v_id);
end $function$;
