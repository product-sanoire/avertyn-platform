"use client";
// Avertyn — Programs (/programs).
// Bucket 2 product modules on one surface: Payment Integrity, RBP Repricing &
// Open Negotiation, Workers' Comp & Auto Bill Review, and ERISA Fiduciary tooling.
// Reads are RLS/org-scoped; every number comes from the live engines
// (module_dashboard, list_review_cases, get_review_case, list_fiduciary_*).
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const MODULES = {
  payment_integrity: { key: "payment_integrity", type: "payment_integrity", label: "Payment Integrity", blurb: "DRG & clinical validation, NCCI/PTP, MUE" },
  rbp_repricing: { key: "rbp_repricing", type: "rbp_repricing", label: "RBP Repricing", blurb: "Reference-based pricing → defensible allowed amount" },
  wc_auto_bill_review: { key: "wc_auto_bill_review", type: null, label: "WC & Auto Bill Review", blurb: "State fee-schedule adjudication + ground rules" },
  erisa_fiduciary: { key: "erisa_fiduciary", type: "erisa", label: "ERISA Fiduciary", blurb: "Compliance & prudent-process documentation" },
};
const CAT_TABS = [
  ["all", "All bill review"],
  ["payment_integrity", "Payment integrity"],
  ["rbp_repricing", "RBP repricing"],
  ["wc_bill_review", "Workers' comp"],
  ["auto_bill_review", "Auto"],
];
const SEV_TONE = { high: "red", medium: "amber", low: "grey", info: "grey" };
const STATUS_TONE = { compliant: "green", gap: "red", in_progress: "amber", na: "grey" };
const pct = (n) => (n == null ? "—" : Math.round(Number(n)) + "%");

