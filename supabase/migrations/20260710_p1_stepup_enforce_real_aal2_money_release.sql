-- P1 agent-governance hardening: make money-action step-up a REAL elevated session, not a flag.
-- Before: release_money_action() gated on the client-supplied boolean p_stepup and only read the
-- JWT aal claim for display. An authenticated user could self-attest step-up without MFA.
-- After: authenticated releasers must present a genuine AAL2 (MFA-elevated) session; service/agent/
-- demo callers (no JWT) keep the explicit p_stepup intent flag, consistent with the kernel's other
-- `auth.uid()/auth_role() is not null` gates. Maker-checker, amount-confirm, and autonomy caps unchanged.
--
-- Verified on demo: request_action('settle', dispute, 500) → queued; release with no step-up →
-- step_up_required; wrong amount → step_up_required (step-up checked first); step-up + amount 500 →
-- executed (dual_control:true, step_up:true); replay → not_pending. Authenticated AAL2 path enforced
-- via auth_aal() (untestable without a live MFA JWT, but gated on auth.uid() is not null).

-- Reusable AAL accessor (mirrors auth_role/auth_org_id; reads the request JWT's aal claim).
CREATE OR REPLACE FUNCTION public.auth_aal()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select auth.jwt() ->> 'aal' $function$;

CREATE OR REPLACE FUNCTION public.release_money_action(p_id uuid, p_actor text DEFAULT 'human'::text, p_confirm_amount numeric DEFAULT NULL::numeric, p_stepup boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q record; money boolean; maxa numeric; checker text; res jsonb;
begin
  select * into q from public.approval_queue where id=p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and q.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if q.status <> 'pending' then return jsonb_build_object('ok',false,'reason','not_pending'); end if;
  select money_out into money from public.action_types where code=q.action_type;
  if not coalesce(money,false) then return jsonb_build_object('ok',false,'reason','not_a_money_action','hint','use release_approval'); end if;

  checker := coalesce(auth.uid()::text, p_actor);
  if q.staged_by is not null and q.staged_by = checker then
    return jsonb_build_object('ok',false,'reason','maker_cannot_check');
  end if;

  -- Step-up must be a REAL elevated (MFA / AAL2) session for authenticated end-users, not a
  -- self-attested boolean. Service/agent/demo callers (no JWT) keep the explicit-intent path.
  if auth.uid() is not null then
    if public.auth_aal() is distinct from 'aal2' then
      return jsonb_build_object('ok',false,'reason','step_up_required',
        'hint','complete MFA to elevate this session to AAL2 before releasing a money action',
        'aal', coalesce(public.auth_aal(),'aal1'));
    end if;
  elsif not p_stepup then
    return jsonb_build_object('ok',false,'reason','step_up_required');
  end if;

  if p_confirm_amount is null or p_confirm_amount <> coalesce(q.amount,-1) then
    return jsonb_build_object('ok',false,'reason','amount_mismatch','expected',q.amount);
  end if;
  select max_amount into maxa from public.autonomy_settings where org_id=q.org_id and action_type=q.action_type;
  if maxa is not null and q.amount is not null and q.amount > maxa then
    return jsonb_build_object('ok',false,'reason','over_cap','cap',maxa);
  end if;

  res := public.execute_action(q.action_type, q.dispute_id, q.params, 'release:'||p_actor,
                               q.dispute_id::text||':'||q.action_type||':approved', q.rationale, '[]'::jsonb, false);
  update public.approval_queue set status='executed', decided_at=now(), decided_by=p_actor where id=p_id;
  return jsonb_build_object('ok',true,'dual_control',true,'step_up',true,'aal',coalesce(public.auth_aal(),'aal1'),'result',res);
end $function$;
