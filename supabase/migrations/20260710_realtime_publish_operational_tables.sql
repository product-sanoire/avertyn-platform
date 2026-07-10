-- Make the operational tables live: add them to the supabase_realtime publication
-- so postgres_changes subscriptions actually receive events (idempotent).
-- Before this, only action_log/approval_queue/notifications were published, so the
-- dashboard's disputes/awards subscriptions silently received nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'disputes','awards','batches','batch_disputes','idre_selections','portal_submissions',
    'predictions','work_items','comm_threads','comm_messages','calendar_events','deadlines',
    'notification_outbox','scheduled_reports','app_users','scim_tokens','sso_connections',
    'eligibility_findings','qpa_records','offers','documents'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
