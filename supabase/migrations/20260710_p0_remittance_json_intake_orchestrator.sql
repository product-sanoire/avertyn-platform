-- P0 #1 — Remittance JSON intake orchestrator
-- One call turns a payer remittance (JSON) into ingested lines + auto-routed, pre-filled NSA disputes.
--
-- intake_remittance(p_payload jsonb, p_plan uuid default null) does, in a single transaction:
--   1. inserts a remittances row (payer/plan/sponsor identifiers + raw payload retained),
--   2. for each line: inserts a remittance_lines row, computing nsa_signal via classify_nsa(carc,rarc),
--   3. routes each line via nsa_route(carc,rarc); for lines routing to
--      federal_idr / air_ambulance_idr / state_idr it auto-creates a pre-filled dispute
--      (cpt, dos, billed, paid->initial_payment, billed->demand, qpa, carc/rarc, payer reg #,
--       plan/sponsor legal names; workflow_state='intake', disposition='open', phase='open_negotiation'),
--      finds-or-creates the provider initiator, runs run_eligibility(dispute), and appends a
--      hash-chained action_log 'ingest' entry with rationale,
--   4. returns {ok, remittance_id, lines, nsa_eligible, disputes_created, routing:{<route>:count}}.
--
-- Idempotent per line via external_ref 'RMT-<remit_ref>-<cpt>-<n>' (skips if a dispute already exists).
-- Depends on existing: classify_nsa, nsa_route, run_eligibility, current_org, plans, remittances,
--   remittance_lines, disputes, initiators, action_log.
-- Verified 2026-07-11 on demo (ssjougrsaecdwfuxeasd): 4-line payload ->
--   routing {federal_idr:1, air_ambulance_idr:1, state_idr:1, review:1}, 3 disputes created,
--   eligibility_score computed on each, ledger entries written.

CREATE OR REPLACE FUNCTION public.intake_remittance(p_payload jsonb, p_plan uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_org();
  v_rem uuid; ln jsonb; v_plan uuid; v_init uuid; v_sig text; v_route jsonb;
  v_ref text; d_id uuid; v_cpt text; v_prov text;
  n_lines int := 0; n_elig int := 0; n_disp int := 0;
  route_counts jsonb := '{}'::jsonb; rk text;
begin
  v_plan := coalesce(p_plan, nullif(p_payload->>'plan_id','')::uuid,
                     (select id from public.plans where org_id = v_org order by created_at limit 1));

  insert into public.remittances(org_id, payer_name, payer_registration_number, plan_legal_name, sponsor_legal_name, remit_ref, remit_date, raw)
  values (v_org, p_payload->>'payer_name', p_payload->>'payer_registration_number', p_payload->>'plan_legal_name',
          p_payload->>'sponsor_legal_name', p_payload->>'remit_ref', nullif(p_payload->>'remit_date','')::date, p_payload)
  returning id into v_rem;

  for ln in select * from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) loop
    n_lines := n_lines + 1;
    v_cpt := ln->>'cpt'; v_prov := coalesce(ln->>'provider_name', p_payload->>'provider_name','Unknown');
    v_sig := public.classify_nsa(ln->>'carc', ln->>'rarc');

    insert into public.remittance_lines(org_id, remittance_id, provider_name, cpt, billed, paid, qpa, carc, rarc, nsa_signal, nsa_eligible)
    values (v_org, v_rem, v_prov, v_cpt, nullif(ln->>'billed','')::numeric, nullif(ln->>'paid','')::numeric,
            nullif(ln->>'qpa','')::numeric, ln->>'carc', ln->>'rarc', v_sig, v_sig='eligible');

    v_route := public.nsa_route(ln->>'carc', ln->>'rarc');
    rk := v_route->>'routing';
    route_counts := jsonb_set(route_counts, array[rk], to_jsonb(coalesce((route_counts->>rk)::int,0)+1), true);
    if v_sig = 'eligible' then n_elig := n_elig + 1; end if;

    -- auto-create a dispute for actionable OON routings
    if rk in ('federal_idr','air_ambulance_idr','state_idr') then
      v_ref := 'RMT-' || coalesce(p_payload->>'remit_ref','R') || '-' || coalesce(v_cpt,'X') || '-' || n_lines;
      if not exists (select 1 from public.disputes where org_id=v_org and external_ref=v_ref) then
        select id into v_init from public.initiators where name = v_prov;
        if v_init is null then
          insert into public.initiators(name, kind) values (v_prov,'provider_group')
          on conflict (name) do update set name=excluded.name returning id into v_init;
        end if;
        insert into public.disputes
          (org_id, plan_id, initiator_id, external_ref, cpt_code, service_category, service_date,
           billed_amount, initial_payment, demand_amount, qpa_amount, carc, rarc,
           idr_registration_number, plan_legal_name, sponsor_legal_name, workflow_state, disposition, phase)
        values
          (v_org, v_plan, v_init, v_ref, v_cpt, ln->>'service_category', nullif(ln->>'service_date','')::date,
           nullif(ln->>'billed','')::numeric, nullif(ln->>'paid','')::numeric, nullif(ln->>'billed','')::numeric,
           nullif(ln->>'qpa','')::numeric, ln->>'carc', ln->>'rarc',
           p_payload->>'payer_registration_number', p_payload->>'plan_legal_name', p_payload->>'sponsor_legal_name',
           'intake', 'open', 'open_negotiation')
        returning id into d_id;
        perform public.run_eligibility(d_id);
        n_disp := n_disp + 1;
        insert into public.action_log(org_id, dispute_id, action_type, actor, params, effect, rationale)
        values (v_org, d_id, 'ingest', 'system',
                jsonb_build_object('remittance', v_rem, 'cpt', v_cpt, 'rarc', ln->>'rarc'),
                jsonb_build_object('created_dispute', v_ref, 'routing', rk),
                'Auto-created from remittance line; NSA routing = '||rk||' ('||coalesce(v_route->>'category','')||').');
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'remittance_id', v_rem, 'lines', n_lines,
    'nsa_eligible', n_elig, 'disputes_created', n_disp, 'routing', route_counts);
end $function$;
