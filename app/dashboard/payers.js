"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import PayerDetail from "./PayerDetail";

function money(n) { return n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function pct(n) { return n == null ? "—" : Math.round(Number(n) * 100) + "%"; }

const PHASE_META = {
  intake:                { label: "Intake",        c: "#9aa1ab" },
  triage:                { label: "Triage",        c: "#7c8794" },
  eligibility_review:    { label: "Eligibility",   c: "#3b3c8f" },
  qpa_defense:           { label: "QPA defense",   c: "#0f6f6a" },
  response_prep:         { label: "Response",      c: "#8a5a00" },
  awaiting_determination:{ label: "Awaiting IDRE", c: "#2f3a63" },
  award_payment:         { label: "Payment",       c: "#137a4b" },
  closed:                { label: "Closed",        c: "#c9cdd3" },
};
const PHASE_ORDER = ["intake","triage","eligibility_review","qpa_defense","response_prep","awaiting_determination","award_payment","closed"];

function ceilingLabel(mode, value, globalPct) {
  if (mode === "pct_of_qpa") return value + "% of QPA";
  if (mode === "amount") return money(value) + " flat";
  return "Global " + globalPct + "%";
}

export function PayersView({ orgId, onErr, onOpenCase }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);        // expanded plan_id
  const [cases, setCases] = useState({});        // plan_id -> case list
  const [busy, setBusy] = useState("");
  const [detailPlan, setDetailPlan] = useState(null);

  const load = useCallback(async () => {
    try { const { data: d, error } = await supabase.rpc("payer_rollup"); if (error) throw error; setData(d); }
    catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  async function toggle(planId) {
    if (open === planId) { setOpen(null); return; }
    setOpen(planId);
    if (!cases[planId]) {
      try { const { data: c, error } = await supabase.rpc("plan_cases", { p_plan: planId }); if (error) throw error; setCases((m) => ({ ...m, [planId]: c || [] })); }
      catch (e) { onErr(e.message); }
    }
  }
  async function bulk(planId, action) {
    setBusy(action + planId);
    try {
      const { error } = await supabase.rpc("plan_bulk", { p_plan: planId, p_action: action });
      if (error) throw error;
      setCases((m) => { const n = { ...m }; delete n[planId]; return n; });
      if (open === planId) { const { data: c } = await supabase.rpc("plan_cases", { p_plan: planId }); setCases((m) => ({ ...m, [planId]: c || [] })); }
      await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }

  if (!data) return <p className="muted" style={{ padding: 24 }}>Loading payers…</p>;
  if (detailPlan) return <PayerDetail planId={detailPlan} onBack={() => setDetailPlan(null)} onOpenCase={onOpenCase} />;
  const plans = data.plans || [];
  const gp = data.global_pct ?? 125;
  const tot = plans.reduce((a, p) => ({
    risk: a.risk + Number(p.at_risk || 0), cases: a.cases + Number(p.open_cases || 0),
    demand: a.demand + Number(p.total_demand || 0), overdue: a.overdue + Number(p.overdue || 0),
  }), { risk: 0, cases: 0, demand: 0, overdue: 0 });

  const num = { fontFamily: "var(--num)", fontVariantNumeric: "tabular-nums", letterSpacing: "-.02em" };
  const card = { background: "var(--card)", borderRadius: 16, boxShadow: "var(--sh-2)", marginBottom: 16, overflow: "hidden" };

  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="shead">
        <div className="stitle">
          <h1 className="vh">Payers</h1>
          <span className="sub">Every plan you administer, grouped by exposure — set the stance once and act across all its cases at once.</span>
        </div>
      </div>

      {/* Portfolio summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, margin: "6px 0 24px" }}>
        {[
          { l: "At risk vs QPA", v: money(tot.risk), c: "var(--sig)" },
          { l: "Open cases", v: tot.cases, c: "var(--ink)" },
          { l: "In demand", v: money(tot.demand), c: "var(--ink)" },
          { l: "Overdue windows", v: tot.overdue, c: tot.overdue > 0 ? "var(--sig)" : "var(--ink)" },
        ].map((s, i) => (
          <div key={i} style={{ background: "var(--card)", borderRadius: 14, padding: "16px 18px", boxShadow: "var(--sh-1)" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--mut)", fontWeight: 600 }}>{s.l}</div>
            <div style={{ ...num, fontSize: 27, fontWeight: 600, marginTop: 7, color: s.c }}>{s.v}</div>
          </div>
        ))}
      </div>

      {plans.length === 0 && <p className="muted">No open cases across your plans right now.</p>}

      {plans.map((p) => {
        const isOpen = open === p.plan_id;
        const phaseTotal = Object.values(p.phases || {}).reduce((a, b) => a + Number(b), 0) || 1;
        const list = cases[p.plan_id] || [];
        return (
          <div key={p.plan_id} style={card}>
            {/* Header */}
            <div style={{ padding: "18px 22px", display: "flex", alignItems: "flex-start", gap: 16, borderLeft: "3px solid " + (p.overdue > 0 ? "var(--sig)" : "var(--line-2, var(--line))") }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <h3 style={{ margin: 0, fontFamily: "var(--disp)", fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>{p.plan_name}</h3>
                  <span className="badge b-grey">{(p.plan_type || "").replace(/_/g, " ")}</span>
                  <span className="badge" style={{ background: p.ceiling_mode ? "var(--accent-soft, #e2f0ef)" : "var(--sunk)", color: p.ceiling_mode ? "var(--accent-ink, #0a4c48)" : "var(--mut)" }}>
                    Ceiling: {ceilingLabel(p.ceiling_mode, p.ceiling_value, gp)}
                  </span>
                  {p.overdue > 0 && <span className="badge b-red"><i className="dot d-red" />{p.overdue} overdue</span>}
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{p.employer}</div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
                <div style={{ ...num, fontSize: 25, fontWeight: 600, color: "var(--sig)" }}>{money(p.at_risk)}</div>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em" }}>at risk vs QPA</div>
              </div>
            </div>

            {/* KPI row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 0, borderTop: "1px solid var(--hair, var(--line))", borderBottom: "1px solid var(--hair, var(--line))" }}>
              {[
                { l: "Open cases", v: p.open_cases },
                { l: "In demand", v: money(p.total_demand) },
                { l: "Plan QPA", v: money(p.total_qpa) },
                { l: "Avg win", v: pct(p.avg_win) },
                { l: "Challengeable", v: p.challengeable },
              ].map((k, i) => (
                <div key={i} style={{ padding: "13px 16px", borderLeft: i ? "1px solid var(--hair, var(--line))" : "none" }}>
                  <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--faint)", fontWeight: 600 }}>{k.l}</div>
                  <div style={{ ...num, fontSize: 16.5, fontWeight: 600, marginTop: 4 }}>{k.v}</div>
                </div>
              ))}
            </div>

            {/* Phase mix + initiators */}
            <div style={{ padding: "16px 22px" }}>
              <div style={{ display: "flex", height: 9, borderRadius: 20, overflow: "hidden", background: "var(--sunk)" }}>
                {PHASE_ORDER.filter((ph) => p.phases?.[ph]).map((ph) => {
                  const m = PHASE_META[ph]; const w = (Number(p.phases[ph]) / phaseTotal) * 100;
                  return <div key={ph} title={m.label + ": " + p.phases[ph]} style={{ width: w + "%", background: m.c }} />;
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 10 }}>
                {PHASE_ORDER.filter((ph) => p.phases?.[ph]).map((ph) => (
                  <span key={ph} style={{ fontSize: 11, color: "var(--mut)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <i style={{ width: 8, height: 8, borderRadius: 2, background: PHASE_META[ph].c, display: "inline-block" }} />{PHASE_META[ph].label} {p.phases[ph]}
                  </span>
                ))}
              </div>

              {(p.initiators || []).length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--faint)", fontWeight: 700, marginBottom: 8 }}>Filing against this plan</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {p.initiators.map((it, i) => (
                      <span key={i} className="chip" style={{ fontSize: 12, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 20, padding: "5px 12px" }}>
                        {it.name} <b style={{ ...num }}>{it.cases}</b> <span className="muted">· {money(it.demand)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ padding: "0 22px 18px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn btn-a" style={{ padding: "8px 14px" }} disabled={busy === "predict" + p.plan_id} onClick={() => bulk(p.plan_id, "predict")}>
                {busy === "predict" + p.plan_id ? "Working…" : "Generate offers at ceiling"}
              </button>
              <button className="btn btn-s" style={{ padding: "8px 14px" }} disabled={busy === "recompute" + p.plan_id} onClick={() => bulk(p.plan_id, "recompute")}>
                {busy === "recompute" + p.plan_id ? "Working…" : "Recompute ceilings"}
              </button>
              <button className="mini" onClick={() => toggle(p.plan_id)}>{isOpen ? "Hide cases" : "View " + p.open_cases + " cases"}</button>
              <button className="mini" onClick={() => setDetailPlan(p.plan_id)}>Open account →</button>
              <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }}>Set this plan&rsquo;s greenlit ceiling in Admin &rsquo; Ceilings</span>
            </div>

            {/* Expanded case table */}
            {isOpen && (
              <div style={{ borderTop: "1px solid var(--line)", padding: "8px 10px 12px", background: "var(--card-2, var(--bg))" }}>
                {list.length === 0 ? <p className="muted" style={{ padding: 14 }}>Loading cases…</p> : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead><tr style={{ color: "var(--faint)", textAlign: "left" }}>
                      {["Case", "Initiator", "Demand", "QPA", "Ceiling", "Rec. offer", "Win", "Phase", ""].map((h, i) => (
                        <th key={i} style={{ padding: "8px 12px", fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700, borderBottom: "1px solid var(--line)" }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {list.map((c) => (
                        <tr key={c.id} style={{ borderBottom: "1px solid var(--hair, var(--line))" }}>
                          <td style={{ padding: "9px 12px", fontWeight: 600 }}>{c.ref}<span className="muted" style={{ fontWeight: 400 }}> · {c.cpt}</span></td>
                          <td style={{ padding: "9px 12px", color: "var(--mut)" }}>{c.initiator || "—"}</td>
                          <td style={{ padding: "9px 12px", ...num }}>{money(c.demand)}</td>
                          <td style={{ padding: "9px 12px", ...num }}>{money(c.qpa)}</td>
                          <td style={{ padding: "9px 12px", ...num }}>{money(c.ceiling)}{c.above_bench && <i className="dot d-amber" title="Above regional benchmark" style={{ marginLeft: 5 }} />}</td>
                          <td style={{ padding: "9px 12px", ...num, fontWeight: 600 }}>{c.rec_offer != null ? money(c.rec_offer) : "—"}</td>
                          <td style={{ padding: "9px 12px", ...num }}>{c.win != null ? pct(c.win) : "—"}</td>
                          <td style={{ padding: "9px 12px" }}><span className="muted">{(c.phase || "").replace(/_/g, " ")}</span></td>
                          <td style={{ padding: "9px 12px", textAlign: "right" }}><button className="mini" onClick={() => onOpenCase && onOpenCase(c.id)}>Open →</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
