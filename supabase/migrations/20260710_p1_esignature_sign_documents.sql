-- P1 e-signature: turn the esign_status/signed_by/signed_at scaffolding into a real signing action.
-- A signature captures signer identity + intent + timestamp and computes a tamper-seal binding all of
-- those to the document's content hash: seal = sha256(content_sha | signer | signed_at_epoch | intent).
-- The seal + inputs are written to the append-only audit_log, so a signature is independently verifiable
-- and any later content change breaks it. Org-scoped; idempotent (won't re-sign an already-signed doc).
-- Verified on demo: signed review_documents letter (signer 'Dr. J. Okafor, Medical Director') ->
-- esign_status='signed'; re-sign -> already_signed; audit seal recomputes == true.
-- UI: app/programs/page.js CaseDetail letters list gains a "Sign" button + shows "✍ <signer>".

-- Determination letters (review_documents).
CREATE OR REPLACE FUNCTION public.sign_review_document(p_id uuid, p_signer text DEFAULT NULL, p_intent text DEFAULT 'I approve and issue this determination.')
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
declare r record; v_signer text; v_ts timestamptz := now(); v_seal text;
begin
  select * into r from public.review_documents where id = p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and r.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if r.esign_status = 'signed' then
    return jsonb_build_object('ok',false,'reason','already_signed','signed_by',r.signed_by,'signed_at',r.signed_at);
  end if;
  v_signer := coalesce(nullif(p_signer,''), (select email from public.app_users where id = auth.uid()), 'Authorized Representative');
  v_seal := encode(extensions.digest(
    coalesce(r.sha256,'') || '|' || v_signer || '|' || extract(epoch from v_ts)::bigint::text || '|' || coalesce(p_intent,''),
    'sha256'),'hex');
  update public.review_documents set esign_status='signed', signed_by=v_signer, signed_at=v_ts where id=p_id;
  insert into public.audit_log(org_id, dispute_id, action, detail)
    values (r.org_id, null, 'esign:review_document',
            jsonb_build_object('document',p_id,'review_case',r.review_case_id,'signer',v_signer,
                               'intent',p_intent,'content_sha256',r.sha256,'seal',v_seal,'signed_at',v_ts));
  return jsonb_build_object('ok',true,'document_id',p_id,'signer',v_signer,'signed_at',v_ts,'seal',v_seal);
end $function$;

-- Dispute documents (documents). Backfills content sha256 if it was never computed.
CREATE OR REPLACE FUNCTION public.sign_document(p_id uuid, p_signer text DEFAULT NULL, p_intent text DEFAULT 'I approve and authorize this document.')
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
declare r record; v_signer text; v_ts timestamptz := now(); v_seal text; v_sha text;
begin
  select * into r from public.documents where id = p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and r.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if r.esign_status = 'signed' then
    return jsonb_build_object('ok',false,'reason','already_signed','signed_by',r.signed_by,'signed_at',r.signed_at);
  end if;
  v_sha := coalesce(r.sha256, encode(extensions.digest(coalesce(r.content,''),'sha256'),'hex'));
  v_signer := coalesce(nullif(p_signer,''), (select email from public.app_users where id = auth.uid()), 'Authorized Representative');
  v_seal := encode(extensions.digest(
    v_sha || '|' || v_signer || '|' || extract(epoch from v_ts)::bigint::text || '|' || coalesce(p_intent,''),
    'sha256'),'hex');
  update public.documents set esign_status='signed', signed_by=v_signer, signed_at=v_ts,
         sha256=coalesce(sha256, v_sha) where id=p_id;
  insert into public.audit_log(org_id, dispute_id, action, detail)
    values (r.org_id, r.dispute_id, 'esign:document',
            jsonb_build_object('document',p_id,'signer',v_signer,'intent',p_intent,
                               'content_sha256',v_sha,'seal',v_seal,'signed_at',v_ts));
  return jsonb_build_object('ok',true,'document_id',p_id,'signer',v_signer,'signed_at',v_ts,'seal',v_seal);
end $function$;
