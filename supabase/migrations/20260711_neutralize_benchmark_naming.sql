-- Neutralize FAIR Health-specific benchmark naming -> source-agnostic "regional".
-- Renames the two benchmark columns and repoints every function, plus the one
-- letter clause that named FAIR Health as the corroborating source (the app is no
-- longer sourcing FAIR Health data, so the copy is corrected to "regional benchmark").
-- Guarded/idempotent: safe to run on the live DB (where benchmarks.fair_health was
-- already renamed) and on a fresh checkout (where both old columns still exist).

-- 1) Column renames (guarded) -------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='benchmarks' and column_name='fair_health') then
    alter table public.benchmarks rename column fair_health to regional_median;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='qpa_records' and column_name='benchmark_fairhealth') then
    alter table public.qpa_records rename column benchmark_fairhealth to benchmark_regional;
  end if;
end $$;

-- 2) compute_qpa_defense: read regional_median, write benchmark_regional --------
CREATE OR REPLACE FUNCTION public.compute_qpa_defense(p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; b record; qpa numeric; ceil numeric; overreach numeric; gap_pct numeric; pct numeric;
begin
  select * into d from public.disputes where id=p_dispute;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  select * into b from public.benchmarks where cpt = d.cpt_code;
  if not found then return jsonb_build_object('ok',false,'reason','no_benchmark','cpt',d.cpt_code); end if;
  select (value#>>'{}')::numeric into pct from public.regulatory_config where key='defensible_ceiling_pct_of_qpa';
  pct := coalesce(pct,125);

  qpa  := coalesce(d.qpa_amount, round(b.medicare * 1.5, 2));
  ceil := coalesce(d.ceiling_override, least(round(qpa * pct/100.0, 2), round(b.regional_median, 2)));
  overreach := round(coalesce(d.demand_amount, b.regional_median) - qpa, 2);
  gap_pct   := case when qpa > 0 then round((coalesce(d.demand_amount, b.regional_median) - qpa) / qpa * 100, 0) else null end;

  if d.qpa_amount is null then update public.disputes set qpa_amount = qpa where id = p_dispute; end if;

  delete from public.qpa_records where dispute_id = p_dispute;
  insert into public.qpa_records (org_id, dispute_id, plan_qpa, methodology, benchmark_regional, benchmark_medicare_mult, contracted_median, defensible_ceiling, indexing_current, notes)
  values (d.org_id, p_dispute, qpa,
          case when d.ceiling_override is not null then 'manual_ceiling' else 'pct_of_qpa_'||pct::text end,
          b.regional_median, round(b.medicare*3,2), qpa, ceil, true,
          'Ceiling = '||case when d.ceiling_override is not null then 'manual override' else pct::text||'% of QPA' end||
          ', capped at regional median. Demand exceeds QPA by '||coalesce(gap_pct,0)||'%.');

  return jsonb_build_object('ok',true,'plan_qpa',qpa,'medicare',b.medicare,'regional_median',b.regional_median,
    'defensible_ceiling',ceil,'ceiling_basis',case when d.ceiling_override is not null then 'manual' else pct::text||'% of QPA' end,
    'initiator_overreach',overreach,'demand_vs_qpa_pct',gap_pct);
end $function$;

-- 3) predict_win: read regional_median -----------------------------------------
CREATE OR REPLACE FUNCTION public.predict_win(p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  -- features
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
  f_iwr := case when itotal >= 2 then iwins::numeric/itotal else 0.55 end;  -- prior: providers win ~55-60%
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
  wp := round((1.0/(1.0+exp(-z)))::numeric, 4);

  -- optimal offer (baseball arbitration: lowest defensible number that still holds)
  ceil := coalesce((select defensible_ceiling from public.qpa_records where dispute_id=d.id order by created_at desc limit 1),
                   coalesce(fair, d.qpa_amount*1.25));
  offer := round(least(ceil, coalesce(d.qpa_amount,0) * (1 + (1-wp)*0.15)), 0);
  -- expected plan cost: win -> pay offer; lose -> pay demand. Savings vs paying demand.
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

  update public.disputes set win_prob = wp where id = d.id;
  insert into public.predictions (org_id, dispute_id, win_prob, recommended, recommended_offer, expected_value, drivers)
  values (g, d.id, wp, rec, offer, ev, drivers);

  return jsonb_build_object('ok',true,'dispute',d.external_ref,'win_prob',wp,'recommended',rec,
    'recommended_offer',offer,'expected_value',ev,'drivers',drivers);
end $function$;

-- 4) build_doc_context: regional benchmark row + money.regional key -------------
CREATE OR REPLACE FUNCTION public.build_doc_context(p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; q record; ctx jsonb; fmt_money text := 'FM$999,999,990'; bench text;
  ex record; exi int := 0; ex_html text := ''; exhibits text := ''; cite_obj jsonb;
  cl record; claims_tbl text := ''; claims_list text := ''; ccount int := 0; cbilled numeric := 0;
  disp_num text; claim_num text; ref_num text; ref_lbl text;
begin
  select di.*, pl.name as plan_name, em.name as employer_name, io.name as initiator_name, og.name as org_name
    into d
  from disputes di
  left join plans pl on pl.id = di.plan_id
  left join employers em on em.id = di.employer_id
  left join initiators io on io.id = di.initiator_id
  left join orgs og on og.id = di.org_id
  where di.id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  select * into q from qpa_records where dispute_id = p_dispute order by created_at desc limit 1;
  bench := '<table class="bench"><thead><tr><th>Reference</th><th>Amount</th></tr></thead><tbody>';
  if coalesce(d.qpa_amount, q.plan_qpa) is not null then bench := bench || '<tr><td>Plan Qualifying Payment Amount (QPA)</td><td>' || to_char(coalesce(d.qpa_amount,q.plan_qpa), fmt_money) || '</td></tr>'; end if;
  if q.contracted_median is not null then bench := bench || '<tr><td>Plan median contracted rate</td><td>' || to_char(q.contracted_median, fmt_money) || '</td></tr>'; end if;
  if q.benchmark_regional is not null then bench := bench || '<tr><td>Regional benchmark</td><td>' || to_char(q.benchmark_regional, fmt_money) || '</td></tr>'; end if;
  if q.benchmark_medicare_mult is not null then bench := bench || '<tr><td>Medicare-based reference</td><td>' || to_char(q.benchmark_medicare_mult, fmt_money) || '</td></tr>'; end if;
  if q.defensible_ceiling is not null then bench := bench || '<tr><td>Defensible ceiling (max concession)</td><td>' || to_char(q.defensible_ceiling, fmt_money) || '</td></tr>'; end if;
  if d.demand_amount is not null then bench := bench || '<tr><td>Initiating party demand</td><td>' || to_char(d.demand_amount, fmt_money) || '</td></tr>'; end if;
  bench := bench || '</tbody></table>';

  claims_tbl := '<table class="bench"><thead><tr><th>Claim number</th><th>CPT</th><th>Date of service</th><th>Billed</th></tr></thead><tbody>';
  for cl in select external_claim_id, cpt_code, service_date, billed_total from claims where dispute_id = p_dispute order by created_at loop
    ccount := ccount + 1;
    claims_tbl := claims_tbl || '<tr><td>' || coalesce(nullif(cl.external_claim_id,''), '(unnumbered claim ' || ccount || ')')
      || '</td><td>' || coalesce(cl.cpt_code,'—')
      || '</td><td>' || case when cl.service_date is null then '—' else to_char(cl.service_date, 'FMMon FMDD, YYYY') end
      || '</td><td>' || case when cl.billed_total is null then '—' else to_char(cl.billed_total, fmt_money) end || '</td></tr>';
    if coalesce(nullif(cl.external_claim_id,''),'') <> '' then
      claims_list := claims_list || case when claims_list <> '' then ', ' else '' end || cl.external_claim_id;
    end if;
    cbilled := cbilled + coalesce(cl.billed_total, 0);
  end loop;
  claims_tbl := claims_tbl || '</tbody></table>';

  for ex in select filename, summary from evidence where dispute_id = p_dispute and status = 'scanned' order by created_at loop
    exi := exi + 1;
    ex_html := ex_html || '<li>Exhibit ' || chr(64 + least(exi,26)) || ' — ' || ex.filename ||
      case when coalesce(ex.summary->>'one_liner','') <> '' then ' (' || (ex.summary->>'one_liner') || ')' else '' end || '</li>';
  end loop;
  if ex_html <> '' then exhibits := '<ul class="exhibits">' || ex_html || '</ul>'; end if;
  select jsonb_object_agg(code, citation) into cite_obj from legal_authorities;

  disp_num := coalesce(nullif(trim(d.idr_registration_number),''), '');
  claim_num := coalesce(nullif(trim(d.claim_number),''), '');
  if coalesce(d.phase,'') = 'idr' then
    ref_num := coalesce(nullif(disp_num,''), coalesce(d.external_ref,''));
    ref_lbl := 'Dispute No. ' || ref_num;
  else
    ref_num := coalesce(nullif(claim_num,''), coalesce(d.external_ref,''));
    ref_lbl := 'Claim No. ' || ref_num;
  end if;

  ctx := jsonb_build_object(
    'dispute', jsonb_build_object(
      'external_ref', coalesce(d.external_ref,''), 'cpt_code', coalesce(d.cpt_code,''),
      'service_category', coalesce(d.service_category,''), 'idr_registration_number', disp_num,
      'claim_number', claim_num, 'phase', coalesce(d.phase,''),
      'phase_label', case when coalesce(d.phase,'')='idr' then 'Federal IDR' else 'Open negotiation' end,
      'reference', ref_lbl, 'reference_num', ref_num,
      'plan_legal_name', coalesce(d.plan_legal_name, d.plan_name,''), 'sponsor_legal_name', coalesce(d.sponsor_legal_name, d.employer_name,''),
      'eligibility_score', coalesce(d.eligibility_score::text,'')),
    'plan', jsonb_build_object('name', coalesce(d.plan_name,'')),
    'employer', jsonb_build_object('name', coalesce(d.employer_name,'')),
    'initiator', jsonb_build_object('name', coalesce(d.initiator_name,'the initiating party')),
    'org', jsonb_build_object('name', coalesce(d.org_name,'')),
    'money', jsonb_build_object(
      'demand', case when d.demand_amount is null then '—' else to_char(d.demand_amount, fmt_money) end,
      'qpa', case when d.qpa_amount is null then '—' else to_char(d.qpa_amount, fmt_money) end,
      'billed', case when d.billed_amount is null then '—' else to_char(d.billed_amount, fmt_money) end,
      'initial_payment', case when d.initial_payment is null then '—' else to_char(d.initial_payment, fmt_money) end,
      'ceiling', case when q.defensible_ceiling is null then '—' else to_char(q.defensible_ceiling, fmt_money) end,
      'regional', case when q.benchmark_regional is null then '—' else to_char(q.benchmark_regional, fmt_money) end,
      'contracted_median', case when q.contracted_median is null then '—' else to_char(q.contracted_median, fmt_money) end),
    'date', jsonb_build_object(
      'today', to_char(now() at time zone 'America/New_York', 'FMMonth FMDD, YYYY'),
      'service', case when d.service_date is null then '—' else to_char(d.service_date, 'FMMonth FMDD, YYYY') end,
      'respond_by', case when d.respond_by is null then '—' else to_char(d.respond_by, 'FMMonth FMDD, YYYY') end),
    'qpa', jsonb_build_object('methodology', coalesce(q.methodology,'median of contracted rates'), 'benchmark_table', bench),
    'claims', jsonb_build_object('count', ccount, 'table', case when ccount>0 then claims_tbl else '' end, 'list', claims_list, 'billed_total', to_char(cbilled, fmt_money)),
    'exhibits', exhibits,
    'cite', coalesce(cite_obj, '{}'::jsonb)
  );
  return ctx;
end $function$;

-- 5) demo_case_detail: read benchmark_regional (demo output key left as-is) ------
CREATE OR REPLACE FUNCTION public.demo_case_detail(p_ref text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with d as (select * from public.disputes where external_ref = p_ref and org_id = 'a0000000-0000-0000-0000-000000000001'),
  ph as (select public.nsa_phase((select workflow_state from d),(select disposition from d)) as phase),
  ceil as (
    select coalesce(
      (select ceiling_override from d),
      (select defensible_ceiling from public.qpa_records where dispute_id=(select id from d) order by created_at desc limit 1),
      (select qpa_amount from d)*1.25
    ) as c
  )
  select jsonb_build_object(
    'ref', p_ref,
    'phase', (select phase from ph),
    'phase_label', public.nsa_phase_label((select phase from ph)),
    'phase_deadline', (
      select jsonb_build_object('kind', kind, 'label', public.deadline_label(kind), 'due_at', due_at)
      from public.deadlines
      where dispute_id = (select id from d) and status='open'
        and ( ((select phase from ph)='open_negotiation' and kind in ('open_negotiation_response','open_negotiation_end'))
           or ((select phase from ph)='idr' and kind in ('initiation','idre_selection','eligibility_review','offer_notice','additional_info','response','payment','document_request')) )
      order by due_at limit 1),
    'on_economics', public.on_economics((select demand_amount from d),(select qpa_amount from d),(select c from ceil)),
    'qpa', (select jsonb_build_object('plan_qpa', plan_qpa, 'defensible_ceiling', defensible_ceiling, 'regional', benchmark_regional, 'basis', methodology, 'notes', notes)
            from public.qpa_records where dispute_id = (select id from d) order by created_at desc limit 1),
    'rebuttal', public.build_repricer_rebuttal((select id from d)),
    'deadlines', (select jsonb_agg(jsonb_build_object('kind', kind, 'label', public.deadline_label(kind), 'due_at', due_at) order by due_at)
                  from public.deadlines where dispute_id = (select id from d) and status = 'open'),
    'documents', (select jsonb_agg(jsonb_build_object('kind', kind, 'title', title, 'sha256', substr(sha256,1,12), 'at', created_at) order by created_at desc)
                  from public.documents where dispute_id = (select id from d))
  );
$function$;

-- 6) qpa_explain: regional benchmark labels + column ---------------------------
CREATE OR REPLACE FUNCTION public.qpa_explain(p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; b record; q record; ladder jsonb; factors jsonb; pct numeric; net jsonb;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  select * into q from public.qpa_records where dispute_id = p_dispute order by created_at desc limit 1;
  if not found then perform public.compute_qpa_defense(p_dispute);
    select * into q from public.qpa_records where dispute_id = p_dispute order by created_at desc limit 1;
    select * into d from public.disputes where id = p_dispute;
  end if;
  select * into b from public.benchmarks where cpt = d.cpt_code;
  net := public.benchmark_resolve(d.cpt_code, coalesce(d.rating_area,'national'));

  pct := nullif(q.plan_qpa, 0);
  ladder := jsonb_build_array(
    jsonb_build_object('label','Plan initial payment','amount',d.initial_payment,'pct_of_qpa', case when pct>0 then round(d.initial_payment/pct*100,0) end),
    jsonb_build_object('label','Qualifying Payment Amount (QPA)','amount',q.plan_qpa,'pct_of_qpa',100,'anchor',true),
    jsonb_build_object('label','Plan contracted median','amount',q.contracted_median,'pct_of_qpa', case when pct>0 then round(q.contracted_median/pct*100,0) end),
    jsonb_build_object('label','Peer network median (contracted)','amount', case when (net->>'ok')::boolean then (net->>'recommended_qpa_basis')::numeric end,'pct_of_qpa', case when pct>0 and (net->>'ok')::boolean then round((net->>'recommended_qpa_basis')::numeric/pct*100,0) end),
    jsonb_build_object('label','Medicare allowed (reference)','amount', case when b.medicare is not null then round(b.medicare,2) end,'pct_of_qpa', case when pct>0 and b.medicare is not null then round(b.medicare/pct*100,0) end),
    jsonb_build_object('label','Regional median (reference)','amount', q.benchmark_regional,'pct_of_qpa', case when pct>0 and q.benchmark_regional is not null then round(q.benchmark_regional/pct*100,0) end),
    jsonb_build_object('label','Defensible concession ceiling','amount', q.defensible_ceiling,'pct_of_qpa', case when pct>0 then round(q.defensible_ceiling/pct*100,0) end),
    jsonb_build_object('label','Provider demand','amount', d.demand_amount,'pct_of_qpa', case when pct>0 then round(d.demand_amount/pct*100,0) end),
    jsonb_build_object('label','Provider billed charge','amount', d.billed_amount,'pct_of_qpa', case when pct>0 then round(d.billed_amount/pct*100,0) end)
  );

  factors := jsonb_build_array(
    jsonb_build_object('factor','Median contracted rate','requirement','Median of the plan''s contracted in-network rates for the item/service',
      'status', case when q.contracted_median is not null then 'applied' else 'estimated' end, 'value', q.contracted_median, 'note', q.methodology),
    jsonb_build_object('factor','Same or similar service','requirement','Same service code and modifier; identical clinical definition',
      'status','applied','value', d.cpt_code, 'note', coalesce(b.description,'CPT '||d.cpt_code)),
    jsonb_build_object('factor','Same geographic region','requirement','Rating area for the service location',
      'status','applied','value', coalesce(d.rating_area,'national'),'note','Anchored to rating-area '||coalesce(d.rating_area,'national')||' contracted rates.'),
    jsonb_build_object('factor','Same insurance market','requirement','Same coverage market (e.g., large group / self-funded)',
      'status','applied','note','Matched to the plan coverage market for this dispute.'),
    jsonb_build_object('factor','CPI-U indexing','requirement','2019 base QPA indexed forward by CPI-U to the plan year',
      'status', case when q.indexing_current then 'current' else 'review' end,
      'note', case when q.indexing_current then 'Indexing applied and current for the plan year.' else 'Indexing should be re-verified for the current plan year.' end),
    jsonb_build_object('factor','Provider specialty','requirement','Specialty-specific rate where the plan varies rates by specialty',
      'status','not_varied','note','Plan does not vary contracted rates by specialty for this code; single QPA applies.')
  );

  return jsonb_build_object('ok', true, 'dispute', d.external_ref, 'cpt', d.cpt_code, 'rating_area', coalesce(d.rating_area,'national'),
    'service', coalesce(b.description, 'CPT '||d.cpt_code), 'qpa', q.plan_qpa, 'methodology', q.methodology,
    'defensible_ceiling', q.defensible_ceiling, 'comparison_ladder', ladder, 'statutory_factors', factors, 'network_benchmark', net,
    'provenance', jsonb_build_object('benchmark_medicare', b.medicare, 'benchmark_regional', q.benchmark_regional,
      'benchmark_updated', b.updated_at, 'indexing_current', q.indexing_current, 'computed_at', q.created_at,
      'sources', jsonb_build_array('Plan contracted-rate median','Peer network (contributed contracted rates)','Medicare PFS','Regional rate benchmark','CPI-U index')),
    'defensibility', jsonb_build_object('narrative', 'QPA derived per 45 CFR 149.140 from the plan''s median contracted rate for '||d.cpt_code||
      ' in rating area '||coalesce(d.rating_area,'national')||', corroborated by an independent peer network of contracted rates and cross-checked against Medicare and a regional benchmark. Every input, source, and index is shown above and reproducible.',
      'auditable', true, 'black_box', false));
end $function$;

-- 7) Letter clause: stop naming FAIR Health as the source ----------------------
update public.template_clauses
set body = replace(body, 'informed by FAIR Health benchmark data', 'informed by regional benchmark data')
where body like '%informed by FAIR Health benchmark data%';
