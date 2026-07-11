-- The webhook delivery worker introduces two in-flight states (dispatched = POSTed via pg_net awaiting
-- response; retrying = failed, scheduled for backoff retry). Expand the status check to allow them.
-- Apply BEFORE 20260710_p1_webhook_delivery_worker_and_signing.sql runs its worker, or together.
ALTER TABLE public.webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;
ALTER TABLE public.webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
  CHECK (status = ANY (ARRAY['pending','dispatched','retrying','delivered','failed']));
