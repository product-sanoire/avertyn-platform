"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { money, untilLabel } from "../../lib/format";
import { InboxView, TasksView, CalendarView, PredictionsView } from "./ops";
import { InitiatorsView } from "./tiera";
import { ImportHub } from "./import";
import { CommandPalette } from "./palette";
import { FilingView } from "./filing";
import { AdminView } from "./admin";
import { ExplainModal } from "./explain";

const TABS = ["Overview", "Cases", "Intelligence", "Workspace", "Filing", "Admin"];
const INTEL = [["initiators", "Initiators & IDREs"], ["exposure", "Employer exposure"]];
const WORKSPACE = [["inbox", "Inbox"], ["tasks", "Tasks"], ["calendar", "Calendar"]];
const STAGES = [["all", "All"], ["due", "Due soon"], ["incoming", "Incoming"], ["eligibility", "Eligibility"], ["qpa", "QPA defense"], ["respond", "Respond & pay"]];
const mkg = { pass: ["pass", "✓"], fail: ["fail", "×"], warn: ["warn", "!"], na: ["na", "–"] };

// Friendly labels for autonomy action codes.
const ACTION_LABEL = {
  triage: "Triage", defend_qpa: "Defend QPA", challenge_eligibility: "Challenge eligibility",
  open_negotiation: "Open negotiation", submit_response: "Submit response",
  submit_additional_info: "Additional info", request_extension: "Request extension",
  withdraw: "Withdraw", escalate: "Escalate", schedule_payment: "Schedule payment", settle: "Settle",
};
const MODES = ["off", "suggest", "review", "auto"];
const MONEY = new Set(["settle", "schedule_payment"]);

