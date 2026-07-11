-- Make the enterprise/integrations layer visible in the (anon) demo so the tools are findable.
-- These tables used strict auth_org_id() RLS, so they returned NOTHING for the demo's anon role —
-- the approvals queue, API keys, and webhooks UIs all rendered empty. Align their READ policies to the
-- same current_org() pattern the rest of the app uses (current_org() = coalesce(auth_org_id(), demo org)),
-- so demo shows the demo org and authenticated users stay scoped to their own org. Writes stay via
-- SECURITY DEFINER RPCs / scoped policies.

-- Approvals queue: existing Overview "Waiting for you" panel populates in the demo.
DROP POLICY IF EXISTS approval_org ON public.approval_queue;
CREATE POLICY approval_org ON public.approval_queue FOR ALL
  USING (org_id = public.current_org()) WITH CHECK (org_id = public.current_org());

-- API keys + webhooks: read visibility in the demo.
DROP POLICY IF EXISTS api_keys_org_read ON public.api_keys;
CREATE POLICY api_keys_org_read ON public.api_keys FOR SELECT USING (org_id = public.current_org());

DROP POLICY IF EXISTS wh_endpoints_org ON public.webhook_endpoints;
CREATE POLICY wh_endpoints_org ON public.webhook_endpoints FOR SELECT USING (org_id = public.current_org());

DROP POLICY IF EXISTS wh_deliveries_org ON public.webhook_deliveries;
CREATE POLICY wh_deliveries_org ON public.webhook_deliveries FOR SELECT USING (org_id = public.current_org());

-- Demo-safe endpoint registration (webhook_register uses strict auth_org_id() → null in demo).
-- Returns the id + signing secret once so the caller can configure their receiver.
CREATE OR REPLACE FUNCTION public.webhook_create(p_url text, p_events text[])
 RETURNS TABLE(id uuid, secret text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  return query
  insert into public.webhook_endpoints(org_id, url, events)
  values (public.current_org(), p_url, coalesce(p_events, '{}'))
  returning webhook_endpoints.id, webhook_endpoints.secret;
end $function$;
