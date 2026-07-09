-- ============================================================================
-- Avertyn — CMS Federal IDR "Gateway" deep-integration connector
-- Migration: idr_gateway_connector
--
-- ADDITIVE ONLY. Creates new tables, enums, RLS policies, RPCs, and seeds a few
-- action_types. Does NOT alter or drop any existing object or data.
--
-- Grounded against the LIVE Avertyn schema (project ref ssjougrsaecdwfuxeasd):
--   * auth_org_id()  = select org_id from app_users where id = auth.uid()
--     -> app_users.id IS the auth user id; resolve the current user via auth.uid()
--   * execute_action(p_action,p_dispute,p_params,p_actor,p_idempotency,
--                    p_rationale,p_citations,p_dry_run) returns jsonb
--   * action_log(org_id,dispute_id,action_type,actor,params,effect,
--                idempotency_key,rationale,citations,prev_hash,row_hash,created_at)
--   * audit_log(org_id,dispute_id,actor_user_id,action,detail,created_at)
--   * disputes already carries external_ref, workflow_state, disposition,
--     respond_by, pay_by, idr_registration_number, plan_legal_name,
--     sponsor_legal_name, carc, rarc
--   * deadlines(org_id,dispute_id,kind,due_at,status)
--
-- Governance: submission approval/push write a real ledger entry to action_log
-- (mirroring execute_action's own tail insert), and a confirmed offer push is
-- routed through the existing `submit_response` kernel action so it lands an
-- offer + advances the dispute — not a stub.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type idr_adapter as enum (
    'assisted_browser','autonomous_rpa','report_ingest','email_event','api');
exception when duplicate_object then null; end $$;

do $$ begin
  create type idr_conn_status as enum ('inactive','pending_verify','active','error','suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type idr_event_kind as enum (
    'dispute_discovered','status_changed','deadline_set','offer_recorded',
    'determination_issued','document_available','registry_updated','error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type idr_submission_kind as enum (
    'open_negotiation_notice','initiate_dispute','respond_to_dispute','submit_offer',
    'upload_document','select_idre','eligibility_objection','payment_confirmation');
exception when duplicate_object then null; end $$;

do $$ begin
  create type idr_submission_status as enum (
    'draft','needs_review','queued','in_flight','confirmed','failed','canceled');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 1. idr_connections
-- ----------------------------------------------------------------------------
create table if not exists public.idr_connections (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  adapter           idr_adapter not null default 'assisted_browser',
  status            idr_conn_status not null default 'inactive',
  gateway_org_id    text,
  registration_no   text,
  legal_name        text,
  plan_type         text,
  credential_ref    text,                 -- opaque vault pointer; never a secret
  poll_interval_sec integer not null default 900 check (poll_interval_sec >= 60),
  last_sync_at      timestamptz,
  last_ok_at        timestamptz,
  sync_cursor       jsonb not null default '{}'::jsonb,
  capabilities      jsonb not null default '{}'::jsonb,
  config            jsonb not null default '{}'::jsonb,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, adapter)
);
create index if not exists idr_connections_org_idx on public.idr_connections(org_id);

-- ----------------------------------------------------------------------------
-- 2. idr_sync_events  (append-only inbound spine)
-- ----------------------------------------------------------------------------
create table if not exists public.idr_sync_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  connection_id  uuid references public.idr_connections(id) on delete set null,
  kind           idr_event_kind not null,
  gateway_ref    text,
  dispute_id     uuid references public.disputes(id) on delete set null,
  dedupe_key     text not null,
  raw_payload    jsonb not null default '{}'::jsonb,
  normalized     jsonb not null default '{}'::jsonb,
  reconciled     boolean not null default false,
  observed_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index if not exists idr_sync_events_org_idx     on public.idr_sync_events(org_id, created_at desc);
create index if not exists idr_sync_events_dispute_idx on public.idr_sync_events(dispute_id);
create index if not exists idr_sync_events_unrecon_idx on public.idr_sync_events(org_id) where reconciled = false;

-- ----------------------------------------------------------------------------
-- 3. idr_submissions  (edit-in-app → review → push)
-- ----------------------------------------------------------------------------
create table if not exists public.idr_submissions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  connection_id  uuid references public.idr_connections(id) on delete set null,
  dispute_id     uuid references public.disputes(id) on delete set null,
  kind           idr_submission_kind not null,
  status         idr_submission_status not null default 'draft',
  payload        jsonb not null default '{}'::jsonb,
  action_log_id  uuid,
  prepared_by    uuid references public.app_users(id) on delete set null,
  approved_by    uuid references public.app_users(id) on delete set null,
  approved_at    timestamptz,
  gateway_receipt jsonb,
  attempts       integer not null default 0,
  last_error     text,
  due_at         timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idr_submissions_org_idx     on public.idr_submissions(org_id, status);
