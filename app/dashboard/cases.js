"use client";
// Avertyn — Cases surface. Three ways to work the same book, all reading from the
// same disputes / findings / offers / documents / approval_queue tables:
//   • Ledger (default) — a data-dense, sortable, filterable table of the whole
//     book with segment chips and bulk actions. The scannable, bulk-actionable
//     replacement for the old list-first master pane.
//   • Case File — open any case into a full-width deep-work workspace (reuses the
//     existing Detail component) with the governed-agent rail beside it. Replaces
//     the cramped center detail pane.
//   • Command Deck — an agent-forward, ranked queue of everything that needs a
//     human decision (staged releases, overdue windows, fileable findings), a
//     decision surface, and a governance rail.
import { useState, useMemo, useEffect } from "react";
import { money, untilLabel, caseIdentity } from "../../lib/format";

const HOUR = 3600e3, DAY = 24 * HOUR;
const MODES = ["off", "suggest", "review", "auto"];
const MONEY = new Set(["settle", "schedule_payment"]);
const ACTION_LABEL = {
  triage: "Triage", defend_qpa: "Defend QPA", challenge_eligibility: "Challenge eligibility",
  open_negotiation: "Open negotiation", submit_response: "Submit response",
  submit_additional_info: "Additional info", request_extension: "Request extension",
  withdraw: "Withdraw", escalate: "Escalate", schedule_payment: "Schedule payment", settle: "Settle",
  predict_outcome: "Predict outcome", generate_document: "Draft document",
};
const DOC_STATUS_LABEL = { draft: "Draft", in_review: "In review", approved: "Approved", filed: "Filed" };
const DOC_STATUS_TONE = { draft: "grey", in_review: "amber", approved: "green", filed: "ink" };
const DOC_STATUS_RANK = { draft: 1, in_review: 2, approved: 3, filed: 4 };
const LANES = [
  ["Intake", ["intake", "triage"]], ["Eligibility", ["eligibility_review"]], ["QPA defense", ["qpa_defense"]],
  ["Respond & file", ["response_prep"]], ["Awaiting", ["awaiting_determination"]], ["Award", ["award_payment"]],
];
const phaseOf = (r) => (r.phase === "idr" ? "idr" : "open_negotiation");
const ratioOf = (r) => (r.qpa_amount ? Number(r.demand_amount || 0) / Number(r.qpa_amount) : 0);
const deadlineOf = (r) => r.respond_by || r.pay_by || null;
function countdown(t) {
  if (!t) return null;
  const diff = new Date(t).getTime() - Date.now();
  if (diff < 0) { const d = Math.max(1, Math.ceil(-diff / DAY)); return { txt: d + "d over", tone: "over" }; }
  const h = diff / HOUR; if (h < 24) return { txt: Math.max(1, Math.round(h)) + "h", tone: "soon" };
  const d = Math.round(h / DAY); return { txt: d + "d", tone: d <= 3 ? "soon" : "ok" };
}
function readState(r, elig) {
  if (r.disposition === "provider_win") return { label: "Award — pay", tone: "ink" };
  if ((elig || 0) >= 80) return { label: "Ineligible", tone: "red" };
  if ((elig || 0) >= 60) return { label: "Review", tone: "amber" };
  if (r.workflow_state === "qpa_defense") return { label: "Defend QPA", tone: "ink" };
  return { label: "Defensible", tone: "green" };
}

