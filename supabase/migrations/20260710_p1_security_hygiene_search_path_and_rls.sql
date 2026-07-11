-- P1 security-hygiene cluster (Supabase security advisor cleanup)
-- Clears the 14 function_search_path_mutable WARNs and the 2 rls_policy_always_true WARNs.
-- Remaining advisor items are intentional/managed and NOT touched here:
--   * 432 anon/authenticated SECURITY-DEFINER executable grants → demo-only; locked down on prod (P0 #5).
--   * extension_in_public (pg_net) → Supabase-managed extension; moving schemas risks net.* refs. Leave.
--   * auth_leaked_password_protection → Supabase Auth dashboard toggle (enable on prod).
--   * rls_enabled_no_policy (app_secrets, benchmark_contributions, billing_accounts) → INFO; deny-by-default
--     is the intended posture (only SECURITY DEFINER service functions touch them).

-- (1) Pin search_path on 14 functions. None reference unqualified extension objects (verified), so
--     'public' is safe and matches the already-hardened functions. Closes search_path-injection vector.
ALTER FUNCTION public._idr_friction()                                  SET search_path TO 'public';
ALTER FUNCTION public._require_admin()                                 SET search_path TO 'public';
ALTER FUNCTION public._w(text, text)                                   SET search_path TO 'public';
ALTER FUNCTION public.action_perm(text)                                SET search_path TO 'public';
ALTER FUNCTION public.biz_add(timestamptz, integer)                    SET search_path TO 'public';
ALTER FUNCTION public.classify_nsa(text, text)                         SET search_path TO 'public';
ALTER FUNCTION public.deadline_label(text)                             SET search_path TO 'public';
ALTER FUNCTION public.deny_mutation()                                  SET search_path TO 'public';
ALTER FUNCTION public.eval_condition(jsonb, jsonb, jsonb)              SET search_path TO 'public';
ALTER FUNCTION public.fn_win_probability(numeric, numeric, integer, numeric) SET search_path TO 'public';
ALTER FUNCTION public.nsa_phase(text, text)                            SET search_path TO 'public';
ALTER FUNCTION public.nsa_phase_label(text)                            SET search_path TO 'public';
ALTER FUNCTION public.on_economics(numeric, numeric, numeric)          SET search_path TO 'public';
ALTER FUNCTION public.render_str(text, jsonb)                          SET search_path TO 'public';

-- (2) Replace the two always-true RLS policies with tenant-scoped predicates.
--     Preserves demo behavior: anon (auth_org_id() IS NULL) still resolves through the demo org,
--     matching the existing client_errors_select policy pattern.

-- batch_disputes is a join table (batch_id, dispute_id) with no org_id — scope via the dispute's org.
DROP POLICY IF EXISTS bd_rw ON public.batch_disputes;
CREATE POLICY bd_rw ON public.batch_disputes FOR ALL
  USING (exists (select 1 from public.disputes d
                 where d.id = batch_disputes.dispute_id
                   and (d.org_id = public.auth_org_id() or public.auth_org_id() is null)))
  WITH CHECK (exists (select 1 from public.disputes d
                 where d.id = batch_disputes.dispute_id
                   and (d.org_id = public.auth_org_id() or public.auth_org_id() is null)));

-- client_errors: telemetry sink. Keep inserts open for unauthenticated/demo, but an authenticated
-- caller may only write rows for its own org (can't forge another tenant's org_id).
DROP POLICY IF EXISTS client_errors_insert ON public.client_errors;
CREATE POLICY client_errors_insert ON public.client_errors FOR INSERT
  WITH CHECK (org_id = public.auth_org_id() or public.auth_org_id() is null);