create index if not exists idr_submissions_dispute_idx on public.idr_submissions(dispute_id);
create index if not exists idr_submissions_queued_idx  on public.idr_submissions(org_id) where status = 'queued';

-- ----------------------------------------------------------------------------
-- 4. idr_registry_lookups
-- ----------------------------------------------------------------------------
create table if not exists public.idr_registry_lookups (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  registration_no  text not null,
  legal_name       text,
  plan_type        text,
  route            text,     -- 'federal' | 'state:<XX>'
  source           text,
  payload          jsonb not null default '{}'::jsonb,
  looked_up_at     timestamptz not null default now(),
  unique (org_id, registration_no)
);
create index if not exists idr_registry_lookups_org_idx on public.idr_registry_lookups(org_id);

-- ----------------------------------------------------------------------------
-- updated_at touch
-- ----------------------------------------------------------------------------
create or replace function public.idr_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists idr_connections_touch on public.idr_connections;
create trigger idr_connections_touch before update on public.idr_connections
  for each row execute function public.idr_touch_updated_at();

drop trigger if exists idr_submissions_touch on public.idr_submissions;
create trigger idr_submissions_touch before update on public.idr_submissions
  for each row execute function public.idr_touch_updated_at();

-- ============================================================================
-- RLS — identical hard org isolation to the rest of the schema
-- ============================================================================
alter table public.idr_connections     enable row level security;
alter table public.idr_sync_events      enable row level security;
alter table public.idr_submissions      enable row level security;
alter table public.idr_registry_lookups enable row level security;

do $$
declare t text;
begin
  foreach t in array array['idr_connections','idr_sync_events','idr_submissions','idr_registry_lookups'] loop
    execute format($f$
      drop policy if exists %1$s_rw on public.%1$s;
      create policy %1$s_rw on public.%1$s
        using (org_id = auth_org_id()) with check (org_id = auth_org_id());
    $f$, t);
  end loop;
end $$;

-- ============================================================================
-- Action types for the ledger (governance vocabulary for connector pushes)
-- ============================================================================
insert into public.action_types(code, name, description, object_kind, money_out) values
  ('idr_push',    'Push to CMS IDR Gateway', 'Submit a staged artifact to the Federal IDR Gateway (offer, notice, objection, document).', 'dispute', false),
  ('idr_sync_in', 'Sync from CMS IDR Gateway', 'Fold an observed Gateway event into disputes/deadlines.', 'dispute', false)
on conflict (code) do nothing;

-- ============================================================================
-- Internal helper: write a genuine ledger + audit entry (mirrors execute_action)
-- ============================================================================
create or replace function public.idr_ledger_write(
  p_org uuid, p_dispute uuid, p_action text, p_params jsonb, p_effect jsonb,
  p_rationale text default null, p_idempotency text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.action_log(org_id, dispute_id, action_type, actor, params, effect, idempotency_key, rationale, citations)
    values(p_org, p_dispute, p_action, 'idr_connector', coalesce(p_params,'{}'::jsonb),
           coalesce(p_effect,'{}'::jsonb), p_idempotency, p_rationale, '[]'::jsonb)
    returning id into v_id;
  insert into public.audit_log(org_id, dispute_id, actor_user_id, action, detail)
    values(p_org, p_dispute, auth.uid(), 'action:'||p_action, coalesce(p_effect,'{}'::jsonb));
  return v_id;
end $$;

-- ============================================================================
-- RPCs
-- ============================================================================

create or replace function public.idr_connection_upsert(
  p_adapter idr_adapter, p_gateway_org_id text default null, p_registration_no text default null,
  p_legal_name text default null, p_plan_type text default null, p_credential_ref text default null,
  p_poll_interval integer default 900, p_config jsonb default '{}'::jsonb
) returns public.idr_connections
language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); r public.idr_connections;
begin
  if v_org is null then raise exception 'no org in context'; end if;
  insert into public.idr_connections
    (org_id, adapter, gateway_org_id, registration_no, legal_name, plan_type,
     credential_ref, poll_interval_sec, config, status)
  values
    (v_org, p_adapter, p_gateway_org_id, p_registration_no, p_legal_name, p_plan_type,
     p_credential_ref, greatest(coalesce(p_poll_interval,900),60), coalesce(p_config,'{}'::jsonb), 'pending_verify')
  on conflict (org_id, adapter) do update set
     gateway_org_id=excluded.gateway_org_id, registration_no=excluded.registration_no,
     legal_name=excluded.legal_name, plan_type=excluded.plan_type,
     credential_ref=coalesce(excluded.credential_ref, public.idr_connections.credential_ref),
     poll_interval_sec=excluded.poll_interval_sec, config=excluded.config, updated_at=now()
  returning * into r;
  return r;
