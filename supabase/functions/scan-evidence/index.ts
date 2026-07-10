// Avertyn — scan-evidence edge function.
// Reads an uploaded case document (PDF or image) with Claude vision, extracts the
// text and a structured, eligibility-relevant summary, and stores it on the evidence
// row so the composer can cite it as an exhibit and fold it into drafted arguments.
//
// Deploy: supabase functions deploy scan-evidence
// Configure: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...  (optional ANTHROPIC_MODEL)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let evId: string | null = null;
  try {
    const { evidence_id } = await req.json();
    evId = evidence_id;
    if (!evId) return json({ ok: false, reason: "evidence_id required" }, 400);

    // Ownership check under the caller's RLS.
    const auth = req.headers.get("Authorization") ?? "";
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } });
    const { data: ev, error: ee } = await user.from("evidence")
      .select("id, dispute_id, storage_path, filename, mime, byte_size").eq("id", evId).single();
    if (ee || !ev) return json({ ok: false, reason: "evidence not found or not authorized" }, 404);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ ok: false, reason: "AI scanning not configured (set ANTHROPIC_API_KEY on scan-evidence)." });

    await svc.from("evidence").update({ status: "scanning", error: null }).eq("id", evId);

    // Download the file (service role).
    const { data: blob, error: de } = await svc.storage.from("evidence").download(ev.storage_path);
    if (de || !blob) throw new Error("download failed: " + (de?.message || "no file"));
    const buf = await blob.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("file too large to scan (max 12 MB)");
    const b64 = toBase64(buf);
    const mime = ev.mime || "application/octet-stream";

    // Build the content block by type.
    let media: unknown;
    if (mime === "application/pdf") {
      media = { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
    } else if (mime.startsWith("image/")) {
      media = { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
    } else {
      // treat as UTF-8 text
      media = { type: "text", text: new TextDecoder().decode(buf).slice(0, 100000) };
    }

    const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest";
    const sys = "You are a No Surprises Act IDR defense analyst for a health plan/TPA. " +
      "Read the attached case document and extract only what it actually says. Return STRICT JSON with keys: " +
      "one_liner (<=120 chars describing what the document is), doc_type, key_facts (array of short strings), " +
      "dates (array of {label,value}), amounts (array of {label,value}), " +
      "relevance (array of {code,note} where code is one of ON_NEG_INCOMPLETE, TF_INITIATION, JUR_STATE, " +
      "QI_NOT_QUALIFIED, DUP_LINE, BATCH_CAP, COST_SHARE, or QPA_SUPPORT — only include grounds the document " +
      "actually supports), and suggested_argument (one sentence a plan could use, grounded ONLY in this document). " +
      "Do not invent facts. Return JSON only, no prose, no markdown fences.";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 1200, system: sys,
        messages: [{ role: "user", content: [media, { type: "text", text: "Extract the JSON now." }] }],
      }),
    });
    if (!resp.ok) throw new Error(`model error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const out = await resp.json();
    const raw = (out?.content?.[0]?.text ?? "").trim().replace(/^```json\s*|\s*```$/g, "");
    let summary: Record<string, unknown>;
    try { summary = JSON.parse(raw); }
    catch { summary = { one_liner: raw.slice(0, 120), key_facts: [], relevance: [], suggested_argument: "" }; }

    await svc.from("evidence").update({
      status: "scanned",
      summary,
      extracted_text: typeof summary.key_facts === "object" ? JSON.stringify(summary.key_facts) : null,
      error: null,
    }).eq("id", evId);

    return json({ ok: true, summary });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (evId) await svc.from("evidence").update({ status: "error", error: msg }).eq("id", evId);
    return json({ ok: false, reason: msg }, 500);
  }
});