export default function ProgramsPage() {
  const [dash, setDash] = useState(null);
  const [cov, setCov] = useState(null);
  const [tab, setTab] = useState("all");
  const [cases, setCases] = useState([]);
  const [sel, setSel] = useState(null);      // {case, lines, adjustments}
  const [plans, setPlans] = useState([]);
  const [planSel, setPlanSel] = useState(null);
  const [assess, setAssess] = useState([]);
  const [err, setErr] = useState("");

  const loadDash = useCallback(async () => {
    const { data, error } = await supabase.rpc("module_dashboard");
    if (error) setErr(error.message); else setDash(data);
    const { data: c } = await supabase.rpc("ncci_mue_coverage");
    setCov(c || null);
  }, []);
  const loadCases = useCallback(async (t) => {
    const { data } = await supabase.rpc("list_review_cases", { p_type: t === "all" ? null : t });
    setCases(data || []);
  }, []);
  const loadPlans = useCallback(async () => {
    const { data } = await supabase.rpc("list_fiduciary_plans");
    setPlans(data || []);
    if ((data || []).length && !planSel) setPlanSel(data[0].plan_id);
  }, [planSel]);

  useEffect(() => { loadDash(); loadPlans(); }, [loadDash, loadPlans]);
  useEffect(() => { loadCases(tab); setSel(null); }, [tab, loadCases]);
  useEffect(() => {
    if (!planSel) return;
    supabase.rpc("list_fiduciary_assessments", { p_plan_id: planSel }).then(({ data }) => setAssess(data || []));
  }, [planSel]);

  async function openCase(id) {
    if (sel?.case?.id === id) { setSel(null); return; }
    const { data } = await supabase.rpc("get_review_case", { p_id: id });
    setSel(data || null);
  }

  const m = dash || {};
  const kpi = (code) => m[code] || {};
  const byCat = assess.reduce((a, x) => { (a[x.category] ||= []).push(x); return a; }, {});

  return (
    <div>
      <div className="topbar"><span className="logo">A</span><b>Avertyn</b>
        <span style={{ color: "#d3cccd", fontSize: 13 }}>· Programs</span></div>
      <div className="wrap" style={{ maxWidth: 1120, margin: "18px auto", padding: "0 22px" }}>
        <Link href="/" className="muted">← Command center</Link>
        <div className="dh" style={{ marginTop: 8 }}>
          <div>
            <h1>Programs</h1>
            <span className="sub">Beyond IDR defense — payment integrity, reference-based repricing, workers&rsquo; comp &amp; auto bill review, and ERISA fiduciary tooling. Every figure below is computed live by the engines.</span>
          </div>
        </div>
        {err && <div className="badge b-red" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}

        {/* ---- Module KPI cards ---- */}
        <div className="cards" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12, marginTop: 16 }}>
          <ModuleCard t={MODULES.payment_integrity} rows={[["Cases", kpi("payment_integrity").cases || 0], ["Billed", money(kpi("payment_integrity").billed)], ["Savings", money(kpi("payment_integrity").savings)]]}
            note={cov ? `Edits loaded: ${cov.ncci_pairs} NCCI · ${cov.mue_codes} MUE · ${cov.drg_rows} DRG${(cov.ncci_quarters && cov.ncci_quarters.length) ? " · " + cov.ncci_quarters.join("/") : ""}` : null} />
          <ModuleCard t={MODULES.rbp_repricing} rows={[["Cases", kpi("rbp_repricing").cases || 0], ["Savings", money(kpi("rbp_repricing").savings)], ["Offers pushed", kpi("rbp_repricing").offers || 0]]} />
          <ModuleCard t={MODULES.wc_auto_bill_review} rows={[["WC / Auto", `${kpi("wc_auto_bill_review").wc || 0} / ${kpi("wc_auto_bill_review").auto || 0}`], ["Billed", money(kpi("wc_auto_bill_review").billed)], ["Savings", money(kpi("wc_auto_bill_review").savings)]]} />
          <ModuleCard t={MODULES.erisa_fiduciary} rows={[["Plans", kpi("erisa_fiduciary").plans_assessed || 0], ["Compliance", pct(kpi("erisa_fiduciary").avg_score)], ["Open gaps", kpi("erisa_fiduciary").open_gaps || 0]]} />
        </div>

        <RbpRunner onDone={() => { loadDash(); loadCases(tab); }} onErr={setErr} />

        <EditsImporter cov={cov} onDone={loadDash} />

        {/* ---- Bill-review case queue ---- */}
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="ph">Bill review
            <span className="act" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {CAT_TABS.map(([k, lbl]) => (
                <button key={k} className={"mini" + (tab === k ? " on" : "")} onClick={() => setTab(k)}
                  style={tab === k ? { background: "var(--ink,#1a1a1a)", color: "#fff" } : {}}>{lbl}</button>
              ))}
            </span>
          </div>
          <div className="pb" style={{ paddingTop: 6 }}>
            {cases.length === 0 && <div className="muted" style={{ padding: "12px 0", fontSize: 13 }}>No cases in this view yet.</div>}
            {cases.map((c) => (
              <div key={c.id}>
                <div className="clause-row" style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }} onClick={() => openCase(c.id)}>
                  <div style={{ minWidth: 0 }}>
                    <b>{c.provider_name || "—"}</b>
                    <span className="code-in muted" style={{ marginLeft: 8, fontSize: 11 }}>{c.review_type}{c.jurisdiction ? " · " + c.jurisdiction : ""}</span>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{c.determination}</div>
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span style={{ fontFamily: "var(--num,monospace)" }}>{money(c.billed_total)} → <b>{money(c.allowed_total)}</b></span>
                    <div><span className="badge b-green" style={{ fontSize: 11 }}><i className="dot d-green" />save {money(c.savings)} · {pct(c.savings_pct)}</span></div>
                  </div>
                </div>
                {sel?.case?.id === c.id && <CaseDetail sel={sel} />}
              </div>
            ))}
          </div>
        </div>

        {/* ---- ERISA fiduciary scorecard ---- */}
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="ph">ERISA fiduciary
            <span className="act" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {plans.map((p) => (
                <button key={p.plan_id} className={"mini" + (planSel === p.plan_id ? " on" : "")} onClick={() => setPlanSel(p.plan_id)}
                  style={planSel === p.plan_id ? { background: "var(--ink,#1a1a1a)", color: "#fff" } : {}}>
                  {p.plan_name} · {pct(p.score_pct)}
                </button>
              ))}
            </span>
          </div>
          <div className="pb" style={{ paddingTop: 8 }}>
            {assess.length === 0 && <div className="muted" style={{ fontSize: 13, padding: "10px 0" }}>Select a plan to see its fiduciary posture.</div>}
            {Object.keys(byCat).sort().map((cat) => (
              <div key={cat} style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{cat.replace(/_/g, " ")}</div>
                {byCat[cat].map((a) => (
                  <div key={a.requirement_code} className="ver-row" style={{ alignItems: "baseline" }}>
                    <span className={"badge b-" + (STATUS_TONE[a.status] || "grey")}><i className={"dot d-" + (STATUS_TONE[a.status] || "grey")} />{a.status.replace("_", " ")}</span>
                    <span style={{ marginLeft: 8 }}><b>{a.title}</b> <span className="code-in muted" style={{ fontSize: 10 }}>{a.authority}</span></span>
                    <span style={{ flex: 1 }} />
                    <span className="muted" style={{ fontSize: 11 }}>{a.evidence || a.owner || ""}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModuleCard({ t, rows, note }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <div className="pb" style={{ padding: 14 }}>
        <b>{t.label}</b>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2, marginBottom: 8 }}>{t.blurb}</div>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
            <span className="muted">{k}</span><b style={{ fontFamily: "var(--num,monospace)" }}>{v}</b>
          </div>
        ))}
        {note && <div className="muted" style={{ fontSize: 10.5, marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--hair,#eee)" }}>{note}</div>}
      </div>
    </div>
  );
}

function CaseDetail({ sel }) {
  const caseId = sel?.case?.id;
  const lines = sel.lines || [], adj = sel.adjustments || [];
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { title, html }
  const [cErr, setCErr] = useState("");

  const loadDocs = useCallback(async () => {
    if (!caseId) return;
    const { data } = await supabase.rpc("list_review_documents", { p_case: caseId });
    setDocs(data || []);
  }, [caseId]);
  useEffect(() => { loadDocs(); }, [loadDocs]);

  async function generate() {
    setBusy(true); setCErr("");
    try {
      const { data, error } = await supabase.rpc("save_review_determination", { p_case: caseId });
      if (error) throw error;
      if (!data?.ok) { setCErr(data?.reason || "Could not generate the letter."); setBusy(false); return; }
      setPreview({ title: data.title, html: data.html });
      await loadDocs();
    } catch (e) { setCErr(e.message); }
    setBusy(false);
  }
  async function viewDoc(id) {
    setCErr("");
    const { data, error } = await supabase.from("review_documents").select("title, content").eq("id", id).single();
    if (error) { setCErr(error.message); return; }
    setPreview({ title: data.title, html: data.content || "" });
  }
  async function signDoc(id) {
    setCErr("");
    try {
      const { data, error } = await supabase.rpc("sign_review_document", { p_id: id });
      if (error) throw error;
      if (!data?.ok) { setCErr(data?.reason === "already_signed" ? "Already signed." : (data?.reason || "Could not sign.")); return; }
      await loadDocs();
    } catch (e) { setCErr(e.message); }
  }
  function downloadPreview() {
    if (!preview) return;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${preview.title}</title></head><body>${preview.html}</body></html>`;
    const blob = new Blob([html], { type: "text/html" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = (preview.title || "determination") + ".html"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  return (
    <div style={{ background: "var(--paper2,#faf8f6)", border: "1px solid var(--hair,#eee)", borderRadius: 8, padding: 12, margin: "4px 0 12px" }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>Lines</div>
      {lines.map((l) => (
        <div key={l.id} className="ver-row" style={{ fontSize: 12.5 }}>
          <span className="code-in">{l.code_system} {l.code}</span>
          <span style={{ marginLeft: 8 }}>{l.description || ""}{Number(l.units) > 1 ? ` ×${l.units}` : ""}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--num,monospace)" }}>{money(l.billed)} → <b>{money(l.allowed)}</b></span>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", margin: "10px 0 6px" }}>Adjustments &amp; findings</div>
      {adj.map((a) => (
        <div key={a.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--hair,#eee)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span><span className={"badge b-" + (SEV_TONE[a.severity] || "grey")}><i className={"dot d-" + (SEV_TONE[a.severity] || "grey")} />{a.rule_code}</span>
              <span style={{ marginLeft: 8, fontSize: 12.5 }}>{a.description}</span></span>
            <b style={{ fontFamily: "var(--num,monospace)", whiteSpace: "nowrap" }}>−{money(a.amount)}</b>
          </div>
          {a.authority && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{a.authority}{a.confidence != null ? ` · confidence ${Math.round(a.confidence * 100)}%` : ""}</div>}
        </div>
      ))}

      {/* Determination letter — render from the template engine and persist a versioned, hash-sealed copy */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hair,#eee)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>Determination letter</span>
        <button className="btn btn-a" style={{ padding: "6px 12px", fontSize: 12 }} disabled={busy} onClick={generate}>{busy ? "Generating…" : "Generate & save"}</button>
        {docs.length > 0 && <span className="muted" style={{ fontSize: 11 }}>{docs.length} saved version{docs.length === 1 ? "" : "s"}</span>}
      </div>
      {cErr && <div className="badge b-red" style={{ marginTop: 8, display: "inline-flex", gap: 8 }}><i className="dot d-red" />{cErr}</div>}
      {docs.map((d) => (
        <div key={d.id} className="ver-row" style={{ fontSize: 12, alignItems: "baseline" }}>
          <span className={"badge b-" + (d.esign_status === "signed" ? "green" : "grey")}><i className={"dot d-" + (d.esign_status === "signed" ? "green" : "grey")} />{d.esign_status}</span>
          <span style={{ marginLeft: 8 }}>{d.title}</span>
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 11, fontFamily: "var(--num,monospace)" }} title={"sha256 " + d.sha256}>{(d.sha256 || "").slice(0, 8)}</span>
          {d.esign_status === "signed" && d.signed_by && <span className="muted" style={{ fontSize: 11, marginLeft: 8 }} title={d.signed_at ? new Date(d.signed_at).toLocaleString() : ""}>✍ {d.signed_by}</span>}
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{new Date(d.created_at).toLocaleDateString()}</span>
          <button className="mini" style={{ marginLeft: 8 }} onClick={() => viewDoc(d.id)}>View</button>
          {d.esign_status !== "signed" && <button className="mini" style={{ marginLeft: 6 }} onClick={() => signDoc(d.id)}>Sign</button>}
        </div>
      ))}
      {preview && (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="ph" style={{ fontSize: 13 }}>{preview.title}
            <span className="act"><button className="mini" onClick={downloadPreview}>Download .html</button><button className="mini" style={{ marginLeft: 6 }} onClick={() => setPreview(null)}>Close</button></span>
          </div>
          <iframe title="determination-preview" srcDoc={preview.html} style={{ width: "100%", height: 420, border: 0, background: "#fff", borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

// Run reference-based-pricing on an open dispute: reprices its CPT to Nx Medicare via the org's RBP
// schedule, writes a repricer determination + a bill-review case (which then shows in the queue above),
// and can optionally push an RBP-supported plan offer into open negotiation.
function RbpRunner({ onDone, onErr }) {
  const [open, setOpen] = useState(false);
  const [disputes, setDisputes] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [disp, setDisp] = useState("");
  const [sched, setSched] = useState("");
  const [makeOffer, setMakeOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    supabase.from("disputes").select("id, external_ref, cpt_code, billed_amount").eq("disposition", "open").order("created_at", { ascending: false }).limit(100).then(({ data }) => setDisputes(data || []));
    supabase.from("rbp_schedules").select("id, name").eq("active", true).then(({ data }) => setSchedules(data || []));
  }, [open]);

  async function run() {
    if (!disp) return;
    setBusy(true); setRes(null); setErr("");
    try {
      const { data, error } = await supabase.rpc("run_rbp_repricing", { p_dispute_id: disp, p_schedule_id: sched || null, p_make_offer: makeOffer });
      if (error) throw error;
      setRes(data);
      if (onDone) await onDone();
    } catch (e) { setErr(e.message || String(e)); if (onErr) onErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="ph">RBP repricing
        <span className="act" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>reference-based price → defensible allowed amount</span>
          <button className="btn btn-s" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Run repricing"}</button>
        </span>
      </div>
      {open && (
        <div className="pb" style={{ paddingTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Pick an open dispute; Avertyn reprices its CPT against Medicare via your RBP schedule and opens a bill-review
            case (shown in the queue above). CPT must have a Medicare reference rate loaded.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select className="btn btn-s" value={disp} onChange={(e) => setDisp(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Choose open dispute…</option>
              {disputes.map((d) => <option key={d.id} value={d.id}>#{d.external_ref} · {d.cpt_code || "—"} · {money(d.billed_amount)}</option>)}
            </select>
            <select className="btn btn-s" value={sched} onChange={(e) => setSched(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">Org default schedule</option>
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--mut,#666)" }}>
              <input type="checkbox" checked={makeOffer} onChange={(e) => setMakeOffer(e.target.checked)} />push open-negotiation offer
            </label>
            <button className="btn btn-a" disabled={busy || !disp} onClick={run}>{busy ? "Repricing…" : "Reprice"}</button>
          </div>
          {err && <div className="badge b-red" style={{ marginTop: 10, display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}
          {res && !err && (
            <div className="badge b-green" style={{ marginTop: 10, display: "inline-flex", gap: 8, alignItems: "center" }}>
              <i className="dot d-green" />Repriced to {money(res.repriced_amount)} (base {money(res.base_rate)}) · billed {money(res.billed)} · save {money(res.savings)}{res.offer ? " · offer pushed" : ""} — opened in bill review
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Upload a CMS NCCI PTP / MUE quarterly CSV straight to the ingest-cms-edits
// edge function. supabase.functions.invoke attaches the signed-in user's JWT,
// so this only succeeds for an admin (the RPC enforces _require_admin).
function EditsImporter({ cov, onDone }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("ncci");
  const [quarter, setQuarter] = useState((cov && cov.ncci_quarters && cov.ncci_quarters[0]) || "2026Q3");
  const [svc, setSvc] = useState("practitioner");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");

  async function run() {
    setErr(""); setRes(null);
    if (!file) { setErr("Choose a CSV file first."); return; }
    if (!quarter.trim()) { setErr("Enter a quarter, e.g. 2026Q3."); return; }
    setBusy(true);
    try {
      const csv = await file.text();
      const body = { kind, quarter: quarter.trim(), csv, source_url: `upload:${file.name}` };
      if (kind === "mue") body.service_type = svc;
      const { data, error } = await supabase.functions.invoke("ingest-cms-edits", { body });
      if (error) throw error;
      setRes(data);
      if (data && data.ok === false && Array.isArray(data.errors)) setErr(data.errors.join(" · "));
      if (onDone) await onDone();
    } catch (e) {
      setErr((e && e.message) || String(e) + " — you must be signed in as an admin to load edits.");
    }
    setBusy(false);
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="ph">Reference data
        <span className="act" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {cov ? `${cov.ncci_pairs} NCCI · ${cov.mue_codes} MUE · ${cov.drg_rows} DRG${(cov.ncci_quarters && cov.ncci_quarters.length) ? " · " + cov.ncci_quarters.join("/") : ""}` : "…"}
          </span>
          <button className="btn btn-s" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Import CMS edits"}</button>
        </span>
      </div>
      {open && (
        <div className="pb" style={{ paddingTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Upload a CMS NCCI PTP or MUE quarterly file as CSV (unzip the CMS download and export the sheet to CSV first).
            Columns are auto-detected; upserts are idempotent per quarter. Admin only.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select className="btn btn-s" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="ncci">NCCI PTP edits</option>
              <option value="mue">MUE values</option>
            </select>
            <input className="btn btn-s" style={{ width: 110 }} value={quarter} onChange={(e) => setQuarter(e.target.value)} placeholder="2026Q3" />
            {kind === "mue" && (
              <select className="btn btn-s" value={svc} onChange={(e) => setSvc(e.target.value)}>
                <option value="practitioner">Practitioner</option>
                <option value="hospital">Hospital / outpatient</option>
                <option value="dme">DME / supplier</option>
              </select>
            )}
            <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files && e.target.files[0])} style={{ fontSize: 12 }} />
            <button className="btn btn-a" disabled={busy} onClick={run}>{busy ? "Loading…" : "Load"}</button>
          </div>
          {err && <div className="badge b-red" style={{ marginTop: 10, display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}
          {res && !err && (
            <div className="badge b-green" style={{ marginTop: 10, display: "inline-flex", gap: 8 }}>
              <i className="dot d-green" />Loaded {res.upserted} of {res.total_rows} rows ({res.batches} batch{res.batches === 1 ? "" : "es"}) into {res.kind.toUpperCase()} · {res.quarter}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
