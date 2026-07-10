"use client";
// Avertyn dashboard — Live Intelligence.
// Ports the standalone site/intelligence.html into the platform as a native,
// org-scoped segment of the Intelligence tab. Every number is computed live by
// Avertyn's engines on THIS org's real disputes (RLS-scoped) — the transparent
// QPA, the game-theoretic negotiation model, the peer-benchmark network and the
// flat-fee ROI. Nothing hardcoded, no black box.
//
// Calls the org-scoped SECURITY DEFINER wrappers (each verifies the dispute
// belongs to auth_org_id()):
//   org_qpa_explain(p_dispute)        org_negotiation_strategy(p_dispute)
//   org_negotiation_counter(p_dispute, p_offer)   org_value_transparency(p_take_rate)
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const logistic = (x, res, scale) => 1 / (1 + Math.exp(-((x - res) / scale)));
const pct = (p) => Math.round((Number(p) || 0) * 100);

export function LiveIntelligenceView({ orgId, onErr, embedded }) {
  const [disputes, setDisputes] = useState([]);
  const [sel, setSel] = useState("");
  const [qpa, setQpa] = useState(null);
  const [strat, setStrat] = useState(null);
  const [roi, setRoi] = useState(null);
  const [loading, setLoading] = useState(true);

  // org disputes for the selector (RLS-scoped to this org)
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("disputes")
          .select("id, claim_number, cpt_code, created_at")
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw error;
        if (!live) return;
        const rows = data || [];
        setDisputes(rows);
        if (rows.length) setSel(rows[0].id);
        else setLoading(false);
      } catch (e) {
        if (live) { onErr && onErr(e.message); setLoading(false); }
      }
    })();
    return () => { live = false; };
  }, [orgId, onErr]);

  // ROI is org-level, not per-dispute — load once
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("org_value_transparency", { p_take_rate: 0.28 });
        if (error) throw error;
        if (live) setRoi(data && data.ok ? data : { ok: false });
      } catch { if (live) setRoi({ ok: false }); }
    })();
    return () => { live = false; };
  }, [orgId]);

  // per-dispute intelligence
  const load = useCallback(async (id) => {
    if (!id) return;
    setLoading(true); setQpa(null); setStrat(null);
    try {
      const [{ data: q, error: e1 }, { data: s, error: e2 }] = await Promise.all([
        supabase.rpc("org_qpa_explain", { p_dispute: id }),
        supabase.rpc("org_negotiation_strategy", { p_dispute: id }),
      ]);
      if (e1) throw e1; if (e2) throw e2;
      setQpa(q && q.ok ? q : { ok: false });
      setStrat(s && s.ok ? s : { ok: false });
    } catch (e) { onErr && onErr(e.message); setQpa({ ok: false }); setStrat({ ok: false }); }
    setLoading(false);
  }, [onErr]);

  useEffect(() => { if (sel) load(sel); }, [sel, load]);

  const meta = qpa && qpa.ok ? `· ${qpa.service} · rating area ${qpa.rating_area || "national"}` : "";

  return (
    <div className="il-wrap">
      <div className="il-ctl">
        <label className="il-sm" htmlFor="il-disp">Dispute</label>
        <select id="il-disp" value={sel} onChange={(e) => setSel(e.target.value)}>
          {disputes.length === 0 && <option value="">No disputes yet</option>}
          {disputes.map((d) => (
            <option key={d.id} value={d.id}>
              {d.claim_number}{d.cpt_code ? ` — CPT ${d.cpt_code}` : ""}
            </option>
          ))}
        </select>
        <span className="il-muted" aria-live="polite">{meta}</span>
        <span className="il-live" style={{ marginLeft: "auto" }}>
          <span className="il-dot" aria-hidden="true" /> Live · computed on your data
        </span>
      </div>

      <div className="il-grid">
        <QpaCard qpa={qpa} loading={loading} />
        <NegCard strat={strat} disputeId={sel} loading={loading} />
        <BmCard qpa={qpa} loading={loading} />
        <RoiCard roi={roi} />
      </div>

      <p className="il-foot">
        Payer-side No Surprises Act IDR defense. Figures are computed live on your
        organization's disputes and update as the engines run.
      </p>
    </div>
  );
}

