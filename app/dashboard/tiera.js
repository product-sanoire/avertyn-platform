"use client";
// Avertyn dashboard — Tier A operator screens:
//   • InitiatorsView   — payer/initiator scorecard + IDRE behavior (leverage view)
//   • DeadlinesView    — deadline compliance rail + notification delivery status
//   • IntegrationsView — eligibility pre-screen API: tokens, docs, live tester
// Self-contained (org-scoped via RLS). Reuses the Ink & Paper component classes.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useLive } from "../../lib/useLive";
import { money, untilLabel } from "../../lib/format";

const API_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ssjougrsaecdwfuxeasd.supabase.co") + "/functions/v1/eligibility-prescreen";
const RESULT_MK = { pass: "ok", fail: "fail", warn: "warn", na: "na" };

// ============================================================ Initiators
export function InitiatorsView({ orgId, onErr, embedded }) {
  const [rows, setRows] = useState([]);
  const [idre, setIdre] = useState([]);

  const load = useCallback(async () => {
    try {
      const [{ data: sc, error: e1 }, { data: ib, error: e2 }] = await Promise.all([
        supabase.from("initiator_scorecard").select("*").order("disputes", { ascending: false }),
        orgId ? supabase.rpc("idre_behavior", { p_org: orgId }) : Promise.resolve({ data: [] }),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      setRows(sc || []);
      setIdre(Array.isArray(ib) ? ib : []);
    } catch (e) { onErr(e.message); }
  }, [orgId, onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("initiators", ["disputes", "idre_selections", "awards"], load);

  const totDisputes = rows.reduce((a, r) => a + Number(r.disputes || 0), 0);
  const totChallenged = rows.reduce((a, r) => a + Number(r.challenged || 0), 0);
  const wIneligible = totDisputes
    ? Math.round(rows.reduce((a, r) => a + Number(r.avg_ineligibility || 0) * Number(r.disputes || 0), 0) / totDisputes)
    : 0;
  const chartRows = [...rows].map((r) => ({ ...r, _m: r.avg_qpa ? Number(r.avg_demand) / Number(r.avg_qpa) : 0 })).sort((a, b) => b._m - a._m).slice(0, 8);
  const maxMult = Math.max(1, ...chartRows.map((r) => r._m));

  return (
    <div>
      {!embedded && <div className="dh"><h1>Initiators &amp; IDREs</h1>
        <span className="sub">Who's filing against your plans, how weak their filings are, and how each IDRE behaves — your negotiation leverage</span></div>}

      <div className="cards" style={{ marginTop: embedded ? 4 : 14 }}>
        <div className="kpi-tile"><div className="l">Initiators</div><div className="n">{rows.length}</div></div>
        <div className="kpi-tile"><div className="l">Disputes filed</div><div className="n">{totDisputes}</div></div>
        <div className="kpi-tile"><div className="l">Avg ineligibility</div><div className="n">{wIneligible}</div><div className="goal">weighted across filings</div></div>
        <div className="kpi-tile"><div className="l">Challenged</div><div className="n">{totChallenged}</div><div className="goal good">eligibility challenges filed</div></div>
      </div>

      <div className="panel">
        <div className="ph">Demand ÷ QPA by initiator<span className="act"><span className="muted" style={{ fontSize: 11 }}>how far each filer overreaches vs. the plan's QPA</span></span></div>
        <div className="pb" style={{ paddingTop: 14 }}>
          {chartRows.length === 0 ? <p className="muted">No data yet.</p> : chartRows.map((r, i) => {
            const w = Math.min(100, (r._m / maxMult) * 100);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0" }}>
                <div style={{ width: 140, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.initiator}</div>
                <div style={{ flex: 1, height: 14, background: "var(--sunk)", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: w + "%", background: "linear-gradient(90deg,#c8492e,#a8321f)", borderRadius: 999 }} />
                </div>
                <div className="mono" style={{ width: 54, textAlign: "right", fontWeight: 600, fontSize: 12.5 }}>{r._m.toFixed(1)}×</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="ph">Initiator scorecard<span className="act"><span className="muted" style={{ fontSize: 11 }}>ranked by filing volume — target the aggressive, weak filers first</span></span></div>
        {rows.length === 0 ? <p className="muted" style={{ padding: 16 }}>No initiator data yet.</p> : (
          <table>
            <thead><tr><th>Initiator</th><th>Disputes</th><th>Avg ineligibility</th><th>Challenged</th><th>Avg demand</th><th>Avg QPA</th><th>Demand ÷ QPA</th></tr></thead>
            <tbody>
              {rows.map((s, i) => {
                const mult = s.avg_qpa ? (Number(s.avg_demand) / Number(s.avg_qpa)) : null;
                return (
                  <tr key={i}>
                    <td><b>{s.initiator}</b></td>
                    <td className="mono">{s.disputes}</td>
                    <td className="mono">{s.avg_ineligibility ?? "—"}{s.avg_ineligibility != null && <span className={"badge " + (s.avg_ineligibility >= 60 ? "b-red" : s.avg_ineligibility >= 40 ? "b-amber" : "b-grey")} style={{ marginLeft: 6 }}>{s.avg_ineligibility >= 60 ? "weak" : s.avg_ineligibility >= 40 ? "mixed" : "solid"}</span>}</td>
                    <td className="mono">{s.challenged}</td>
                    <td className="mono">{money(s.avg_demand)}</td>
                    <td className="mono">{money(s.avg_qpa)}</td>
                    <td className="mono">{mult ? <span className="badge b-red">{mult.toFixed(1)}×</span> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="ph">IDRE behavior<span className="act"><span className="muted" style={{ fontSize: 11 }}>certified IDR entities you've been assigned — selections &amp; re-selections</span></span></div>
        {idre.length === 0 ? <p className="muted" style={{ padding: 16 }}>No IDRE selections recorded yet.</p> : (
          <table>
            <thead><tr><th>Certified IDRE</th><th>Selections</th><th>Re-selections</th></tr></thead>
            <tbody>
              {idre.map((e, i) => (
                <tr key={i}><td><b>{e.idre}</b></td><td className="mono">{e.selections}</td><td className="mono">{e.reselections}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================ Deadlines & delivery
export function DeadlinesView({ orgId, onErr, embedded }) {
  const [dls, setDls] = useState([]);
  const [status, setStatus] = useState(null);
  const [outbox, setOutbox] = useState([]);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [{ data: d, error: e1 }, { data: st }, { data: ob }] = await Promise.all([
        supabase.from("deadlines").select("id, kind, due_at, status, disputes(external_ref)").eq("status", "open").order("due_at", { ascending: true }).limit(60),
        supabase.from("outbox_status_v").select("*").maybeSingle(),
        supabase.from("notification_outbox").select("id, channel_kind, target, status, response, last_attempt_at, created_at").order("created_at", { ascending: false }).limit(14),
      ]);
      if (e1) throw e1;
      setDls(d || []); setStatus(st || null); setOutbox(ob || []);
    } catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("deadlines", ["deadlines", "notification_outbox", "notifications"], load);

  async function scanAlerts() {
    setBusy("scan"); setNote("");
    try {
      const { data, error } = await supabase.rpc("deliver_deadline_alerts", { p_org: orgId });
      if (error) throw error;
      setNote(`Created ${data?.alerts_created ?? 0} deadline alert(s) — queued to your channels.`);
      await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function dispatch() {
    setBusy("send"); setNote("");
    try {
      const { data, error } = await supabase.functions.invoke("deliver-notifications", { body: {} });
      if (error) throw error;
      setNote(`Dispatched ${data?.processed ?? 0}: ${data?.sent ?? 0} sent · ${data?.simulated ?? 0} simulated · ${data?.failed ?? 0} failed (provider: ${data?.provider ?? "none"}).`);
      await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }

  const overdue = dls.filter((d) => new Date(d.due_at) < new Date()).length;
  const soon = dls.filter((d) => { const h = (new Date(d.due_at) - new Date()) / 3.6e6; return h >= 0 && h <= 72; }).length;

  return (
    <div>
      {!embedded && <div className="dh"><h1>Deadlines &amp; delivery</h1>
        <span className="sub">Never miss a window — the rail that kills default losses, plus the alerts that actually go out</span></div>}

      <div className="cards" style={{ marginTop: embedded ? 4 : 14 }}>
        <div className="kpi-tile"><div className="l">Open windows</div><div className="n">{dls.length}</div></div>
        <div className="kpi-tile"><div className="l">Overdue</div><div className="n">{overdue}</div><div className={"goal" + (overdue ? " bad" : " good")}>{overdue ? "act now" : "none missed"}</div></div>
        <div className="kpi-tile"><div className="l">Due ≤ 72h</div><div className="n">{soon}</div><div className="goal">business-day aware</div></div>
        <div className="kpi-tile"><div className="l">Alerts queued</div><div className="n">{status?.queued ?? 0}</div><div className="goal">{status?.sent ?? 0} sent · {status?.failed ?? 0} failed</div></div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-s" disabled={busy === "scan"} onClick={scanAlerts}>{busy === "scan" ? "Scanning…" : "Scan windows & create alerts"}</button>
        <button className="btn btn-a" disabled={busy === "send"} onClick={dispatch}>{busy === "send" ? "Dispatching…" : "Dispatch queued alerts now"}</button>
        {note && <span className="badge b-green"><i className="dot d-green" />{note}</span>}
      </div>

      <div className="panel">
        <div className="ph">Upcoming windows</div>
        {dls.length === 0 ? <p className="muted" style={{ padding: 16 }}>No open deadlines. The rail is clear.</p> : (
          <table>
            <thead><tr><th>Dispute</th><th>Window</th><th>Due</th><th>Countdown</th></tr></thead>
            <tbody>
              {dls.map((d) => {
                const od = new Date(d.due_at) < new Date();
                return (
                  <tr key={d.id}>
                    <td><b>#{d.disputes?.external_ref || "—"}</b></td>
                    <td>{(d.kind || "deadline").replace(/_/g, " ")}</td>
                    <td className="mono">{new Date(d.due_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td><span className={"badge " + (od ? "b-red" : "b-amber")}><i className={"dot d-" + (od ? "red" : "amber")} />{untilLabel(d.due_at)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="ph">Delivery log<span className="act"><span className="muted" style={{ fontSize: 11 }}>notification_outbox — email &amp; push dispatch results</span></span></div>
        {outbox.length === 0 ? <p className="muted" style={{ padding: 16 }}>Nothing dispatched yet.</p> : (
          <table>
            <thead><tr><th>Channel</th><th>Target</th><th>Status</th><th>Response</th><th>When</th></tr></thead>
            <tbody>
              {outbox.map((o) => (
                <tr key={o.id}>
                  <td>{o.channel_kind}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{o.target}</td>
                  <td><span className={"badge " + (o.status === "sent" ? "b-green" : o.status === "failed" ? "b-red" : "b-amber")}>{o.status}</span></td>
                  <td className="muted" style={{ fontSize: 11 }}>{o.response || "—"}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{o.last_attempt_at ? new Date(o.last_attempt_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================ Integrations / API
function genToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return "avk_live_" + [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function IntegrationsView({ onErr, embedded }) {
  const [tokens, setTokens] = useState([]);
  const [logs, setLogs] = useState([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState("");   // newly-minted token, shown once
  const [busy, setBusy] = useState(false);
  // tester
  const [form, setForm] = useState({ jurisdiction: "self_funded_erisa", open_negotiation_complete: true, initiation_within_window: true, qualified_item: true, cost_share_at_qpa: true, duplicate: false, batch_line_count: "" });
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ data: t, error: e1 }, { data: l }] = await Promise.all([
        supabase.from("api_tokens").select("id, name, token_prefix, active, request_count, last_used_at, created_at").order("created_at", { ascending: false }),
        supabase.from("api_request_log").select("endpoint, status, meta, created_at").order("created_at", { ascending: false }).limit(10),
      ]);
      if (e1) throw e1;
      setTokens(t || []); setLogs(l || []);
    } catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true);
    try {
      const token = genToken();
      const hash = await sha256Hex(token);
      const { error } = await supabase.rpc("api_token_add", { p_name: name.trim() || "API token", p_prefix: token.slice(0, 13), p_hash: hash });
      if (error) throw error;
      setFresh(token); setName(""); await load();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }
  async function revoke(id) {
    try { const { error } = await supabase.rpc("api_token_revoke", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }
  async function runTest() {
    setTesting(true); setResult(null);
    try {
      const payload = { jurisdiction: form.jurisdiction, open_negotiation_complete: form.open_negotiation_complete, initiation_within_window: form.initiation_within_window, qualified_item: form.qualified_item, cost_share_at_qpa: form.cost_share_at_qpa, duplicate: form.duplicate };
      if (form.batch_line_count !== "") payload.batch_line_count = Number(form.batch_line_count);
      const { data, error } = await supabase.rpc("prescreen_eligibility", { p_payload: payload });
      if (error) throw error;
      setResult(data);
    } catch (e) { onErr(e.message); }
    setTesting(false);
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const curl = `curl -X POST "${API_BASE}" \\
  -H "Authorization: Bearer avk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"jurisdiction":"state","initiation_within_window":false,"open_negotiation_complete":true}'`;

  return (
    <div>
      {!embedded && <div className="dh"><h1>Integrations · Eligibility API</h1>
        <span className="sub">Embed Avertyn's NSA eligibility pre-screen in a clearinghouse or another TPA — the distribution play</span></div>}

      {fresh && (
        <div className="panel" style={{ borderColor: "var(--ok)" }}>
          <div className="ph" style={{ color: "var(--ok)" }}>New token — copy it now, it won't be shown again</div>
          <div className="pb" style={{ paddingTop: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code className="mono" style={{ background: "#f4f3f1", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, wordBreak: "break-all" }}>{fresh}</code>
              <button className="mini" onClick={() => navigator.clipboard?.writeText(fresh)}>Copy</button>
              <button className="mini" onClick={() => setFresh("")}>Done</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="ph">API tokens
          <span className="act" style={{ display: "flex", gap: 8 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name…"
              style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12 }} />
            <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy} onClick={create}>{busy ? "Creating…" : "Create token"}</button>
          </span>
        </div>
        {tokens.length === 0 ? <p className="muted" style={{ padding: 16 }}>No tokens yet. Create one to call the API.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Requests</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b></td>
                  <td className="mono" style={{ fontSize: 11 }}>{t.token_prefix}…</td>
                  <td className="mono">{t.request_count}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{t.last_used_at ? new Date(t.last_used_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never"}</td>
                  <td><span className={"badge " + (t.active ? "b-green" : "b-grey")}>{t.active ? "active" : "revoked"}</span></td>
                  <td>{t.active && <button className="mini" onClick={() => revoke(t.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="ph">Endpoint</div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span className="badge b-ink">POST</span>
            <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{API_BASE}</code>
          </div>
          <pre style={{ background: "#f4f3f1", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", fontSize: 11.5, overflow: "auto", margin: 0, fontFamily: "var(--num)" }}>{curl}</pre>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Fields: <code>open_negotiation_complete</code>, <code>initiation_within_window</code>, <code>jurisdiction</code>, <code>qualified_item</code>, <code>oon_consent</code>, <code>carc</code>/<code>rarc</code>, <code>batch_line_count</code>, <code>cost_share_at_qpa</code>, <code>duplicate</code>. Returns an ineligibility score (0–100), band, recommendation, and itemized findings.</p>
        </div>
      </div>

      <div className="panel">
        <div className="ph">Try it<span className="act"><span className="muted" style={{ fontSize: 11 }}>runs the same engine the API uses</span></span></div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ minWidth: 260 }}>
              <label className="rlabel" style={{ display: "block" }}>Jurisdiction</label>
              <select value={form.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} className="dsel" style={{ padding: "8px 10px", width: "100%" }}>
                <option value="self_funded_erisa">Self-funded ERISA (federal)</option>
                <option value="federal">Federal</option>
                <option value="state">State</option>
                <option value="unknown">Unknown</option>
              </select>
              <div style={{ marginTop: 10 }}>
                {[["open_negotiation_complete", "Open-negotiation complete"], ["initiation_within_window", "Initiated within 4-day window"], ["qualified_item", "NSA-qualified OON item"], ["cost_share_at_qpa", "Cost-share at QPA"], ["duplicate", "Duplicate of a filed dispute"]].map(([k, lbl]) => (
                  <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--mut)", padding: "5px 0" }}>
                    <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} />{lbl}
                  </label>
                ))}
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--mut)", padding: "5px 0" }}>
                  Batch line count
                  <input type="number" value={form.batch_line_count} onChange={(e) => set("batch_line_count", e.target.value)} placeholder="—" style={{ width: 90, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12 }} />
                </label>
              </div>
              <button className="btn btn-a" style={{ marginTop: 10 }} disabled={testing} onClick={runTest}>{testing ? "Scoring…" : "Pre-screen this claim"}</button>
            </div>

            <div style={{ flex: 1, minWidth: 260 }}>
              {!result ? <p className="muted">Set the claim facts and run the pre-screen to see the score and findings.</p> : (
                <div>
                  <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                    <div className="gauge" style={{ background: `conic-gradient(${result.eligibility_score >= 80 ? "var(--sig)" : result.eligibility_score >= 50 ? "var(--warn)" : "var(--ok)"} ${result.eligibility_score}%,#eeedea 0)` }}>
                      <div className="v"><b style={{ color: result.eligibility_score >= 80 ? "var(--sig)" : result.eligibility_score >= 50 ? "var(--warn)" : "var(--ok)" }}>{result.eligibility_score}</b><span>Ineligible</span></div>
                    </div>
                    <div>
                      <span className={"badge " + (result.band === "likely_ineligible" ? "b-red" : result.band === "review" ? "b-amber" : "b-green")}><i className={"dot d-" + (result.band === "likely_ineligible" ? "red" : result.band === "review" ? "amber" : "green")} />{String(result.recommendation || "").replace(/_/g, " ")}</span>
                      <p className="muted" style={{ marginTop: 8, maxWidth: "26ch", fontSize: 12 }}>{result.disqualifying_fails} disqualifying · {result.warnings} warning(s). Same scoring as the stored-dispute engine.</p>
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    {(result.findings || []).map((f, i) => (
                      <div key={i} className="frow"><span className={"mk " + (RESULT_MK[f.result] || "na")}>{f.result === "pass" ? "✓" : f.result === "fail" ? "×" : f.result === "warn" ? "!" : "–"}</span>
                        <div><b>{f.name}</b><div className="sub">{f.severity} · {f.detail}</div></div></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">Recent API requests</div>
        {logs.length === 0 ? <p className="muted" style={{ padding: 16 }}>No API calls yet. Calls made with a token appear here.</p> : (
          <table>
            <thead><tr><th>Endpoint</th><th>Status</th><th>Recommendation</th><th>When</th></tr></thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 11 }}>{l.endpoint}</td>
                  <td><span className={"badge " + (l.status === 200 ? "b-green" : "b-red")}>{l.status}</span></td>
                  <td className="muted" style={{ fontSize: 11 }}>{l.meta?.recommendation ? String(l.meta.recommendation).replace(/_/g, " ") : "—"}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{new Date(l.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