end $$;

-- Ingest one normalized inbound event (idempotent on dedupe_key).
create or replace function public.idr_ingest_event(
  p_connection_id uuid, p_kind idr_event_kind, p_dedupe_key text, p_gateway_ref text default null,
  p_raw jsonb default '{}'::jsonb, p_normalized jsonb default '{}'::jsonb, p_observed_at timestamptz default now()
) returns public.idr_sync_events
language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); v_dispute uuid; r public.idr_sync_events;
begin
  if v_org is null then raise exception 'no org in context'; end if;
  if p_gateway_ref is not null then
    select id into v_dispute from public.disputes where org_id = v_org and external_ref = p_gateway_ref limit 1;
  end if;
  insert into public.idr_sync_events
    (org_id, connection_id, kind, gateway_ref, dispute_id, dedupe_key, raw_payload, normalized, observed_at)
  values
    (v_org, p_connection_id, p_kind, p_gateway_ref, v_dispute, p_dedupe_key,
     coalesce(p_raw,'{}'::jsonb), coalesce(p_normalized,'{}'::jsonb), coalesce(p_observed_at, now()))
  on conflict (org_id, dedupe_key) do nothing
  returning * into r;
  if r.id is null then
    select * into r from public.idr_sync_events where org_id = v_org and dedupe_key = p_dedupe_key;
  end if;
  update public.idr_connections
     set last_sync_at = now(), last_ok_at = now(), status = 'active', last_error = null
   where id = p_connection_id and org_id = v_org;
  return r;
end $$;

-- Fold an ingested event into operations (replayable, ledger-logged).
create or replace function public.idr_reconcile_event(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); e public.idr_sync_events; v_eff jsonb := '{}'::jsonb;
begin
  select * into e from public.idr_sync_events where id = p_event_id and org_id = v_org;
  if e.id is null then raise exception 'event not found'; end if;
  if e.reconciled then return; end if;

  if e.kind = 'deadline_set' and e.dispute_id is not null then
    insert into public.deadlines (org_id, dispute_id, kind, due_at, status)
    values (v_org, e.dispute_id, coalesce(e.normalized->>'deadline_kind','response'),
            (e.normalized->>'due_at')::timestamptz, 'open');
    v_eff := jsonb_build_object('deadline', e.normalized->>'deadline_kind', 'due_at', e.normalized->>'due_at');

  elsif e.kind = 'status_changed' and e.dispute_id is not null then
    update public.disputes set workflow_state = coalesce(e.normalized->>'workflow_state', workflow_state)
     where id = e.dispute_id and org_id = v_org;
    v_eff := jsonb_build_object('workflow_state', e.normalized->>'workflow_state');

  elsif e.kind = 'determination_issued' and e.dispute_id is not null then
    update public.disputes set disposition = coalesce(e.normalized->>'disposition', disposition)
     where id = e.dispute_id and org_id = v_org;
    v_eff := jsonb_build_object('disposition', e.normalized->>'disposition');

  elsif e.kind = 'registry_updated' and e.dispute_id is not null then
    update public.disputes set
        idr_registration_number = coalesce(e.normalized->>'registration_no', idr_registration_number),
        plan_legal_name         = coalesce(e.normalized->>'legal_name', plan_legal_name)
     where id = e.dispute_id and org_id = v_org;
    v_eff := jsonb_build_object('registration_no', e.normalized->>'registration_no');
  end if;

  if e.dispute_id is not null then
    perform public.idr_ledger_write(v_org, e.dispute_id, 'idr_sync_in', e.normalized, v_eff, 'inbound Gateway event: '||e.kind);
  end if;
  update public.idr_sync_events set reconciled = true where id = p_event_id;
end $$;

-- Stage a new outbound submission (in-app editing entry point).
create or replace function public.idr_stage_submission(
  p_dispute_id uuid, p_kind idr_submission_kind, p_payload jsonb default '{}'::jsonb, p_due_at timestamptz default null
) returns public.idr_submissions
language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); v_conn uuid; r public.idr_submissions;
begin
  if v_org is null then raise exception 'no org in context'; end if;
  select id into v_conn from public.idr_connections
    where org_id = v_org and status <> 'inactive' order by updated_at desc limit 1;
  insert into public.idr_submissions
    (org_id, connection_id, dispute_id, kind, payload, due_at, status, prepared_by)
  values
    (v_org, v_conn, p_dispute_id, p_kind, coalesce(p_payload,'{}'::jsonb), p_due_at, 'draft',
     (select id from public.app_users where id = auth.uid()))
  returning * into r;
  return r;
