-- Avertyn — Evidence upload + AI scanning
-- Upload existing case documents (open-negotiation notices, EOB/remittances, the
-- initiator's filing, contracts, correspondence); an edge function reads them with
-- Claude vision, extracts an eligibility-relevant summary, and the render engine can
-- cite them as exhibits and feed them into AI-drafted arguments.

-- ── 1. Private storage bucket + org-scoped policies ────────────────────────
insert into storage.buckets (id, name, public) values ('evidence','evidence', false)
  on conflict (id) do nothing;

do $$ begin
  create policy evidence_read on storage.objects for select to authenticated
    using (bucket_id = 'evidence' and (storage.foldername(name))[1] = public.auth_org_id()::text);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy evidence_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = public.auth_org_id()::text);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy evidence_delete on storage.objects for delete to authenticated
    using (bucket_id = 'evidence' and (storage.foldername(name))[1] = public.auth_org_id()::text);
exception when duplicate_object then null; end $$;

-- ── 2. Evidence table ──────────────────────────────────────────────────────
create table if not exists public.evidence (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  dispute_id    uuid not null references public.disputes(id) on delete cascade,
  storage_path  text not null,
  filename      text not null,
  mime          text,
  byte_size     bigint,
  status        text not null default 'uploaded',  -- uploaded | scanning | scanned | error
  extracted_text text,
  summary       jsonb,                              -- {one_liner, facts[], dates[], amounts[], relevance:[{code,note}]}
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists evidence_dispute on public.evidence(dispute_id);
alter table public.evidence enable row level security;
do $$ begin
  create policy ev_read on public.evidence for select to authenticated
    using (public.auth_org_id() is null or org_id = public.auth_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ev_write on public.evidence for all to authenticated
    using (org_id = public.auth_org_id()) with check (org_id = public.auth_org_id());
exception when duplicate_object then null; end $$;

-- ── 3. RPCs ────────────────────────────────────────────────────────────────
create or replace function public.add_evidence(p_dispute uuid, p_path text, p_filename text, p_mime text, p_size bigint)
returns uuid language plpgsql security definer set search_path to 'public' as $fn$
declare d record; ev_id uuid;
begin
  select * into d from disputes where id = p_dispute;
  if not found then raise exception 'dispute not found'; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  insert into evidence(org_id, dispute_id, storage_path, filename, mime, byte_size, status)
    values (d.org_id, p_dispute, p_path, p_filename, p_mime, p_size, 'uploaded')
    returning id into ev_id;
  return ev_id;
end $fn$;

create or replace function public.list_evidence(p_dispute uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'filename', filename, 'mime', mime, 'status', status,
    'summary', summary, 'error', error, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
  from evidence where dispute_id = p_dispute
    and (public.auth_org_id() is null or org_id = public.auth_org_id());
$fn$;

create or replace function public.delete_evidence(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare e record;
begin
  select * into e from evidence where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public.auth_org_id() is not null and e.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  delete from storage.objects where bucket_id = 'evidence' and name = e.storage_path;
  delete from evidence where id = p_id;
  return jsonb_build_object('ok', true);
end $fn$;

grant execute on function
  public.add_evidence(uuid, text, text, text, bigint),
  public.list_evidence(uuid),
  public.delete_evidence(uuid)
to authenticated;

-- ── 4. build_doc_context: add {{exhibits}} token ───────────────────────────
create or replace function public.build_doc_context(p_dispute uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare d record; q record; ctx jsonb; fmt_money text := 'FM$999,999,990'; bench text;
  ex record; exi int := 0; ex_html text := ''; exhibits text := '';
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

  for ex in select filename, summary from evidence
    where dispute_id = p_dispute and status = 'scanned' order by created_at loop
    exi := exi + 1;
    ex_html := ex_html || '<li>Exhibit ' || chr(64 + least(exi,26)) || ' — ' || ex.filename ||
      case when coalesce(ex.summary->>'one_liner','') <> '' then ' (' || (ex.summary->>'one_liner') || ')' else '' end || '</li>';
  end loop;
  if ex_html <> '' then exhibits := '<ul class="exhibits">' || ex_html || '</ul>'; end if;

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
    'qpa', jsonb_build_object('methodology', coalesce(q.methodology,'median of contracted rates'), 'benchmark_table', bench),
    'exhibits', exhibits
  );
  return ctx;
end $fn$;

-- ── 5. render_template: add has_evidence flag ──────────────────────────────
create or replace function public.render_template(p_dispute uuid, p_code text, p_answers jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  d record; t record; ctx jsonb; flags jsonb := '{}'::jsonb; answers jsonb;
  findings jsonb := '[]'::jsonb; fr record; idx int := 0; nev int := 0;
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
  select count(*) into nev from evidence where dispute_id = p_dispute and status='scanned';
  flags := jsonb_set(flags, '{has_evidence}', to_jsonb(nev > 0), true);
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

-- ── 6. Exhibit clause on the global challenge + position templates ──────────
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, 88, 'exhibits',
  '<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}',
  '{"flag":"has_evidence"}'::jsonb, null
from public.document_templates t
where t.org_id is null and t.code in ('challenge_letter','position_statement')
on conflict (template_id, key) do update set body = excluded.body, include_when = excluded.include_when, seq = excluded.seq;
