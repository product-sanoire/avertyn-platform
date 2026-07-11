-- P1 outcome-learning loop (part 1): recalibrate the win-probability model from realized outcomes.
-- model_calibration MEASURES predict_win; this makes the model LEARN. With small n a full coefficient
-- refit overfits, so we fit a 2-parameter Platt recalibration p_cal = sigmoid(A*logit(p_raw)+B) on the
-- model's own outputs vs realized plan-win labels. Accepted only if it improves log-loss on >= min_n
-- labeled cases; else identity (A=1,B=0). It recovers the raw logit from the stored win_prob, so no
-- feature re-extraction is needed. Verified on demo (n=11): A=1.29,B=0.28, log-loss 0.5454→0.5408, accepted.

CREATE TABLE IF NOT EXISTS public.model_calibration_params (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.orgs(id),
  version       text NOT NULL DEFAULT 'v1',
  a             numeric NOT NULL DEFAULT 1,
  b             numeric NOT NULL DEFAULT 0,
  n             integer NOT NULL DEFAULT 0,
  log_loss_raw  numeric,
  log_loss_cal  numeric,
  accepted      boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT false,
  fitted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_active_idx ON public.model_calibration_params(org_id, version, active);
ALTER TABLE public.model_calibration_params ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_read ON public.model_calibration_params;
CREATE POLICY mcp_read ON public.model_calibration_params FOR SELECT
  USING (public.auth_org_id() is null or org_id = public.current_org());

CREATE OR REPLACE FUNCTION public.calibrated_win_prob(p_raw numeric, p_org uuid, p_version text DEFAULT 'v1')
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with p as (
    select a, b from public.model_calibration_params
    where org_id = p_org and version = p_version and active and accepted
    order by fitted_at desc limit 1
  ), r as (select least(0.999, greatest(0.001, coalesce(p_raw,0.5))) as pr)
  select coalesce(
    (select round((1.0/(1.0+exp(-( a * ln(r.pr/(1-r.pr)) + b ))))::numeric, 4) from p, r),
    round(p_raw,4));
$function$;

CREATE OR REPLACE FUNCTION public.refit_win_model(p_org uuid, p_version text DEFAULT 'v1', p_min_n int DEFAULT 8)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  z numeric[]; y numeric[]; n int; k int; it int;
  A numeric := 1; B numeric := 0; ga numeric; gb numeric; p numeric; lr numeric := 0.08;
  ll_raw numeric := 0; ll_cal numeric := 0; pr numeric; accept boolean := false; v_id uuid;
begin
  if public.auth_org_id() is not null and p_org <> public.auth_org_id() then raise exception 'not authorized'; end if;

  with latest as (
    select distinct on (dispute_id) dispute_id, win_prob
    from public.predictions
    where org_id = p_org and win_prob is not null
    order by dispute_id, created_at desc
  ),
  labeled as (
    select least(0.999, greatest(0.001, l.win_prob)) as praw,
           case when d.disposition in ('plan_win','eligibility_challenged') then 1
                when d.disposition = 'provider_win' then 0 end as yv
    from latest l join public.disputes d on d.id = l.dispute_id
    where d.disposition in ('plan_win','eligibility_challenged','provider_win')
  )
  select array_agg(ln(praw/(1-praw))), array_agg(yv) into z, y from labeled;

  n := coalesce(array_length(z,1),0);
  if n < p_min_n then
    return jsonb_build_object('ok', true, 'n', n, 'accepted', false, 'reason', 'insufficient_labeled_outcomes', 'min_n', p_min_n);
  end if;

  for it in 1..800 loop
    ga := 0; gb := 0;
    for k in 1..n loop
      p := 1.0/(1.0+exp(-(A*z[k]+B)));
      ga := ga + (p - y[k]) * z[k];
      gb := gb + (p - y[k]);
    end loop;
    A := A - lr*ga/n; B := B - lr*gb/n;
  end loop;

  for k in 1..n loop
    pr := least(0.999, greatest(0.001, 1.0/(1.0+exp(-(z[k])))));
    ll_raw := ll_raw - (y[k]*ln(pr) + (1-y[k])*ln(1-pr));
    pr := least(0.999, greatest(0.001, 1.0/(1.0+exp(-(A*z[k]+B)))));
    ll_cal := ll_cal - (y[k]*ln(pr) + (1-y[k])*ln(1-pr));
  end loop;
  ll_raw := round(ll_raw/n,4); ll_cal := round(ll_cal/n,4);
  accept := ll_cal < ll_raw;

  update public.model_calibration_params set active=false where org_id=p_org and version=p_version and active;
  insert into public.model_calibration_params(org_id, version, a, b, n, log_loss_raw, log_loss_cal, accepted, active)
  values (p_org, p_version, round(A,4), round(B,4), n, ll_raw, ll_cal, accept, accept)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'n', n, 'a', round(A,4), 'b', round(B,4),
    'log_loss_raw', ll_raw, 'log_loss_calibrated', ll_cal, 'accepted', accept,
    'improvement', round(ll_raw - ll_cal, 4), 'snapshot', v_id);
end $function$;
