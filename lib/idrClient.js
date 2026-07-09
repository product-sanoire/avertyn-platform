"use client";
// ============================================================================
// Client helpers for the IDR Gateway connector — thin wrappers over the RPCs
// and the org-scoped tables. All calls go through the browser Supabase client,
// so RLS scopes everything to the signed-in user's org automatically.
// ============================================================================
import { supabase } from "./supabaseClient";

// --- connection ------------------------------------------------------------
export async function getConnection() {
  const { data } = await supabase
    .from("idr_connections").select("*")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

export async function connect(adapter = "assisted_browser", opts = {}) {
  const { data, error } = await supabase.rpc("idr_connection_upsert", {
    p_adapter: adapter,
    p_gateway_org_id: opts.gatewayOrgId ?? null,
    p_registration_no: opts.registrationNo ?? null,
    p_legal_name: opts.legalName ?? null,
    p_plan_type: opts.planType ?? null,
    p_poll_interval: opts.pollInterval ?? 900,
  });
  if (error) throw error;
  return data;
}

// --- inbound events --------------------------------------------------------
export async function listEvents(disputeId, limit = 15) {
  const { data } = await supabase
    .from("idr_sync_events").select("*")
    .eq("dispute_id", disputeId)
    .order("created_at", { ascending: false }).limit(limit);
  return data || [];
}

// --- outbound submissions --------------------------------------------------
export async function listSubmissions(disputeId) {
  const { data } = await supabase
    .from("idr_submissions").select("*")
    .eq("dispute_id", disputeId)
    .order("created_at", { ascending: false });
  return data || [];
}

export async function stage(disputeId, kind, payload = {}, dueAt = null) {
  const { data, error } = await supabase.rpc("idr_stage_submission", {
    p_dispute_id: disputeId, p_kind: kind, p_payload: payload, p_due_at: dueAt,
  });
  if (error) throw error;
  return data;
}

// Advance lifecycle. `patch` merges into payload while draft/needs_review.
export async function advance(submissionId, to, { patch = null, receipt = null, error = null } = {}) {
  const { data, error: err } = await supabase.rpc("idr_advance_submission", {
    p_submission_id: submissionId, p_to: to, p_patch: patch, p_receipt: receipt, p_error: error,
  });
  if (err) throw err;
  return data;
}

// Convenience lifecycle steps.
export const editPayload = (id, patch) => advance(id, "draft", { patch });
export const approve = (id) => advance(id, "queued");
export const markInFlight = (id) => advance(id, "in_flight");
export const markConfirmed = (id, receipt) => advance(id, "confirmed", { receipt });
export const markFailed = (id, msg) => advance(id, "failed", { error: msg });

export const SUBMISSION_KINDS = [
  ["submit_offer", "Submit offer"],
  ["respond_to_dispute", "Respond to dispute"],
  ["open_negotiation_notice", "Open-negotiation notice"],
  ["eligibility_objection", "Eligibility objection"],
  ["upload_document", "Upload document"],
  ["select_idre", "Select IDRE"],
];