/* ───────────────────────── Why this QPA ───────────────────────── */
function QpaCard({ qpa, loading }) {
  return (
    <div className="il-card">
      <h3>Why this QPA</h3>
      <div className="il-cap">Transparent · 45 CFR 149.140</div>
      {loading ? <div className="il-load">Loading…</div>
        : !qpa || !qpa.ok ? <span className="il-err">No QPA data.</span>
        : <QpaBody q={qpa} />}
    </div>
  );
}
function QpaBody({ q }) {
  const lad = (q.comparison_ladder || []).filter((r) => r.amount != null);
  const max = Math.max(1, ...lad.map((r) => Number(r.amount) || 0));
  const facts = (q.statutory_factors || []).slice(0, 6);
  return (
    <>
      <div className="il-kv"><span className="k">Service · rating area</span><span className="v">{q.service} · {q.rating_area || "national"}</span></div>
      <div className="il-kv"><span className="k">Qualifying Payment Amount</span><span className="v">{money(q.qpa)}</span></div>
      <div className="il-kv"><span className="k">Defensible ceiling</span><span className="v">{money(q.defensible_ceiling)}</span></div>
      <div className="il-lad" style={{ marginTop: 12 }}>
        {lad.map((r, i) => {
          const w = Math.max(2, (Number(r.amount) / max) * 100);
          const cls = r.anchor ? "anchor" : (/demand|billed/i.test(r.label) ? "demand" : "");
          return (
            <div className="il-lrow" key={i}>
              <span className="ll">{r.label}</span>
              <span className={`il-bar ${cls}`}><span style={{ width: `${w}%` }} /></span>
              <span className="lv">{money(r.amount)}{r.pct_of_qpa ? <span className="il-muted"> {r.pct_of_qpa}%</span> : null}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12 }}>
        {facts.map((f, i) => (
          <div className="il-fac" key={i}><b>{f.factor}</b> — {f.note || f.requirement}</div>
        ))}
      </div>
      <div className="il-fac" style={{ marginTop: 10 }}>
        <span className="il-pill p-ok">black box: false</span> &nbsp;every input reproducible
      </div>
    </>
  );
}

/* ───────────────────────── Negotiation cockpit ───────────────────────── */
function NegCard({ strat, disputeId, loading }) {
  return (
    <div className="il-card">
      <h3>Negotiation cockpit</h3>
      <div className="il-cap">Bargaining zone · acceptance curve</div>
      {loading ? <div className="il-load">Loading…</div>
        : !strat || !strat.ok ? <span className="il-err">No negotiation data.</span>
        : <NegBody s={strat} disputeId={disputeId} />}
    </div>
  );
}
function NegBody({ s, disputeId }) {
  const m = s.model, r = s.recommendation, w = s.window;
  const res = +m.provider_reservation, idr = +m.plan_idr_cost, scale = +m.scale;
  const qpa = +s.anchors.qpa, demand = +s.anchors.demand, target = +r.target_settlement;

  const W = 460, H = 190, padL = 6, padR = 6, padT = 8, padB = 22;
  const x0 = Math.min(qpa, res) * 0.9, x1 = demand * 1.02;
  const sx = (v) => padL + ((v - x0) / (x1 - x0)) * (W - padL - padR);
  const sy = (p) => padT + (1 - p) * (H - padT - padB);
  let path = "";
  for (let i = 0; i <= 60; i++) {
    const v = x0 + (x1 - x0) * i / 60;
    const p = logistic(v, res, scale);
    path += (i ? "L" : "M") + sx(v).toFixed(1) + "," + sy(p).toFixed(1) + " ";
  }
  const zoneOK = res <= idr;
  const dotY = sy(logistic(target, res, scale));
  const cls = r.recommended_path === "settle" ? "settle" : "idr";
  const tick = (v, lbl, lvl = 0) => {
    const x = sx(v);
    const a = x < 30 ? "start" : (x > W - 30 ? "end" : "middle");
    return <text key={lbl} x={x.toFixed(1)} y={H - 6 - lvl * 11} fontSize="9" fill="#878d97" textAnchor={a} fontFamily="Space Grotesk">{lbl}</text>;
  };
  const vline = (v, c, dash) => <line x1={sx(v)} y1={padT} x2={sx(v)} y2={H - padB} stroke={c} strokeWidth="1.5" strokeDasharray={dash ? "4 3" : undefined} />;
  const desc = `Acceptance-probability curve. Provider reservation ${money(res)}, plan IDR cost ${money(idr)}, target ${money(target)} at ${pct(r.target_accept_prob)}% acceptance.`;

  return (
    <>
      <svg className="il-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={desc}>
        {zoneOK && <rect x={sx(res)} y={padT} width={Math.max(0, sx(idr) - sx(res))} height={H - padT - padB} fill="#2e6b52" opacity="0.09" />}
        <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#e2e5ea" />
        <line x1={padL} y1={sy(0.5)} x2={W - padR} y2={sy(0.5)} stroke="#edeff2" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke="#181b20" strokeWidth="2" />
        {vline(res, "#8a6a1f", 1)}{vline(idr, "#b23a2a", 1)}{vline(target, "#2e6b52", 0)}
        <circle cx={sx(target)} cy={dotY} r="4.5" fill="#2e6b52" />
        {tick(qpa, "QPA", 0)}{tick(res, "reserve", 1)}{tick(target, "target", 2)}{tick(idr, "IDR", 1)}{tick(demand, "demand", 0)}
      </svg>
      <div className="il-legend">
        <span><i style={{ background: "#181b20" }} />P(provider accepts)</span>
        <span><i style={{ background: "#2e6b52", opacity: 0.4 }} />bargaining zone</span>
        <span><i style={{ background: "#2e6b52" }} />target</span>
        <span><i style={{ background: "#b23a2a" }} />plan IDR cost</span>
      </div>
      <div className={`il-rec ${cls}`}>
        <b>{r.recommended_path === "settle" ? "Settle" : "Proceed to IDR"}</b> · target <b>{money(target)}</b>
        {" "}({pct(r.target_accept_prob)}% accept) — {r.recommended_path === "settle"
          ? <>saves <b>{money(r.savings_vs_idr)}</b> vs IDR</>
          : <>hold at QPA {money(qpa)}</>}.
        <div className="il-muted" style={{ marginTop: 4 }}>
          Provider reservation {money(res)} · plan IDR cost {money(idr)} · window {w.business_days_left} biz-days left
        </div>
      </div>
      <Counter disputeId={disputeId} defaultOffer={Math.round((res + idr) / 2)} />
    </>
  );
}
function Counter({ disputeId, defaultOffer }) {
  const [off, setOff] = useState(String(defaultOffer || ""));
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOff(String(defaultOffer || "")); setRes(null); }, [defaultOffer, disputeId]);

  const run = async () => {
    const v = Number(off);
    if (!v || !disputeId) return;
    setBusy(true); setRes(null);
    try {
      const { data: c, error } = await supabase.rpc("org_negotiation_counter", { p_dispute: disputeId, p_offer: v });
      if (error) throw error;
      setRes(c);
    } catch { setRes({ _err: true }); }
    setBusy(false);
  };

  const tone = res && !res._err
    ? (res.decision === "accept" ? "p-ok" : res.decision === "counter" ? "p-warn" : "p-sig")
    : "";
  return (
    <>
      <div className="il-counter">
        <label className="il-sm" htmlFor="il-poff">Provider offers</label>
        <input type="number" id="il-poff" value={off} onChange={(e) => setOff(e.target.value)}
          style={{ width: 120 }} aria-label="Provider offer amount in dollars" />
        <button onClick={run} disabled={busy}>{busy ? "Modeling…" : "Model counter"}</button>
      </div>
      <div className="il-cres" aria-live="polite">
        {res && (res._err
          ? <span className="il-err">error</span>
          : <><span className={`il-pill ${tone}`}>{String(res.decision || "").replace(/_/g, " ")}</span> counter <b>{money(res.recommended_counter)}</b> · {res.rationale}</>)}
      </div>
    </>
  );
}

