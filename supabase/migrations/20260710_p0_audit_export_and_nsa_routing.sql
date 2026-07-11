-- P0 #8: exportable, verifiable audit trail + retention over the hash-chained action_log.
-- P0 #2: CARC/RARC classifier → actionable federal/state/air-ambulance routing.
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10.

INSERT INTO public.regulatory_config(key, value, note)
SELECT 'audit_retention_years', '6'::jsonb, 'HIPAA-aligned minimum retention for the audit trail (action_log is append-only + hash-chained).'
WHERE NOT EXISTS (SELECT 1 FROM public.regulatory_config WHERE key='audit_retention_years');

CREATE OR REPLACE FUNCTION public.audit_export(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit int DEFAULT 5000)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_org uuid := public.current_org(); v_ver jsonb; v_ret int; v_entries jsonb; v_count int;
begin
  v_ver := public.verify_ledger(v_org);
  select coalesce((value#>>'{}')::int, 6) into v_ret from public.regulatory_config where key='audit_retention_years';
  select coalesce(jsonb_agg(e ORDER BY (e->>'created_at')), '[]'::jsonb), count(*)
    into v_entries, v_count
  from (
    select jsonb_build_object(
      'id', a.id, 'created_at', a.created_at, 'action', a.action_type, 'actor', a.actor,
      'dispute_ref', d.external_ref, 'rationale', a.rationale, 'citations', a.citations,
      'params', a.params, 'effect', a.effect, 'prev_hash', a.prev_hash, 'row_hash', a.row_hash) AS e
    from public.action_log a
    left join public.disputes d on d.id = a.dispute_id
    where a.org_id = v_org
      and (p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at <= p_to)
    order by a.created_at, a.id
    limit greatest(coalesce(p_limit,5000),1)
  ) t;
  return jsonb_build_object('org', v_org, 'generated_at', now(), 'retention_years', coalesce(v_ret,6),
    'ledger_verified', v_ver, 'from', p_from, 'to', p_to, 'count', coalesce(v_count,0), 'entries', v_entries);
end $function$;
GRANT EXECUTE ON FUNCTION public.audit_export(timestamptz, timestamptz, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.nsa_route(p_carc text, p_rarc text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_sig text; v_cat text; v_route text; v_desc text;
begin
  v_sig := public.classify_nsa(p_carc, p_rarc);
  select description into v_desc from public.carc_rarc_codes where code = coalesce(p_rarc, p_carc) limit 1;
  v_cat := case
    when p_rarc = 'N866' then 'air_ambulance'
    when p_rarc = 'N864' then 'emergency'
    when p_rarc = 'N865' then 'nonemergency_participating_facility'
    when p_rarc in ('N867','N871','N872') then 'state_law'
    when p_rarc = 'N874' then 'open_negotiation_final'
    when p_rarc = 'N875' then 'idr_final'
    when p_rarc in ('N859','N830','N876','N877') then 'nsa_out_of_network'
    else 'unspecified' end;
  v_route := case
    when v_cat = 'air_ambulance' then 'air_ambulance_idr'
    when v_cat = 'state_law' then 'state_idr'
    when v_cat in ('emergency','nonemergency_participating_facility','nsa_out_of_network') then 'federal_idr'
    when v_cat in ('open_negotiation_final','idr_final') then 'resolved'
    when v_sig = 'eligible' then 'federal_idr'
    when v_sig = 'ineligible' then 'not_eligible'
    else 'review' end;
  return jsonb_build_object('signal', v_sig, 'category', v_cat, 'routing', v_route,
    'rarc_code', coalesce(p_rarc, p_carc), 'description', v_desc);
end $function$;
GRANT EXECUTE ON FUNCTION public.nsa_route(text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.nsa_classify_dispute(p_dispute uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare d record; res jsonb;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  res := public.nsa_route(d.carc, d.rarc);
  return res || jsonb_build_object('dispute_id', p_dispute, 'carc', d.carc, 'rarc', d.rarc);
end $function$;
GRANT EXECUTE ON FUNCTION public.nsa_classify_dispute(uuid) TO anon, authenticated;
