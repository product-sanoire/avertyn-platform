// Avertyn — external eligibility pre-screen API
// Token-authed (avk_ bearer). Lets clearinghouses / other TPAs score an NSA
// claim's eligibility BEFORE a dispute exists, using the same rule engine.
// Deployed with verify_jwt=false; auth is a hashed API token (api_tokens).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const DOCS = {
  service: "Avertyn eligibility pre-screen",
  method: "POST",
  auth: "Authorization: Bearer <avk_ token>",
  body_fields: {
    open_negotiation_complete: "boolean — 30-business-day open-negotiation notice on record",
    initiation_within_window: "boolean — IDR initiated within the 4-business-day window",
    jurisdiction: "'federal' | 'self_funded_erisa' | 'state'",
    qualified_item: "boolean — NSA surprise-billing-protected OON item",
    oon_consent: "boolean — patient gave valid OON consent (disqualifying if true)",
    carc: "string (optional) — NSA CARC code from the 835",
    rarc: "string (optional) — NSA RARC code from the 835",
    batch_line_count: "integer (optional) — line items in the batch (>50 warns)",
    cost_share_at_qpa: "boolean (optional) — patient cost-share set at the QPA",
    duplicate: "boolean (optional) — overlaps a submitted dispute/batch",
  },
  returns: "{ eligibility_score, band, recommendation, disqualifying_fails, warnings, findings[] }",
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return json(DOCS);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "unauthorized", detail: "Provide 'Authorization: Bearer <token>'." }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const hash = await sha256Hex(token);
  const { data: org, error: vErr } = await admin.rpc("api_token_verify", {
    p_hash: hash,
    p_scope: "eligibility:prescreen",
  });
  if (vErr) return json({ error: "server_error", detail: vErr.message }, 500);
  if (!org) return json({ error: "unauthorized", detail: "Invalid or revoked token." }, 401);

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request", detail: "Body must be valid JSON." }, 400);
  }

  const { data: result, error: sErr } = await admin.rpc("prescreen_eligibility", { p_payload: payload });
  if (sErr) return json({ error: "server_error", detail: sErr.message }, 500);

  await admin.rpc("api_log_request", {
    p_token_hash: hash,
    p_org: org,
    p_endpoint: "eligibility-prescreen",
    p_status: 200,
    p_meta: { recommendation: (result as Record<string, unknown>)?.recommendation ?? null },
  });

  return json(result);
});
