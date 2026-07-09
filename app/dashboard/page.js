"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const TABS = ["Command center", "Incoming", "Eligibility", "QPA defense", "Respond & pay", "Employer exposure"];
const mkg = { pass: ["pass", "✓"], fail: ["fail", "×"], warn: ["warn", "!"], na: ["na", "–"] };

export default function Dashboard() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [orgId, setOrgId] = useState(null);
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [agentM, setAgentM] = useState(null);
  const [scorecard, setScorecard] = useState([]);
  const [queue, setQueue] = useState([]);
  const [feed, setFeed] = useState([]);
  const [notifs, setNotifs] = useState(0);
  const [tab, setTab] = useState(1);
  const [busy, setBusy] = useState("");
  const [verify, setVerify] = useState(null);

  const loadShell = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.push("/login"); return; }
    setEmail(session.user.email);
    const { data: me } = await supabase.from("app_users").select("org_id").eq("id", session.user.id).maybeSingle();
    setOrgId(me?.org_id || null);

    const [{ data: d }, { data: m }, { data: am }, { data: sc }, { data: q }, { data: f }, { count: nc }] = await Promise.all([
      supabase.from("disputes").select("id, external_ref, cpt_code, demand_amount, qpa_amount, workflow_state, disposition, eligibility_score, respond_by, pay_by, plans(name), initiators(name)").order("respond_by", { ascending: true, nullsFirst: false }),
      supabase.from("org_metrics").select("*").maybeSingle(),
      supabase.from("agent_metrics").select("*").maybeSingle(),
      supabase.from("initiator_scorecard").select("*").order("disputes", { ascending: false }),
      supabase.from("approval_queue").select("id, dispute_id, action_type, amount, rationale").eq("status", "pending"),
      supabase.from("action_log").select("action_type, actor, rationale, created_at").order("created_at", { ascending: false }).limit(6),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("read", false),
    ]);
    setRows(d || []);
    setMetrics(m || null); setAgentM(am || null); setScorecard(sc || []);
    setQueue(q || []); setFeed(f || []); setNotifs(nc || 0);
  }, [router]);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    const [{ data: d }, { data: find }, { data: q }] = await Promise.all([
      supabase.from("disputes").select("*, plans(name), initiators(name)").eq("id", id).single(),
      supabase.from("eligibility_findings").select("result, detail, eligibility_rules(name, severity)").eq("dispute_id", id),
      supabase.from("qpa_records").select("*").eq("dispute_id", id).maybeSingle(),
    ]);
    setDetail({ d, find: find || [], qpa: q || null });
  }, []);

  useEffect(() => { loadShell(); }, [loadShell]);
  useEffect(() => { if (rows.length && !sel) setSel(rows[0].id); }, [rows, sel]);
  useEffect(() => { if (sel) loadDetail(sel); }, [sel, loadDetail]);

  async function act(name, fn) { setBusy(name); await fn(); await loadShell(); if (sel) await loadDetail(sel); setBusy(""); }
  const runEngine = () => act("engine", () => supabase.rpc("run_eligibility", { p_dispute: sel }));
  const runAutopilot = () => act("auto", () => orgId && supabase.rpc("bavert_tick_all", { p_org: orgId }));
  const release = (id) => act("rel" + id, () => supabase.rpc("release_approval", { p_id: id, p_actor: email }));
  const reject = (id) => act("rej" + id, () => supabase.rpc("reject_approval", { p_id: id, p_actor: email }));
  const genLetter = () => act("doc", async () => {
    const { data } = await supabase.rpc("generate_document", { p_dispute: sel, p_kind: "challenge_letter" });
    if (data) await supabase.rpc("sign_document", { p_doc: data, p_signer: email });
  });
  const verifyLedger = () => act("verify", async () => { const { data } = await supabase.rpc("verify_ledger", { p_org: orgId }); setVerify(data); });
  const exportData = () => act("export", async () => {
    const { data } = await supabase.rpc("export_org_data", { p_org: orgId });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "bavert-export.json"; a.click(); URL.revokeObjectURL(url);
  });
  async function signOut() { await supabase.auth.signOut(); router.push("/login"); }

  return (
    <div className="app">
      <div className="masthead">
        <div className="brand"><span className="lg">B</span> Avertyn</div>
        <div className="switch">Meridian Plan Administrators ⌄</div>
        <div className="grow" />
        <div className="search"><span>Search…</span><span className="kbd">⌘K</span></div>
        <span className="badge" title="Unread notifications"><i className={"dot " + (notifs ? "d-red" : "d-green")} />{notifs} alerts</span>
        <span className="who">{email}</span>
        <button className="linkbtn" onClick={signOut}>Sign out</button>
      </div>

      <div className="tabs">
        {TABS.map((t, i) => <button key={t} className={"tab" + (i === tab ? " on" : "")} onClick={() => setTab(i)}>{t}</button>)}
      </div>

      {tab === 0 ? (
        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          <CommandCenter metrics={metrics} agentM={agentM} scorecard={scorecard}
            onVerify={verifyLedger} onExport={exportData} onAutopilot={runAutopilot} busy={busy} verify={verify} />
        </div>
      ) : tab === 1 ? (
        <div className="work">
          <div className="list">
            <div className="lhdr"><b>Incoming</b><span className="ct">{rows.length} disputes</span></div>
            {rows.map((r) => {
              const rd = read(r);
              return (
                <div key={r.id} className={"lrow" + (r.id === sel ? " on" : "")} onClick={() => setSel(r.id)}>
                  <div className="r1"><b>#{r.external_ref}</b><span className="badge"><i className={"dot d-" + rd.tone} />{rd.label}</span></div>
                  <div className="r2">{r.initiators?.name || "—"} · {money(r.demand_amount)} · {r.workflow_state}</div>
                </div>
              );
            })}
          </div>
          <div className="detail">
            {!detail ? <p className="muted">Select a dispute…</p> : <Detail dd={detail} onRun={runEngine} onDoc={genLetter} busy={busy} />}
          </div>
          <div className="rail">
            <div className="rlabel">Autopilot · governed</div>
            <div className="rcard">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <b style={{ fontFamily: "var(--disp)", fontSize: 15 }}>Agent</b>
                <button className="btn btn-s" style={{ padding: "6px 11px" }} disabled={busy === "auto"} onClick={runAutopilot}>{busy === "auto" ? "Running…" : "Run tick"}</button>
              </div>
              {metrics && <p className="muted" style={{ marginTop: 8 }}>{metrics.open_disputes} open · {money(metrics.dollars_defended)} defended · {metrics.challenges_filed} challenges</p>}
            </div>
            <div className="rlabel">Autonomy dial</div>
            <div className="rcard" style={{ padding: "4px 13px" }}>
              <div className="dial"><span>Triage · Defend · Challenge</span><span className="badge"><i className="dot d-ink" />Auto</span></div>
              <div className="dial"><span>Submit response</span><span className="badge"><i className="dot d-amber" />Review</span></div>
              <div className="dial"><span>Schedule pay · Settle</span><span className="badge"><i className="dot d-amber" />Review</span></div>
            </div>
            <div className="rlabel">Waiting for you · {queue.length}</div>
            {queue.length === 0 ? <p className="muted">Nothing staged.</p> : queue.map((q) => (
              <div key={q.id} className="rcard">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <b style={{ fontSize: 12 }}>{q.action_type} · {money(q.amount)}</b><span className="badge"><i className="dot d-amber" />Review</span>
                </div>
                {q.rationale && <div className="muted" style={{ fontSize: 11, margin: "6px 0 9px" }}>{q.rationale}</div>}
                <div style={{ display: "flex", gap: 7 }}>
                  <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "rel" + q.id} onClick={() => release(q.id)}>Release</button>
                  <button className="btn btn-s" style={{ padding: "7px 12px" }} disabled={busy === "rej" + q.id} onClick={() => reject(q.id)}>Reject</button>
                </div>
              </div>
            ))}
            <div className="rlabel">Agent activity · ledger</div>
            <div className="rcard"><div className="feed">
              {feed.map((e, i) => <div key={i}>{e.actor === "agent" ? "✦" : "•"} <b>{e.action_type}</b> · {e.actor}{e.rationale ? " — " + e.rationale.slice(0, 60) : ""}</div>)}
            </div></div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--mut)" }}>{TABS[tab]} — view coming next</div>
      )}
    </div>
  );
}

