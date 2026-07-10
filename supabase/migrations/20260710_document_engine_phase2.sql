-- Avertyn — Document Engine, Phase 2
-- Adds: per-rule legal authority plumbing, version history + audit, a pre-flight
-- completeness check, a computed QPA benchmark-table token, and an in-app template
-- builder (clone-to-org + upsert/delete RPCs, admin-gated).

-- ── 1. Legal authority on the rule catalog ──────────────────────────────────
alter table public.eligibility_rules add column if not exists authority text;  -- e.g. '45 CFR §149.510'
alter table public.eligibility_rules add column if not exists argument  text;  -- one-sentence legal argument

-- ── 2. Version history + audit ──────────────────────────────────────────────
create table if not exists public.document_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  version     int  not null,
  event       text not null,            -- generated | saved | signed
  actor       text,
  content     text,
  sha256      text,
  created_at  timestamptz not null default now()
);
create index if not exists document_versions_doc on public.document_versions(document_id, version);
alter table public.document_versions enable row level security;
do $$ begin
  create policy dv_read on public.document_versions for select to authenticated
    using (public.auth_org_id() is null or org_id = public.auth_org_id());
exception when duplicate_object then null; end $$;

-- snapshot helper: coalesces rapid autosaves (a 'saved' version < 45s old is updated in place)
create or replace function public.snapshot_document(p_doc uuid, p_event text, p_actor text)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare dd record; lastv record; nextn int;
begin
  select * into dd from documents where id = p_doc;
  if not found then return; end if;
  select * into lastv from document_versions where document_id = p_doc order by version desc limit 1;
  if p_event = 'saved' and lastv.event = 'saved' and lastv.created_at > now() - interval '45 seconds' then
    update document_versions set content = dd.content, sha256 = dd.sha256, created_at = now(), actor = p_actor
      where id = lastv.id;
    return;
  end if;
  nextn := coalesce(lastv.version, 0) + 1;
  insert into document_versions(org_id, document_id, version, event, actor, content, sha256)
    values (dd.org_id, p_doc, nextn, p_event, p_actor, dd.content, dd.sha256);
end $fn$;

create or replace function public.list_document_versions(p_doc uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'version', version, 'event', event, 'actor', actor,
    'sha256', substr(sha256,1,12), 'created_at', created_at) order by version desc), '[]'::jsonb)
  from document_versions where document_id = p_doc
    and (public.auth_org_id() is null or org_id = public.auth_org_id());
$fn$;

