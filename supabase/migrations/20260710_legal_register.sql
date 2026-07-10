-- Avertyn — Living Legal Register
-- Central, versioned registry of the regulations/citations that underpin the templates,
-- so an AI currency check can keep them current and every brief cites the latest verified
-- authority. Templates reference citations by {{cite.CODE}} token instead of hardcoding them.
-- Hybrid updates: low-risk changes (renumber / effective-date / source) auto-apply; substantive
-- changes (superseded / new standard) are held as proposals for human review.

-- ── 1. Registry + revision (proposal/changelog) tables ─────────────────────
create table if not exists public.legal_authorities (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,        -- e.g. 'NSA_OPEN_NEG'
  citation      text not null,               -- current CFR cite, rendered by {{cite.CODE}}
  mirrors       text,                         -- 26 CFR / 29 CFR mirrors
  topic         text,
  summary       text,                         -- one-line rule statement
  source_url    text,
  status        text not null default 'unverified',  -- verified | flagged | superseded | pending | unverified
  operative     boolean not null default true,
  effective_note text,
  confidence    numeric,
  last_verified_at timestamptz,
  verified_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.authority_revisions (
  id            uuid primary key default gen_random_uuid(),
  authority_code text not null,
  field         text not null,               -- citation | summary | status | effective_note | source_url | mirrors | operative
  old_value     text,
  new_value     text,
  kind          text,                         -- renumber | effective_date | source | mirrors | supersede | new_standard | operative_change | other
  risk          text not null default 'substantive', -- low | substantive
  rationale     text,
  source_url    text,
  confidence    numeric,
  state         text not null default 'proposed',    -- proposed | auto_applied | approved | dismissed
  proposed_by   text,
  proposed_at   timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz
);
create index if not exists authority_revisions_open on public.authority_revisions(state, proposed_at desc);

alter table public.legal_authorities enable row level security;
alter table public.authority_revisions enable row level security;
do $$ begin
  create policy la_read on public.legal_authorities for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ar_read on public.authority_revisions for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- link eligibility rules to the registry (keeps the challenge-letter ground cites in sync)
alter table public.eligibility_rules add column if not exists authority_code text;

-- ── 2. Seed the verified authorities (eCFR-checked 2026-07-10) ──────────────
insert into public.legal_authorities (code,citation,mirrors,topic,summary,source_url,status,operative,effective_note,confidence,last_verified_at,verified_by)
values
 ('NSA_IDR_GENERAL','45 CFR §149.510','26 CFR §54.9816-8T; 29 CFR §2590.716-8','Federal IDR process','The Federal Independent Dispute Resolution process for determining out-of-network rates.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,null,0.95,now(),'ai:research-2026-07-10'),
 ('NSA_OPEN_NEG','45 CFR §149.510(b)(1)','26 CFR §54.9816-8T(b)(1); 29 CFR §2590.716-8(b)(1)','Open negotiation','A 30-business-day open-negotiation period must precede Federal IDR.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,null,0.95,now(),'ai:research-2026-07-10'),
 ('NSA_IDR_INIT_WINDOW','45 CFR §149.510(b)(2)(i)','26 CFR §54.9816-8T(b)(2); 29 CFR §2590.716-8(b)(2)','IDR initiation window','IDR must be initiated in the 4-business-day window beginning on the 31st business day after open negotiation starts.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,null,0.95,now(),'ai:research-2026-07-10'),
 ('NSA_IDRE_SELECT','45 CFR §149.510(c)(1)(ii)','26 CFR §54.9816-8T(c)(1); 29 CFR §2590.716-8(c)(1)','IDRE selection & objection','Parties jointly select a certified IDR entity; a party may object to the proposed entity for conflict of interest, triggering reselection.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,'2026 Operations rule adds a two-step preliminary/final selection with a COI-verification window; not operative until portal guidance.',0.9,now(),'ai:research-2026-07-10'),
 ('NSA_IDRE_COI','45 CFR §149.510(a)(2)(iv)','26 CFR §54.9816-8T(a)(2)(iv); 29 CFR §2590.716-8(a)(2)(iv)','IDRE conflict of interest','A certified IDR entity may not be a party, an affiliate of a party or trade association, or have a material familial, financial, or professional relationship.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,null,0.9,now(),'ai:research-2026-07-10'),
 ('NSA_QPA_FACTORS','45 CFR §149.510(c)(4)(iii)','26 CFR §54.9816-8T(c)(4)(iii); 29 CFR §2590.716-8(c)(4)(iii)','IDR consideration of factors','The certified IDR entity must first consider the QPA, then weigh the additional statutory factors; no factor, including the QPA, is controlling.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,'QPA is not a rebuttable presumption (Texas Medical Association litigation vacated that standard).',0.95,now(),'ai:research-2026-07-10'),
 ('NSA_PAYMENT_WINDOW','45 CFR §149.510(c)(4)(ix)','26 CFR §54.9816-8T(c)(4)(ix); 29 CFR §2590.716-8(c)(4)(ix)','Payment after determination','The selected offer amount must be paid within 30 calendar days after the certified IDR entity determination.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,null,0.95,now(),'ai:research-2026-07-10'),
 ('NSA_BATCHING','45 CFR §149.510(c)(3)','26 CFR §54.9816-8T(c)(3); 29 CFR §2590.716-8(c)(3)','Batching conditions','Items may be batched only where they share the same provider/facility, same plan/issuer, same or similar service code, and the same batching period.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,'2026 Operations rule adds a 50-line-item cap and revised batching scenarios; not operative until portal guidance.',0.9,now(),'ai:research-2026-07-10'),
 ('NSA_QUALIFIED_ITEM','45 CFR §149.510(a)(2)','26 CFR §54.9816-8T(a)(2); 29 CFR §2590.716-8(a)(2)','Qualified IDR item','Federal IDR applies only to qualified IDR items and services not governed by a specified State law or All-Payer Model Agreement.','https://www.ecfr.gov/current/title-45/section-149.510','verified',true,'Operative jurisdiction clause is at §149.510(a)(2)(xi); confirm the exact clause number in the printed eCFR copy.',0.85,now(),'ai:research-2026-07-10'),
 ('NSA_STATE_DEFS','45 CFR §149.30','26 CFR §54.9816-3T; 29 CFR §2590.716-3','Specified State law / All-Payer','Definitions of specified State law, All-Payer Model Agreement, and recognized amount.','https://www.ecfr.gov/current/title-45/section-149.30','verified',true,null,0.95,now(),'ai:research-2026-07-10'),
 ('NSA_QPA_DISCLOSURE','45 CFR §149.140(d)(1)','26 CFR §54.9816-6T(d); 29 CFR §2590.716-6(d)','QPA disclosure','The plan must disclose the QPA and required information with each initial payment or notice of denial, and further information on request.','https://www.ecfr.gov/current/title-45/section-149.140','verified',true,null,0.9,now(),'ai:research-2026-07-10'),
 ('NSA_QPA_DOWNCODE','45 CFR §149.140(d)(1)(ii)','26 CFR §54.9816-6T(d); 29 CFR §2590.716-6(d)','QPA downcoding disclosure','If a service code or modifier was downcoded, the plan must disclose that it was downcoded, what changed, and the QPA absent downcoding.','https://www.ecfr.gov/current/title-45/section-149.140','verified',true,null,0.9,now(),'ai:research-2026-07-10'),
 ('NSA_COSTSHARE_EMERG','45 CFR §149.110(b)(3)(iii)','26 CFR §54.9816-4T(c)(3)(iii); 29 CFR §2590.716-4(c)(3)(iii)','Emergency cost-sharing','Patient cost-sharing for emergency services is calculated on the recognized amount.','https://www.ecfr.gov/current/title-45/section-149.110','verified',true,null,0.9,now(),'ai:research-2026-07-10'),
 ('NSA_COSTSHARE_NONEMERG','45 CFR §149.120(c)(2)','26 CFR §54.9816-5T(c)(2); 29 CFR §2590.716-5(c)(2)','Non-emergency cost-sharing','Cost-sharing for non-emergency services at a participating facility is calculated on the recognized amount.','https://www.ecfr.gov/current/title-45/section-149.120','verified',true,null,0.9,now(),'ai:research-2026-07-10'),
 ('NSA_COMPLAINT_PROVIDER','45 CFR §149.450',null,'Balance-billing complaints','Federal complaint process for provider, facility, and air-ambulance balance-billing violations.','https://www.ecfr.gov/current/title-45/section-149.450','verified',true,null,0.85,now(),'ai:research-2026-07-10'),
 ('NSA_ENFORCE_PLAN','PHS Act §2723 (42 U.S.C. §300gg-22); 45 CFR part 150',null,'Plan enforcement','Enforcement of plan/issuer No Surprises Act duties, including IDR payment and QPA disclosure.','https://www.ecfr.gov/current/title-45/part-150','verified',true,null,0.8,now(),'ai:research-2026-07-10'),
 ('NSA_2026_OPERATIONS','2026 Federal IDR Operations final rule (RIN 2026-11140, 91 FR)',null,'2026 IDR Operations rule','Overhauls IDR selection/COI, extensions, batching, CARC/RARC QPA communication, and the registry.','https://www.federalregister.gov/documents/2026/06/04/2026-11140/federal-independent-dispute-resolution-operations','pending',false,'Effective Aug 3, 2026, but key operational provisions each trigger ~90 business days after CMS portal guidance (phased up to 24 months). Not operative yet — do not cite as controlling.',0.9,now(),'ai:research-2026-07-10')
on conflict (code) do update set
  citation=excluded.citation, mirrors=excluded.mirrors, topic=excluded.topic, summary=excluded.summary,
  source_url=excluded.source_url, status=excluded.status, operative=excluded.operative,
  effective_note=excluded.effective_note, confidence=excluded.confidence,
  last_verified_at=excluded.last_verified_at, verified_by=excluded.verified_by, updated_at=now();

-- link the 7 eligibility rules to their registry codes
update public.eligibility_rules set authority_code = m.code from (values
  ('ON_NEG_INCOMPLETE','NSA_OPEN_NEG'),('TF_INITIATION','NSA_IDR_INIT_WINDOW'),
  ('JUR_STATE','NSA_QUALIFIED_ITEM'),('QI_NOT_QUALIFIED','NSA_QUALIFIED_ITEM'),
  ('DUP_LINE','NSA_QUALIFIED_ITEM'),('BATCH_CAP','NSA_BATCHING'),('COST_SHARE','NSA_COSTSHARE_NONEMERG')
) as m(rule,code) where eligibility_rules.code = m.rule;

-- ── 3. build_doc_context: expose {{cite.CODE}} tokens ──────────────────────
create or replace function public.build_doc_context(p_dispute uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare d record; q record; ctx jsonb; fmt_money text := 'FM$999,999,990'; bench text;
  ex record; exi int := 0; ex_html text := ''; exhibits text := ''; cite_obj jsonb;
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
  if q.benchmark_fairhealth is not null then bench := bench || '<tr><td>FAIR Health regional benchmark</td><td>' || to_char(q.benchmark_fairhealth, fmt_money) || '</td></tr>'; end if;
  if q.benchmark_medicare_mult is not null then bench := bench || '<tr><td>Medicare-based reference</td><td>' || to_char(q.benchmark_medicare_mult, fmt_money) || '</td></tr>'; end if;
  if q.defensible_ceiling is not null then bench := bench || '<tr><td>Defensible ceiling (max concession)</td><td>' || to_char(q.defensible_ceiling, fmt_money) || '</td></tr>'; end if;
  if d.demand_amount is not null then bench := bench || '<tr><td>Initiating party demand</td><td>' || to_char(d.demand_amount, fmt_money) || '</td></tr>'; end if;
  bench := bench || '</tbody></table>';

  for ex in select filename, summary from evidence where dispute_id = p_dispute and status = 'scanned' order by created_at loop
    exi := exi + 1;
    ex_html := ex_html || '<li>Exhibit ' || chr(64 + least(exi,26)) || ' — ' || ex.filename ||
      case when coalesce(ex.summary->>'one_liner','') <> '' then ' (' || (ex.summary->>'one_liner') || ')' else '' end || '</li>';
  end loop;
  if ex_html <> '' then exhibits := '<ul class="exhibits">' || ex_html || '</ul>'; end if;

  select jsonb_object_agg(code, citation) into cite_obj from legal_authorities;

  ctx := jsonb_build_object(
    'dispute', jsonb_build_object(
      'external_ref', coalesce(d.external_ref,''), 'cpt_code', coalesce(d.cpt_code,''),
      'service_category', coalesce(d.service_category,''), 'idr_registration_number', coalesce(d.idr_registration_number,''),
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
      'fairhealth', case when q.benchmark_fairhealth is null then '—' else to_char(q.benchmark_fairhealth, fmt_money) end,
      'contracted_median', case when q.contracted_median is null then '—' else to_char(q.contracted_median, fmt_money) end),
    'date', jsonb_build_object(
      'today', to_char(now() at time zone 'America/New_York', 'FMMonth FMDD, YYYY'),
      'service', case when d.service_date is null then '—' else to_char(d.service_date, 'FMMonth FMDD, YYYY') end,
      'respond_by', case when d.respond_by is null then '—' else to_char(d.respond_by, 'FMMonth FMDD, YYYY') end),
    'qpa', jsonb_build_object('methodology', coalesce(q.methodology,'median of contracted rates'), 'benchmark_table', bench),
    'exhibits', exhibits,
    'cite', coalesce(cite_obj, '{}'::jsonb)
  );
  return ctx;
end $fn$;

-- ── 4. Re-point template clauses to {{cite.CODE}} tokens (specific → general) ─
do $$
declare pairs text[][] := array[
  ['45 CFR §149.510(c)(4)(iii)','{{cite.NSA_QPA_FACTORS}}'],
  ['45 CFR §149.510(c)(4)(ix)','{{cite.NSA_PAYMENT_WINDOW}}'],
  ['45 CFR §149.510(a)(2)(iv)','{{cite.NSA_IDRE_COI}}'],
  ['45 CFR §149.510(c)(1)(ii)','{{cite.NSA_IDRE_SELECT}}'],
  ['§149.510(c)(1)(ii)','{{cite.NSA_IDRE_SELECT}}'],
  ['45 CFR §149.510(c)(3)','{{cite.NSA_BATCHING}}'],
  ['45 CFR §149.510(b)(2)(i)','{{cite.NSA_IDR_INIT_WINDOW}}'],
  ['§149.510(b)(2)(i)','{{cite.NSA_IDR_INIT_WINDOW}}'],
  ['45 CFR §149.510(b)(1)','{{cite.NSA_OPEN_NEG}}'],
  ['45 CFR §149.510(a)(2)','{{cite.NSA_QUALIFIED_ITEM}}'],
  ['45 CFR §149.140(d)(1)(ii)','{{cite.NSA_QPA_DOWNCODE}}'],
  ['45 CFR §149.140(d)(1)','{{cite.NSA_QPA_DISCLOSURE}}'],
  ['45 CFR §149.110(b)(3)(iii)','{{cite.NSA_COSTSHARE_EMERG}}'],
  ['§149.120(c)(2)','{{cite.NSA_COSTSHARE_NONEMERG}}'],
  ['§149.30','{{cite.NSA_STATE_DEFS}}'],
  ['45 CFR §149.510','{{cite.NSA_IDR_GENERAL}}']
];
  i int;
begin
  for i in 1 .. array_length(pairs,1) loop
    update public.template_clauses c
      set body = replace(body, pairs[i][1], pairs[i][2])
      from public.document_templates t
      where c.template_id = t.id and t.org_id is null and c.body like '%'||pairs[i][1]||'%';
  end loop;
end $$;

-- ── 5. Render + hybrid-apply RPCs ──────────────────────────────────────────
-- internal: apply one field change to an authority (+ sync eligibility_rules citation)
create or replace function public._apply_authority(p_code text, p_field text, p_value text, p_actor text)
returns void language plpgsql security definer set search_path to 'public' as $fn$
begin
  update legal_authorities set
    citation      = case when p_field='citation' then p_value else citation end,
    summary       = case when p_field='summary' then p_value else summary end,
    status        = case when p_field='status' then p_value else status end,
    effective_note= case when p_field='effective_note' then p_value else effective_note end,
    source_url    = case when p_field='source_url' then p_value else source_url end,
    mirrors       = case when p_field='mirrors' then p_value else mirrors end,
    operative     = case when p_field='operative' then (p_value='true') else operative end,
    last_verified_at = now(), verified_by = p_actor, updated_at = now()
   where code = p_code;
  if p_field='citation' then
    update eligibility_rules set authority = p_value where authority_code = p_code;
  end if;
end $fn$;

-- called by the AI check: record a proposed change; hybrid = low-risk auto-applies, else held for review
create or replace function public.propose_authority_change(
  p_code text, p_field text, p_new text, p_kind text, p_risk text,
  p_rationale text, p_source text, p_confidence numeric, p_by text default 'ai')
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare a record; rid uuid; st text;
begin
  select * into a from legal_authorities where code = p_code;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_authority'); end if;
  st := case when p_risk = 'low' then 'auto_applied' else 'proposed' end;
  insert into authority_revisions(authority_code,field,old_value,new_value,kind,risk,rationale,source_url,confidence,state,proposed_by)
   values (p_code,p_field,
     case p_field when 'citation' then a.citation when 'summary' then a.summary when 'status' then a.status
       when 'effective_note' then a.effective_note when 'source_url' then a.source_url when 'mirrors' then a.mirrors
       when 'operative' then a.operative::text else null end,
     p_new,p_kind,p_risk,p_rationale,p_source,p_confidence,st,p_by)
   returning id into rid;
  if p_risk = 'low' then
    perform public._apply_authority(p_code, p_field, p_new, p_by);
  else
    update legal_authorities set status='flagged', updated_at=now() where code=p_code;
  end if;
  return jsonb_build_object('ok', true, 'revision', rid, 'state', st);
end $fn$;

-- confirm no change (updates the last-verified stamp)
create or replace function public.mark_authority_verified(p_code text, p_confidence numeric, p_source text, p_by text default 'ai')
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
begin
  update legal_authorities set last_verified_at=now(), verified_by=p_by, confidence=coalesce(p_confidence,confidence),
    source_url=coalesce(p_source,source_url), status=case when status='flagged' then status else 'verified' end, updated_at=now()
   where code=p_code;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.decide_authority_revision(p_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare r record;
begin
  if public.auth_org_id() is not null and coalesce(public.auth_role(),'') <> 'admin' then raise exception 'admin role required'; end if;
  select * into r from authority_revisions where id = p_id and state = 'proposed';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;
  if p_decision = 'approve' then
    perform public._apply_authority(r.authority_code, r.field, r.new_value, coalesce(public.auth_role(),'human'));
    update authority_revisions set state='approved', decided_by=coalesce(public.auth_role(),'human'), decided_at=now() where id=p_id;
    update legal_authorities set status='verified' where code=r.authority_code
      and not exists (select 1 from authority_revisions x where x.authority_code=r.authority_code and x.state='proposed' and x.id<>p_id);
  elsif p_decision = 'dismiss' then
    update authority_revisions set state='dismissed', decided_by=coalesce(public.auth_role(),'human'), decided_at=now() where id=p_id;
    update legal_authorities set status='verified' where code=r.authority_code
      and not exists (select 1 from authority_revisions x where x.authority_code=r.authority_code and x.state='proposed' and x.id<>p_id);
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_decision');
  end if;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.list_authorities()
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code',code,'citation',citation,'mirrors',mirrors,'topic',topic,'summary',summary,'source_url',source_url,
    'status',status,'operative',operative,'effective_note',effective_note,'confidence',confidence,
    'last_verified_at',last_verified_at,'verified_by',verified_by) order by topic, code), '[]'::jsonb)
  from legal_authorities;
$fn$;

create or replace function public.list_authority_revisions(p_open_only boolean default true)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'authority_code',authority_code,'field',field,'old_value',old_value,'new_value',new_value,
    'kind',kind,'risk',risk,'rationale',rationale,'source_url',source_url,'confidence',confidence,
    'state',state,'proposed_by',proposed_by,'proposed_at',proposed_at,'decided_by',decided_by,'decided_at',decided_at)
    order by proposed_at desc), '[]'::jsonb)
  from authority_revisions
  where (not p_open_only) or state in ('proposed','auto_applied');
$fn$;

grant execute on function
  public.list_authorities(), public.list_authority_revisions(boolean),
  public.decide_authority_revision(uuid, text),
  public.propose_authority_change(text,text,text,text,text,text,text,numeric,text),
  public.mark_authority_verified(text,numeric,text,text)
to authenticated;
