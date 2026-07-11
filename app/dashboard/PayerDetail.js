"use client";
// Avertyn — Payer detail hub (account view for one plan sponsor).
// Additive: a NEW component. Renders the single-call payer_detail(plan) RPC as a
// master-detail hub (open from the Payers list row). Reuses existing data only —
// exposure, per-plan ceiling config, fiduciary compliance, top opponents, cases.
// Props:
//   planId     — plan uuid to show
//   onBack     — () => void, return to the Payers list
//   onOpenCase — (disputeId) => void, optional; jump to a case
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const pct = (p) => (p == null ? "—" : Math.round(Number(p) * 100) + "%");
const ceilingLabel = (cfg) => {
  if (!cfg) return "—";
  if (cfg.ceiling_mode && cfg.ceiling_value != null) {
    return cfg.ceiling_mode === "pct_of_qpa" ? `${cfg.ceiling_value}% of QPA (plan override)` : `${money(cfg.ceiling_value)} (plan override)`;
  }
  return `${cfg.global_pct}% of QPA (org default)`;
};

export function PayerDetail({ planId, onBack, onOpenCase }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("payer_detail", { p_plan: planId });
    if (error) setErr(error.message);
    else if (data && data.ok === false) setErr("Payer not found.");
    else setD(data);
    setLoading(false);
  }, [planId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="pb" style={{ padding: 20 }}><span className="muted">Loading payer…</span></div>;
  if (err) return <div className="pb" style={{ padding: 20 }}><span className="badge b-red"><i className="dot d-red" />{err}</span></div>;
  if (!d) return null;

  const ex = d.exposure || {};
  const inits = d.initiators || [];
  const cases = d.recent_cases || [];
  const phases = d.phases || {};
  const fid = d.fiduciary;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        {onBack && <button className="mini" onClick={onBack}>← Payers</button>}
      </div>
      <div className="dh" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 className="vh">{d.plan_name}</h1>
          <span className="sub">
            {d.employer || "—"}{d.broker ? ` · Broker ${d.broker}` : ""} · {(d.plan_type || "").replace(/_/g, " ")}
          </span>
        </div>
        {fid && (
          <span className={"badge b-" + (fid.score_pct >= 80 ? "green" : fid.score_pct >= 60 ? "amber" : "red")} style={{ marginLeft: "auto" }}
            title="ERISA fiduciary compliance for this plan">
            <i className={"dot d-" + (fid.score_pct >= 80 ? "green" : fid.score_pct >= 60 ? "amber" : "red")} />
            Compliance {fid.score_pct}%{fid.gaps ? ` · ${fid.gaps} gap${fid.gaps === 1 ? "" : "s"}` : ""}
          </span>
        )}
      </div>

      {/* Exposure KPIs */}
      <div className="cards" style={{ marginTop: 14 }}>
        <div className="kpi-tile"><div className="l">Open at risk</div><div className="n">{money(ex.at_risk)}</div><div className="goal">{ex.open_cases} open · {ex.overdue || 0} overdue</div></div>
        <div className="kpi-tile"><div className="l">Defended to date</div><div className="n">{money(ex.defended)}</div><div className="goal good">{ex.lifetime_disputes} lifetime disputes</div></div>
        <div className="kpi-tile"><div className="l">Win rate</div><div className="n">{ex.win_rate == null ? "—" : pct(ex.win_rate)}</div><div className="goal">{ex.resolved || 0} resolved · avg model {pct(ex.avg_win)}</div></div>
        <div className="kpi-tile"><div className="l">Challengeable</div><div className="n">{ex.challengeable || 0}</div><div className="goal">open · eligibility ≥ 80</div></div>
      </div>

      {/* Config + phases */}
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="ph">Plan configuration &amp; posture</div>
        <div className="pb" style={{ paddingTop: 12, display: "flex", gap: 28, flexWrap: "wrap" }}>
          <div style={{ minWidth: 220 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Defensible ceiling</div>
            <div style={{ fontFamily: "var(--num,monospace)", fontWeight: 600, marginTop: 3 }}>{ceilingLabel(d.config)}</div>
            {d.config?.ceiling_updated_at && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>updated {new Date(d.config.ceiling_updated_at).toLocaleDateString()}{d.config.ceiling_updated_by ? ` · ${d.config.ceiling_updated_by}` : ""}</div>}
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Set per-plan overrides in Admin → Plan ceilings.</div>
          </div>
          <div style={{ minWidth: 200 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Open cases by phase</div>
            {Object.keys(phases).length === 0 ? <span className="muted" style={{ fontSize: 12.5 }}>No open cases.</span> :
              Object.entries(phases).sort((a, b) => b[1] - a[1]).map(([ws, c]) => (
                <div key={ws} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0", gap: 14 }}>
                  <span className="muted">{ws.replace(/_/g, " ")}</span><b className="mono">{c}</b>
                </div>
              ))}
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Top opponents</div>
            {inits.length === 0 ? <span className="muted" style={{ fontSize: 12.5 }}>None.</span> :
              inits.slice(0, 6).map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0", gap: 14 }}>
                  <span>{it.name} <span className="muted">· {it.cases} case{it.cases === 1 ? "" : "s"}</span></span>
                  <b className="mono">{money(it.demand)}</b>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Cases */}
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="ph">Open cases<span className="act"><span className="muted" style={{ fontSize: 11 }}>this plan sponsor · highest demand first</span></span></div>
        {cases.length === 0 ? <p className="muted" style={{ padding: 16 }}>No open cases for this plan.</p> : (
          <table>
            <thead><tr>
              <th>Case</th><th>CPT</th><th>Initiator</th>
              <th style={{ textAlign: "right" }}>Demand</th><th style={{ textAlign: "right" }}>QPA</th>
              <th style={{ textAlign: "right" }}>Win</th><th style={{ textAlign: "right" }}>Inelig.</th><th>Phase</th>
            </tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} style={{ cursor: onOpenCase ? "pointer" : "default" }} onClick={() => onOpenCase && onOpenCase(c.id)}
                  title={onOpenCase ? "Open case" : undefined}>
                  <td><b>{c.ref || "—"}</b></td>
                  <td className="mono">{c.cpt || "—"}</td>
                  <td>{c.initiator || "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{money(c.demand)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{money(c.qpa)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.win == null ? "—" : pct(c.win)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.elig ?? "—"}</td>
                  <td>{(c.phase || "").replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default PayerDetail;