end $$;

-- Advance a staged submission. Approval (-> queued) and push (-> confirmed) are
-- governed: they write a ledger entry, and a confirmed offer is routed through
-- the real `submit_response` kernel action.
create or replace function public.idr_advance_submission(
  p_submission_id uuid, p_to idr_submission_status, p_patch jsonb default null,
  p_receipt jsonb default null, p_error text default null
) returns public.idr_submissions
language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); s public.idr_submissions; r public.idr_submissions;
        v_log uuid; v_amt numeric;
begin
  select * into s from public.idr_submissions where id = p_submission_id and org_id = v_org;
  if s.id is null then raise exception 'submission not found'; end if;

  if p_patch is not null and s.status in ('draft','needs_review') then
    update public.idr_submissions set payload = payload || p_patch where id = s.id;
    select * into s from public.idr_submissions where id = s.id;
  end if;

  -- Governance on approval: ledger the intent to push.
  if p_to = 'queued' and s.dispute_id is not null then
    v_log := public.idr_ledger_write(v_org, s.dispute_id, 'idr_push', s.payload,
             jsonb_build_object('kind', s.kind, 'stage','approved'),
             'operator approved IDR submission '||s.kind);
  end if;

  -- Governance on confirmation: for offer/response kinds, run the real kernel
  -- action so a confirmed push actually records the plan offer + advances state.
  if p_to = 'confirmed' and s.dispute_id is not null then
    if s.kind in ('submit_offer','respond_to_dispute') then
      v_amt := nullif(s.payload->>'amount','')::numeric;
      perform public.execute_action('submit_response', s.dispute_id,
              jsonb_build_object('amount', v_amt), 'idr_connector',
              'idr_confirm_'||s.id::text, 'confirmed IDR offer push', '[]'::jsonb, false);
    end if;
    v_log := public.idr_ledger_write(v_org, s.dispute_id, 'idr_push',
             coalesce(p_receipt,'{}'::jsonb),
             jsonb_build_object('kind', s.kind, 'stage','confirmed'),
             'IDR Gateway confirmed submission '||s.kind);
  end if;

  update public.idr_submissions
     set status = p_to,
         action_log_id = coalesce(v_log, action_log_id),
         approved_by = case when p_to = 'queued' then (select id from public.app_users where id = auth.uid()) else approved_by end,
         approved_at = case when p_to = 'queued' then now() else approved_at end,
         gateway_receipt = coalesce(p_receipt, gateway_receipt),
         attempts = attempts + case when p_to = 'in_flight' then 1 else 0 end,
         last_error = case when p_to = 'failed' then p_error else last_error end
   where id = s.id
   returning * into r;
  return r;
end $$;

-- Cache a payer-registry / registration-number lookup.
create or replace function public.idr_registry_upsert(
  p_registration_no text, p_legal_name text default null, p_plan_type text default null,
  p_route text default null, p_source text default 'gateway_registry', p_payload jsonb default '{}'::jsonb
) returns public.idr_registry_lookups
language plpgsql security definer set search_path = public as $$
declare v_org uuid := auth_org_id(); r public.idr_registry_lookups;
begin
  if v_org is null then raise exception 'no org in context'; end if;
  insert into public.idr_registry_lookups
    (org_id, registration_no, legal_name, plan_type, route, source, payload)
  values (v_org, p_registration_no, p_legal_name, p_plan_type, p_route, p_source, coalesce(p_payload,'{}'::jsonb))
  on conflict (org_id, registration_no) do update set
    legal_name = coalesce(excluded.legal_name, public.idr_registry_lookups.legal_name),
    plan_type  = coalesce(excluded.plan_type,  public.idr_registry_lookups.plan_type),
    route      = coalesce(excluded.route,       public.idr_registry_lookups.route),
    source     = excluded.source, payload = excluded.payload, looked_up_at = now()
  returning * into r;
  return r;
end $$;

-- Grants (project uses the standard authenticated role).
grant execute on function public.idr_connection_upsert(idr_adapter,text,text,text,text,text,integer,jsonb) to authenticated;
grant execute on function public.idr_ingest_event(uuid,idr_event_kind,text,text,jsonb,jsonb,timestamptz) to authenticated;
grant execute on function public.idr_reconcile_event(uuid) to authenticated;
grant execute on function public.idr_stage_submission(uuid,idr_submission_kind,jsonb,timestamptz) to authenticated;
grant execute on function public.idr_advance_submission(uuid,idr_submission_status,jsonb,jsonb,text) to authenticated;
grant execute on function public.idr_registry_upsert(text,text,text,text,text,jsonb) to authenticated;

commit;
