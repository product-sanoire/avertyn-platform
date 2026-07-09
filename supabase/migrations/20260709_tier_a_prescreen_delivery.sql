-- Tier A: stateless eligibility pre-screen API + notification delivery rail
-- - prescreen_eligibility(jsonb): stateless scorer mirroring run_eligibility/rescore_dispute
-- - api_tokens + api_request_log: external API auth (hashed tokens, org-scoped)
-- - outbox_status_v: delivery-rail status surface for the Deadlines screen
-- Applied to the live Avertyn project (ref ssjougrsaecdwfuxeasd).

-- ------------------------------------------------------------------ pre-screen
-- Stateless eligibility scorer. Same rule catalog and scoring formula as the
-- stored-dispute engine (run_eligibility -> rescore_dispute), but evaluated
-- against a raw JSON claim so external callers can score BEFORE a dispute
-- exists. No org context, no writes.
create or replace function public.prescreen_eligibility(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  findings jsonb := '[]'::jsonb;
  n_disq int := 0;
  n_warn int := 0;
  s int;
  rec_action text;
  band text;
  v_jur text := lower(coalesce(p_payload->>'jurisdiction',''));
  v_carc text := nullif(p_payload->>'carc','');
  v_rarc text := nullif(p_payload->>'rarc','');
  nsa text;
  b_onneg boolean := (p_payload->>'open_negotiation_complete')::boolean;
  b_tf boolean := (p_payload->>'initiation_within_window')::boolean;
  b_qi boolean := (p_payload->>'qualified_item')::boolean;
  b_consent boolean := (p_payload->>'oon_consent')::boolean;
  v_batch int := (p_payload->>'batch_line_count')::int;
  b_costshare boolean := (p_payload->>'cost_share_at_qpa')::boolean;
  b_dup boolean := (p_payload->>'duplicate')::boolean;
  r_name text;
begin
  -- ON_NEG_INCOMPLETE (disqualifying)
  if b_onneg is not null then
    select name into r_name from eligibility_rules where code='ON_NEG_INCOMPLETE';
    if b_onneg = false then
      n_disq := n_disq + 1;
      findings := findings || jsonb_build_object('code','ON_NEG_INCOMPLETE','name',r_name,'severity','disqualifying','result','fail','detail','No valid 30-business-day open-negotiation notice on record.');
    else
      findings := findings || jsonb_build_object('code','ON_NEG_INCOMPLETE','name',r_name,'severity','disqualifying','result','pass','detail','Open-negotiation period completed.');
    end if;
  end if;

  -- TF_INITIATION (disqualifying)
  if b_tf is not null then
    select name into r_name from eligibility_rules where code='TF_INITIATION';
    if b_tf = false then
      n_disq := n_disq + 1;
      findings := findings || jsonb_build_object('code','TF_INITIATION','name',r_name,'severity','disqualifying','result','fail','detail','IDR initiated outside the 4-business-day window.');
    else
      findings := findings || jsonb_build_object('code','TF_INITIATION','name',r_name,'severity','disqualifying','result','pass','detail','Initiated within the 4-business-day window.');
    end if;
  end if;

  -- JUR_STATE (disqualifying)
  if v_jur <> '' then
    select name into r_name from eligibility_rules where code='JUR_STATE';
    if v_jur = 'state' then
      n_disq := n_disq + 1;
      findings := findings || jsonb_build_object('code','JUR_STATE','name',r_name,'severity','disqualifying','result','fail','detail','Claim belongs to a qualifying state IDR process — federal IDR would be dismissed.');
    elsif v_jur in ('federal','self_funded_erisa') then
      findings := findings || jsonb_build_object('code','JUR_STATE','name',r_name,'severity','disqualifying','result','pass','detail','Federal jurisdiction confirmed ('||v_jur||').');
    else
      findings := findings || jsonb_build_object('code','JUR_STATE','name',r_name,'severity','disqualifying','result','warn','detail','Jurisdiction unclear — verify federal vs. state IDR.');
    end if;
  end if;

  -- QI_NOT_QUALIFIED (disqualifying) — CARC/RARC signal or explicit flags
  select name into r_name from eligibility_rules where code='QI_NOT_QUALIFIED';
  if v_carc is not null or v_rarc is not null then
    nsa := public.classify_nsa(v_carc, v_rarc);
    if nsa = 'ineligible' then
      n_disq := n_disq + 1;
      findings := findings || jsonb_build_object('code','QI_NOT_QUALIFIED','name',r_name,'severity','disqualifying','result','fail','detail','NSA CARC/RARC signal indicates a non-qualified item ('||coalesce(v_carc,'—')||'/'||coalesce(v_rarc,'—')||').');
    elsif nsa = 'eligible' then
      findings := findings || jsonb_build_object('code','QI_NOT_QUALIFIED','name',r_name,'severity','disqualifying','result','pass','detail','NSA CARC/RARC signal indicates a protected OON item.');
    end if;
  elsif b_consent = true or b_qi = false then
    n_disq := n_disq + 1;
    findings := findings || jsonb_build_object('code','QI_NOT_QUALIFIED','name',r_name,'severity','disqualifying','result','fail','detail','Not a surprise-billing-protected OON item (valid OON consent or non-qualified service).');
  elsif b_qi = true then
    findings := findings || jsonb_build_object('code','QI_NOT_QUALIFIED','name',r_name,'severity','disqualifying','result','pass','detail','NSA-qualified OON item.');
  end if;

  -- BATCH_CAP (warning)
  if v_batch is not null then
    select name into r_name from eligibility_rules where code='BATCH_CAP';
    if v_batch > 50 then
      n_warn := n_warn + 1;
      findings := findings || jsonb_build_object('code','BATCH_CAP','name',r_name,'severity','warning','result','warn','detail','Batch has '||v_batch||' line items — exceeds the 50-line cap.');
    end if;
  end if;

  -- COST_SHARE (warning)
  if b_costshare is not null and b_costshare = false then
    select name into r_name from eligibility_rules where code='COST_SHARE';
    n_warn := n_warn + 1;
    findings := findings || jsonb_build_object('code','COST_SHARE','name',r_name,'severity','warning','result','warn','detail','Patient cost-share not set at the in-network (QPA) amount.');
  end if;

  -- DUP_LINE (warning)
  if b_dup = true then
    select name into r_name from eligibility_rules where code='DUP_LINE';
    n_warn := n_warn + 1;
    findings := findings || jsonb_build_object('code','DUP_LINE','name',r_name,'severity','warning','result','warn','detail','Line item overlaps a batch/dispute already submitted.');
  end if;

  -- scoring — identical to rescore_dispute
  if    n_disq >= 2 then s := 92;
  elsif n_disq = 1  then s := 84;
  elsif n_warn >= 1 then s := 55;
  else                   s := 15;
  end if;

  if    s >= 80 then rec_action := 'challenge_eligibility'; band := 'likely_ineligible';
  elsif s >= 50 then rec_action := 'review';                band := 'review';
  else               rec_action := 'defend_qpa';            band := 'defensible';
  end if;

  return jsonb_build_object(
    'eligibility_score', s,
    'ineligibility_confidence', s,
    'band', band,
    'recommendation', rec_action,
    'disqualifying_fails', n_disq,
    'warnings', n_warn,
    'findings', findings,
    'model', 'avertyn-eligibility-v1',
    'scored_at', now()
  );
end $$;

comment on function public.prescreen_eligibility(jsonb) is
  'Stateless NSA eligibility pre-screen. Mirrors the stored-dispute rule engine so external callers (clearinghouses / other TPAs) can score a claim before a dispute exists.';

-- ------------------------------------------------------------------ api tokens
create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  token_prefix text not null,
  token_hash text not null unique,
  scopes text[] not null default array['eligibility:prescreen'],
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  request_count int not null default 0,
  expires_at timestamptz
);
alter table public.api_tokens enable row level security;
drop policy if exists api_tokens_org_all on public.api_tokens;
create policy api_tokens_org_all on public.api_tokens
  for all using (org_id = public.auth_org_id())
  with check (org_id = public.auth_org_id());

