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
export function InitiatorsView({ orgId, onErr, embedded, onPickInitiator }) {
  const [rows, setRows] = useState([]);
  const [idre, setIdre] = useState([]);
  const [lev, setLev] = useState(null);
  const [trends, setTrends] = useState([]);
  const [mom, setMom] = useState([]);
  const [sort, setSort] = useState({ key: "disputes", dir: -1 });
  const [isort, setISort] = useState({ key: "selections", dir: -1 });

  const load = useCallback(async () => {
    try {
      const [{ data: sc, error: e1 }, { data: ib }, { data: lv }, { data: tr }, { data: mo }] = await Promise.all([
        supabase.from("initiator_scorecard").select("*").order("disputes", { ascending: false }),
        orgId ? supabase.rpc("idre_behavior", { p_org: orgId }) : Promise.resolve({ data: [] }),
        supabase.rpc("leverage_summary"),
        supabase.rpc("intel_trends", { p_months: 12 }),
        supabase.rpc("initiator_momentum"),
      ]);
      if (e1) throw e1;
      setRows(sc || []);
      setIdre(Array.isArray(ib) ? ib : []);
      setLev(lv && lv.ok ? lv : null);
      setTrends(Array.isArray(tr) ? tr : []);
      setMom(Array.isArray(mo) ? mo : []);
    } catch (e) { onErr && onErr(e.message); }
  }, [orgId, onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("initiators", ["disputes", "idre_selections", "awards"], load);

  const momMap = {}; mom.forEach((m) => { momMap[m.initiator] = m; });
  const totDisputes = rows.reduce((a, r) => a + Number(r.disputes || 0), 0);
  const chartRows = [...rows].map((r) => ({ ...r, _m: r.avg_qpa ? Number(r.avg_demand) / Number(r.avg_qpa) : 0 }))
    .sort((a, b) => b._m - a._m).slice(0, 8);
  const maxMult = Math.max(1, ...chartRows.map((r) => r._m));

  const monthsShown = trends.filter((t) => Number(t.filings) > 0 || Number(t.plan_wins) > 0 || Number(t.provider_wins) > 0);
  const filSeries = monthsShown.map((t) => Number(t.filings));
  const dqSeries = monthsShown.map((t) => Number(t.demand_qpa));
  const wrSeries = monthsShown.map((t) => (t.win_rate == null ? 0 : Number(t.win_rate)));

  const scoreRows = sortBy(rows.map((r) => ({ ...r, dq: r.avg_qpa ? Number(r.avg_demand) / Number(r.avg_qpa) : null })), sort);
  const idreRows = sortBy(idre, isort);

  return (
    <div>
      {!embedded && <div className="dh"><h1 className="vh">Initiators &amp; IDREs</h1>
        <span className="sub">Who's filing against your plans, how weak their filings are, how they trend, and how each IDRE actually decides — your negotiation leverage</span></div>}

      {/* ── Leverage summary ── */}
      {lev && (
        <div className="cards" style={{ marginTop: embedded ? 4 : 14 }}>
          <div className="kpi-tile"><div className="l">Open at risk</div><div className="n">{money(lev.at_risk)}</div><div className="goal">{lev.open} open disputes</div></div>
          <div className="kpi-tile"><div className="l">Settle-favorable now</div><div className="n">{money(lev.settle_savings)}</div><div className="goal good">{lev.settle_favorable} in bargaining zone</div></div>
          <div className="kpi-tile"><div className="l">Challengeable</div><div className="n">{lev.challengeable}</div><div className="goal">open · eligibility ≥ 80</div></div>
          <div className="kpi-tile"><div className="l">Top overreach</div><div className="n" style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lev.top_initiator?.name || "—"}</div><div className="goal risk">{imult(lev.top_initiator?.mult)} demand ÷ QPA</div></div>
        </div>
      )}

      {/* ── Trends ── */}
      {monthsShown.length > 1 && (
        <div className="panel">
          <div className="ph">Trends · last {monthsShown.length} months<span className="act"><span className="muted" style={{ fontSize: 11 }}>filing volume, overreach and win-rate over time</span></span></div>
          <div className="pb" style={{ display: "flex", gap: 28, flexWrap: "wrap", paddingTop: 14 }}>
            <TrendStat label="Monthly filings" now={filSeries[filSeries.length - 1]} sub={`${totDisputes} total`}><Spark vals={filSeries} kind="bar" color="var(--sig,#b23a2a)" /></TrendStat>
            <TrendStat label="Demand ÷ QPA" now={imult(dqSeries[dqSeries.length - 1])} sub="overreach drift"><Spark vals={dqSeries} color="var(--warn,#8a6a1f)" /></TrendStat>
            <TrendStat label="Plan win-rate" now={ipct(wrSeries[wrSeries.length - 1])} sub="of resolved disputes"><Spark vals={wrSeries} kind="bar" color="var(--ok,#2e6b52)" /></TrendStat>
          </div>
        </div>
      )}

      {/* ── Demand ÷ QPA by initiator ── */}
      <div className="panel">
        <div className="ph">Demand ÷ QPA by initiator<span className="act"><span className="muted" style={{ fontSize: 11 }}>how far each filer overreaches vs. the plan's QPA · ▲ = filing more this quarter</span></span></div>
        <div className="pb" style={{ paddingTop: 14 }}>
          {chartRows.length === 0 ? <p className="muted">No data yet.</p> : chartRows.map((r, i) => {
            const w = Math.min(100, (r._m / maxMult) * 100);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0" }}>
                <div style={{ width: 150, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.initiator}<MomArrow m={momMap[r.initiator]} /></div>
                <div style={{ flex: 1, height: 14, background: "var(--sunk,#f0eee9)", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: w + "%", background: "linear-gradient(90deg,#c8492e,#a8321f)", borderRadius: 999 }} />
                </div>
                <div className="mono" style={{ width: 54, textAlign: "right", fontWeight: 600, fontSize: 12.5 }}>{r._m.toFixed(1)}×</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Initiator scorecard (sortable, actionable) ── */}
      <div className="panel">
        <div className="ph">Initiator scorecard<span className="act"><span className="muted" style={{ fontSize: 11 }}>click a column to sort · click a row to see that filer's cases</span></span></div>
        {rows.length === 0 ? <p className="muted" style={{ padding: 16 }}>No initiator data yet.</p> : (
          <table>
            <thead><tr>
              <Th label="Initiator" k="initiator" sort={sort} setSort={setSort} />
              <Th label="Disputes" k="disputes" sort={sort} setSort={setSort} right />
              <Th label="Avg inelig." k="avg_ineligibility" sort={sort} setSort={setSort} right />
              <Th label="Win-rate" k="win_rate" sort={sort} setSort={setSort} right />
              <Th label="Award ×QPA" k="avg_award_mult" sort={sort} setSort={setSort} right />
              <Th label="Challenged" k="challenged" sort={sort} setSort={setSort} right />
              <Th label="Demand ÷ QPA" k="dq" sort={sort} setSort={setSort} right />
            </tr></thead>
            <tbody>
              {scoreRows.map((s, i) => (
                <tr key={i} style={{ cursor: onPickInitiator ? "pointer" : "default" }}
                  onClick={() => onPickInitiator && onPickInitiator(s.initiator)}
                  title={onPickInitiator ? `Open ${s.initiator}'s cases` : undefined}>
                  <td><b>{s.initiator}</b><MomArrow m={momMap[s.initiator]} /></td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.disputes}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.avg_ineligibility ?? "—"}
                    {s.avg_ineligibility != null && <span className={"badge " + (s.avg_ineligibility >= 60 ? "b-red" : s.avg_ineligibility >= 40 ? "b-amber" : "b-grey")} style={{ marginLeft: 6 }}>{s.avg_ineligibility >= 60 ? "weak" : s.avg_ineligibility >= 40 ? "mixed" : "solid"}</span>}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.win_rate == null ? <span className="muted">—</span> : <b style={{ color: s.win_rate >= 0.6 ? "var(--ok,#2e6b52)" : s.win_rate >= 0.4 ? "var(--warn,#8a6a1f)" : "var(--sig,#b23a2a)" }}>{ipct(s.win_rate)}</b>}<span className="muted" style={{ fontSize: 10 }}> {s.resolved ? `n=${s.resolved}` : ""}</span></td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.avg_award_mult ? imult(s.avg_award_mult) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.challenged}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{s.dq ? <span className="badge b-red">{s.dq.toFixed(1)}×</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── IDRE intelligence (award tendency) ── */}
      <div className="panel">
        <div className="ph">IDRE intelligence<span className="act"><span className="muted" style={{ fontSize: 11 }}>how each certified IDR entity actually decides — favor the plan-friendly, contest the rest</span></span></div>
        {idre.length === 0 ? <p className="muted" style={{ padding: 16 }}>No IDRE decisions recorded yet.</p> : (
          <>
            {lev?.best_idre && lev?.worst_idre && (
              <div className="pb" style={{ paddingTop: 10, paddingBottom: 0, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5 }}>
                <span><span className="badge b-green"><i className="dot d-green" />prefer</span> <b>{lev.best_idre.idre}</b> · {ipct(lev.best_idre.plan_favorable_rate)} plan-favorable, awards {imult(lev.best_idre.avg_award_pct_qpa)} QPA</span>
                <span><span className="badge b-red"><i className="dot d-red" />contest</span> <b>{lev.worst_idre.idre}</b> · {ipct(lev.worst_idre.plan_favorable_rate)} plan-favorable, awards {imult(lev.worst_idre.avg_award_pct_qpa)} QPA</span>
              </div>
            )}
            <table>
              <thead><tr>
                <Th label="Certified IDRE" k="idre" sort={isort} setSort={setISort} />
                <Th label="Assigned" k="selections" sort={isort} setSort={setISort} right />
                <Th label="Decided" k="decisions" sort={isort} setSort={setISort} right />
                <Th label="Plan-favorable" k="plan_favorable_rate" sort={isort} setSort={setISort} right />
                <Th label="Award ×QPA" k="avg_award_pct_qpa" sort={isort} setSort={setISort} right />
                <Th label="Median ×QPA" k="median_award_pct_qpa" sort={isort} setSort={setISort} right />
                <Th label="Days to decide" k="avg_days_to_determination" sort={isort} setSort={setISort} right />
                <Th label="Reselect" k="reselections" sort={isort} setSort={setISort} right />
              </tr></thead>
              <tbody>
                {idreRows.map((e, i) => {
                  const pf = e.plan_favorable_rate;
                  return (
                    <tr key={i}>
                      <td><b>{e.idre}</b></td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.selections}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.decisions}</td>
                      <td style={{ textAlign: "right" }}>
                        {pf == null ? <span className="muted">—</span> : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                            <span style={{ width: 46, height: 6, background: "var(--sunk,#f0eee9)", borderRadius: 999, overflow: "hidden", display: "inline-block" }}>
                              <span style={{ display: "block", height: "100%", width: (pf * 100) + "%", background: pf >= 0.6 ? "var(--ok,#2e6b52)" : pf >= 0.5 ? "var(--warn,#8a6a1f)" : "var(--sig,#b23a2a)" }} />
                            </span>
                            <b className="mono" style={{ fontSize: 12 }}>{ipct(pf)}</b>
                          </span>
                        )}
                      </td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.avg_award_pct_qpa ? imult(e.avg_award_pct_qpa) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.median_award_pct_qpa ? imult(e.median_award_pct_qpa) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.avg_days_to_determination != null ? e.avg_days_to_determination + "d" : "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{e.reselections || 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

const ipct = (p) => (p == null ? "—" : Math.round(Number(p) * 100) + "%");
const imult = (n) => (n == null ? "—" : Number(n).toFixed(1) + "×");
function sortBy(arr, s) {
  const { key, dir } = s;
  return [...arr].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    const an = Number(av), bn = Number(bv);
    if (!isNaN(an) && !isNaN(bn) && av !== "" && bv !== "") return (an - bn) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}
function Th({ label, k, sort, setSort, right }) {
  const active = sort.key === k;
  return (
    <th style={{ cursor: "pointer", textAlign: right ? "right" : "left", whiteSpace: "nowrap", userSelect: "none" }}
      onClick={() => setSort({ key: k, dir: active ? -sort.dir : -1 })}>
      {label}{active ? (sort.dir < 0 ? " ↓" : " ↑") : ""}
    </th>
  );
}
function MomArrow({ m }) {
  if (!m) return null;
  if (m.delta_pct == null) return (m.last_q === 0 && m.this_q > 0)
    ? <span className="badge b-amber" style={{ marginLeft: 6, fontSize: 10 }}>new</span> : null;
  if (m.delta_pct === 0) return null;
  const up = m.delta_pct > 0;
  return <span title={`${m.last_q} → ${m.this_q} filings this quarter`} style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: up ? "var(--sig,#b23a2a)" : "var(--ok,#2e6b52)" }}>{up ? "▲" : "▼"}{Math.abs(m.delta_pct)}%</span>;
}
function TrendStat({ label, now, sub, children }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div style={{ fontFamily: "var(--num,monospace)", fontSize: 20, fontWeight: 700, margin: "2px 0 4px" }}>{now}</div>
      {children}
      <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>{sub}</div>
    </div>
  );
}
function Spark({ vals, kind = "line", w = 116, h = 28, color = "#b23a2a" }) {
  const nums = (vals || []).map((v) => Number(v) || 0);
  if (!nums.length) return null;
  const max = Math.max(1, ...nums), min = Math.min(0, ...nums);
  const sx = (i) => (nums.length === 1 ? w / 2 : (i / (nums.length - 1)) * (w - 3) + 1.5);
  const sy = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
  if (kind === "bar") {
    const bw = Math.max(2, (w - 2) / nums.length - 2.5);
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {nums.map((v, i) => <rect key={i} x={(i / nums.length) * (w - 2) + 1.5} y={sy(v)} width={bw} height={Math.max(1, h - 3 - sy(v))} rx="1" fill={color} opacity="0.9" />)}
      </svg>
    );
  }
  const d = nums.map((v, i) => (i ? "L" : "M") + sx(i).toFixed(1) + "," + sy(v).toFixed(1)).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={sx(nums.length - 1)} cy={sy(nums[nums.length - 1])} r="2.2" fill={color} />
    </svg>
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
      {!embedded && <div className="dh"><h1 className="vh">Deadlines &amp; delivery</h1>
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
                    <td>{(d.kind || "deadline").replace(/_/g, " ").replace(/\b(idre|idr|qpa|nsa|cpt|drg|rbp|erisa|ncci|mue|tpa|hcpcs|npi|cms|hhs|dol|wc|ptp|mrf)\b/gi, m => m.toUpperCase())}</td>
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
      {!embedded && <div className="dh"><h1 className="vh">Integrations · Eligibility API</h1>
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
                      <span className={"badge " + (result.band === "likely_ineligible" ? "b-red" : result.band === "review" ? "b-amber" : "b-green")}><i className={"dot d-" + (result.band === "likely_ineligible" ? "red" : result.band === "review" ? "amber" : "green")} />{String(result.recommendation || "").replace(/_/g, " ").replace(/\b(idre|idr|qpa|nsa|cpt|drg|rbp|erisa|ncci|mue|tpa|hcpcs|npi|cms|hhs|dol|wc|ptp|mrf)\b/gi, m => m.toUpperCase())}</span>
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
                  <td className="muted" style={{ fontSize: 11 }}>{l.meta?.recommendation ? String(l.meta.recommendation).replace(/_/g, " ").replace(/\b(idre|idr|qpa|nsa|cpt|drg|rbp|erisa|ncci|mue|tpa|hcpcs|npi|cms|hhs|dol|wc|ptp|mrf)\b/gi, m => m.toUpperCase()) : "—"}</td>
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
