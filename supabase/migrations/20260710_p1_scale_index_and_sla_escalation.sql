-- P1 backend depth: scale index + proactive deadline/SLA escalation.
-- (1) predictions had only a PK; the learning-loop queries do distinct-on(dispute_id) order by created_at.
CREATE INDEX IF NOT EXISTS predictions_org_dispute_created_idx
  ON public.predictions (org_id, dispute_id, created_at DESC);

-- (2) sla_status: open regulated deadlines bucketed by urgency (overdue / <=72h business-days / <=7d) with
-- dispute context — the proactive SLA view. Verified on demo (after realistic re-spread): 5 overdue, 24 urgent, 14 soon.
CREATE OR REPLACE FUNCTION public.sla_status(p_org uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with dl as (
    select d.id, d.dispute_id, d.kind, d.due_at, dp.external_ref,
           case when d.due_at < now() then 'overdue'
                when d.due_at <= public.biz_add(now(), 3) then 'urgent'
                when d.due_at <= now() + interval '7 days' then 'soon'
                else 'later' end as urgency
    from public.deadlines d
    join public.disputes dp on dp.id = d.dispute_id
    where d.org_id = coalesce(p_org, public.current_org())
      and d.due_at is not null
      and coalesce(d.status,'open') not in ('met','done','closed','satisfied','cancelled','waived')
      and dp.disposition = 'open'
  )
  select jsonb_build_object(
    'overdue', count(*) filter (where urgency='overdue'),
    'urgent',  count(*) filter (where urgency='urgent'),
    'soon',    count(*) filter (where urgency='soon'),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                'dispute_ref', external_ref, 'kind', kind, 'label', public.deadline_label(kind),
                'due_at', due_at, 'urgency', urgency) order by due_at)
              from dl where urgency in ('overdue','urgent','soon')), '[]')
  ) from dl;
$function$;

-- (3) sla_escalate: raise an urgent notification for each overdue open deadline not already escalated
-- (idempotent within 24h), and ledger it. Returns the count escalated.
CREATE OR REPLACE FUNCTION public.sla_escalate(p_org uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_org uuid := coalesce(p_org, public.current_org()); r record; n int := 0;
begin
  if public.auth_org_id() is not null and v_org <> public.auth_org_id() then raise exception 'not authorized'; end if;
  for r in
    select d.id, d.dispute_id, d.kind, d.due_at, dp.external_ref
    from public.deadlines d join public.disputes dp on dp.id = d.dispute_id
    where d.org_id = v_org and d.due_at < now()
      and coalesce(d.status,'open') not in ('met','done','closed','satisfied','cancelled','waived')
      and dp.disposition = 'open'
      and not exists (
        select 1 from public.notifications nt
        where nt.dispute_id = d.dispute_id and nt.kind = 'sla_escalation'
          and nt.created_at > now() - interval '24 hours')
  loop
    insert into public.notifications(org_id, dispute_id, kind, title, body, severity, read)
    values (v_org, r.dispute_id, 'sla_escalation',
            'Overdue: '||public.deadline_label(r.kind)||' — '||coalesce(r.external_ref,'dispute'),
            'This regulated deadline passed on '||to_char(r.due_at,'Mon DD, HH24:MI')||'. Act now to avoid a default loss.',
            'urgent', false);
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'escalated', n);
end $function$;
