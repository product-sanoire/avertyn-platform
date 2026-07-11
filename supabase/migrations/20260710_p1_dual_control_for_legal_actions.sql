-- P1 governance: extend maker-checker dual-control from money actions to consequential LEGAL actions.
-- Before: only money_out actions (settle, schedule_payment) required dual-control; binding legal filings
-- (withdraw a case, submit an IDR response/offer, file to IDRE/CMS, select the arbitrator) could be
-- executed directly by a single authenticated user, and release_approval() had NO maker != checker check.
-- After: action_types.dual_control marks those actions; execute_action() routes them through the
-- approval queue for an authenticated caller; release_approval() enforces maker != checker (stager can't
-- self-approve). Demo/service (no auth) is exempt, consistent with the money path.
-- Verified on demo: request_action('withdraw', dispute) -> queued (staged_by=agent);
-- release_approval(id,'agent') -> maker_cannot_check; release_approval(id,'human') -> executed
-- (dual_control:true); replay -> not_pending.

ALTER TABLE public.action_types ADD COLUMN IF NOT EXISTS dual_control boolean NOT NULL DEFAULT false;
UPDATE public.action_types SET dual_control = true
 WHERE code IN ('withdraw','submit_response','submit_additional_info','file_submission','idr_push','select_idre');

CREATE OR REPLACE FUNCTION public.execute_action(p_action text, p_dispute uuid, p_params jsonb DEFAULT '{}'::jsonb, p_actor text DEFAULT 'agent'::text, p_idempotency text DEFAULT NULL::text, p_rationale text DEFAULT NULL::text, p_citations jsonb DEFAULT '[]'::jsonb, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; existing record; eff jsonb := '{}'::jsonb; amt numeric;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then return jsonb_build_object('ok',false,'reason','dispute_not_found'); end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized for this dispute'; end if;
  if not exists(select 1 from public.action_types where code = p_action) then return jsonb_build_object('ok',false,'reason','unknown_action'); end if;

  if public.auth_role() is not null and not public.can_action(p_action) then
    return jsonb_build_object('ok',false,'reason','forbidden','required_permission',public.action_perm(p_action),'role',public.auth_role());
  end if;

  if (select money_out from public.action_types where code=p_action)
     and public.auth_role() is not null and p_actor not like 'release:%' and not p_dry_run then
    return jsonb_build_object('ok',false,'reason','requires_dual_control',
      'hint','stage via request_action; a different user releases with release_money_action (step-up + amount confirm)');
  end if;

  -- Legal (non-money) actions marked dual_control also require maker-checker approval.
  if (select dual_control from public.action_types where code=p_action)
     and public.auth_role() is not null and p_actor not like 'release:%' and not p_dry_run then
    return jsonb_build_object('ok',false,'reason','requires_approval',
      'hint','stage via request_action; a different user approves with release_approval (maker-checker)');
  end if;

  if p_idempotency is not null and not p_dry_run then
    select * into existing from public.action_log where idempotency_key = p_idempotency limit 1;
    if found then return jsonb_build_object('ok',true,'idempotent',true,'action',p_action,'effect',existing.effect); end if;
  end if;

  if p_action = 'triage' then
    if not p_dry_run then update public.disputes set workflow_state='eligibility_review' where id=p_dispute and workflow_state='intake'; end if;
    eff := jsonb_build_object('workflow_state','eligibility_review');
  elsif p_action = 'challenge_eligibility' then
    if coalesce(d.eligibility_score,0) < 80 then return jsonb_build_object('ok',false,'reason','eligibility_below_threshold','score',d.eligibility_score); end if;
    if not p_dry_run then
      insert into public.documents(org_id,dispute_id,kind,title,generated) values(d.org_id,d.id,'challenge_letter','Eligibility challenge — '||coalesce(d.external_ref,'dispute'),true);
      update public.disputes set workflow_state='closed', disposition='eligibility_challenged' where id=p_dispute;
    end if;
    eff := jsonb_build_object('workflow_state','closed','disposition','eligibility_challenged','document','challenge_letter');
  elsif p_action = 'defend_qpa' then
    if not p_dry_run then update public.disputes set workflow_state='qpa_defense' where id=p_dispute; end if;
    eff := jsonb_build_object('workflow_state','qpa_defense');
  elsif p_action = 'open_negotiation' then
    amt := coalesce(nullif(p_params->>'amount','')::numeric, round(coalesce(d.qpa_amount,0) * 1.25));
    if amt is null or amt = 0 then return jsonb_build_object('ok',false,'reason','no_amount'); end if;
    if not p_dry_run then
      insert into public.offers(org_id,dispute_id,party,kind,amount,note)
        values(d.org_id,d.id,'plan','open_negotiation',amt,'Open-negotiation offer via '||p_actor);
      update public.disputes set workflow_state='qpa_defense'
        where id=p_dispute and workflow_state in ('intake','triage','eligibility_review');
    end if;
    eff := jsonb_build_object('stage','open_negotiation','offer_amount',amt);
  elsif p_action = 'submit_response' then
    amt := coalesce((p_params->>'amount')::numeric, d.qpa_amount);
    if amt is null then return jsonb_build_object('ok',false,'reason','no_amount'); end if;
    if not p_dry_run then
      insert into public.offers(org_id,dispute_id,party,kind,amount,note) values(d.org_id,d.id,'plan','idr_offer',amt,'Submitted via '||p_actor);
      update public.disputes set workflow_state='awaiting_determination' where id=p_dispute;
    end if;
    eff := jsonb_build_object('workflow_state','awaiting_determination','offer_amount',amt);
  elsif p_action = 'submit_additional_info' then
    if not p_dry_run then
      insert into public.documents(org_id,dispute_id,kind,title,generated)
        values(d.org_id,d.id,'additional_info','Additional information — '||coalesce(d.external_ref,'dispute'),true);
    end if;
    eff := jsonb_build_object('document','additional_info','window','5_business_day');
  elsif p_action = 'request_extension' then
    eff := jsonb_build_object('requested','extension','note',coalesce(p_params->>'note','Extension requested.'));
  elsif p_action = 'withdraw' then
    if not p_dry_run then update public.disputes set workflow_state='closed', disposition='withdrawn' where id=p_dispute; end if;
    eff := jsonb_build_object('workflow_state','closed','disposition','withdrawn');
  elsif p_action = 'escalate' then
    if not p_dry_run then
      insert into public.notifications(org_id,dispute_id,kind,title,body,severity,read)
        values(d.org_id,d.id,'escalation','Escalation — '||coalesce(d.external_ref,'dispute'),coalesce(p_params->>'note','Human review requested by '||p_actor||'.'),'urgent',false);
    end if;
    eff := jsonb_build_object('escalated',true);
  elsif p_action = 'idr_push' then
    eff := jsonb_build_object('pushed',true,'note',coalesce(p_params->>'note','Staged artifact pushed to CMS IDR Gateway.'));
  elsif p_action = 'predict_outcome' then
    if p_dry_run then eff := jsonb_build_object('note','would run win-probability & optimal-offer model');
    else eff := public.predict_win(p_dispute); end if;
  elsif p_action = 'generate_document' then
    if not p_dry_run then perform public.generate_document(p_dispute, coalesce(nullif(p_params->>'kind',''),'position_statement')); end if;
    eff := jsonb_build_object('document', coalesce(nullif(p_params->>'kind',''),'position_statement'), 'generated', not p_dry_run);
  elsif p_action = 'notify' then
    if not p_dry_run then
      insert into public.notifications(org_id,dispute_id,kind,title,body,severity,read)
        values(d.org_id,d.id,'agent_notify',coalesce(nullif(p_params->>'title',''),'Avertyn — '||coalesce(d.external_ref,'dispute')),coalesce(p_params->>'body',''),coalesce(nullif(p_params->>'severity',''),'info'),false);
    end if;
    eff := jsonb_build_object('notified',true);
  elsif p_action = 'idr_sync_in' then
    eff := jsonb_build_object('note','Gateway events fold in via idr_reconcile_event.');
  elsif p_action = 'schedule_payment' then
    if not p_dry_run then
      update public.awards set payment_status='scheduled' where dispute_id=p_dispute and payment_status <> 'paid';
      update public.disputes set workflow_state='award_payment' where id=p_dispute;
    end if;
    eff := jsonb_build_object('workflow_state','award_payment','payment','scheduled');
  elsif p_action = 'settle' then
    amt := nullif(p_params->>'amount','')::numeric;
    if not p_dry_run then update public.disputes set workflow_state='closed', disposition='settled' where id=p_dispute; end if;
    eff := jsonb_build_object('workflow_state','closed','disposition','settled','amount',amt);
  elsif p_action = 'ingest' then
    eff := jsonb_build_object('note','ingest handled by create_dispute_from_claim');
  else
    return jsonb_build_object('ok',false,'reason','unhandled_action');
  end if;

  if p_dry_run then
    return jsonb_build_object('ok',true,'dry_run',true,'action',p_action,'would',eff,'rationale',p_rationale);
  end if;

  insert into public.action_log(org_id,dispute_id,action_type,actor,params,effect,idempotency_key,rationale,citations)
    values(d.org_id,p_dispute,p_action,p_actor,coalesce(p_params,'{}'::jsonb),eff,p_idempotency,p_rationale,coalesce(p_citations,'[]'::jsonb));
  insert into public.audit_log(org_id,dispute_id,action,detail)
    values(d.org_id,p_dispute,'action:'||p_action,eff);

  return jsonb_build_object('ok',true,'action',p_action,'actor',p_actor,'effect',eff,'rationale',p_rationale);
end $function$;

CREATE OR REPLACE FUNCTION public.release_approval(p_id uuid, p_actor text DEFAULT 'human'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q record; money boolean; checker text; res jsonb;
begin
  select * into q from public.approval_queue where id=p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and q.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if q.status <> 'pending' then return jsonb_build_object('ok',false,'reason','not_pending'); end if;
  select money_out into money from public.action_types where code=q.action_type;
  if coalesce(money,false) then
    return jsonb_build_object('ok',false,'reason','money_action_requires_dual_control','hint','use release_money_action with step-up + amount confirmation');
  end if;

  -- Maker cannot check their own staged action (dual-control for legal actions).
  checker := coalesce(auth.uid()::text, p_actor);
  if q.staged_by is not null and q.staged_by = checker then
    return jsonb_build_object('ok',false,'reason','maker_cannot_check');
  end if;

  res := public.execute_action(q.action_type, q.dispute_id, q.params, 'release:'||p_actor,
                               q.dispute_id::text||':'||q.action_type||':approved');
  update public.approval_queue set status='executed', decided_at=now(), decided_by=p_actor where id=p_id;
  return jsonb_build_object('ok',true,'dual_control',true,'result',res);
end $function$;
