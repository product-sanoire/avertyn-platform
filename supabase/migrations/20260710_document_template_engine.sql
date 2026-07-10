-- Avertyn — Document Template Engine
-- Turns "argument documents" (eligibility challenge letters, position statements,
-- open-negotiation notices, offer letters) into DATA: a template = a set of clauses
-- whose inclusion is driven by eligibility findings + a small answered questionnaire.
-- Deterministic render in Postgres; the app layers an editor + optional AI narrative.
--
-- New objects:
--   document_templates   — one row per doc type (global org_id=null, or org override)
--   template_questions   — the intake wizard for a template
--   template_clauses     — ordered, conditionally-included body fragments (HTML)
--   render_str()         — scalar {{token}} substitution against a jsonb context
--   eval_condition()     — boolean clause-inclusion logic over flags + answers
--   build_doc_context()  — assembles dispute/qpa/party facts into the render context
--   render_template()    — the engine: clauses × conditions × findings → {title, html}
--   preview_document()   — render without persisting (live wizard preview)
--   generate_document_from_template() — render + persist into documents
--   save_document_content() — editor autosave (blocked once signed)
--   list_doc_templates(), get_doc_template(), list_documents(), get_document() — reads
-- generate_document() is refactored to route through a template when one exists.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Schema
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.document_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.orgs(id) on delete cascade,  -- null = global catalog
  code        text not null,                 -- e.g. 'challenge_letter'
  kind        text not null,                 -- documents.kind written on generate
  title       text not null,                 -- title template (supports {{tokens}})
  description text,
  jurisdiction text not null default 'federal',
  version     int  not null default 1,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists document_templates_scope_code
  on public.document_templates (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

create table if not exists public.template_questions (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  seq         int  not null default 0,
  key         text not null,                 -- answers key
  prompt      text not null,
  help        text,
  input_type  text not null default 'text',  -- text | textarea | select | boolean | number
  options     jsonb,                          -- for select: [{"value":..,"label":..}]
  default_val jsonb,                          -- default answer (jsonb scalar)
  required    boolean not null default false,
  ai_assist   boolean not null default false, -- offer "AI draft" for this field
  ai_prompt   text,                            -- guidance passed to the drafting model
  unique (template_id, key)
);

create table if not exists public.template_clauses (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  seq         int  not null default 0,
  key         text not null,
  body        text not null,                 -- HTML fragment with {{tokens}}
  include_when jsonb,                          -- null = always; else eval_condition()
  repeat_over text,                            -- null | 'findings' (repeats per failed finding, wrapped <ol>)
  editable    boolean not null default true,
  unique (template_id, key)
);

-- documents: carry the questionnaire answers + an updated_at for editor saves
alter table public.documents add column if not exists answers jsonb;
alter table public.documents add column if not exists updated_at timestamptz not null default now();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.document_templates enable row level security;
alter table public.template_questions enable row level security;
alter table public.template_clauses  enable row level security;

do $$ begin
  -- templates: read global rows or your org's; write only your org (admins) — global rows are seed-managed
  create policy dt_read on public.document_templates for select to authenticated
    using (org_id is null or org_id = public.auth_org_id());
  create policy dt_write on public.document_templates for all to authenticated
    using (org_id = public.auth_org_id()) with check (org_id = public.auth_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy tq_read on public.template_questions for select to authenticated
    using (exists (select 1 from public.document_templates t where t.id = template_id
                   and (t.org_id is null or t.org_id = public.auth_org_id())));
  create policy tq_write on public.template_questions for all to authenticated
    using (exists (select 1 from public.document_templates t where t.id = template_id and t.org_id = public.auth_org_id()))
    with check (exists (select 1 from public.document_templates t where t.id = template_id and t.org_id = public.auth_org_id()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy tc_read on public.template_clauses for select to authenticated
    using (exists (select 1 from public.document_templates t where t.id = template_id
                   and (t.org_id is null or t.org_id = public.auth_org_id())));
  create policy tc_write on public.template_clauses for all to authenticated
    using (exists (select 1 from public.document_templates t where t.id = template_id and t.org_id = public.auth_org_id()))
    with check (exists (select 1 from public.document_templates t where t.id = template_id and t.org_id = public.auth_org_id()));
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Engine primitives
-- ─────────────────────────────────────────────────────────────────────────────

-- Scalar substitution: replace every {{ a.b.c }} with ctx #>> '{a,b,c}' (missing -> '').
create or replace function public.render_str(p_tpl text, p_ctx jsonb)
returns text language plpgsql immutable as $fn$
declare out text := coalesce(p_tpl,''); m record; val text;
begin
  -- Collect distinct tokens once, then replace all occurrences of each (whitespace-tolerant).
  for m in
    select distinct t.token from (
      select (rx)[1] as token
      from regexp_matches(out, '\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}', 'g') as rx
    ) t
  loop
    val := coalesce(p_ctx #>> string_to_array(m.token, '.'), '');
    -- escape backslashes so regexp_replace does not interpret \1 etc. in the value
    val := replace(val, '\', '\\');
    out := regexp_replace(out, '\{\{\s*' || replace(m.token, '.', '\.') || '\s*\}\}', val, 'g');
  end loop;
  -- clear any unresolved tokens
  out := regexp_replace(out, '\{\{\s*[a-zA-Z0-9_.]+\s*\}\}', '', 'g');
  return out;
end $fn$;

-- Condition eval for clause inclusion.
--   null                                  -> true
--   {"flag":"CODE"}                       -> flags->>CODE = 'true'
--   {"answer":"key"}                      -> answers has non-empty truthy value at key
--   {"answer":"key","equals":<value>}     -> answers->>key = value (as text)
--   {"not":<cond>} / {"any":[..]} / {"all":[..]}
create or replace function public.eval_condition(p_cond jsonb, p_flags jsonb, p_answers jsonb)
returns boolean language plpgsql immutable as $fn$
declare k text; av jsonb; el jsonb;
begin
  if p_cond is null or p_cond = 'null'::jsonb then return true; end if;

  if p_cond ? 'not' then
    return not public.eval_condition(p_cond->'not', p_flags, p_answers);
  end if;
  if p_cond ? 'all' then
    for el in select * from jsonb_array_elements(p_cond->'all') loop
      if not public.eval_condition(el, p_flags, p_answers) then return false; end if;
    end loop;
    return true;
  end if;
  if p_cond ? 'any' then
    for el in select * from jsonb_array_elements(p_cond->'any') loop
      if public.eval_condition(el, p_flags, p_answers) then return true; end if;
    end loop;
    return false;
  end if;
  if p_cond ? 'flag' then
    return coalesce(p_flags ->> (p_cond->>'flag'), 'false') = 'true';
  end if;
  if p_cond ? 'answer' then
    k  := p_cond->>'answer';
    av := p_answers -> k;
    if p_cond ? 'equals' then
      return coalesce(av #>> '{}', '') = coalesce(p_cond->'equals' #>> '{}', '');
    end if;
    -- truthy: present, not null, not false, not '' , not '0'
    if av is null or av = 'null'::jsonb or av = 'false'::jsonb then return false; end if;
    if jsonb_typeof(av) = 'string' and coalesce(av #>> '{}','') = '' then return false; end if;
    return true;
  end if;
  return true;
end $fn$;

-- Assemble the render context (facts) for a dispute.
create or replace function public.build_doc_context(p_dispute uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare d record; q record; ctx jsonb;
  fmt_money text := 'FM$999,999,990';
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
    'qpa', jsonb_build_object('methodology', coalesce(q.methodology,'median of contracted rates'))
  );
  return ctx;
end $fn$;

-- The engine.
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

  -- resolve template: org override wins over global
  select * into t from document_templates
   where code = p_code and active
     and (org_id = d.org_id or org_id is null)
   order by (org_id is not null) desc limit 1;
  if not found then raise exception 'template % not found', p_code; end if;

  -- context + failed findings
  ctx := public.build_doc_context(p_dispute);
  for fr in
    select r.name, r.code, r.category, r.severity, ef.detail
      from eligibility_findings ef join eligibility_rules r on r.id = ef.rule_id
     where ef.dispute_id = p_dispute and ef.result = 'fail'
     order by (r.severity = 'disqualifying') desc, r.code
  loop
    idx := idx + 1;
    findings := findings || jsonb_build_object(
      'index', idx, 'name', coalesce(fr.name,''), 'code', coalesce(fr.code,''),
      'category', coalesce(fr.category,''), 'detail', coalesce(fr.detail,''));
    flags := jsonb_set(flags, array[fr.code], 'true'::jsonb, true);
  end loop;
  flags := jsonb_set(flags, '{has_findings}', to_jsonb(idx > 0), true);

  -- merge answer defaults from the questionnaire
  answers := coalesce(p_answers, '{}'::jsonb);
  for qrow in select key, default_val from template_questions where template_id = t.id loop
    if qrow.default_val is not null and not (answers ? qrow.key) then
      answers := jsonb_set(answers, array[qrow.key], qrow.default_val, true);
    end if;
  end loop;
  ctx := jsonb_set(ctx, '{answers}', answers, true);

  -- walk clauses
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

  return jsonb_build_object(
    'ok', true, 'kind', t.kind, 'code', t.code, 'title', title_out,
    'html', body_html, 'answers', answers, 'flags', flags, 'findings', findings);
end $fn$;

-- Preview (no persistence) — for the live wizard.
create or replace function public.preview_document(p_dispute uuid, p_code text, p_answers jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select public.render_template(p_dispute, p_code, p_answers);
$fn$;

-- Generate + persist.
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

  insert into public.audit_log(org_id, dispute_id, action, detail)
  values (d.org_id, p_dispute, 'document:generated',
          jsonb_build_object('doc', doc_id, 'template', p_code, 'answers', r->'answers'));
  return doc_id;
end $fn$;

-- Editor autosave (blocked once signed).
create or replace function public.save_document_content(p_doc uuid, p_content text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare dd record; h text;
begin
  select * into dd from documents where id = p_doc;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and dd.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if dd.esign_status = 'signed' then return jsonb_build_object('ok', false, 'reason', 'document_signed'); end if;
  h := encode(extensions.digest(coalesce(p_content,''), 'sha256'), 'hex');
  update documents set content = p_content, sha256 = h, updated_at = now(), generated = false where id = p_doc;
  return jsonb_build_object('ok', true, 'sha256', substr(h,1,16), 'updated_at', now());
end $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Read RPCs for the app
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.list_doc_templates()
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'kind', kind, 'title', title, 'description', description,
           'jurisdiction', jurisdiction) order by title), '[]'::jsonb)
  from document_templates
  where active and (org_id is null or org_id = public.auth_org_id());
$fn$;

create or replace function public.get_doc_template(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare t record;
begin
  select * into t from document_templates
   where code = p_code and active and (org_id is null or org_id = public.auth_org_id())
   order by (org_id is not null) desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true,
    'code', t.code, 'kind', t.kind, 'title', t.title, 'description', t.description,
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', key, 'prompt', prompt, 'help', help, 'input_type', input_type,
        'options', options, 'default', default_val, 'required', required,
        'ai_assist', ai_assist, 'ai_prompt', ai_prompt) order by seq, key), '[]'::jsonb)
      from template_questions where template_id = t.id));
end $fn$;

create or replace function public.list_documents(p_dispute uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'title', title, 'kind', kind, 'template_code', template_code,
           'esign_status', esign_status, 'signed_by', signed_by, 'signed_at', signed_at,
           'generated', generated, 'updated_at', updated_at, 'created_at', created_at
         ) order by created_at desc), '[]'::jsonb)
  from documents
  where dispute_id = p_dispute
    and (public.auth_org_id() is null or org_id = public.auth_org_id());
$fn$;

create or replace function public.get_document(p_doc uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare dd record;
begin
  select * into dd from documents where id = p_doc;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and dd.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  return jsonb_build_object('ok', true, 'id', dd.id, 'title', dd.title, 'kind', dd.kind,
    'template_code', dd.template_code, 'content', dd.content, 'answers', dd.answers,
    'esign_status', dd.esign_status, 'signed_by', dd.signed_by, 'signed_at', dd.signed_at,
    'sha256', dd.sha256, 'updated_at', dd.updated_at, 'created_at', dd.created_at);
end $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Route legacy generate_document through a template when one exists
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.generate_document(p_dispute uuid, p_kind text default 'challenge_letter')
returns uuid language plpgsql security definer set search_path to 'public' as $fn$
declare d record; tcode text; doc_id uuid;
begin
  select * into d from disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  select code into tcode from document_templates
   where kind = p_kind and active and (org_id = d.org_id or org_id is null)
   order by (org_id is not null) desc limit 1;

  if tcode is not null then
    return public.generate_document_from_template(p_dispute, tcode, '{}'::jsonb);
  end if;

  -- Fallback: minimal generated stub (kept so nothing breaks if a template is missing)
  insert into public.documents(org_id, dispute_id, kind, title, content, template_code, sha256, generated, updated_at)
  values (d.org_id, p_dispute, p_kind, initcap(replace(p_kind,'_',' ')) || ' — ' || coalesce(d.external_ref,'dispute'),
          '<p>(No template configured for ' || p_kind || '. Configure one under Templates.)</p>', p_kind,
          encode(extensions.digest(p_kind || coalesce(d.external_ref,''), 'sha256'), 'hex'), true, now())
  returning id into doc_id;
  return doc_id;
end $fn$;

grant execute on function public.list_doc_templates(),
  public.get_doc_template(text),
  public.preview_document(uuid, text, jsonb),
  public.generate_document_from_template(uuid, text, jsonb),
  public.save_document_content(uuid, text),
  public.list_documents(uuid),
  public.get_document(uuid)
to authenticated;
