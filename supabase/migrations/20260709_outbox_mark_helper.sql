-- Atomic outbox row update for the delivery worker (service-role only).
create or replace function public.outbox_mark(p_id uuid, p_status text, p_response text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.notification_outbox
     set status = p_status,
         attempts = attempts + 1,
         last_attempt_at = now(),
         response = p_response
   where id = p_id;
end $$;
revoke execute on function public.outbox_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.outbox_mark(uuid, text, text) to service_role;