/* ───────────────────────── Benchmark network ───────────────────────── */
function BmCard({ qpa, loading }) {
  const net = (qpa && qpa.network_benchmark) || {};
  return (
    <div className="il-card">
      <h3>Benchmark network</h3>
      <div className="il-cap">Multi-source · confidence-scored</div>
      {loading ? <div className="il-load">Loading…</div>
        : !net.ok ? <span className="il-err">No benchmark.</span>
        : <BmBody net={net} />}
    </div>
  );
}
function BmBody({ net }) {
  const conf = net.confidence || 0;
  return (
    <>
      <div className="il-badge">
        <div className="il-ring" style={{ "--v": conf }}><i>{conf}</i></div>
        <div>
          <div style={{ fontWeight: 600 }}>Confidence {conf}/100 {net.geo_specific && <span className="il-pill p-ok">geo-specific</span>}</div>
          <div className="il-muted">Recommended QPA basis <b className="il-num">{money(net.recommended_qpa_basis)}</b> · {net.peer_contributors} peer plans · {(net.total_sample_n || 0).toLocaleString()} obs</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {(net.sources || []).map((s, i) => (
          <div className="il-kv" key={i}>
            <span className="k">
              {String(s.source || "").replace("_", " ")}{s.rating_area && s.rating_area !== "national" ? ` · ${s.rating_area}` : ""}
              {" "}<span className="il-muted">p{s.percentile} · {(s.sample_n || 0).toLocaleString()} obs · {s.age_months}mo</span>
            </span>
            <span className="v">{money(s.amount)}</span>
          </div>
        ))}
      </div>
      <div className="il-fac" style={{ marginTop: 10 }}>{net.network_effect}</div>
    </>
  );
}

