// Avertyn — verify-authorities edge function (on-demand "Verify now").
// Uses Claude with the web_search tool to check each legal authority against current
// eCFR / Federal Register text, then records findings via the hybrid RPCs:
//   low-risk  -> propose_authority_change(..., 'low', ...)      (auto-applies)
//   substantive -> propose_authority_change(..., 'substantive', ...) (held for review)
//   unchanged  -> mark_authority_verified(...)
// Degrades gracefully if ANTHROPIC_API_KEY is unset or web search is unavailable.
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
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: auths, error } = await svc.from("legal_authorities")
      .select("code, citation, mirrors, summary, source_url, status, operative, effective_note");
    if (error) throw error;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ ok: false, reason: "On-demand verification needs ANTHROPIC_API_KEY on verify-authorities. The weekly scheduled check is unaffected." });

    const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest";
    const registry = (auths || []).map((a: any) =>
      `- ${a.code}: "${a.citation}" — ${a.summary} [status ${a.status}, operative ${a.operative}] src ${a.source_url}`).join("\n");

    const sys = "You verify U.S. No Surprises Act / Federal IDR citations for a health-plan legal product. " +
      "For each authority below, use web search against eCFR (ecfr.gov title 45 part 149), CMS.gov, and " +
      "federalregister.gov to check whether its CFR subsection number is current, its one-line summary still " +
      "matches the text, whether it was superseded/vacated, or whether a pending rule became operative. " +
      "Be conservative: if a change touches legal meaning, classify it 'substantive'; only clean renumbers / " +
      "effective-date / source updates are 'low'. Do not invent citations. " +
      "Return ONLY a JSON array (no prose, no markdown) of objects: " +
      "{code, action: 'verified'|'low'|'substantive', field?: 'citation'|'summary'|'effective_note'|'source_url'|'mirrors'|'operative', " +
      "new_value?, kind?: 'renumber'|'effective_date'|'source'|'mirrors'|'supersede'|'new_standard'|'operative_change', " +
      "rationale?, source?, confidence: 0..1}. Include one object per authority.";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 4000, system: sys,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: `Authorities:\n${registry}\n\nReturn the JSON array now.` }],
      }),
    });
    if (!resp.ok) return json({ ok: false, reason: `model/web-search error ${resp.status}: ${(await resp.text()).slice(0, 200)}` });
    const out = await resp.json();
    const text = (out?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return json({ ok: false, reason: "Could not parse verification output." });
    let actions: any[]; try { actions = JSON.parse(m[0]); } catch { return json({ ok: false, reason: "Verification output was not valid JSON." }); }

    let verified = 0, auto = 0, review = 0;
    for (const a of actions) {
      try {
        if (a.action === "verified") {
          await svc.rpc("mark_authority_verified", { p_code: a.code, p_confidence: a.confidence ?? null, p_source: a.source ?? null, p_by: "ai:on-demand" });
          verified++;
        } else if (a.action === "low" || a.action === "substantive") {
          await svc.rpc("propose_authority_change", {
            p_code: a.code, p_field: a.field, p_new: String(a.new_value ?? ""), p_kind: a.kind ?? "other",
            p_risk: a.action === "low" ? "low" : "substantive", p_rationale: a.rationale ?? "",
            p_source: a.source ?? null, p_confidence: a.confidence ?? null, p_by: "ai:on-demand",
          });
          if (a.action === "low") auto++; else review++;
        }
      } catch (_) { /* tolerate a single bad action */ }
    }
    return json({ ok: true, checked: actions.length, verified, auto_applied: auto, held_for_review: review });
  } catch (e) {
    return json({ ok: false, reason: String((e as Error).message || e) }, 500);
  }
});
