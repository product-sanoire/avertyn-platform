// Avertyn — draft-section edge function (v2, evidence-aware).
// Drafts one optional narrative argument field from the real case facts AND any
// scanned evidence summaries, under the caller's RLS. Grounded, never auto-filed.
// Degrades gracefully when ANTHROPIC_API_KEY is unset.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { dispute_id, guidance } = await req.json();
    if (!dispute_id) return json({ ok: false, reason: "dispute_id required" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } });

    const { data: d, error: de } = await supa.from("disputes")
      .select("external_ref, cpt_code, service_category, service_date, demand_amount, qpa_amount, eligibility_score, plans(name), initiators(name)")
      .eq("id", dispute_id).single();
    if (de || !d) return json({ ok: false, reason: "dispute not found or not authorized" }, 404);

    const { data: fnd } = await supa.from("eligibility_findings")
      .select("result, detail, eligibility_rules(name, code)").eq("dispute_id", dispute_id).eq("result", "fail");
    const { data: evs } = await supa.from("evidence")
      .select("filename, summary").eq("dispute_id", dispute_id).eq("status", "scanned");

    const findingsTxt = (fnd || []).map((f: any) => `- ${f.eligibility_rules?.name}: ${f.detail}`).join("\n") || "- (none)";
    const evidenceTxt = (evs || []).map((e: any, i: number) => {
      const s = e.summary || {};
      const facts = Array.isArray(s.key_facts) ? s.key_facts.join("; ") : "";
      return `- Exhibit ${String.fromCharCode(65 + i)} (${e.filename}): ${s.one_liner || ""}${facts ? " — " + facts : ""}${s.suggested_argument ? " [supports: " + s.suggested_argument + "]" : ""}`;
    }).join("\n") || "- (no scanned evidence)";

    const facts =
      `Dispute ${d.external_ref} | CPT ${d.cpt_code} | ${d.service_category} | service date ${d.service_date}\n` +
      `Plan: ${(d as any).plans?.name} | Initiator: ${(d as any).initiators?.name}\n` +
      `Demand $${d.demand_amount} vs plan QPA $${d.qpa_amount} | ineligibility score ${d.eligibility_score}\n` +
      `Failed eligibility findings:\n${findingsTxt}\n` +
      `Scanned evidence:\n${evidenceTxt}`;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ ok: false, reason: "AI drafting not configured (set ANTHROPIC_API_KEY on draft-section). The deterministic template still works without it." });

    const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest";
    const sys = (guidance ||
      "Write one concise, professional paragraph of additional eligibility argument for a No Surprises Act IDR eligibility objection.") +
      " Use ONLY the supplied facts and evidence — do not invent statutes, dates, or figures. Where a point is supported by an exhibit, reference it (e.g., 'as shown in Exhibit A'). Return the paragraph text only, no preamble, no markdown.";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 500, system: sys,
        messages: [{ role: "user", content: `Case facts:\n${facts}\n\nWrite the paragraph.` }] }),
    });
    if (!resp.ok) return json({ ok: false, reason: `model error ${resp.status}: ${(await resp.text()).slice(0, 200)}` });
    const out = await resp.json();
    return json({ ok: true, text: (out?.content?.[0]?.text ?? "").trim() });
  } catch (e) {
    return json({ ok: false, reason: String((e as Error).message || e) }, 500);
  }
});
