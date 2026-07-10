-- Merge step 2: wire the determination document-templates into the review_case flow.
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10.
-- render_review_determination(review_case) builds a doc context from the case + lines/adjustments and renders the
-- matching determination template (payment_integrity_determination | bill_review_determination) via the engine's
-- own render_str/eval_condition primitives. Returns { ok, title, html } for display/print.
CREATE OR REPLACE FUNCTION public.render_review_determination(p_case uuid, p_answers jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  rc record; t record; tcode text; ctx jsonb; answers jsonb := coalesce(p_answers,'{}'::jsonb);
  fmt text := 'FM$999,999,990';
  v_plan text; v_org text; v_cpt text; v_lob text; v_cat text; v_ref text;
  adj_html text := ''; adj record; rationale text := '';
  cite_obj jsonb; flags jsonb;
  c record; body_html text := ''; qrow record; title_out text;
begin
  select * into rc from review_cases where id = p_case;
  if not found then raise exception 'review case not found'; end if;
  if public.auth_org_id() is not null and rc.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  tcode := case rc.review_type
             when 'payment_integrity' then 'payment_integrity_determination'
             when 'wc_bill_review'   then 'bill_review_determination'
             when 'auto_bill_review' then 'bill_review_determination'
             else 'payment_integrity_determination' end;
  select * into t from document_templates where code = tcode and active and org_id is null limit 1;
  if not found then raise exception 'template % not found', tcode; end if;

  select name into v_plan from plans where id = rc.plan_id;
  select name into v_org  from orgs  where id = rc.org_id;
  select code into v_cpt  from review_lines where review_case_id = p_case order by line_no limit 1;
  v_ref := 'Claim ' || left(rc.id::text,8);

  for adj in select rule_code, category, description, amount from review_adjustments
             where review_case_id = p_case order by amount desc nulls last loop
    if v_cat is null then v_cat := adj.category; end if;
    adj_html := adj_html || '<li><strong>' || coalesce(adj.rule_code,'') || '</strong> &mdash; ' || coalesce(adj.description,'')
      || case when adj.amount is not null then ' (&minus;' || to_char(adj.amount, fmt) || ')' else '' end || '</li>';
  end loop;
  if adj_html <> '' then rationale := '<p>Basis for the determination:</p><ul>' || adj_html || '</ul>'; end if;

  v_lob := case rc.review_type when 'auto_bill_review' then 'auto' else 'wc' end;

  for qrow in select key, default_val from template_questions where template_id = t.id loop
    if qrow.default_val is not null and not (answers ? qrow.key) then
      answers := jsonb_set(answers, array[qrow.key], qrow.default_val, true);
    end if;
  end loop;
  if not (answers ? 'line_of_business') then answers := jsonb_set(answers,'{line_of_business}', to_jsonb(v_lob), true); end if;
  if v_cat is not null and not (answers ? 'review_category') then answers := jsonb_set(answers,'{review_category}', to_jsonb(v_cat), true); end if;
  if v_cat is not null and not (answers ? 'edit_category')   then answers := jsonb_set(answers,'{edit_category}',   to_jsonb(v_cat), true); end if;
  if rationale <> '' and not (answers ? 'rationale')         then answers := jsonb_set(answers,'{rationale}',       to_jsonb(rationale), true); end if;
  if not (answers ? 'signer_name')  then answers := jsonb_set(answers,'{signer_name}',  '"Authorized Representative"'::jsonb, true); end if;

  select jsonb_object_agg(code, citation) into cite_obj from legal_authorities;

  ctx := jsonb_build_object(
    'dispute', jsonb_build_object(
       'external_ref', coalesce(nullif(rc.provider_name,''), left(rc.id::text,8)),
       'reference', v_ref, 'claim_number', left(rc.id::text,8),
       'cpt_code', coalesce(v_cpt,''), 'service_category', coalesce(rc.review_type,''),
       'plan_legal_name', coalesce(v_plan,'the Plan')),
    'plan', jsonb_build_object('name', coalesce(v_plan,'')),
    'org',  jsonb_build_object('name', coalesce(v_org,'')),
    'initiator', jsonb_build_object('name', coalesce(rc.provider_name,'the provider')),
    'money', jsonb_build_object(
       'qpa',    case when rc.allowed_total is null then '—' else to_char(rc.allowed_total, fmt) end,
       'demand', case when rc.billed_total  is null then '—' else to_char(rc.billed_total,  fmt) end,
       'billed', case when rc.billed_total  is null then '—' else to_char(rc.billed_total,  fmt) end),
    'date', jsonb_build_object(
       'today',   to_char(now() at time zone 'America/New_York','FMMonth FMDD, YYYY'),
       'service', case when rc.date_of_service is null then '—' else to_char(rc.date_of_service,'FMMonth FMDD, YYYY') end),
    'qpa', jsonb_build_object('methodology','the applicable fee-schedule / benchmark allowed amount','benchmark_table',''),
    'exhibits','',
    'cite', coalesce(cite_obj,'{}'::jsonb),
    'answers', answers
  );
  flags := jsonb_build_object('has_findings', true, 'has_evidence', false);

  for c in select * from template_clauses where template_id = t.id order by seq, key loop
    if not public.eval_condition(c.include_when, flags, answers) then continue; end if;
    body_html := body_html || public.render_str(c.body, ctx);
  end loop;
  title_out := public.render_str(t.title, ctx);

  return jsonb_build_object('ok', true, 'template', tcode, 'review_type', rc.review_type,
    'title', title_out, 'html', body_html);
end $function$;
GRANT EXECUTE ON FUNCTION public.render_review_determination(uuid, jsonb) TO anon, authenticated;