export function CasesSurface(props) {
  const { rows, briefMap = {}, negMap = {}, sel, setSel, detailLoaded, busy,
    queue = [], autonomy = [], feed = [], metrics,
    onRunBulk, onBatchFile, onRelease, onReject, onMoneyRelease, onSetAutonomy, onAutopilot,
    onExportCSV, onExplain, renderDetail } = props;

  const [view, setView] = useState("ledger");        // ledger | command
  const [caseOpen, setCaseOpen] = useState(false);
  const stagedSet = useMemo(() => new Set(queue.map((q) => q.dispute_id)), [queue]);
  const agent = { queue, autonomy, feed, metrics, onRelease, onReject, onMoneyRelease, onSetAutonomy, onAutopilot, busy };

  function openCase(id) { setSel(id); setCaseOpen(true); }

  return (
    <div className="cs-root">
      <div className="cs-bar">
        <div>
          <h1 className="cs-title vh">{caseOpen ? "Case" : view === "ledger" ? "Cases" : "Command deck"}</h1>
          <div className="cs-sub">{caseOpen ? "Full-width deep work on one dispute"
            : view === "ledger" ? "The whole book — sort, filter, act in bulk, drill in"
            : "Everything that needs a human decision, ranked — you govern the autopilot"}</div>
        </div>
        {caseOpen ? (
          <button className="mini" onClick={() => setCaseOpen(false)}>‹ Back to {view === "command" ? "deck" : "Ledger"}</button>
        ) : (
          <div className="cs-seg">
            {[["ledger", "▦ Ledger"], ["command", "✦ Command deck"]].map(([k, l]) => (
              <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}
                {k === "command" && queue.length > 0 && <span className="cs-segn">{queue.length}</span>}</button>
            ))}
          </div>
        )}
      </div>

      {caseOpen
        ? <CaseFile detailLoaded={detailLoaded} renderDetail={renderDetail} rows={rows} sel={sel} setSel={setSel} agent={agent} onExplain={onExplain} />
        : view === "ledger"
          ? <Ledger rows={rows} briefMap={briefMap} negMap={negMap} stagedSet={stagedSet} busy={busy}
              onOpen={openCase} onRunBulk={onRunBulk} onBatchFile={onBatchFile} onExportCSV={onExportCSV} />
          : <CommandDeck rows={rows} queue={queue} stagedSet={stagedSet} sel={sel} setSel={setSel}
              detailLoaded={detailLoaded} renderDetail={renderDetail} agent={agent} onOpenFull={openCase} onExplain={onExplain} />}
    </div>
  );
}

/* ============================ Ledger ============================ */
const SEGMENTS = [
  ["all", "All", () => true],
  ["due", "Due ≤72h", (r) => { const t = deadlineOf(r); return t && (new Date(t).getTime() - Date.now()) / HOUR <= 72; }],
  ["ineligible", "Ineligible ≥60", (r) => (r.eligibility_score || 0) >= 60],
  ["filing", "Filing-ready", (r, ctx) => ctx.brief(r)?.status === "approved"],
  ["idr", "In IDR", (r) => phaseOf(r) === "idr"],
  ["awards", "Awards to pay", (r) => r.disposition === "provider_win"],
  ["agent", "Waiting on agent", (r, ctx) => ctx.staged.has(r.id)],
];
const COLS = [
  { k: "no", label: "Case", get: (r) => caseIdentity(r).number },
  { k: "initiator", label: "Initiator", get: (r) => r.initiators?.name || "" },
  { k: "phase", label: "Phase", get: (r) => phaseOf(r) },
  { k: "demand", label: "Demand", num: 1, get: (r) => Number(r.demand_amount || 0) },
  { k: "qpa", label: "QPA", num: 1, get: (r) => Number(r.qpa_amount || 0) },
  { k: "ratio", label: "D÷QPA", num: 1, get: (r) => ratioOf(r) },
  { k: "elig", label: "Ineligibility", num: 1, get: (r) => r.eligibility_score || 0 },
  { k: "deadline", label: "Deadline", num: 1, get: (r) => { const t = deadlineOf(r); return t ? new Date(t).getTime() : 8e15; } },
  { k: "brief", label: "Brief", get: (r, ctx) => DOC_STATUS_RANK[ctx.brief(r)?.status] || 0 },
  { k: "neg", label: "Neg", num: 1, get: (r, ctx) => ctx.neg(r)?.last_pct ?? -1 },
  { k: "agent", label: "Agent", num: 1, get: (r, ctx) => (ctx.staged.has(r.id) ? 1 : 0) },
];

