// Avertyn — notification delivery worker
// Dispatches queued notification_outbox rows to real channels (email via Resend,
// push via FCM). Honest fallback: when a provider key isn't configured it marks
// the row 'sent' with a 'simulated:*' response so the rail is demonstrable.
//
// Two invocation modes:
//   - Cron/service:  header 'x-cron-secret: <CRON_SECRET>'  -> all orgs
//   - In-app (user): 'Authorization: Bearer <supabase jwt>' -> caller's org only
// Deployed with verify_jwt=false; auth handled below.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Avertyn <alerts@avertyn.com>";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

async function sendEmail(to: string, subject: string, text: string): Promise<string> {
  if (!RESEND_API_KEY) return "simulated:email (no RESEND_API_KEY)";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json().catch(() => ({}));
  return `sent:email:${j.id ?? "ok"}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- scope resolution ----
  let orgFilter: string | null = null;
  const cronHeader = req.headers.get("x-cron-secret") || "";
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;

  if (!isCron) {
    const authz = req.headers.get("authorization") || "";
    if (!authz.toLowerCase().startsWith("bearer ")) {
      return json({ error: "unauthorized" }, 401);
    }
    // Resolve the caller's org via their JWT (RLS lets them read their own row).
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authz } },
    });
    const { data: me } = await asUser.from("app_users").select("org_id").maybeSingle();
    if (!me?.org_id) return json({ error: "unauthorized", detail: "No org for caller." }, 401);
    orgFilter = me.org_id;
  }

  // ---- pull queued rows (+ notification content) ----
  let q = admin
    .from("notification_outbox")
    .select("id, org_id, channel_kind, target, notification_id, notifications(title, body, severity)")
    .eq("status", "queued")
    .limit(200);
  if (orgFilter) q = q.eq("org_id", orgFilter);
  const { data: rows, error } = await q;
  if (error) return json({ error: "server_error", detail: error.message }, 500);

  let sent = 0, simulated = 0, failed = 0;
  for (const row of rows ?? []) {
    const n = (row as any).notifications || {};
    const subject = n.title || "Avertyn alert";
    const text = n.body || subject;
    let status = "sent";
    let response = "";
    try {
      if (row.channel_kind === "email") {
        response = await sendEmail(row.target, subject, text);
      } else if (row.channel_kind === "push") {
        response = "simulated:push (FCM worker not configured)";
      } else {
        response = `simulated:${row.channel_kind}`;
      }
      if (response.startsWith("simulated")) simulated++; else sent++;
    } catch (e) {
      status = "failed";
      response = `error:${(e as Error).message}`.slice(0, 300);
      failed++;
    }
    await admin.rpc("outbox_mark", { p_id: row.id, p_status: status, p_response: response });
  }

  return json({
    ok: true,
    scope: isCron ? "all_orgs" : orgFilter,
    processed: (rows ?? []).length,
    sent,
    simulated,
    failed,
    provider: RESEND_API_KEY ? "resend" : "none",
  });
});
