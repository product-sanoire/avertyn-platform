-- Make API-key creation and global search work in the (anon) demo, like the rest of the app.
-- Both used strict auth_org_id() → api_key_create raised 'no org for caller' and global_search returned
-- nothing for the demo's anon role. Switch org resolution to current_org() (= coalesce(auth_org_id(),
-- demo org)). Also fixes a latent bug: the BAA check referenced `id` which is ambiguous with the OUT
-- parameter named id — qualified as orgs.id. Verified: test key mints in demo; global_search(NULL,'IN-')
-- returns 16 hits via the demo-org fallback.

CREATE OR REPLACE FUNCTION public.api_key_create(p_name text, p_scopes text[], p_environment text DEFAULT 'live'::text)
 RETURNS TABLE(id uuid, plaintext text, key_prefix text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_org uuid := public.current_org(); v_raw text; v_full text; v_prefix text; s text;
  valid text[] := array['cases:read:basic','cases:read','cases:read:phi','cases:write','metrics:read','documents:read','webhooks:manage'];
begin
  if v_org is null then raise exception 'no org for caller'; end if;
  if p_environment not in ('live','test') then raise exception 'bad environment'; end if;
  foreach s in array coalesce(p_scopes,'{}') loop
    if not (s = any(valid)) then raise exception 'unknown scope: %', s; end if;
  end loop;
  if p_environment = 'live'
     and (p_scopes && array['cases:read','cases:read:phi','cases:write','documents:read'])
     and (select baa_signed_at from orgs where orgs.id = v_org) is null then
    raise exception 'A signed BAA is required before issuing a live key with PHI access. Set orgs.baa_signed_at first.';
  end if;
  v_raw := encode(gen_random_bytes(24),'hex'); v_full := 'avk_'||p_environment||'_'||v_raw; v_prefix := left(v_full,16);
  insert into api_keys(org_id,name,key_prefix,key_hash,scopes,environment,created_by)
  values (v_org,p_name,v_prefix,encode(digest(v_full,'sha256'),'hex'),coalesce(p_scopes,'{}'),p_environment,
          (select email from app_users where app_users.id = auth.uid()))
  returning api_keys.id, api_keys.key_prefix into id, key_prefix;
  plaintext := v_full; return next;
end $function$;

CREATE OR REPLACE FUNCTION public.global_search(p_org uuid, p_q text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with q as (select '%'||coalesce(p_q,'')||'%' as like, coalesce(p_org, public.current_org()) as org)
  select coalesce(jsonb_agg(r order by r->>'type'), '[]') from (
    select jsonb_build_object('type','dispute','ref',d.external_ref,'label','#'||d.external_ref,
           'sub',coalesce(i.name,'')||' · '||coalesce(d.cpt_code,'')) r
    from public.disputes d left join public.initiators i on i.id=d.initiator_id, q
    where d.org_id=q.org and (d.external_ref ilike q.like or d.cpt_code ilike q.like or i.name ilike q.like)
    union all
    select jsonb_build_object('type','account','ref',a.id::text,'label',a.name,'sub',a.kind)
    from public.accounts a, q where a.org_id=q.org and a.name ilike q.like
    union all
    select jsonb_build_object('type','contact','ref',c.id::text,'label',c.name,'sub',coalesce(c.title,'')||' · '||coalesce(c.email,''))
    from public.contacts c, q where c.org_id=q.org and (c.name ilike q.like or c.email ilike q.like)
    union all
    select jsonb_build_object('type','file','ref',f.id::text,'label',f.name,'sub',f.folder)
    from public.files f, q where f.org_id=q.org and (f.name ilike q.like or array_to_string(f.tags,' ') ilike q.like)
    union all
    select jsonb_build_object('type','task','ref',w.id::text,'label',w.title,'sub',w.status||' · '||coalesce(w.assignee,''))
    from public.work_items w, q where w.org_id=q.org and w.title ilike q.like
    limit 40
  ) s;
$function$;
