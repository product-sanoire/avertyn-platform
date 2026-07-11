-- Find a case by ANY of its identifiers: internal ref, CPT, initiator, the dispute-level claim number,
-- the federal IDR dispute number, OR any batched claim's number (claims.external_claim_id). This closes
-- the batched-open-negotiation gap where a non-lead claim number couldn't locate its case.
-- Verified on demo: searching 'CLM-IN-88214-03' (a non-lead claim) returns its case IN-88214.
CREATE OR REPLACE FUNCTION public.global_search(p_org uuid, p_q text)
 RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with q as (select '%'||coalesce(p_q,'')||'%' as like, coalesce(p_org, public.current_org()) as org)
  select coalesce(jsonb_agg(r order by r->>'type'), '[]') from (
    select jsonb_build_object('type','dispute','ref',d.external_ref,'label','#'||d.external_ref,
           'sub',coalesce(i.name,'')||' · '||coalesce(d.cpt_code,'')) r
    from public.disputes d left join public.initiators i on i.id=d.initiator_id, q
    where d.org_id=q.org and (
          d.external_ref ilike q.like
       or d.cpt_code ilike q.like
       or i.name ilike q.like
       or d.claim_number ilike q.like
       or d.idr_registration_number ilike q.like
       or exists (select 1 from public.claims cl where cl.dispute_id = d.id and cl.external_claim_id ilike q.like))
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