function read(r) {
  if (r.disposition === "provider_win") return { label: "Award — pay", tone: "ink" };
  if ((r.eligibility_score || 0) >= 80) return { label: "Ineligible", tone: "red" };
  if ((r.eligibility_score || 0) >= 60) return { label: "Review", tone: "amber" };
  if (r.workflow_state === "qpa_defense") return { label: "Defend QPA", tone: "ink" };
  return { label: "Defensible", tone: "green" };
}

function CommandCenter({ metrics, agentM, scorecard, onVerify, onExport, onAutopilot, busy, verify }) {
  const overrideRate = agentM && (agentM.human_released + agentM.human_rejected)
    ? Math.round((agentM.human_rejected / (agentM.human_released + agentM.human_rejected)) * 100) : 0;
  return (
    <div>
      <div className="dh"><h1>Command center</h1><span className="sub">Meridian Plan Administrators · all plans</span></div>
      <div className="cards" style={{ marginTop: 14 }}>
        <div className="box"><div className="l">Open disputes</div><div className="n">{metrics?.open_disputes ?? "—"}</div></div>
        <div className="box"><div className="l">$ defended</div><div className="n">{money(metrics?.dollars_defended)}</div></div>
        <div className="box"><div className="l">Challenges filed</div><div className="n">{metrics?.challenges_filed ?? "—"}</div></div>
        <div className="box"><div className="l">Agent actions</div><div className="n">{agentM?.agent_actions ?? "—"}</div></div>
        <div className="box"><div className="l">Human override</div><div className="n">{overrideRate}%</div></div>
      </div>

      <div className="panel">
        <div className="ph">Initiator scorecard
          <span className="act"><button className="btn btn-s" style={{ padding: "6px 11px" }} disabled={busy === "auto"} onClick={onAutopilot}>{busy === "auto" ? "Running…" : "Run autopilot"}</button></span>
        </div>
        <table>
          <thead><tr><th>Initiator</th><th>Disputes</th><th>Avg ineligibility</th><th>Challenged</th><th>Avg demand</th><th>Avg QPA</th></tr></thead>
          <tbody>
            {scorecard.map((s, i) => (
              <tr key={i}>
                <td><b>{s.initiator}</b></td><td className="mono">{s.disputes}</td>
                <td className="mono">{s.avg_ineligibility ?? "—"}</td><td className="mono">{s.challenged}</td>
                <td className="mono">{money(s.avg_demand)}</td><td className="mono">{money(s.avg_qpa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="ph">Trust &amp; compliance</div>
        <div className="pb" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", paddingTop: 12 }}>
          <button className="btn btn-s" disabled={busy === "verify"} onClick={onVerify}>{busy === "verify" ? "Verifying…" : "Verify ledger integrity"}</button>
          <button className="btn btn-s" disabled={busy === "export"} onClick={onExport}>{busy === "export" ? "Exporting…" : "Export org data (JSON)"}</button>
          {verify && <span className="badge"><i className={"dot " + (verify.ok ? "d-green" : "d-red")} />{verify.ok ? `Ledger intact · ${verify.rows} rows, 0 tamper` : `${verify.mismatches} mismatches`}</span>}
        </div>
      </div>
    </div>
  );
}

function Detail({ dd, onRun, onDoc, busy }) {
  const { d, find, qpa } = dd;
  const s = d.eligibility_score ?? 0;
  const gcol = s >= 80 ? "var(--sig)" : s >= 60 ? "var(--warn)" : "var(--ok)";
  const verdict = s >= 80 ? ["Challenge — likely ineligible", "red"] : s >= 60 ? ["Review eligibility", "amber"] : ["Defensible", "green"];
  return (
    <div>
      <div className="dh"><h1>#{d.external_ref}</h1>
        <span className="sub">{d.initiators?.name} · CPT {d.cpt_code} · {d.plans?.name} · {d.workflow_state}</span></div>
      <div className="cards">
        <div className="box" style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div className="gauge" style={{ background: `conic-gradient(${gcol} ${s}%,#eeedea 0)` }}>
            <div className="v"><b style={{ color: gcol }}>{s}</b><span>Ineligible</span></div>
          </div>
          <div><span className="badge"><i className={"dot d-" + verdict[1]} />{verdict[0]}</span>
            <p className="muted" style={{ marginTop: 9, maxWidth: "22ch" }}>Ineligibility score from the rule engine.</p></div>
        </div>
        <div className="box"><div className="l">Demand vs QPA</div><div className="n">{money(d.demand_amount)}</div><div className="l" style={{ marginTop: 3 }}>QPA {money(d.qpa_amount)}</div></div>
      </div>
      <div className="panel">
        <div className="ph">Eligibility findings
          <span className="act"><button className="btn btn-s" style={{ padding: "6px 11px" }} disabled={busy === "engine"} onClick={onRun}>{busy === "engine" ? "Running…" : "Run engine"}</button></span>
        </div>
        <div className="pb">
          {find.length === 0 ? <p className="muted">No findings — run the engine.</p> : find.map((f, i) => {
            const [cls, gl] = mkg[f.result] || mkg.na;
            return (<div key={i} className="frow"><span className={"mk " + cls}>{gl}</span>
              <div><b>{f.eligibility_rules?.name}</b><div className="sub">{f.eligibility_rules?.severity} · {f.detail}</div></div></div>);
          })}
        </div>
      </div>
      {qpa && (
        <div className="panel"><div className="ph">QPA defense</div><div className="pb">
          <Bar l="Demand" v={d.demand_amount} max={d.demand_amount} c="var(--sig)" />
          <Bar l="Plan QPA" v={qpa.plan_qpa} max={d.demand_amount} c="var(--ink)" showref />
          <Bar l="FAIR Health median" v={qpa.benchmark_fairhealth} max={d.demand_amount} c="#b9b6b0" />
          <Bar l="Defensible ceiling" v={qpa.defensible_ceiling} max={d.demand_amount} c="#8f8d88" />
          {qpa.notes && <p className="muted" style={{ fontSize: 12 }}>{qpa.notes}</p>}
        </div></div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {s >= 80
          ? <button className="btn btn-a" disabled={busy === "doc"} onClick={onDoc}>{busy === "doc" ? "Generating…" : "Generate & sign challenge letter"}</button>
          : <button className="btn btn-a">Submit response</button>}
      </div>
    </div>
  );
}

function Bar({ l, v, max, c, showref }) {
  const pct = max ? Math.min(100, Math.round((Number(v) / Number(max)) * 100)) : 0;
  return (
    <div className="bar">
      <div className="bl"><b>{l}</b><span className="mono">{money(v)}</span></div>
      <div className="track"><div className="fill" style={{ width: pct + "%", background: c }} />{showref && <div className="qref" style={{ left: pct + "%" }} />}</div>
    </div>
  );
}