/* ───────────────────────── ROI vs take-rate ───────────────────────── */
function RoiCard({ roi }) {
  const [tr, setTr] = useState(28);
  return (
    <div className="il-card">
      <h3>ROI vs a %-of-savings vendor</h3>
      <div className="il-cap">Flat SaaS · aligned pricing</div>
      {!roi ? <div className="il-load">Loading…</div>
        : !roi.ok ? <span className="il-err">ROI unavailable</span>
        : <RoiBody v={roi} tr={tr} setTr={setTr} />}
    </div>
  );
}
function RoiBody({ v, tr, setTr }) {
  const rate = tr / 100;
  const vend = Math.round((Number(v.realized_savings) || 0) * rate);
  const flat = Number(v.avertyn_cost) || 0;
  const net = vend - flat;
  const max = Math.max(vend, flat, 1);
  const eff = Number(v.realized_savings) > 0 ? (flat / Number(v.realized_savings) * 100).toFixed(1) : 0;
  return (
    <>
      <div className="il-kv"><span className="k">Realized savings (resolved)</span><span className="v">{money(v.realized_savings)}</span></div>
      <div className="il-kv"><span className="k">Avertyn flat cost ({v.avertyn_plan})</span><span className="v">{money(v.avertyn_cost)}</span></div>
      <div style={{ margin: "14px 0 4px" }}>
        <label className="il-sm" htmlFor="il-tr">Vendor take-rate: <span className="il-num">{tr}%</span></label>
        <input type="range" id="il-tr" min="15" max="40" value={tr} onChange={(e) => setTr(+e.target.value)}
          aria-label="Vendor take-rate percentage" aria-valuetext={`${tr} percent`} />
      </div>
      <div className="il-roibars">
        <div className="il-roibar"><span className="rl">%-of-savings vendor</span><span className="il-rbar"><span style={{ width: `${vend / max * 100}%`, background: "var(--sig)" }} /></span><span className="lv il-num" style={{ textAlign: "right" }}>{money(vend)}</span></div>
        <div className="il-roibar"><span className="rl">Avertyn (flat)</span><span className="il-rbar"><span style={{ width: `${flat / max * 100}%`, background: "var(--ok)" }} /></span><span className="lv il-num" style={{ textAlign: "right" }}>{money(flat)}</span></div>
      </div>
      <div style={{ marginTop: 12 }} className="il-muted">Net advantage from flat pricing</div>
      <div className="il-roi-big">{money(net)} kept</div>
      <div className="il-fac" style={{ marginTop: 8 }}>
        On {money(v.realized_savings)} of savings, a {tr}% vendor bills {money(vend)}. Avertyn's flat fee is an
        effective <b>{eff}%</b> — and it's the same whether savings are large or small. No incentive to inflate "savings".
      </div>
    </>
  );
}