-- ── 3. Benchmark-table token in the render context ──────────────────────────
create or replace function public.build_doc_context(p_dispute uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare d record; q record; ctx jsonb;
  fmt_money text := 'FM$999,999,990'; bench text; function_row text;
  procedure_note text;
begin
  select di.*, pl.name as plan_name, em.name as employer_name, io.name as initiator_name,
         og.name as org_name
    into d
  from disputes di
  left join plans pl on pl.id = di.plan_id
  left join employers em on em.id = di.employer_id
  left join initiators io on io.id = di.initiator_id
  left join orgs og on og.id = di.org_id
  where di.id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  select * into q from qpa_records where dispute_id = p_dispute order by created_at desc limit 1;

  -- QPA benchmark table (rows only for values we have)
  bench := '<table class="bench"><thead><tr><th>Reference</th><th>Amount</th></tr></thead><tbody>';
  if coalesce(d.qpa_amount, q.plan_qpa) is not null then
    bench := bench || '<tr><td>Plan Qualifying Payment Amount (QPA)</td><td>' || to_char(coalesce(d.qpa_amount,q.plan_qpa), fmt_money) || '</td></tr>';
  end if;
  if q.contracted_median is not null then
    bench := bench || '<tr><td>Plan median contracted rate</td><td>' || to_char(q.contracted_median, fmt_money) || '</td></tr>';
  end if;
  if q.benchmark_fairhealth is not null then
    bench := bench || '<tr><td>FAIR Health regional benchmark</td><td>' || to_char(q.benchmark_fairhealth, fmt_money) || '</td></tr>';
  end if;
  if q.benchmark_medicare_mult is not null then
    bench := bench || '<tr><td>Medicare-based reference</td><td>' || to_char(q.benchmark_medicare_mult, fmt_money) || '</td></tr>';
  end if;
  if q.defensible_ceiling is not null then
    bench := bench || '<tr><td>Defensible ceiling (max concession)</td><td>' || to_char(q.defensible_ceiling, fmt_money) || '</td></tr>';
  end if;
  if d.demand_amount is not null then
    bench := bench || '<tr><td>Initiating party demand</td><td>' || to_char(d.demand_amount, fmt_money) || '</td></tr>';
  end if;
  bench := bench || '</tbody></table>';

  ctx := jsonb_build_object(
    'dispute', jsonb_build_object(
      'external_ref', coalesce(d.external_ref,''),
      'cpt_code', coalesce(d.cpt_code,''),
      'service_category', coalesce(d.service_category,''),
      'idr_registration_number', coalesce(d.idr_registration_number,''),
      'plan_legal_name', coalesce(d.plan_legal_name, d.plan_name,''),
      'sponsor_legal_name', coalesce(d.sponsor_legal_name, d.employer_name,''),
      'eligibility_score', coalesce(d.eligibility_score::text,'')
    ),
    'plan', jsonb_build_object('name', coalesce(d.plan_name,'')),
    'employer', jsonb_build_object('name', coalesce(d.employer_name,'')),
    'initiator', jsonb_build_object('name', coalesce(d.initiator_name,'the initiating party')),
    'org', jsonb_build_object('name', coalesce(d.org_name,'')),
    'money', jsonb_build_object(
      'demand', case when d.demand_amount is null then '—' else to_char(d.demand_amount, fmt_money) end,
      'qpa',    case when d.qpa_amount is null then '—' else to_char(d.qpa_amount, fmt_money) end,
      'billed', case when d.billed_amount is null then '—' else to_char(d.billed_amount, fmt_money) end,
      'initial_payment', case when d.initial_payment is null then '—' else to_char(d.initial_payment, fmt_money) end,
      'ceiling', case when q.defensible_ceiling is null then '—' else to_char(q.defensible_ceiling, fmt_money) end,
      'fairhealth', case when q.benchmark_fairhealth is null then '—' else to_char(q.benchmark_fairhealth, fmt_money) end,
      'contracted_median', case when q.contracted_median is null then '—' else to_char(q.contracted_median, fmt_money) end
    ),
    'date', jsonb_build_object(
      'today', to_char(now() at time zone 'America/New_York', 'FMMonth FMDD, YYYY'),
      'service', case when d.service_date is null then '—' else to_char(d.service_date, 'FMMonth FMDD, YYYY') end,
      'respond_by', case when d.respond_by is null then '—' else to_char(d.respond_by, 'FMMonth FMDD, YYYY') end
    ),
    'qpa', jsonb_build_object('methodology', coalesce(q.methodology,'median of contracted rates'),
                              'benchmark_table', bench)
  );
  return ctx;
end $fn$;

-- ── 4. render_template: carry rule authority + argument into findings ───────
create or replace function public.render_template(p_dispute uuid, p_code text, p_answers jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  d record; t record; ctx jsonb; flags jsonb := '{}'::jsonb; answers jsonb;
  findings jsonb := '[]'::jsonb; fr record; idx int := 0;
  c record; body_html text := ''; clause_out text; item jsonb; item_ctx jsonb; grp text;
  qrow record; title_out text;
begin
  select * into d from disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  select * into t from document_templates
   where code = p_code and active and (org_id = d.org_id or org_id is null)
   order by (org_id is not null) desc limit 1;
  if not found then raise exception 'template % not found', p_code; end if;
  ctx := public.build_doc_context(p_dispute);
  for fr in
    select r.name, r.code, r.category, r.severity, r.authority, r.argument, ef.detail
      from eligibility_findings ef join eligibility_rules r on r.id = ef.rule_id
     where ef.dispute_id = p_dispute and ef.result = 'fail'
     order by (r.severity = 'disqualifying') desc, r.code
  loop
    idx := idx + 1;
    findings := findings || jsonb_build_object(
      'index', idx, 'name', coalesce(fr.name,''), 'code', coalesce(fr.code,''),
      'category', coalesce(fr.category,''), 'detail', coalesce(fr.detail,''),
      'authority', coalesce(fr.authority,''), 'argument', coalesce(fr.argument,''));
    flags := jsonb_set(flags, array[fr.code], 'true'::jsonb, true);
  end loop;
  flags := jsonb_set(flags, '{has_findings}', to_jsonb(idx > 0), true);
  answers := coalesce(p_answers, '{}'::jsonb);
  for qrow in select key, default_val from template_questions where template_id = t.id loop
    if qrow.default_val is not null and not (answers ? qrow.key) then
      answers := jsonb_set(answers, array[qrow.key], qrow.default_val, true);
    end if;
  end loop;
  ctx := jsonb_set(ctx, '{answers}', answers, true);
  for c in select * from template_clauses where template_id = t.id order by seq, key loop
    if not public.eval_condition(c.include_when, flags, answers) then continue; end if;
    if c.repeat_over = 'findings' then
      grp := '';
      for item in select * from jsonb_array_elements(findings) loop
        item_ctx := ctx || jsonb_build_object('this', item);
        grp := grp || public.render_str(c.body, item_ctx);
      end loop;
      if grp <> '' then body_html := body_html || '<ol class="grounds">' || grp || '</ol>'; end if;
    else
      clause_out := public.render_str(c.body, ctx);
      body_html := body_html || clause_out;
    end if;
  end loop;
  title_out := public.render_str(t.title, ctx);
  return jsonb_build_object('ok', true, 'kind', t.kind, 'code', t.code, 'title', title_out,
    'html', body_html, 'answers', answers, 'flags', flags, 'findings', findings);
end $fn$;

-- ── 5. Snapshot on generate / save / sign ──────────────────────────────────
create or replace function public.generate_document_from_template(p_dispute uuid, p_code text, p_answers jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to 'public' as $fn$
declare d record; r jsonb; h text; doc_id uuid;
begin
  select * into d from disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  r := public.render_template(p_dispute, p_code, p_answers);
  h := encode(extensions.digest(r->>'html', 'sha256'), 'hex');
  insert into public.documents(org_id, dispute_id, kind, title, content, template_code, answers, sha256, generated, esign_status, updated_at)
  values (d.org_id, p_dispute, r->>'kind', r->>'title', r->>'html', r->>'code', (r->'answers'), h, true, 'unsigned', now())
  returning id into doc_id;
  perform public.snapshot_document(doc_id, 'generated', 'system');
  insert into public.audit_log(org_id, dispute_id, action, detail)
  values (d.org_id, p_dispute, 'document:generated', jsonb_build_object('doc', doc_id, 'template', p_code));
  return doc_id;
end $fn$;

create or replace function public.save_document_content(p_doc uuid, p_content text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare dd record; h text; changed boolean;
begin
  select * into dd from documents where id = p_doc;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and dd.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if dd.esign_status = 'signed' then return jsonb_build_object('ok', false, 'reason', 'document_signed'); end if;
  h := encode(extensions.digest(coalesce(p_content,''), 'sha256'), 'hex');
  changed := (h <> coalesce(dd.sha256,''));
  update documents set content = p_content, sha256 = h, updated_at = now(), generated = false where id = p_doc;
  if changed then perform public.snapshot_document(p_doc, 'saved', coalesce(public.auth_role(),'operator')); end if;
  return jsonb_build_object('ok', true, 'sha256', substr(h,1,16), 'updated_at', now(), 'changed', changed);
end $fn$;

create or replace function public.sign_document(p_doc uuid, p_signer text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare dd record; seal text;
begin
  select * into dd from documents where id = p_doc;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and dd.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  seal := encode(extensions.digest(coalesce(dd.content,'') || '|' || p_signer || '|' || now()::text, 'sha256'), 'hex');
  update public.documents set esign_status='signed', signed_by=p_signer, signed_at=now(), sha256=seal where id=p_doc;
  perform public.snapshot_document(p_doc, 'signed', p_signer);
  insert into public.audit_log(org_id,dispute_id,action,detail)
    values (dd.org_id,dd.dispute_id,'document:signed',jsonb_build_object('doc',p_doc,'signer',p_signer,'seal',seal));
  return jsonb_build_object('ok',true,'seal',seal);
end $fn$;

-- ── 6. Pre-flight completeness check ────────────────────────────────────────
create or replace function public.document_preflight(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare dd record; d record; issues jsonb := '[]'::jsonb; nfail int;
begin
  select * into dd from documents where id = p_doc;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and dd.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  select * into d from disputes where id = dd.dispute_id;

  if coalesce(dd.answers->>'signer_name','') = '' and dd.esign_status <> 'signed' then
    issues := issues || jsonb_build_object('level','warn','msg','No signer name captured — the signature block will be blank.');
  end if;
  if position('{{' in coalesce(dd.content,'')) > 0 then
    issues := issues || jsonb_build_object('level','error','msg','Unresolved template tokens remain in the document.');
  end if;
  select count(*) into nfail from eligibility_findings where dispute_id = dd.dispute_id and result='fail';
  if dd.kind = 'challenge_letter' and nfail = 0 then
    issues := issues || jsonb_build_object('level','warn','msg','No failed eligibility findings are cited — confirm the grounds before filing.');
  end if;
  if d.respond_by is not null and d.respond_by < now() then
    issues := issues || jsonb_build_object('level','warn','msg','The respond-by window has passed for this dispute.');
  end if;
  if coalesce(d.idr_registration_number,'') = '' then
    issues := issues || jsonb_build_object('level','info','msg','No IDR registration number on the case yet.');
  end if;
  if char_length(coalesce(dd.content,'')) < 200 then
    issues := issues || jsonb_build_object('level','warn','msg','Document body looks unusually short.');
  end if;

  return jsonb_build_object('ok', true,
    'errors', (select count(*) from jsonb_array_elements(issues) e where e->>'level'='error'),
    'warnings', (select count(*) from jsonb_array_elements(issues) e where e->>'level'='warn'),
    'issues', issues);
end $fn$;

-- ── 7. Template builder — clone-to-org + upsert/delete (admin-gated) ────────
create or replace function public._require_admin() returns void language plpgsql stable as $fn$
begin
  if public.auth_org_id() is null then raise exception 'not authenticated'; end if;
  if coalesce(public.auth_role(),'') not in ('admin') then raise exception 'admin role required'; end if;
end $fn$;

create or replace function public.clone_template_to_org(p_code text)
returns text language plpgsql security definer set search_path to 'public' as $fn$
declare src record; neworg uuid := public.auth_org_id(); new_id uuid; existing uuid;
begin
  perform public._require_admin();
  select id into existing from document_templates where code = p_code and org_id = neworg;
  if existing is not null then return p_code; end if;   -- already have an org copy
  select * into src from document_templates
   where code = p_code and (org_id is null or org_id = neworg) order by (org_id is not null) desc limit 1;
  if not found then raise exception 'template % not found', p_code; end if;
  insert into document_templates(org_id, code, kind, title, description, jurisdiction, version, active)
    values (neworg, src.code, src.kind, src.title, src.description, src.jurisdiction, src.version, true)
    returning id into new_id;
  insert into template_questions(template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
    select new_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt
    from template_questions where template_id = src.id;
  insert into template_clauses(template_id, seq, key, body, include_when, repeat_over, editable)
    select new_id, seq, key, body, include_when, repeat_over, editable
    from template_clauses where template_id = src.id;
  return p_code;
end $fn$;

-- resolve the caller-org template id for a code (must be org-owned to edit)
create or replace function public._org_template_id(p_code text)
returns uuid language sql stable security definer set search_path to 'public' as $fn$
  select id from document_templates where code = p_code and org_id = public.auth_org_id();
$fn$;

create or replace function public.upsert_template_clause(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare tid uuid;
begin
  perform public._require_admin();
  tid := public._org_template_id(p->>'code');
  if tid is null then raise exception 'no editable (org-owned) template for %; clone it first', p->>'code'; end if;
  insert into template_clauses(template_id, seq, key, body, include_when, repeat_over, editable)
  values (tid, coalesce((p->>'seq')::int,0), p->>'key', p->>'body',
          case when p ? 'include_when' then p->'include_when' else null end,
          nullif(p->>'repeat_over',''), coalesce((p->>'editable')::boolean, true))
  on conflict (template_id, key) do update
    set seq = excluded.seq, body = excluded.body, include_when = excluded.include_when,
        repeat_over = excluded.repeat_over, editable = excluded.editable;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.upsert_template_question(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare tid uuid;
begin
  perform public._require_admin();
  tid := public._org_template_id(p->>'code');
  if tid is null then raise exception 'no editable (org-owned) template for %; clone it first', p->>'code'; end if;
  insert into template_questions(template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
  values (tid, coalesce((p->>'seq')::int,0), p->>'key', p->>'prompt', p->>'help',
          coalesce(p->>'input_type','text'),
          case when p ? 'options' then p->'options' else null end,
          case when p ? 'default' then p->'default' else null end,
          coalesce((p->>'required')::boolean,false),
          coalesce((p->>'ai_assist')::boolean,false), p->>'ai_prompt')
  on conflict (template_id, key) do update
    set seq = excluded.seq, prompt = excluded.prompt, help = excluded.help, input_type = excluded.input_type,
        options = excluded.options, default_val = excluded.default_val, required = excluded.required,
        ai_assist = excluded.ai_assist, ai_prompt = excluded.ai_prompt;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.delete_template_item(p_code text, p_kind text, p_key text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare tid uuid;
begin
  perform public._require_admin();
  tid := public._org_template_id(p_code);
  if tid is null then raise exception 'no editable template for %', p_code; end if;
  if p_kind = 'clause' then delete from template_clauses where template_id = tid and key = p_key;
  elsif p_kind = 'question' then delete from template_questions where template_id = tid and key = p_key;
  else raise exception 'unknown kind %', p_kind; end if;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.set_template_meta(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare tid uuid;
begin
  perform public._require_admin();
  tid := public._org_template_id(p->>'code');
  if tid is null then raise exception 'no editable template for %', p->>'code'; end if;
  update document_templates set
    title = coalesce(p->>'title', title),
    description = coalesce(p->>'description', description),
    active = coalesce((p->>'active')::boolean, active)
   where id = tid;
  return jsonb_build_object('ok', true);
end $fn$;

-- full template (with clauses + questions) for the builder
create or replace function public.get_template_full(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare t record;
begin
  select * into t from document_templates
   where code = p_code and (org_id = public.auth_org_id() or org_id is null)
   order by (org_id is not null) desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true,
    'code', t.code, 'kind', t.kind, 'title', t.title, 'description', t.description,
    'editable', (t.org_id is not null),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object(
        'seq',seq,'key',key,'prompt',prompt,'help',help,'input_type',input_type,'options',options,
        'default',default_val,'required',required,'ai_assist',ai_assist,'ai_prompt',ai_prompt) order by seq,key),'[]'::jsonb)
      from template_questions where template_id = t.id),
    'clauses', (select coalesce(jsonb_agg(jsonb_build_object(
        'seq',seq,'key',key,'body',body,'include_when',include_when,'repeat_over',repeat_over,'editable',editable) order by seq,key),'[]'::jsonb)
      from template_clauses where template_id = t.id));
end $fn$;

grant execute on function
  public.list_document_versions(uuid),
  public.document_preflight(uuid),
  public.clone_template_to_org(text),
  public.upsert_template_clause(jsonb),
  public.upsert_template_question(jsonb),
  public.delete_template_item(text, text, text),
  public.set_template_meta(jsonb),
  public.get_template_full(text)
to authenticated;
