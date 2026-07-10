-- Bulk import: disputes (CSV), reference data, and clearinghouse connections.

create or replace function public.import_disputes(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o uuid := public.auth_org_id(); r jsonb; created int := 0; failed int := 0; errs jsonb := '[]'::jsonb;
        did uuid; pid uuid; iid uuid;
begin
  if o is null then raise exception 'not authorized'; end if;
  for r in select value from jsonb_array_elements(p_rows) as t(value) loop
    begin
      pid := null;
      if coalesce(r->>'plan','') <> '' then
        select id into pid from plans where org_id = o and lower(name) = lower(r->>'plan') limit 1;
        if pid is null then
          insert into plans(org_id, name, plan_type)
          values (o, r->>'plan', coalesce(nullif(r->>'plan_type',''),'self_funded_erisa')) returning id into pid;
        end if;
      end if;
      iid := null;
      if coalesce(r->>'initiator','') <> '' then
        select id into iid from initiators where lower(name) = lower(r->>'initiator') limit 1;
        if iid is null then
          insert into initiators(name, kind, pe_backed) values (r->>'initiator', 'provider_group', false) returning id into iid;
        end if;
      end if;
      insert into disputes(org_id, plan_id, initiator_id, external_ref, cpt_code, service_date,
                           billed_amount, demand_amount, qpa_amount, workflow_state, carc, rarc)
      values (o, pid, iid, nullif(r->>'external_ref',''), nullif(r->>'cpt_code',''),
              nullif(r->>'service_date','')::date, nullif(r->>'billed_amount','')::numeric,
              nullif(r->>'demand_amount','')::numeric, nullif(r->>'qpa_amount','')::numeric,
              coalesce(nullif(r->>'workflow_state',''),'intake'), nullif(r->>'carc',''), nullif(r->>'rarc',''))
      returning id into did;
      perform public.run_eligibility(did);
      created := created + 1;
    exception when others then
      failed := failed + 1;
      errs := errs || jsonb_build_object('ref', coalesce(r->>'external_ref','(row)'), 'error', SQLERRM);
    end;
  end loop;
  return jsonb_build_object('created', created, 'failed', failed, 'errors', errs);
end $$;

create or replace function public.import_reference(p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o uuid := public.auth_org_id(); r jsonb; n int := 0;
begin
  if o is null then raise exception 'not authorized'; end if;
  for r in select value from jsonb_array_elements(p_rows) as t(value) loop
    if coalesce(r->>'name','') = '' then continue; end if;
    if p_kind = 'plans' then
      if not exists (select 1 from plans where org_id=o and lower(name)=lower(r->>'name')) then
        insert into plans(org_id, name, plan_type) values (o, r->>'name', coalesce(nullif(r->>'plan_type',''),'self_funded_erisa')); n := n+1;
      end if;
    elsif p_kind = 'employers' then
      if not exists (select 1 from employers where org_id=o and lower(name)=lower(r->>'name')) then
        insert into employers(org_id, name, broker_name) values (o, r->>'name', nullif(r->>'broker_name','')); n := n+1;
      end if;
    elsif p_kind = 'initiators' then
      if not exists (select 1 from initiators where lower(name)=lower(r->>'name')) then
        insert into initiators(name, kind, pe_backed) values (r->>'name', coalesce(nullif(r->>'kind',''),'provider_group'), coalesce((r->>'pe_backed')::boolean,false)); n := n+1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('imported', n, 'kind', p_kind);
end $$;

create table if not exists public.clearinghouse_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null,
  external_account text,
  status text not null default 'pending',
  config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, provider)
);
alter table public.clearinghouse_connections enable row level security;
drop policy if exists ch_conn_org on public.clearinghouse_connections;
create policy ch_conn_org on public.clearinghouse_connections
  for all using (org_id = public.auth_org_id()) with check (org_id = public.auth_org_id());

create or replace function public.clearinghouse_connect(p_provider text, p_external_account text, p_config jsonb)
returns public.clearinghouse_connections language plpgsql security definer set search_path to 'public' as $$
declare o uuid := public.auth_org_id(); row public.clearinghouse_connections;
begin
  if o is null then raise exception 'not authorized'; end if;
  insert into public.clearinghouse_connections(org_id, provider, external_account, status, config)
  values (o, p_provider, nullif(p_external_account,''), 'pending', p_config)
  on conflict (org_id, provider) do update
    set external_account = excluded.external_account, config = excluded.config, updated_at = now()
  returning * into row;
  return row;
end $$;