create table if not exists public.api_request_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  token_id uuid references public.api_tokens(id) on delete set null,
  endpoint text not null,
  status int not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
alter table public.api_request_log enable row level security;
drop policy if exists api_request_log_org_read on public.api_request_log;
create policy api_request_log_org_read on public.api_request_log
  for select using (org_id = public.auth_org_id());
create index if not exists api_request_log_org_time on public.api_request_log(org_id, created_at desc);

-- Client generates the token + prefix + sha-256 hash; only the hash is stored.
create or replace function public.api_token_add(p_name text, p_prefix text, p_hash text)
returns public.api_tokens
language plpgsql security definer set search_path to 'public' as $$
declare o uuid := public.auth_org_id(); row public.api_tokens;
begin
  if o is null then raise exception 'not authorized'; end if;
  insert into public.api_tokens(org_id, name, token_prefix, token_hash, created_by)
  values (o, coalesce(nullif(p_name,''),'API token'), p_prefix, p_hash, auth.uid())
  returning * into row;
  return row;
end $$;

create or replace function public.api_token_revoke(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.api_tokens set active=false where id=p_id and org_id=public.auth_org_id();
end $$;

-- Privileged (service-role only): resolve org from a presented token hash + scope.
create or replace function public.api_token_verify(p_hash text, p_scope text)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare o uuid;
begin
  select org_id into o from public.api_tokens
   where token_hash = p_hash and active
     and (expires_at is null or expires_at > now())
     and p_scope = any(scopes)
   limit 1;
  if o is not null then
    update public.api_tokens
      set last_used_at = now(), request_count = request_count + 1
      where token_hash = p_hash;
  end if;
  return o;
end $$;

create or replace function public.api_log_request(p_token_hash text, p_org uuid, p_endpoint text, p_status int, p_meta jsonb default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare t uuid;
begin
  select id into t from public.api_tokens where token_hash = p_token_hash;
  insert into public.api_request_log(org_id, token_id, endpoint, status, meta)
  values (p_org, t, p_endpoint, p_status, p_meta);
end $$;

revoke execute on function public.api_token_verify(text, text) from public, anon, authenticated;
revoke execute on function public.api_log_request(text, uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.api_token_verify(text, text) to service_role;
grant execute on function public.api_log_request(text, uuid, text, int, jsonb) to service_role;

-- ------------------------------------------------------------- delivery status
-- Org-scoped delivery-rail summary for the Deadlines screen. security_invoker
-- so notification_outbox RLS applies to the caller.
create or replace view public.outbox_status_v with (security_invoker=true) as
select org_id,
  count(*) filter (where status='queued') as queued,
  count(*) filter (where status='sent')   as sent,
  count(*) filter (where status='failed') as failed,
  count(*) as total,
  max(last_attempt_at) as last_dispatch
from public.notification_outbox
group by org_id;