function Ledger({ rows, briefMap, negMap, stagedSet, busy, onOpen, onRunBulk, onBatchFile, onExportCSV }) {
  const [seg, setSeg] = useState("all");
  const [sort, setSort] = useState({ key: "deadline", dir: 1 });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const ctx = { brief: (r) => briefMap[r.id], neg: (r) => negMap[r.id], staged: stagedSet };

  const segCount = (fn) => rows.filter((r) => fn(r, ctx)).length;
  const shown = useMemo(() => {
    let arr = rows.filter((r) => SEGMENTS.find((s) => s[0] === seg)[2](r, ctx));
    const s = q.trim().toLowerCase().replace(/^#+/, "");
    if (s) arr = arr.filter((r) => [r.claim_number, r.idr_registration_number, r.external_ref, r.initiators?.name, r.cpt_code].some((v) => (v || "").toLowerCase().replace(/^#+/, "").includes(s)));
    const col = COLS.find((c) => c.k === sort.key) || COLS[7];
    return [...arr].sort((a, b) => { const x = col.get(a, ctx), y = col.get(b, ctx); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  }, [rows, seg, q, sort, briefMap, negMap, stagedSet]); // eslint-disable-line

  const toggle = (id, on) => { const n = new Set(sel); on ? n.add(id) : n.delete(id); setSel(n); };
  const doBulk = async (kind) => { if (kind === "clear") { setSel(new Set()); return; } const ids = Array.from(sel); if (kind === "file") onBatchFile(ids); else onRunBulk(ids, kind); setSel(new Set()); };
  const clickSort = (k) => setSort((s) => s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: 1 });
  const totalOver = shown.reduce((a, r) => a + Math.max(0, Number(r.demand_amount || 0) - Number(r.qpa_amount || 0)), 0);

  return (
    <>
      <div className="cs-segbar">
        {SEGMENTS.map(([k, l, fn]) => (
          <button key={k} className={"cs-chip" + (seg === k ? " on" : "")} onClick={() => setSeg(k)}>{l}<span className="c">{segCount(fn)}</span></button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="mini" onClick={onExportCSV}>⤓ Export CSV</button>
        </div>
      </div>

      <div className="cs-tblwrap">
        <div className="cs-tbar">
          {sel.size > 0 ? (
            <div className="cs-bulk">
              <span className="n">{sel.size} selected</span>
              <button className="mini" disabled={busy === "bulk"} onClick={() => doBulk("engine")}>{busy === "bulk" ? "Working…" : "Run engine"}</button>
              <button className="mini" disabled={busy === "bulk"} onClick={() => doBulk("predict")}>Predict</button>
              <button className="mini" disabled={busy === "bulk"} onClick={() => doBulk("file")}>⛁ Batch &amp; file →</button>
              <button className="mini" onClick={() => doBulk("clear")}>Clear</button>
            </div>
          ) : (
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter case #, initiator, CPT…" />
          )}
          <div className="cs-tbar-rt"><span>{shown.length} cases</span><span>·</span><span className="mono">{money(totalOver)} over QPA</span></div>
        </div>
        <div className="cs-tscroll">
          <table className="cs-table">
            <thead><tr><th style={{ width: 34 }}><input type="checkbox" checked={shown.length > 0 && shown.every((r) => sel.has(r.id))} onChange={(e) => { const n = new Set(sel); e.target.checked ? shown.forEach((r) => n.add(r.id)) : shown.forEach((r) => n.delete(r.id)); setSel(n); }} /></th>
              {COLS.map((c) => <th key={c.k} className={c.num ? "num" : ""} onClick={() => clickSort(c.k)}>{c.label} <span className="ar">{sort.key === c.k ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</span></th>)}
            </tr></thead>
            <tbody>
              {shown.length === 0 ? <tr><td colSpan={COLS.length + 1}><p className="muted" style={{ padding: 16 }}>Nothing here right now.</p></td></tr>
              : shown.map((r) => {
                const ci = caseIdentity(r); const elig = r.eligibility_score || 0; const rr = ratioOf(r);
                const cd = countdown(deadlineOf(r)); const b = briefMap[r.id]; const n = negMap[r.id]; const idr = phaseOf(r) === "idr";
                const rcls = rr >= 4 ? "hi" : rr >= 2 ? "mid" : "lo";
                return (
                  <tr key={r.id} className={sel.has(r.id) ? "sel" : ""} onClick={() => onOpen(r.id)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} /></td>
                    <td><div className="cs-cno">{ci.number}</div><div className="cs-cint">CPT {r.cpt_code || "—"}</div></td>
                    <td>{r.initiators?.name || "—"}<div className="cs-cint" style={{ fontFamily: "var(--sans)" }}>{r.plans?.name || ""}</div></td>
                    <td><span className={"badge b-" + (idr ? "green" : "amber")}>{idr ? "IDR" : "Open neg."}</span></td>
                    <td className="num mono">{money(r.demand_amount)}</td>
                    <td className="num mono">{money(r.qpa_amount)}</td>
                    <td className="num"><span className={"cs-ratio " + rcls}>{rr ? rr.toFixed(1) + "×" : "—"}</span></td>
                    <td className="num"><span className="cs-elbar"><i style={{ width: elig + "%", background: elig >= 60 ? "var(--sig)" : elig >= 40 ? "var(--warn)" : "var(--faint)" }} /></span><span className="mono" style={{ fontSize: 11 }}>{elig}</span></td>
                    <td className="num">{cd ? <span className={"cs-cd cd-" + cd.tone}>{cd.txt}</span> : <span className="faint">—</span>}</td>
                    <td>{b ? <span className={"badge b-" + (DOC_STATUS_TONE[b.status] || "grey")}>{DOC_STATUS_LABEL[b.status] || "Draft"}</span> : <span className="faint">—</span>}</td>
                    <td className="num">{n ? <span className="mono" style={{ fontSize: 11.5 }}>{n.last_pct != null ? Math.round(n.last_pct) + "%" : money(n.last_amount)}</span> : <span className="faint">—</span>}</td>
                    <td className="num">{stagedSet.has(r.id) ? <span className="cs-agflag" title="Agent staged an action">✦</span> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ============================ Case File ============================ */
function CaseFile({ detailLoaded, renderDetail, rows, sel, setSel, agent, onExplain }) {
  return (
    <div className="cs-file">
      <div className="cs-filebar">
        <select className="dsel" value={sel || ""} onChange={(e) => setSel(e.target.value)} title="Switch case">
          {rows.map((r) => <option key={r.id} value={r.id}>{caseIdentity(r).number} · {r.initiators?.name || "—"}</option>)}
        </select>
      </div>
      <div className="cs-filegrid">
        <div className="cs-filemain">
          {detailLoaded ? renderDetail() : <p className="muted" style={{ padding: 18 }}>Loading case…</p>}
        </div>
        <div className="cs-filerail"><AgentRail agent={agent} /></div>
      </div>
    </div>
  );
}

/* ============================ Command Deck ============================ */
function CommandDeck({ rows, queue, stagedSet, sel, setSel, detailLoaded, renderDetail, agent, onOpenFull, onExplain }) {
  const byId = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r])), [rows]);
  const decisions = useMemo(() => {
    const list = [];
    queue.forEach((q) => { const r = byId[q.dispute_id]; if (!r) return; const isMoney = MONEY.has(q.action_type);
      list.push({ id: "a_" + q.id, kind: "approve", caseId: q.dispute_id, q, priority: isMoney ? 1 : 1, amount: q.amount,
        title: "Release: " + (ACTION_LABEL[q.action_type] || q.action_type) + (q.amount != null ? " · " + money(q.amount) : ""), sub: q.rationale }); });
    rows.forEach((r) => { const t = deadlineOf(r); if (!t) return; if (new Date(t).getTime() < Date.now() && !stagedSet.has(r.id))
      list.push({ id: "o_" + r.id, kind: "respond", caseId: r.id, priority: 0, title: "Overdue: respond on " + caseIdentity(r).number, sub: (phaseOf(r) === "idr" ? "IDR response" : "Negotiation") + " window past due" }); });
    rows.forEach((r) => { if ((r.eligibility_score || 0) >= 70 && !stagedSet.has(r.id) && !(byId[r.id] && DOC_STATUS_RANK[(r._briefStatus)] >= 4))
      list.push({ id: "f_" + r.id, kind: "file", caseId: r.id, priority: 2, title: "File failed-finding · " + caseIdentity(r).number, sub: "Ineligibility " + (r.eligibility_score || 0) }); });
    return list.sort((a, b) => a.priority - b.priority);
  }, [rows, queue, stagedSet]); // eslint-disable-line

  const GROUPS = [[0, "Overdue — act now", "red"], [1, "Agent staged · needs release", "amber"], [2, "Fileable — high ineligibility", "grey"]];
  const [pick, setPick] = useState(decisions[0]?.id || null);
  const cur = decisions.find((d) => d.id === pick) || decisions[0] || null;
  // keep the loaded case detail in sync with the selected decision (in an effect,
  // never during render, so we don't trigger an update loop)
  useEffect(() => { if (cur && sel !== cur.caseId) setSel(cur.caseId); }, [cur, sel, setSel]);

  return (
    <div className="cs-deck">
      <div className="cs-deckcol">
        <div className="cs-colhd"><h3>Decision queue</h3><span className="ct">{decisions.length}</span></div>
        <div className="cs-deckscroll">
          {decisions.length === 0 ? <p className="muted" style={{ padding: 14 }}>Queue clear. 🎉</p> : GROUPS.map(([p, label, tone]) => {
            const items = decisions.filter((d) => d.priority === p); if (!items.length) return null;
            return (
              <div key={p}>
                <div className="cs-glabel"><i className={"dot d-" + tone} />{label} · {items.length}</div>
                {items.map((d) => { const r = byId[d.caseId];
                  return (
                    <div key={d.id} className={"cs-dcard" + (d.kind === "approve" ? " agent" : "") + (pick === d.id ? " sel" : "")} onClick={() => setPick(d.id)}>
                      <div className="r1"><span className={"cs-tico " + d.kind}>{d.kind === "approve" ? "✦" : d.kind === "file" ? "⚑" : "▲"}</span><span className="cs-cno">{caseIdentity(r).number}</span>{d.amount != null && <span className="amt">{money(d.amount)}</span>}</div>
                      <div className="tt">{d.title}</div>
                      <div className="sub">{r.initiators?.name || "—"} · {money(r.demand_amount)} vs {money(r.qpa_amount)} QPA</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="cs-decksurface">
        {!cur ? <p className="muted" style={{ padding: 18 }}>Queue clear.</p> : (
          <>
            <div className="cs-decision">
              <div className="cs-drk">✦ Decision</div>
              <div className="cs-drv">{cur.title}</div>
              <div className="cs-drr">{cur.sub}</div>
              <div className="cs-dacts">
                {cur.kind === "approve" ? (<>
                  {MONEY.has(cur.q.action_type)
                    ? <button className="btn btn-a" disabled={agent.busy === "rel" + cur.q.id} onClick={() => agent.onMoneyRelease(cur.q)}>Release · step-up</button>
                    : <button className="btn btn-a" disabled={agent.busy === "rel" + cur.q.id} onClick={() => agent.onRelease(cur.q.id)}>✓ Release</button>}
                  <button className="btn btn-s" disabled={agent.busy === "rej" + cur.q.id} onClick={() => agent.onReject(cur.q.id)}>Reject</button>
                </>) : (
                  <button className="btn btn-a" onClick={() => onOpenFull(cur.caseId)}>Work this case →</button>
                )}
                <button className="btn btn-s" onClick={() => onExplain(cur.caseId)}>◎ Explain</button>
                <button className="btn btn-s" onClick={() => onOpenFull(cur.caseId)}>Open full case →</button>
              </div>
            </div>
            <div className="cs-deckdetail">{detailLoaded ? renderDetail() : <p className="muted" style={{ padding: 18 }}>Loading case…</p>}</div>
          </>
        )}
      </div>

      <div className="cs-deckrail"><AgentRail agent={agent} rows={rows} showPipeline /></div>
    </div>
  );
}

/* ============================ shared agent rail ============================ */
function AgentRail({ agent, rows, showPipeline }) {
  const { queue, autonomy, feed, metrics, onRelease, onReject, onMoneyRelease, onSetAutonomy, onAutopilot, busy } = agent;
  return (
    <>
      <div className="cs-agenthd">
        <span className="cs-agav">✦</span>
        <div className="cs-agmeta"><b>Agent · governed</b><span>autopilot &amp; approvals</span></div>
        <button className="mini" disabled={busy === "auto"} onClick={onAutopilot}>{busy === "auto" ? "…" : "Run tick"}</button>
      </div>
      {metrics && <p className="muted" style={{ fontSize: 11.5, margin: "0 0 6px" }}>{metrics.open_disputes} open · {money(metrics.dollars_defended)} defended · {metrics.challenges_filed} challenges</p>}

      {showPipeline && rows && <>
        <div className="cs-agsub">Pipeline</div>
        <div className="cs-pipe">
          {(() => { const max = Math.max(1, ...LANES.map(([, st]) => rows.filter((r) => st.includes(r.workflow_state)).length));
            return LANES.map(([l, st]) => { const n = rows.filter((r) => st.includes(r.workflow_state)).length;
              return <div key={l} className="cs-piperow"><span className="pl">{l}</span><span className="pipebar"><i style={{ width: Math.max(6, n / max * 100) + "%" }} /></span><span className="pn">{n}</span></div>; }); })()}
        </div>
      </>}

      <div className="cs-agsub">Waiting on you · {queue.length}</div>
      {queue.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>Nothing staged. 🎉</p> : queue.map((q) => {
        const isMoney = MONEY.has(q.action_type);
        return (
          <div key={q.id} className="cs-app">
            <div className="cs-apphd"><b>{ACTION_LABEL[q.action_type] || q.action_type}{q.amount != null ? " · " + money(q.amount) : ""}</b>
              <span className={"badge " + (isMoney ? "b-red" : "b-amber")}><i className={"dot d-" + (isMoney ? "red" : "amber")} />{isMoney ? "Dual" : "Review"}</span></div>
            {q.rationale && <div className="cs-apprat">{q.rationale}</div>}
            <div className="cs-appacts">
              {isMoney
                ? <button className="btn btn-a" style={{ padding: "6px 11px" }} disabled={busy === "rel" + q.id} onClick={() => onMoneyRelease(q)}>Release · step-up</button>
                : <button className="btn btn-a" style={{ padding: "6px 11px" }} disabled={busy === "rel" + q.id} onClick={() => onRelease(q.id)}>Release</button>}
              <button className="btn btn-s" style={{ padding: "6px 11px" }} disabled={busy === "rej" + q.id} onClick={() => onReject(q.id)}>Reject</button>
            </div>
          </div>
        );
      })}

      {autonomy.length > 0 && <>
        <div className="cs-agsub">Autonomy dial</div>
        <div className="cs-dials">
          {autonomy.map((a) => (
            <div key={a.action_type} className="cs-dial"><span>{ACTION_LABEL[a.action_type] || a.action_type}</span>
              <select value={a.mode} disabled={busy === "dial" + a.action_type} onChange={(e) => onSetAutonomy(a.action_type, e.target.value)}>
                {MODES.map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
              </select>
            </div>
          ))}
        </div>
      </>}

      <div className="cs-agsub">Activity · ledger</div>
      <div className="cs-astream">
        {feed.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No recent actions.</p> : feed.map((e, i) => (
          <div key={i} className="cs-aline">{e.actor === "agent" ? "✦" : "•"} <b>{(e.action_type || "").replace(/_/g, " ")}</b>{e.rationale ? " — " + e.rationale.slice(0, 64) : ""}</div>
        ))}
      </div>
    </>
  );
}
