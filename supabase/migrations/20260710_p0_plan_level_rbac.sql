-- P0 #6 (part): plan-level RBAC enforcement layer. Applied live to ssjougrsaecdwfuxeasd 2026-07-10.
-- Model: a user is UNRESTRICTED (all plans in their org) UNLESS they have explicit user_plan_access rows.
-- MFA is a Supabase Auth config (Authentication -> MFA/TOTP required + leaked-password protection) — not SQL.

CREATE OR REPLACE FUNCTION public.has_plan_access(p_plan uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select case
    when exists (select 1 from public.user_plan_access x where x.user_id = auth.uid())
      then exists (select 1 from public.user_plan_access x where x.user_id = auth.uid() and x.plan_id = p_plan)
    else exists (select 1 from public.plans pl join public.app_users u on u.org_id = pl.org_id
                 where u.id = auth.uid() and pl.id = p_plan)
  end;
$function$;

CREATE OR REPLACE FUNCTION public.accessible_plan_ids()
 RETURNS TABLE(plan_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select pl.id from public.plans pl join public.app_users u on u.org_id = pl.org_id
  where u.id = auth.uid()
    and ( not exists (select 1 from public.user_plan_access x where x.user_id = auth.uid())
          or exists (select 1 from public.user_plan_access x where x.user_id = auth.uid() and x.plan_id = pl.id) );
$function$;
GRANT EXECUTE ON FUNCTION public.accessible_plan_ids() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_disputes_plan_scoped(p_limit int DEFAULT 200)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb) from (
    select d.id, d.external_ref, d.cpt_code, d.plan_id, d.qpa_amount, d.demand_amount, d.workflow_state, d.created_at
    from public.disputes d
    where d.org_id = public.auth_org_id() and public.has_plan_access(d.plan_id)
    order by d.created_at desc limit greatest(coalesce(p_limit,200),1)
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.list_disputes_plan_scoped(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.grant_plan_access(p_user uuid, p_plan uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select org_id into v_org from public.plans where id = p_plan;
  if v_org is null then raise exception 'plan not found'; end if;
  if public.auth_org_id() is not null and v_org <> public.auth_org_id() then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.app_users u where u.id = p_user and u.org_id = v_org) then
    raise exception 'user is not a member of this org'; end if;
  insert into public.user_plan_access(user_id, plan_id, org_id)
  select p_user, p_plan, v_org
  where not exists (select 1 from public.user_plan_access x where x.user_id=p_user and x.plan_id=p_plan);
  return true;
end $function$;
GRANT EXECUTE ON FUNCTION public.grant_plan_access(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_plan_access(p_user uuid, p_plan uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select org_id into v_org from public.plans where id = p_plan;
  if public.auth_org_id() is not null and v_org is not null and v_org <> public.auth_org_id() then raise exception 'not authorized'; end if;
  delete from public.user_plan_access where user_id = p_user and plan_id = p_plan;
  return true;
end $function$;
GRANT EXECUTE ON FUNCTION public.revoke_plan_access(uuid, uuid) TO authenticated;