// CSV export helper (reporting).
function downloadCSV(name, rows, cols) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.map((c) => c.h).join(","), ...rows.map((r) => cols.map((c) => esc(c.f(r))).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
// Brief lifecycle status badges (mirror the Composer / case page).
const DOC_STATUS_LABEL = { draft: "Draft", in_review: "In review", approved: "Approved", filed: "Filed" };
const DOC_STATUS_TONE = { draft: "grey", in_review: "amber", approved: "green", filed: "ink" };
const DOC_STATUS_RANK = { draft: 1, in_review: 2, approved: 3, filed: 4 };
function briefMapFrom(docs) {
  const m = {};
  for (const d of docs || []) {
    const cur = m[d.dispute_id];
    const rank = DOC_STATUS_RANK[d.status] || 1;
    if (!cur || rank >= cur.rank) m[d.dispute_id] = { status: d.status || "draft", rank, sealed: (cur?.sealed || d.esign_status === "signed") };
    else if (d.esign_status === "signed") cur.sealed = true;
  }
  return m;
}
const DISPUTE_CSV_COLS = [
  { h: "ref", f: (r) => r.external_ref }, { h: "initiator", f: (r) => r.initiators?.name }, { h: "plan", f: (r) => r.plans?.name },
  { h: "cpt", f: (r) => r.cpt_code }, { h: "demand", f: (r) => r.demand_amount }, { h: "qpa", f: (r) => r.qpa_amount },
  { h: "eligibility_score", f: (r) => r.eligibility_score }, { h: "state", f: (r) => r.workflow_state }, { h: "disposition", f: (r) => r.disposition },
];

export default function Dashboard() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState(null);
  const [orgId, setOrgId] = useState(null);
  const [rows, setRows] = useState([]);
  const [briefMap, setBriefMap] = useState({});   // dispute_id -> { status, sealed } (furthest-along brief)
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [score, setScore] = useState(null);      // org_scorecard (PRD success metrics)
  const [awardsM, setAwardsM] = useState(null);   // awards_metrics
  const [agentM, setAgentM] = useState(null);
  const [scorecard, setScorecard] = useState([]);
  const [gap, setGap] = useState([]);             // qpa_gap by CPT
  const [exposure, setExposure] = useState([]);   // employer_exposure_v
  const [queue, setQueue] = useState([]);
  const [feed, setFeed] = useState([]);
  const [autonomy, setAutonomy] = useState([]);
  const [notifs, setNotifs] = useState(0);
  const [notifList, setNotifList] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [explainId, setExplainId] = useState(null);
  const [filingBatch, setFilingBatch] = useState(null);
  const [docView, setDocView] = useState(null);
  const [moneyRel, setMoneyRel] = useState(null);
  const [tab, setTab] = useState(0);
  const [stage, setStage] = useState("all");
  const [intel, setIntel] = useState("initiators");
  const [dispSort, setDispSort] = useState("deadline");
  const [dispQuery, setDispQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [ws, setWs] = useState("inbox");
  const [busy, setBusy] = useState("");
  const [verify, setVerify] = useState(null);
  const [err, setErr] = useState("");
  const loadedOnce = useRef(false);
  const selRef = useRef(null);

  // ---- data loading --------------------------------------------------------
  const loadShell = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.push("/login"); return; }
      setEmail(session.user.email);
      setUserId(session.user.id);
      const { data: me } = await supabase.from("app_users").select("org_id").eq("id", session.user.id).maybeSingle();
      setOrgId(me?.org_id || null);

      const res = await Promise.all([
        supabase.from("disputes").select("id, external_ref, cpt_code, demand_amount, qpa_amount, workflow_state, disposition, eligibility_score, respond_by, pay_by, plans(name), initiators(name)").order("respond_by", { ascending: true, nullsFirst: false }),
        supabase.from("org_metrics").select("*").maybeSingle(),
        supabase.from("org_scorecard").select("*").maybeSingle(),
        supabase.from("awards_metrics").select("*").maybeSingle(),
        supabase.from("agent_metrics").select("*").maybeSingle(),
        supabase.from("initiator_scorecard").select("*").order("disputes", { ascending: false }),
        supabase.from("qpa_gap").select("*").order("demand_to_qpa", { ascending: false }).limit(8),
        supabase.from("employer_exposure_v").select("*").order("at_risk", { ascending: false }),
        supabase.from("approval_queue").select("id, dispute_id, action_type, amount, rationale").eq("status", "pending"),
        supabase.from("action_log").select("action_type, actor, rationale, created_at").order("created_at", { ascending: false }).limit(8),
        supabase.from("autonomy_settings").select("action_type, mode, max_amount"),
        supabase.from("notifications").select("id, dispute_id, kind, title, body, severity, read, created_at").order("created_at", { ascending: false }).limit(30),
        supabase.from("documents").select("dispute_id, status, esign_status"),
      ]);
      const firstErr = res.find((r) => r.error)?.error;
      if (firstErr) throw firstErr;
      const [d, m, sc2, aw, am, sc, g, ex, q, f, au, nl, db] = res.map((r) => r.data);
      setRows(d || []);
      setBriefMap(briefMapFrom(db || []));
      setMetrics(m || null); setScore(sc2 || null); setAwardsM(aw || null); setAgentM(am || null);
      setScorecard(sc || []); setGap(g || []); setExposure(ex || []);
      setQueue(q || []); setFeed(f || []); setAutonomy(au || []);
      setNotifList(nl || []); setNotifs((nl || []).filter((n) => !n.read).length);
      loadedOnce.current = true;
    } catch (e) {
      setErr(e.message || "Couldn't load the dashboard.");
    }
  }, [router]);

  // Light refetch after an action (no heavy list/exposure/gap requeries).
  const loadOps = useCallback(async () => {
    try {
      const res = await Promise.all([
        supabase.from("org_metrics").select("*").maybeSingle(),
        supabase.from("org_scorecard").select("*").maybeSingle(),
        supabase.from("agent_metrics").select("*").maybeSingle(),
        supabase.from("approval_queue").select("id, dispute_id, action_type, amount, rationale").eq("status", "pending"),
        supabase.from("action_log").select("action_type, actor, rationale, created_at").order("created_at", { ascending: false }).limit(8),
        supabase.from("autonomy_settings").select("action_type, mode, max_amount"),
        supabase.from("notifications").select("id, dispute_id, kind, title, body, severity, read, created_at").order("created_at", { ascending: false }).limit(30),
      ]);
      const [m, sc2, am, q, f, au, nl] = res.map((r) => r.data);
      setMetrics(m || null); setScore(sc2 || null); setAgentM(am || null);
      setQueue(q || []); setFeed(f || []); setAutonomy(au || []);
      setNotifList(nl || []); setNotifs((nl || []).filter((n) => !n.read).length);
    } catch (e) { setErr(e.message); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    try {
      const [{ data: d }, { data: find }, { data: q }, { data: docs }, { data: offs }] = await Promise.all([
        supabase.from("disputes").select("*, plans(name), initiators(name)").eq("id", id).single(),
        supabase.from("eligibility_findings").select("result, detail, eligibility_rules(name, severity)").eq("dispute_id", id),
        supabase.from("qpa_records").select("*").eq("dispute_id", id).maybeSingle(),
        supabase.from("documents").select("id, kind, title, status, esign_status, signed_by, signed_at, created_at, content").eq("dispute_id", id).order("created_at", { ascending: false }),
        supabase.from("offers").select("id, party, kind, amount, note, submitted_at").eq("dispute_id", id).order("submitted_at", { ascending: true }),
      ]);
      setDetail({ d, find: find || [], qpa: q || null, docs: docs || [], offers: offs || [] });
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { loadShell(); }, [loadShell]);
  // Self-heal: signed in but not yet mapped to an org (brand-new user, or access
  // just granted). Realtime channels are gated on orgId, so with no org there's
  // nothing to subscribe to — poll the bootstrap until an org appears, then the
  // dashboard fills in and subscribes on its own. No manual refresh needed.
  useEffect(() => {
    if (orgId || !userId) return;
    const t = setInterval(() => { loadShell(); }, 4000);
    return () => clearInterval(t);
  }, [orgId, userId, loadShell]);
  // Refetch when the tab regains focus so a long-idle tab is never stale.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") loadShell(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadShell]);
  useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => { if (rows.length && !sel) setSel(rows[0].id); }, [rows, sel]);
  useEffect(() => { selRef.current = sel; if (sel) loadDetail(sel); }, [sel, loadDetail]);

  // Realtime: keep every live slice moving — queue, ledger, disputes, awards,
  // predictions, and the open case's findings/QPA/offers/documents.
  useEffect(() => {
    if (!orgId) return;
    const detail = () => { if (selRef.current) loadDetail(selRef.current); };
    const ch = supabase
      .channel("avertyn-ops")
      .on("postgres_changes", { event: "*", schema: "public", table: "approval_queue" }, loadOps)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, loadOps)
      .on("postgres_changes", { event: "*", schema: "public", table: "action_log" }, loadOps)
      .on("postgres_changes", { event: "*", schema: "public", table: "disputes" }, loadShell)
      .on("postgres_changes", { event: "*", schema: "public", table: "awards" }, loadShell)
      .on("postgres_changes", { event: "*", schema: "public", table: "predictions" }, loadShell)
      .on("postgres_changes", { event: "*", schema: "public", table: "eligibility_findings" }, detail)
      .on("postgres_changes", { event: "*", schema: "public", table: "qpa_records" }, detail)
      .on("postgres_changes", { event: "*", schema: "public", table: "offers" }, detail)
      .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, () => { detail(); loadShell(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [orgId, loadOps, loadShell, loadDetail]);

  // ---- actions -------------------------------------------------------------
  async function act(name, fn, opts = {}) {
    setBusy(name); setErr("");
    try {
      await fn();
      if (opts.full) await loadShell(); else await loadOps();
      if (sel) await loadDetail(sel);
    } catch (e) { setErr(e.message || "Action failed."); }
    setBusy("");
  }
  const rpc = async (name, args) => { const { error } = await supabase.rpc(name, args); if (error) throw error; };
  async function runBulk(perId) {
    if (!selected.size) return;
    setBusy("bulk"); setErr("");
    try { for (const id of Array.from(selected)) { await perId(id); } setSelected(new Set()); await loadShell(); if (sel) await loadDetail(sel); }
    catch (e) { setErr(e.message || "Bulk action failed."); }
    setBusy("");
  }
  // Build a batch from the selected cases and jump to Filing (batch → IDRE → file).
  async function batchAndFile() {
    if (!selected.size) return;
    setBusy("bulk"); setErr("");
    try {
      const { data, error } = await supabase.rpc("execute_batch_action", { p_action: "build_batch", p_params: { dispute_ids: Array.from(selected) }, p_actor: "operator", p_rationale: "Batch & file from case queue" });
      if (error) throw error;
      if (data && data.ok === false) throw new Error(data.reason === "over_50_line_cap" ? "A batch can hold at most 50 lines." : (data.reason || "Couldn't build the batch."));
      setSelected(new Set());
      setFilingBatch(data?.effect?.batch_id || null);
      setTab(4);
      await loadShell();
    } catch (e) { setErr(e.message || "Batch & file failed."); }
    setBusy("");
  }

  const runEngine = () => act("engine", () => rpc("run_eligibility", { p_dispute: sel }));
  const runAutopilot = () => act("auto", () => orgId && rpc("bavert_tick_all", { p_org: orgId }));
  const release = (id) => act("rel" + id, () => rpc("release_approval", { p_id: id, p_actor: email }));
  const reject = (id) => act("rej" + id, () => rpc("reject_approval", { p_id: id, p_actor: email }));
  const genLetter = () => act("doc", async () => {
    const { data, error } = await supabase.rpc("generate_document", { p_dispute: sel, p_kind: "challenge_letter" });
    if (error) throw error;
    if (data) { const { error: e2 } = await supabase.rpc("sign_document", { p_doc: data, p_signer: email }); if (e2) throw e2; }
  });
  const openNeg = () => act("oneg", async () => {
    const { data, error } = await supabase.rpc("execute_action", { p_action: "open_negotiation", p_dispute: sel, p_params: {}, p_actor: email, p_rationale: "Open-negotiation offer at 125% of QPA — settle before IDR fees." });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.reason === "forbidden" ? "Your role can't send offers." : (data.reason || "Couldn't open negotiation."));
  });
  const caseAction = (action, rationale) => act("ca_" + action, async () => {
    const { data, error } = await supabase.rpc("execute_action", { p_action: action, p_dispute: sel, p_params: {}, p_actor: email, p_rationale: rationale });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.reason === "forbidden" ? "Your role can't do that." : (data.reason || "Action failed."));
  });
  const stageMoney = (action, amount, rationale) => act("stage_" + action, async () => {
    const { data, error } = await supabase.rpc("request_action", { p_action: action, p_dispute: sel, p_amount: amount, p_rationale: rationale });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.reason === "over_cap" ? `Amount exceeds the ${money(data.cap)} cap.` : (data.reason || "Couldn't stage."));
  });
  const releaseMoney = (id, confirmAmount) => act("rel" + id, async () => {
    const { data, error } = await supabase.rpc("release_money_action", { p_id: id, p_actor: email, p_confirm_amount: confirmAmount, p_stepup: true });
    if (error) throw error;
    if (data && data.ok === false) {
      const map = { maker_cannot_check: "You staged this — a different reviewer must release it.", amount_mismatch: "The amount didn't match.", over_cap: "Over the approval cap.", step_up_required: "Step-up required." };
      throw new Error(map[data.reason] || data.reason || "Release failed.");
    }
  });
  const setAutonomy_ = (action_type, mode) => act("dial" + action_type, () => rpc("autonomy_set", { p_action_type: action_type, p_mode: mode, p_max_amount: null }));
  const verifyLedger = () => act("verify", async () => { const { data, error } = await supabase.rpc("verify_ledger", { p_org: orgId }); if (error) throw error; setVerify(data); });
  const exportData = () => act("export", async () => {
    const { data, error } = await supabase.rpc("export_org_data", { p_org: orgId });
    if (error) throw error;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "avertyn-export.json"; a.click(); URL.revokeObjectURL(url);
  });
  async function markAllRead() { try { await supabase.rpc("notifications_mark_all_read"); await loadOps(); } catch (e) { setErr(e.message); } }
  async function openNotif(n) {
    try { if (!n.read) { await supabase.rpc("notifications_mark_read", { p_ids: [n.id] }); await loadOps(); } } catch (e) { setErr(e.message); }
    if (n.dispute_id) { setSel(n.dispute_id); setTab(1); }
    setNotifOpen(false);
  }
  async function signOut() { await supabase.auth.signOut(); router.push("/login"); }

  // ---- tab filters ---------------------------------------------------------
  const filtered = (() => {
    if (tab !== 1 || stage === "all") return rows;
    if (stage === "due") return rows.filter((r) => { const t = r.respond_by || r.pay_by; if (!t) return false; return (new Date(t).getTime() - Date.now()) / 3.6e6 <= 72; });
    if (stage === "incoming") return rows.filter((r) => ["intake", "triage"].includes(r.workflow_state));
    if (stage === "eligibility") return rows.filter((r) => (r.eligibility_score || 0) >= 60 || ["intake", "triage", "eligibility_review"].includes(r.workflow_state));
    if (stage === "qpa") return rows.filter((r) => r.workflow_state === "qpa_defense" || r.workflow_state === "response_prep");
    if (stage === "respond") return rows.filter((r) => ["response_prep", "awaiting_determination", "award_payment"].includes(r.workflow_state) || r.disposition === "provider_win");
    return rows;
  })();
  const tabHeader = STAGES.find((s) => s[0] === stage)?.[1] || "All";
  const displayed = (() => {
    let arr = filtered;
    const q = dispQuery.trim().toLowerCase();
    if (q) arr = arr.filter((r) => (r.external_ref || "").toLowerCase().includes(q) || (r.initiators?.name || "").toLowerCase().includes(q) || (r.cpt_code || "").toLowerCase().includes(q));
    return [...arr].sort((a, b) => {
      if (dispSort === "demand") return (b.demand_amount || 0) - (a.demand_amount || 0);
      if (dispSort === "score") return (b.eligibility_score || 0) - (a.eligibility_score || 0);
      return new Date(a.respond_by || "2999-01-01").getTime() - new Date(b.respond_by || "2999-01-01").getTime();
    });
  })();

  return (
    <div className="app">
      <div className="masthead">
        <div className="mzone">
          <span className="brandmark" role="img" aria-label="Avertyn">
            <svg viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#141414" /><g fill="none" stroke="#F5F4F2" strokeWidth="44" strokeLinecap="butt" strokeLinejoin="round"><path d="M172 374 L244 196" /><path d="M340 374 L268 196" /></g><circle cx="256" cy="182" r="27" fill="#B23A2A" /></svg>
          </span>
          <button className="switch2" title="Meridian Plan Administrators">
            <span className="col"><span className="eb">Workspace</span><span className="nm">Meridian Plan Administrators</span></span>
            <span className="cv">⌄</span>
          </button>
        </div>
        <div className="searchc">
          <div className="search2" title="Search & commands" onClick={() => setPaletteOpen(true)}>
            <svg className="mg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <span>Search disputes, clients, files…</span><span className="kbd">⌘K</span>
          </div>
        </div>
        <div className="mzone">
          <span className="mchip live" title="Realtime — updates as disputes, awards and alerts move"><span className="pulse" />LIVE</span>
          <button className={"mchip alert" + (notifs ? " loud" : "")} title="Notifications" onClick={() => setNotifOpen(true)}>
            <i className={"dot " + (notifs ? "d-red" : "d-green")} />{notifs}
          </button>
          <a className="btn btn-s" style={{ padding: "8px 14px", textDecoration: "none" }} href="/authorities">Register</a>
          <a className="btn btn-s" style={{ padding: "8px 14px", textDecoration: "none" }} href="/templates">Templates</a>
          <button className="btn btn-s" style={{ padding: "8px 14px" }} onClick={() => setImportOpen(true)}>+ Import</button>
          <AccountMenu email={email} onSignOut={signOut} onExport={exportData} />
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t, i) => <button key={t} className={"tab" + (i === tab ? " on" : "")} onClick={() => setTab(i)}>{t}</button>)}
      </div>

      {tab === 0 ? (
        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          <CommandCenter metrics={metrics} score={score} awardsM={awardsM} agentM={agentM}
            scorecard={scorecard} gap={gap} onVerify={verifyLedger} onExport={exportData}
            onAutopilot={runAutopilot} busy={busy} verify={verify} />
          <PredictionsView embedded onErr={setErr} onOpen={(id) => { setSel(id); setTab(1); setStage("all"); }} />
        </div>
      ) : tab === 2 ? (
        <div style={{ flex: 1, overflow: "auto", padding: "22px 26px" }}>
          <div className="shead">
            <div className="stitle">
              <h1>Intelligence</h1>
              <span className="sub">{intel === "exposure"
                ? "What IDR is costing each plan sponsor — the view your brokers distribute"
                : "Who's filing against your plans, how weak their filings are, and how each IDRE behaves — your negotiation leverage"}</span>
            </div>
            <div className="seg">
              {INTEL.map(([k, l]) => <button key={k} className={intel === k ? "on" : ""} onClick={() => setIntel(k)}>{l}</button>)}
            </div>
          </div>
          {intel === "exposure" ? <ExposureView exposure={exposure} embedded /> : <InitiatorsView orgId={orgId} onErr={setErr} embedded />}
        </div>
      ) : tab === 3 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="shead" style={{ padding: "22px 26px 15px", margin: 0, flexWrap: "wrap" }}>
            <div className="stitle">
              <h1>Workspace</h1>
              <span className="sub">{ws === "inbox" ? "Payer & provider correspondence tied to your cases"
                : ws === "tasks" ? "Your team's open work, prioritized"
                : "Business-day, holiday-aware windows & events"}</span>
            </div>
            <div className="seg">
              {WORKSPACE.map(([k, l]) => <button key={k} className={ws === k ? "on" : ""} onClick={() => setWs(k)}>{l}</button>)}
            </div>
          </div>
          {ws === "inbox" ? (
            <div style={{ flex: 1, overflow: "hidden" }}><InboxView email={email} orgId={orgId} onErr={setErr} /></div>
          ) : (
            <div style={{ flex: 1, overflow: "auto", padding: "18px 24px 22px" }}>
              {ws === "tasks" ? <TasksView email={email} orgId={orgId} userId={userId} onErr={setErr} embedded /> : <CalendarView onErr={setErr} embedded />}
            </div>
          )}
        </div>
      ) : tab === 4 ? (
        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          <FilingView orgId={orgId} onErr={setErr} initialBatch={filingBatch} onConsumeInitial={() => setFilingBatch(null)} />
        </div>
      ) : tab === 5 ? (
        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          <AdminView orgId={orgId} onErr={setErr} />
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "16px 24px 12px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 style={{ fontFamily: "var(--disp)", fontSize: 25, margin: 0, letterSpacing: "-.02em" }}>Cases</h1>
            <div className="seg">
              {STAGES.map(([k, label]) => (
                <button key={k} className={stage === k ? "on" : ""} onClick={() => setStage(k)}>{label}</button>
              ))}
            </div>
            {selected.size > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="badge b-ink">{selected.size} selected</span>
                <button className="mini" disabled={busy === "bulk"} onClick={() => runBulk((id) => rpc("run_eligibility", { p_dispute: id }))}>{busy === "bulk" ? "Working…" : "Run engine"}</button>
                <button className="mini" disabled={busy === "bulk"} onClick={() => runBulk((id) => rpc("execute_action", { p_action: "predict_outcome", p_dispute: id, p_params: {}, p_actor: email, p_rationale: "Bulk predict" }))}>Predict</button>
                <button className="mini" disabled={busy === "bulk"} onClick={batchAndFile}>Batch &amp; file →</button>
                <button className="mini" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
              <input value={dispQuery} onChange={(e) => setDispQuery(e.target.value)} placeholder="Filter…"
                style={{ padding: "8px 12px", border: 0, borderRadius: 9, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", font: "inherit", fontSize: 12.5, width: 150 }} />
              <select className="dsel" value={dispSort} onChange={(e) => setDispSort(e.target.value)} style={{ padding: "8px 10px" }}>
                <option value="deadline">Sort: deadline</option>
                <option value="demand">Sort: demand</option>
                <option value="score">Sort: ineligibility</option>
              </select>
              <span className="muted" style={{ fontSize: 12.5 }}>{displayed.length}</span>
              <button className="mini" onClick={() => downloadCSV("avertyn-disputes.csv", displayed, DISPUTE_CSV_COLS)}>Export CSV</button>
            </div>
          </div>
          <div className="work" style={{ flex: 1 }}>
          <div className="list">
            <div className="lhdr"><b>{tabHeader}</b><span className="ct">{displayed.length}</span></div>
            {displayed.length === 0
              ? <p className="muted" style={{ padding: 16 }}>Nothing here right now.</p>
              : displayed.map((r) => {
                  const rd = read(r);
                  const isSel = selected.has(r.id);
                  return (
                    <div key={r.id} className={"lrow" + (r.id === sel ? " on" : "")} onClick={() => setSel(r.id)}>
                      <div className="r1">
                        <label style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={isSel} onChange={(e) => { const n = new Set(selected); e.target.checked ? n.add(r.id) : n.delete(r.id); setSelected(n); }} />
                          <b>#{r.external_ref}</b>
                        </label>
                        <span className="badge"><i className={"dot d-" + rd.tone} />{rd.label}</span>
                        {(() => { const t = r.respond_by || r.pay_by; if (!t) return null; const h = (new Date(t).getTime() - Date.now()) / 3.6e6; if (h > 168) return null; const od = h < 0; return <span className={"badge " + (od ? "b-red" : h <= 72 ? "b-amber" : "b-grey")} style={{ marginLeft: "auto" }} title="Response / payment window"><i className={"dot d-" + (od ? "red" : h <= 72 ? "amber" : "grey")} />{untilLabel(t)}</span>; })()}
                      </div>
                      <div className="r2" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span>{r.initiators?.name || "—"} · {money(r.demand_amount)} · {r.workflow_state}</span>
                        {briefMap[r.id] && (
                          <span className={"badge b-" + (DOC_STATUS_TONE[briefMap[r.id].status] || "grey")} title="Furthest-along brief status on this case">
                            <i className={"dot d-" + (DOC_STATUS_TONE[briefMap[r.id].status] || "grey")} />
                            {DOC_STATUS_LABEL[briefMap[r.id].status] || "Draft"}
                          </span>
                        )}
                        {briefMap[r.id]?.sealed && <span className="badge b-green" title="A document on this case is signed &amp; sealed"><i className="dot d-green" />Sealed</span>}
                      </div>
                    </div>
                  );
                })}
          </div>
          <div className="detail">
            {!detail ? <p className="muted">Select a dispute…</p> : <Detail dd={detail} onRun={runEngine} onDoc={genLetter} onOpenNeg={openNeg} onAction={caseAction} onStageMoney={stageMoney} onView={setDocView} onExplain={() => setExplainId(sel)} busy={busy} />}
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
              {autonomy.length === 0 ? <p className="muted" style={{ padding: "8px 0" }}>No policy set.</p> : autonomy.map((a) => (
                <div key={a.action_type} className="dial">
                  <span>{ACTION_LABEL[a.action_type] || a.action_type}</span>
                  <select className="dsel" value={a.mode} disabled={busy === "dial" + a.action_type}
                    onChange={(e) => setAutonomy_(a.action_type, e.target.value)}>
                    {MODES.map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <div className="rlabel">Waiting for you · {queue.length}</div>
            {queue.length === 0 ? <p className="muted">Nothing staged.</p> : queue.map((q) => {
              const isMoney = MONEY.has(q.action_type);
              return (
                <div key={q.id} className="rcard">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <b style={{ fontSize: 12 }}>{q.action_type} · {money(q.amount)}</b>
                    <span className={"badge " + (isMoney ? "b-red" : "b-amber")}><i className={"dot d-" + (isMoney ? "red" : "amber")} />{isMoney ? "Dual-control" : "Review"}</span>
                  </div>
                  {q.rationale && <div className="muted" style={{ fontSize: 11, margin: "6px 0 9px" }}>{q.rationale}</div>}
                  <div style={{ display: "flex", gap: 7 }}>
                    {isMoney
                      ? <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "rel" + q.id} onClick={() => setMoneyRel(q)}>Release · step-up</button>
                      : <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "rel" + q.id} onClick={() => release(q.id)}>Release</button>}
                    <button className="btn btn-s" style={{ padding: "7px 12px" }} disabled={busy === "rej" + q.id} onClick={() => reject(q.id)}>Reject</button>
                  </div>
                </div>
              );
            })}

            <div className="rlabel">Agent activity · ledger</div>
            <div className="rcard"><div className="feed">
              {feed.map((e, i) => <div key={i}>{e.actor === "agent" ? "✦" : "•"} <b>{e.action_type}</b> · {e.actor}{e.rationale ? " — " + e.rationale.slice(0, 60) : ""}</div>)}
            </div></div>
          </div>
        </div>
        </div>
      )}

      {notifOpen && <NotifDrawer list={notifList} onClose={() => setNotifOpen(false)} onOpen={openNotif} onAllRead={markAllRead} />}
      {importOpen && <ImportHub orgId={orgId} onErr={setErr} onClose={() => setImportOpen(false)} onDone={loadShell} />}
      {paletteOpen && <CommandPalette orgId={orgId} rows={rows} tabs={TABS}
        onNavigate={(i) => { setTab(i); setPaletteOpen(false); }}
        onSelectDispute={(id) => { setSel(id); setTab(1); setStage("all"); setPaletteOpen(false); }}
        onImport={() => { setImportOpen(true); setPaletteOpen(false); }}
        onAutopilot={() => { runAutopilot(); setPaletteOpen(false); }}
        onClose={() => setPaletteOpen(false)} />}
      {explainId && <ExplainModal disputeId={explainId} onClose={() => setExplainId(null)} />}
      {docView && <DocModal doc={docView} onClose={() => setDocView(null)} />}
      {moneyRel && <MoneyReleaseModal q={moneyRel} onClose={() => setMoneyRel(null)} onRelease={(amt) => { releaseMoney(moneyRel.id, amt); setMoneyRel(null); }} />}
      {err && <div className="toast"><span className="td" />{err}<button onClick={() => { setErr(""); loadShell(); }}>Retry</button><button onClick={() => setErr("")}>Dismiss</button></div>}
    </div>
  );
}

function AccountMenu({ email, onSignOut, onExport }) {
  const [open, setOpen] = useState(false);
  const initials = ((email || "?").replace(/@.*/, "").replace(/[^a-zA-Z]/g, "").slice(0, 2) || "?").toUpperCase();
  return (
    <div className="acct">
      <button className="acctbtn" title={email} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="acct-mono">{initials}</span><span className="cv">⌄</span>
      </button>
      {open && (
        <>
          <div className="acct-bg" onClick={() => setOpen(false)} />
          <div className="acctmenu" role="menu">
            <div className="id"><div className="nm">{email}</div></div>
            <div className="mi" role="menuitem" onClick={() => { setOpen(false); onExport(); }}>Export org data</div>
            <div className="sep" />
            <div className="mi danger" role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}>Sign out</div>
          </div>
        </>
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

function pct(n) { return n == null ? "—" : Math.round(Number(n)) + "%"; }

function CommandCenter({ metrics, score, awardsM, agentM, scorecard, gap, onVerify, onExport, onAutopilot, busy, verify }) {
  const overrideRate = agentM && (agentM.human_released + agentM.human_rejected)
    ? Math.round((agentM.human_rejected / (agentM.human_released + agentM.human_rejected)) * 100) : 0;
  const dlr = score?.default_loss_rate;
  const icr = score?.ineligible_caught_rate;
  const otr = awardsM?.on_time_rate;
  const settled = score?.avg_settled_pct_of_demand;
  return (
    <div>
      <div className="dh"><h1>Overview</h1><span className="sub">Meridian Plan Administrators · all plans</span></div>

      <div className="bento">
        <div className="feat">
          <div className="fl">Dollars defended · H1 2026</div>
          <div className="fn">{money(metrics?.dollars_defended)}</div>
          <div className="fs">Held out of provider hands across {score?.open_disputes ?? metrics?.open_disputes ?? "—"} open disputes — the number your brokers show employers.</div>
          <div className="fmeta">
            <span className="badge b-green">Default-loss {pct(dlr)}</span>
            <span className="badge">{metrics?.challenges_filed ?? "—"} challenges filed</span>
          </div>
        </div>
        <Tile l="Open disputes" n={score?.open_disputes ?? metrics?.open_disputes ?? "—"} />
        <Tile l="Default-loss rate" n={pct(dlr)} goal="target 0%" good={dlr === 0} bad={dlr > 0} />
        <Tile l="Ineligible caught" n={pct(icr)} goal="~40% of filings" prog={icr} tone="var(--ink)" />
        <Tile l="Awards paid on time" n={awardsM?.awards_total ? pct(otr) : "—"} goal="target 100%" good={otr >= 100} bad={awardsM?.awards_total && otr < 100} prog={awardsM?.awards_total ? otr : null} tone="var(--ok)" />
        <Tile l="Avg settled vs demand" n={pct(settled)} goal="lower is better" />
        <Tile l="Agent actions" n={agentM?.agent_actions ?? "—"} />
        <Tile l="Human override" n={overrideRate + "%"} />
      </div>

      <div className="panel">
        <div className="ph">QPA gap by CPT<span className="act"><span className="muted" style={{ fontSize: 11 }}>demand ÷ QPA — where providers inflate most</span></span></div>
        {gap.length === 0 ? <p className="muted" style={{ padding: 16 }}>No QPA data yet.</p> : (
          <table>
            <thead><tr><th>CPT</th><th>Disputes</th><th>Avg demand</th><th>Avg QPA</th><th>Demand ÷ QPA</th></tr></thead>
            <tbody>
              {gap.map((g, i) => (
                <tr key={i}>
                  <td><b>{g.cpt_code}</b></td><td className="mono">{g.disputes}</td>
                  <td className="mono">{money(g.avg_demand)}</td><td className="mono">{money(g.avg_qpa)}</td>
                  <td className="mono"><span className="badge b-red">{g.demand_to_qpa}×</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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

function Tile({ l, n, goal, good, bad, prog, tone }) {
  const hasProg = prog != null && !Number.isNaN(Number(prog));
  return (
    <div className="kpi-tile">
      <div className="l">{l}</div>
      <div className="n">{n}</div>
      {hasProg && <div className="kprog"><div className="kprogf" style={{ width: Math.max(3, Math.min(100, Number(prog))) + "%", background: tone || "var(--ink)" }} /></div>}
      {goal && <div className={"goal" + (good ? " good" : bad ? " bad" : "")}>{goal}</div>}
    </div>
  );
}

function ExposureView({ exposure, embedded }) {
  const totalRisk = exposure.reduce((a, e) => a + Number(e.at_risk || 0), 0);
  const totalDef = exposure.reduce((a, e) => a + Number(e.defended || 0), 0);
  function printBrief() {
    const fmt = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
    const rows = exposure.map((e) => `<tr><td><b>${e.employer}</b></td><td>${e.broker_name || "—"}</td><td class="n">${e.total_disputes}</td><td class="n">${e.open_disputes}</td><td class="n risk">${fmt(e.at_risk)}</td><td class="n good">${fmt(e.defended)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Avertyn — Employer IDR Exposure</title>
<style>body{font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#191712;margin:40px;background:#fffef9}
.hd{display:flex;align-items:center;gap:10px;border-bottom:2px solid #191712;padding-bottom:14px}
.lg{width:30px;height:30px;border-radius:9px;background:#191712;color:#fbf8f0;display:grid;place-items:center;font-weight:700;font-family:Georgia,serif}
h1{font-family:Georgia,serif;font-size:26px;margin:0}.sub{color:#6b665b;font-size:13px;margin:10px 0 22px}
.kpis{display:flex;gap:14px;margin-bottom:22px}.kpi{border:1px solid #e2ddd1;border-radius:12px;padding:14px 18px;flex:1}
.kpi .l{font-size:11px;color:#6b665b;text-transform:uppercase;letter-spacing:.05em}.kpi .v{font-size:24px;font-weight:700;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8a857a;border-bottom:1px solid #e2ddd1;padding:9px 10px}
td{padding:11px 10px;border-bottom:1px solid #efeade}td.n{text-align:right;font-variant-numeric:tabular-nums}.risk{color:#a8321f;font-weight:600}.good{color:#2e6b4c;font-weight:600}
.ft{margin-top:26px;font-size:11px;color:#8a857a}</style></head>
<body><div class="hd"><span class="lg">A</span><h1>Employer IDR Exposure</h1></div>
<div class="sub">Prepared by Avertyn · plan-side No Surprises Act IDR defense · ${new Date().toLocaleDateString()}</div>
<div class="kpis"><div class="kpi"><div class="l">Employers</div><div class="v">${exposure.length}</div></div>
<div class="kpi"><div class="l">Total at risk (open)</div><div class="v" style="color:#a8321f">${fmt(totalRisk)}</div></div>
<div class="kpi"><div class="l">Defended to date</div><div class="v" style="color:#2e6b4c">${fmt(totalDef)}</div></div></div>
<table><thead><tr><th>Employer</th><th>Broker</th><th class="n">Disputes</th><th class="n">Open</th><th class="n">At risk</th><th class="n">Defended</th></tr></thead><tbody>${rows}</tbody></table>
<div class="ft">Confidential · figures reflect current open IDR exposure and dollars defended to date.</div></body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 350);
  }
  return (
    <div>
      {embedded
        ? <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}><button className="mini" disabled={!exposure.length} onClick={printBrief}>Export broker brief →</button></div>
        : <div className="dh"><h1>Exposure</h1><span className="sub">What IDR is costing each plan sponsor — the view your brokers distribute</span>
          <button className="mini" style={{ marginLeft: "auto" }} disabled={!exposure.length} onClick={printBrief}>Export broker brief →</button></div>}
      <div className="cards" style={{ marginTop: embedded ? 4 : 14 }}>
        <Tile l="Employers" n={exposure.length} />
        <Tile l="Total at risk (open)" n={money(totalRisk)} />
        <Tile l="Defended to date" n={money(totalDef)} />
      </div>
      {exposure.length === 0 ? (
        <div className="empty"><div className="eh">No employers yet</div><div className="es">Add employers and disputes to see per-sponsor IDR exposure and defended dollars.</div></div>
      ) : (
        <div className="exgrid">
          {exposure.map((e) => (
            <div key={e.employer_id} className="excard">
              <div className="en">{e.employer}</div>
              <div className="eb">{e.broker_name ? "Broker · " + e.broker_name : "No broker on file"}</div>
              <div style={{ marginTop: 10 }}>
                <div className="exrow"><span>Total disputes</span><span className="v">{e.total_disputes}</span></div>
                <div className="exrow"><span>Open</span><span className="v">{e.open_disputes}</span></div>
                <div className="exrow"><span>At risk (open)</span><span className="v risk">{money(e.at_risk)}</span></div>
                <div className="exrow"><span>Default losses</span><span className="v">{e.default_losses}</span></div>
                <div className="exrow"><span>Defended</span><span className="v good">{money(e.defended)}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ dd, onRun, onDoc, onOpenNeg, onAction, onStageMoney, onView, onExplain, busy }) {
  const { d, find, qpa, docs, offers } = dd;
  const briefBest = (docs || []).reduce((acc, x) => { const r = DOC_STATUS_RANK[x.status] || 1; return r >= acc.r ? { r, s: x.status || "draft" } : acc; }, { r: 0, s: null });
  const hasOnp = (offers || []).some((o) => o.kind === "open_negotiation");
  const closed = d.workflow_state === "closed";
  const s = d.eligibility_score ?? 0;
  const gcol = s >= 80 ? "var(--sig)" : s >= 60 ? "var(--warn)" : "var(--ok)";
  const verdict = s >= 80 ? ["Challenge — likely ineligible", "red"] : s >= 60 ? ["Review eligibility", "amber"] : ["Defensible", "green"];
  return (
    <div>
      <div className="dh"><h1>#{d.external_ref}</h1>
        <span className="sub">{d.initiators?.name} · CPT {d.cpt_code} · {d.plans?.name} · {d.workflow_state}</span>
        {d.win_prob != null && (() => { const wp = Math.round(Number(d.win_prob) * 100); const tone = wp >= 60 ? "sage" : wp >= 40 ? "amber" : "red"; return <span className={"badge b-" + tone} style={{ marginLeft: 10 }} title="Modeled plan-prevail probability — open Explain for the full driver breakdown"><i className={"dot d-" + tone} />{wp}% win</span>; })()}
        {briefBest.s && <span className={"badge b-" + (DOC_STATUS_TONE[briefBest.s] || "grey")} style={{ marginLeft: 10 }} title="Furthest-along brief status on this case"><i className={"dot d-" + (DOC_STATUS_TONE[briefBest.s] || "grey")} />Brief: {DOC_STATUS_LABEL[briefBest.s] || "Draft"}</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="mini" onClick={onExplain}>Explain ⓘ</button>
          <a className="mini" href={`/dispute/${d.id}`}>Open IDR case →</a>
        </span></div>
      <div className="cards">
        <div className="box" style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div className="gauge" style={{ background: `conic-gradient(${gcol} ${s}%,#eeedea 0)` }}>
            <div className="v"><b style={{ color: gcol }}>{s}</b><span>Ineligible</span></div>
          </div>
          <div><span className={"badge b-" + verdict[1]}><i className={"dot d-" + verdict[1]} />{verdict[0]}</span>
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
          <Bar l="FAIR Health median" v={qpa.benchmark_fairhealth} max={d.demand_amount} c="var(--c-teal)" />
          <Bar l="Defensible ceiling" v={qpa.defensible_ceiling} max={d.demand_amount} c="var(--c-sage)" />
          {qpa.notes && <p className="muted" style={{ fontSize: 12 }}>{qpa.notes}</p>}
        </div></div>
      )}

      <div className="panel">
        <div className="ph">Offers &amp; negotiation
          <span className="act">
            <button className="btn btn-s" style={{ padding: "6px 11px" }} disabled={busy === "oneg" || hasOnp} onClick={onOpenNeg}>
              {busy === "oneg" ? "Sending…" : hasOnp ? "Open-negotiation sent" : "Send open-negotiation offer"}
            </button>
          </span>
        </div>
        <div className="pb">
          {(!offers || offers.length === 0) ? <p className="muted">No offers yet. Open a negotiation to settle at ~125% of QPA before any IDR fee — the cheapest win.</p> : offers.map((o) => (
            <div key={o.id} className="frow" style={{ alignItems: "center" }}>
              <span className={"badge b-" + (o.party === "plan" ? "ink" : "amber")}>{o.party}</span>
              <div style={{ flex: 1 }}><b className="mono">{money(o.amount)}</b><div className="sub">{o.kind?.replace(/_/g, " ")}{o.note ? " · " + o.note : ""}</div></div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="ph">Documents</div>
        <div className="pb">
          {(!docs || docs.length === 0) ? <p className="muted">No documents yet. Generate a challenge letter or position statement below.</p> : docs.map((doc) => (
            <div key={doc.id} className="frow" style={{ alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <b>{doc.title || doc.kind?.replace(/_/g, " ")}</b>
                <div className="sub">
                  {doc.esign_status === "signed" ? `Signed by ${doc.signed_by || "—"}` : (doc.esign_status || "draft")}
                  {" · "}{new Date(doc.created_at).toLocaleDateString()}
                </div>
              </div>
              <span className={"badge b-" + (DOC_STATUS_TONE[doc.status] || "grey")} title="Brief status">
                <i className={"dot d-" + (DOC_STATUS_TONE[doc.status] || "grey")} />{DOC_STATUS_LABEL[doc.status] || "Draft"}
              </span>
              <button className="mini" onClick={() => onView(doc)}>View</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        {s >= 80
          ? <button className="btn btn-a" disabled={busy === "doc"} onClick={onDoc}>{busy === "doc" ? "Generating…" : "Generate & sign challenge letter"}</button>
          : <button className="btn btn-a">Submit response</button>}
      </div>

      <div className="rlabel" style={{ marginTop: 18 }}>Case actions</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-s" disabled={closed || busy === "ca_submit_additional_info"} onClick={() => onAction("submit_additional_info", "Additional information within the 5-business-day window.")}>
          {busy === "ca_submit_additional_info" ? "Filing…" : "Submit additional info"}
        </button>
        <button className="btn btn-s" disabled={busy === "ca_escalate"} onClick={() => onAction("escalate", "Operator escalation for human review.")}>
          {busy === "ca_escalate" ? "Escalating…" : "Escalate"}
        </button>
        <button className="btn btn-s" disabled={closed || busy === "ca_withdraw"} onClick={() => onAction("withdraw", "Operator withdrew the dispute.")}>
          {busy === "ca_withdraw" ? "Withdrawing…" : "Withdraw"}
        </button>
        <button className="btn btn-s" disabled={busy === "ca_predict_outcome"} onClick={() => onAction("predict_outcome", "Consult the win-probability & optimal-offer model.")}>
          {busy === "ca_predict_outcome" ? "Scoring…" : "Predict outcome"}
        </button>
        <button className="btn btn-s" disabled={busy === "ca_generate_document"} onClick={() => onAction("generate_document", "Draft the position statement.")}>
          {busy === "ca_generate_document" ? "Drafting…" : "Position statement"}
        </button>
      </div>

      <div className="rlabel" style={{ marginTop: 16 }}>Money actions · dual-control</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-s" disabled={closed || busy === "stage_settle" || !d.qpa_amount}
          onClick={() => onStageMoney("settle", Number(d.qpa_amount), "Stage settlement at QPA for a second reviewer.")}>
          {busy === "stage_settle" ? "Staging…" : `Stage settlement ${money(d.qpa_amount)}`}
        </button>
        {d.disposition === "provider_win" && (
          <button className="btn btn-s" disabled={busy === "stage_schedule_payment"}
            onClick={() => onStageMoney("schedule_payment", null, "Stage award payment for a second reviewer.")}>
            {busy === "stage_schedule_payment" ? "Staging…" : "Stage payment"}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Money actions can't be executed directly — they stage for a different reviewer, who releases with step-up re-auth and amount confirmation.
      </p>
    </div>
  );
}

function Bar({ l, v, max, c, showref }) {
  const pctv = max ? Math.min(100, Math.round((Number(v) / Number(max)) * 100)) : 0;
  return (
    <div className="bar">
      <div className="bl"><b>{l}</b><span className="mono">{money(v)}</span></div>
      <div className="track"><div className="fill" style={{ width: pctv + "%", background: c }} />{showref && <div className="qref" style={{ left: pctv + "%" }} />}</div>
    </div>
  );
}

function NotifDrawer({ list, onClose, onOpen, onAllRead }) {
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="dhd">Notifications<span style={{ flex: 1 }} />
          <button className="mini" onClick={onAllRead}>Mark all read</button>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="body">
          {list.length === 0 ? <p className="muted" style={{ padding: 16 }}>No notifications.</p> : list.map((n) => (
            <div key={n.id} className={"nrow" + (n.read ? "" : " unread")} onClick={() => onOpen(n)} style={{ cursor: "pointer" }}>
              <i className={"dot d-" + (n.severity === "urgent" ? "red" : n.severity === "warn" ? "amber" : "green")} style={{ marginTop: 5 }} />
              <div style={{ flex: 1 }}>
                <div className="nt">{n.title}</div>
                {n.body && <div className="nb">{n.body}</div>}
                <div className="nm">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function MoneyReleaseModal({ q, onRelease, onClose }) {
  const [amt, setAmt] = useState("");
  const [ack, setAck] = useState(false);
  const ok = ack && amt !== "" && Number(amt) === Number(q.amount);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhd"><b>Release money action</b>
          <span className="badge b-red"><i className="dot d-red" />Dual-control</span>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="mbody">
          <p className="muted" style={{ marginTop: 0 }}>
            {q.action_type.replace(/_/g, " ")} · <b>{money(q.amount)}</b>. A money action needs a second reviewer, step-up re-auth, and the amount re-typed.
          </p>
          <div className="rlabel" style={{ margin: "10px 0 4px" }}>Re-type the amount</div>
          <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={String(q.amount)}
            style={{ width: "100%", padding: "11px 13px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit", fontSize: 13 }} />
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 12.5, color: "var(--mut)" }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
            I have re-authenticated (step-up) and approve this payment as a second reviewer.
          </label>
          <button className="btn btn-a" style={{ marginTop: 16, width: "100%" }} disabled={!ok} onClick={() => onRelease(Number(amt))}>
            Release {money(q.amount)}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocModal({ doc, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhd">
          <b>{doc.title || doc.kind?.replace(/_/g, " ")}</b>
          {doc.esign_status === "signed" && <span className="badge b-green"><i className="dot d-green" />Signed{doc.signed_by ? " · " + doc.signed_by : ""}</span>}
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="mbody">
          {doc.content ? <pre>{doc.content}</pre> : <p className="muted">This document has no inline content (stored as a file).</p>}
        </div>
      </div>
    </div>
  );
}
