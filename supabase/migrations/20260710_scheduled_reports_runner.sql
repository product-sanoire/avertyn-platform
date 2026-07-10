-- Scheduled reports: run one, run all due, and a pg_cron heartbeat.
-- Delivery reuses notifications -> notification_outbox -> deliver-notifications.

create or replace function public.run_scheduled_report(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare sr record; rep jsonb; nid uuid; rcpt text; emails text[]; total numeric; topline text; sent int := 0;
begin
  select * into sr from public.scheduled_reports where id = p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and sr.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  select public.report_custom(sr.org_id, sr.metric, sr.dim) into rep;
  total := coalesce((rep->>'total')::numeric, 0);
  select string_agg((e->>'label')||': '||(e->>'value'), '  ·  ')
    into topline
    from (select jsonb_array_elements(coalesce(rep->'rows','[]'::jsonb)) e limit 3) t;

  insert into public.notifications (org_id, dispute_id, kind, title, body, severity)
  values (sr.org_id, null, 'report:'||sr.metric||'_by_'||sr.dim,
          'Scheduled report — '||sr.name,
          'Total '||sr.metric||': '||total::text||coalesce('. Top — '||topline, '.'), 'info')
  returning id into nid;

  emails := regexp_split_to_array(coalesce(sr.recipients,''), '\s*,\s*');
  if emails is not null then
    foreach rcpt in array emails loop
      if length(trim(coalesce(rcpt,''))) > 3 then
        insert into public.notification_outbox (org_id, notification_id, channel_kind, target, status)
        values (sr.org_id, nid, 'email', trim(rcpt), 'queued');
        sent := sent + 1;
      end if;
    end loop;
  end if;

  update public.scheduled_reports set last_run = now() where id = p_id;
  return jsonb_build_object('ok',true,'report',sr.name,'metric',sr.metric,'dim',sr.dim,
                            'total',total,'notification',nid,'recipients',sent,'result',rep);
end $$;

create or replace function public.run_due_scheduled_reports()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0;
begin
  for r in select id, cadence, last_run from public.scheduled_reports loop
    if r.last_run is null
       or (r.cadence='hourly'  and r.last_run < now() - interval '1 hour')
       or (r.cadence='daily'   and r.last_run < now() - interval '1 day')
       or (r.cadence='weekly'  and r.last_run < now() - interval '7 days')
       or (r.cadence='monthly' and r.last_run < now() - interval '1 month')
    then
      perform public.run_scheduled_report(r.id);
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'ran',n);
end $$;

grant execute on function public.run_scheduled_report(uuid) to authenticated;

do $$ begin perform cron.unschedule('avert-scheduled-reports'); exception when others then null; end $$;
select cron.schedule('avert-scheduled-reports','7 * * * *', 'select public.run_due_scheduled_reports();');
