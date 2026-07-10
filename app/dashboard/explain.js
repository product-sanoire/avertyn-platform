"use client";
// Avertyn — Explainability. Every recommendation is glass-box: the win-probability
// model's feature contributions, the QPA comparison ladder + statutory factors,
// the eligibility findings, and a chronological action trail. Opens over a dispute.
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const REC_TONE = { challenge: "red", defend: "ink", settle: "amber" };
const RESULT_MK = { pass: ["ok", "✓"], fail: ["fail", "×"], warn: ["warn", "!"], na: ["na", "–"] };
const FACTOR_TONE = { applied: "green", current: "green", estimated: "amber", review: "amber", not_varied: "grey" };

export function ExplainModal({ disputeId, onClose }) {
  const [ex, setEx] = useState(null);
  const [qp, setQp] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const [{ data: e, error: e1 }, { data: q, error: e2 }] = await Promise.all([
          supabase.rpc("explain_dispute", { p_dispute: disputeId }),
          supabase.rpc("qpa_explain", { p_dispute: disputeId }),
        ]);
        if (e1) throw e1; if (e2) throw e2;
        if (live) { setEx(e || null); setQp(q && q.ok !== false ? q : null); }
      } catch (er) { if (live) setErr(er.message || "Couldn't build the explanation."); }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [disputeId]);

  const pred = ex?.prediction;
  const drivers = pred?.drivers || [];
  const maxAbs = Math.max(0.01, ...drivers.map((d) => Math.abs(Number(d.contribution) || 0)));
  const ladder = (qp?.comparison_ladder || []).filter((l) => l.amount != null);
  const maxAmt = Math.max(1, ...ladder.map((l) => Number(l.amount) || 0));
  const trail = ex?.action_trail || [];
  const findings = ex?.eligibility_findings || [];
  const wp = pred ? Math.round(Number(pred.win_prob) * 100) : null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal xw" onClick={(e) => e.stopPropagation()}>
        <div className="mhd">
          <b style={{ fontFamily: "var(--disp)", fontSize: 16 }}>Why this recommendation · #{ex?.dispute || "—"}</b>
          <span className="badge b-ink" style={{ marginLeft: 8 }}>glass-box</span>
          <button className="x" onClick={onClose} style={{ marginLeft: "auto" }}>×</button>
        </div>
        <div className="mbody" style={{ maxHeight: "76vh", overflow: "auto" }}>
          {loading ? <p className="muted">Assembling the model, benchmarks and ledger…</p>
            : err ? <p className="muted">{err}</p>
            : (
            <>
              {/* Prediction + driver contributions */}
              <div className="xsec">
                <div className="xh">Model recommendation</div>
                {!pred ? <p className="muted">No prediction yet — run “Predict outcome” on this case first.</p> : (
                  <>
                    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
                      <div className="gauge" style={{ background: `conic-gradient(var(--ink) ${wp}%,#eeedea 0)` }}>
                        <div className="v"><b>{wp}%</b><span>Plan win</span></div>
                      </div>
                      <div>
                        <span className={"badge b-" + (REC_TONE[pred.recommended] || "grey")}><i className={"dot d-" + (REC_TONE[pred.recommended] || "grey")} />{String(pred.recommended || "").toUpperCase()}</span>
                        <div className="muted" style={{ fontSize: 12.5, marginTop: 8, maxWidth: "42ch" }}>
                          Recommended offer <b className="mono">{money(pred.recommended_offer)}</b> · model {pred.model_version || "logit-v1"}. Each driver below is a signed contribution to the win-probability logit — nothing hidden.
                        </div>
                      </div>
                    </div>
                    <div className="wf">
                      {drivers.map((d, i) => {
                        const c = Number(d.contribution) || 0;
                        const w = (Math.abs(c) / maxAbs) * 50;
                        const pos = c >= 0;
                        return (
                          <div key={i} className="wfrow">
                            <div className="wfl">{String(d.feature).replace(/_/g, " ")}</div>
                            <div className="wftrack">
                              <div className="wfmid" />
                              <div className="wfbar" style={{ [pos ? "left" : "right"]: "50%", width: w + "%", background: pos ? "var(--c-sage)" : "var(--c-clay)" }} />
                            </div>
                            <div className="mono wfv" style={{ color: pos ? "var(--c-sage)" : "var(--c-clay)" }}>{pos ? "+" : ""}{c.toFixed(2)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Green raises the plan's win probability · clay lowers it. Feature value shown as the model saw it.</div>
                  </>
                )}
              </div>

              {/* QPA ladder */}
              {qp && (
                <div className="xsec">
                  <div className="xh">QPA derivation · {qp.cpt} · rating area {qp.rating_area}</div>
                  <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{qp?.defensibility?.narrative}</p>
                  <div className="ladder">
                    {ladder.map((l, i) => {
                      const w = (Number(l.amount) / maxAmt) * 100;
                      const anchor = l.anchor;
                      return (
                        <div key={i} className={"ldrow" + (anchor ? " anchor" : "")}>
                          <div className="ldl">{l.label}{anchor && <span className="badge b-ink" style={{ marginLeft: 6 }}>QPA</span>}</div>
                          <div className="ldtrack"><div className="ldfill" style={{ width: w + "%", background: anchor ? "var(--ink)" : "var(--c-teal)" }} /></div>
                          <div className="mono ldv">{money(l.amount)}{l.pct_of_qpa != null && <span className="muted" style={{ marginLeft: 5 }}>{l.pct_of_qpa}%</span>}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="xh" style={{ marginTop: 14 }}>Statutory factors · 45 CFR 149.140</div>
                  <div className="pb" style={{ padding: 0 }}>
                    {(qp.statutory_factors || []).map((f, i) => (
                      <div key={i} className="frow" style={{ alignItems: "flex-start" }}>
                        <span className={"badge b-" + (FACTOR_TONE[f.status] || "grey")} style={{ marginTop: 1 }}>{String(f.status).replace(/_/g, " ")}</span>
                        <div><b>{f.factor}</b><div className="sub">{f.note || f.requirement}</div></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Eligibility findings */}
              <div className="xsec">
                <div className="xh">Eligibility findings</div>
                {findings.length === 0 ? <p className="muted">No findings recorded — run the eligibility engine.</p> : findings.map((f, i) => {
                  const [cls, gl] = RESULT_MK[f.result] || RESULT_MK.na;
                  return (
                    <div key={i} className="frow" style={{ alignItems: "flex-start" }}>
                      <span className={"mk " + cls}>{gl}</span>
                      <div><b>{String(f.rule || "rule").replace(/_/g, " ")}</b>
                        <div className="sub">{f.detail}{f.confidence != null ? ` · confidence ${Math.round(Number(f.confidence) * 100)}%` : ""}</div></div>
                    </div>
                  );
                })}
              </div>

              {/* Action trail timeline */}
              <div className="xsec">
                <div className="xh">Decision & action trail</div>
                {trail.length === 0 ? <p className="muted">No actions recorded on this case yet.</p> : (
                  <div className="tl">
                    {trail.map((t, i) => (
                      <div key={i} className="tlitem">
                        <div className="tldot" data-agent={t.actor === "agent" ? "1" : "0"} />
                        <div className="tlbody">
                          <div className="tltop"><b>{String(t.action || "").replace(/_/g, " ")}</b>
                            <span className={"badge " + (t.actor === "agent" ? "b-amber" : "b-ink")}>{t.actor}</span>
                            <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>{t.at ? new Date(t.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
                          </div>
                          {t.rationale && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{t.rationale}</div>}
                          {Array.isArray(t.citations) && t.citations.length > 0 && (
                            <div style={{ marginTop: 5, display: "flex", gap: 5, flexWrap: "wrap" }}>
                              {t.citations.map((c, j) => <span key={j} className="badge b-grey" style={{ fontSize: 10 }}>{typeof c === "string" ? c : (c.label || c.cite || "cite")}</span>)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
