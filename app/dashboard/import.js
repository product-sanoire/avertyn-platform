"use client";
// Avertyn — Import hub. Bulk-load your data: disputes (CSV), claims (EDI 837),
// reference data (plans/employers/initiators), and clearinghouse connections.
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const MODES = [["notice", "Notice · AI scan"], ["disputes", "Disputes · CSV"], ["edi", "Claims · EDI 837"], ["reference", "Org setup"], ["clearinghouse", "Clearinghouse"]];
const DISPUTE_COLS = ["external_ref", "initiator", "plan", "cpt_code", "service_date", "billed_amount", "demand_amount", "qpa_amount", "workflow_state", "carc", "rarc"];
const SAMPLE = `external_ref,initiator,plan,cpt_code,service_date,billed_amount,demand_amount,qpa_amount,workflow_state
IDR-30001,HaloMD,Acme Mfg PPO,70553,2026-05-12,7200,5880,1010,eligibility_review
IDR-30002,TeamHealth,Northwind HDHP,99285,2026-05-14,5100,4120,1600,qpa_defense
IDR-30003,Radiology Partners,Acme Mfg PPO,74177,2026-05-18,4300,3700,1000,intake`;

function parseCSV(text) {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (l) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === ",") { out.push(cur); cur = ""; } else if (c === '"') q = true; else cur += c; }
    }
    out.push(cur); return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows = lines.slice(1).map((l) => { const cells = parseLine(l); const o = {}; headers.forEach((h, i) => (o[h] = (cells[i] || "").trim())); return o; });
  return { headers, rows };
}

export function ImportHub({ orgId, onErr, onClose, onDone }) {
  const [mode, setMode] = useState("notice");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  // notice AI scan → case
  const [nBusy, setNBusy] = useState(false);
  const [nx, setNx] = useState(null);   // reviewed extraction payload

  // disputes CSV
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState(null);
  // edi
  const [plans, setPlans] = useState([]);
  const [plan, setPlan] = useState("");
  const [edi, setEdi] = useState("");
  // reference
  const [refKind, setRefKind] = useState("plans");
  const [refCsv, setRefCsv] = useState("");
  // clearinghouse
  const [chProvider, setChProvider] = useState("Availity");
  const [chAccount, setChAccount] = useState("");

  useEffect(() => {
    supabase.from("plans").select("id, name").then(({ data }) => setPlans(data || []));
  }, []);

  const readFile = (e, setter) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => setter(String(r.result || "")); r.readAsText(f);
  };

  async function run(fn) {
    setBusy(true); setResult(null);
    try { const r = await fn(); setResult(r); if (onDone) onDone(); }
    catch (e) { onErr(e.message); }
    setBusy(false);
  }
  const importDisputes = () => run(async () => {
    const { rows } = parseCSV(csv);
    if (!rows.length) throw new Error("No rows found. Paste CSV with a header row.");
    const { data, error } = await supabase.rpc("import_disputes", { p_rows: rows });
    if (error) throw error;
    return { kind: "disputes", ...data };
  });
  const ingestEdi = () => run(async () => {
    if (!edi.trim()) throw new Error("Paste a raw X12 837 payload.");
    const { data, error } = await supabase.rpc("ingest_x12_837", { p_org: orgId, p_plan: plan || null, p_raw: edi });
    if (error) throw error;
    return { kind: "edi", ...(typeof data === "object" ? data : { result: data }) };
  });
  const importRef = () => run(async () => {
    const { rows } = parseCSV(refCsv);
    if (!rows.length) throw new Error("No rows found. Paste CSV with a header row.");
    const { data, error } = await supabase.rpc("import_reference", { p_kind: refKind, p_rows: rows });
    if (error) throw error;
    return { kind: "reference", ...data };
  });
  const connectCh = () => run(async () => {
    const { data, error } = await supabase.rpc("clearinghouse_connect", { p_provider: chProvider, p_external_account: chAccount, p_config: { requested_at: new Date().toISOString() } });
    if (error) throw error;
    return { kind: "clearinghouse", provider: data?.provider, status: data?.status };
  });

  // ---- notice → AI scan → reviewed case ----
  function scanNoticeFile(e) {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      const b64 = String(r.result || "").split(",")[1] || "";
      setNBusy(true); setResult(null);
      try {
        const { data, error } = await supabase.functions.invoke("intake-notice", { body: { file_base64: b64, mime: f.type || "application/pdf" } });
        if (error) throw error;
        if (!data?.ok) { onErr(data?.reason || "Could not read the notice."); setNBusy(false); return; }
        const ex = data.extracted || {};
        setNx({
          notice_type: ex.notice_type === "idr_initiation" ? "idr_initiation" : "open_negotiation",
          internal_ref: "", claim_number: ex.claim_number || "", dispute_number: ex.dispute_number || "",
          plan: ex.plan || "", initiator: ex.initiator || "", patient_ref: ex.patient_ref || "",
          cpt_code: ex.cpt_code || "", service_category: ex.service_category || "",
          service_date: ex.service_date || "", demand_amount: ex.demand_amount ?? "", qpa_amount: ex.qpa_amount ?? "",
          billed_amount: ex.billed_amount ?? "", respond_by: ex.respond_by || "",
          claims: Array.isArray(ex.claims) ? ex.claims.map((c) => ({ claim_number: c.claim_number || "", cpt: c.cpt || "", service_date: c.service_date || "", billed: c.billed ?? "", patient_ref: c.patient_ref || "" })) : [],
          _name: f.name,
        });
      } catch (e2) { onErr(e2.message); }
      setNBusy(false);
    };
    r.readAsDataURL(f);
  }
  const setN = (k, v) => setNx((p) => ({ ...p, [k]: v }));
  const setNClaim = (i, k, v) => setNx((p) => ({ ...p, claims: p.claims.map((c, j) => j === i ? { ...c, [k]: v } : c) }));
  const addNClaim = () => setNx((p) => ({ ...p, claims: [...(p.claims || []), { claim_number: "", cpt: "", service_date: "", billed: "", patient_ref: "" }] }));
  const rmNClaim = (i) => setNx((p) => ({ ...p, claims: p.claims.filter((_, j) => j !== i) }));
  async function createFromNotice() {
    if (!nx) return;
    setNBusy(true);
    try {
      const { data, error } = await supabase.rpc("create_case_from_notice", { p_payload: nx });
      if (error) throw error;
      if (!data?.ok) { onErr(data?.reason || "Could not create the case."); setNBusy(false); return; }
      window.location.assign(`/dispute/${data.id}`);
    } catch (e) { onErr(e.message); setNBusy(false); }
  }

  const ta = { width: "100%", minHeight: 190, padding: "13px 15px", border: "0", borderRadius: 12, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", font: "inherit", fontFamily: "var(--num)", fontSize: 12, lineHeight: 1.6, resize: "vertical" };
  const inp = { width: "100%", padding: "11px 13px", border: 0, borderRadius: 10, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", font: "inherit", fontSize: 13 };
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 };
  const L = ({ t, children }) => <label style={{ display: "block" }}><span className="rlabel" style={{ fontSize: 11, display: "block", marginBottom: 3 }}>{t}</span>{children}</label>;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 860 }} onClick={(e) => e.stopPropagation()}>
        <div className="mhd">
          <b>Import data</b>
          <span className="muted" style={{ fontSize: 12 }}>bulk-load your platform</span>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="mbody">
          <div className="seg" style={{ marginBottom: 18 }}>
            {MODES.map(([k, l]) => <button key={k} className={mode === k ? "on" : ""} onClick={() => { setMode(k); setResult(null); }}>{l}</button>)}
          </div>

          {mode === "notice" && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Upload an <b>open-negotiation notice</b> or a <b>notice of IDR initiation</b> (PDF or image). Claude reads it, pulls the legal identifiers and claim line(s), and opens a case after your review. The legal number becomes the case&apos;s primary identifier.</p>
              <label className="btn btn-a" style={{ cursor: "pointer", padding: "9px 15px", display: "inline-block" }}>
                {nBusy ? "Reading notice…" : (nx ? "Scan a different notice" : "⤒ Upload notice")}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" style={{ display: "none" }} disabled={nBusy} onChange={scanNoticeFile} />
              </label>
              {nx && (
                <div className="panel" style={{ marginTop: 14 }}>
                  <div className="ph" style={{ fontSize: 14 }}>Review — {nx._name}<span className="act"><span className="muted" style={{ fontSize: 11 }}>edit anything before creating</span></span></div>
                  <div className="pb" style={{ paddingTop: 12 }}>
                    <div style={grid}>
                      <L t="Notice type"><select className="dsel" style={inp} value={nx.notice_type} onChange={(e) => setN("notice_type", e.target.value)}><option value="open_negotiation">Open negotiation</option><option value="idr_initiation">IDR initiation</option></select></L>
                      {nx.notice_type === "idr_initiation"
                        ? <L t="Dispute number (legal ID)"><input style={inp} value={nx.dispute_number} onChange={(e) => setN("dispute_number", e.target.value)} placeholder="Federal IDR dispute no." /></L>
                        : <L t="Claim number (legal ID)"><input style={inp} value={nx.claim_number} onChange={(e) => setN("claim_number", e.target.value)} placeholder="claim / control no." /></L>}
                      <L t="Internal case no. (optional)"><input style={inp} value={nx.internal_ref} onChange={(e) => setN("internal_ref", e.target.value)} placeholder="your own ref" /></L>
                      <L t="Plan"><input style={inp} value={nx.plan} onChange={(e) => setN("plan", e.target.value)} /></L>
                      <L t="Initiator"><input style={inp} value={nx.initiator} onChange={(e) => setN("initiator", e.target.value)} /></L>
                      <L t="Patient ref (de-identified)"><input style={inp} value={nx.patient_ref} onChange={(e) => setN("patient_ref", e.target.value)} /></L>
                      <L t="CPT"><input style={inp} value={nx.cpt_code} onChange={(e) => setN("cpt_code", e.target.value)} /></L>
                      <L t="Service date"><input type="date" style={inp} value={nx.service_date || ""} onChange={(e) => setN("service_date", e.target.value)} /></L>
                      <L t="Demand $"><input style={inp} value={nx.demand_amount} onChange={(e) => setN("demand_amount", e.target.value)} /></L>
                      <L t="QPA $"><input style={inp} value={nx.qpa_amount} onChange={(e) => setN("qpa_amount", e.target.value)} /></L>
                    </div>
                    <div className="rlabel" style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Claims{nx.notice_type === "idr_initiation" ? " batched in this dispute" : ""}</span>
                      <button className="mini" onClick={addNClaim}>+ Add claim</button>
                    </div>
                    {(nx.claims || []).length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No separate claim lines — the case carries one lead claim from the fields above.</p> :
                      nx.claims.map((c, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "6px 0" }}>
                          <input style={{ ...inp, width: 150 }} placeholder="Claim #" value={c.claim_number} onChange={(e) => setNClaim(i, "claim_number", e.target.value)} />
                          <input style={{ ...inp, width: 80 }} placeholder="CPT" value={c.cpt} onChange={(e) => setNClaim(i, "cpt", e.target.value)} />
                          <input type="date" style={{ ...inp, width: 150 }} value={c.service_date || ""} onChange={(e) => setNClaim(i, "service_date", e.target.value)} />
                          <input style={{ ...inp, width: 110 }} placeholder="Billed $" value={c.billed} onChange={(e) => setNClaim(i, "billed", e.target.value)} />
                          <button className="mini" onClick={() => rmNClaim(i)}>✕</button>
                        </div>
                      ))}
                    <button className="btn btn-a" style={{ marginTop: 14 }} disabled={nBusy} onClick={createFromNotice}>{nBusy ? "Creating…" : "Create case →"}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === "disputes" && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Paste or upload a CSV. Header row expected — recognized columns: <span className="mono" style={{ fontSize: 11 }}>{DISPUTE_COLS.join(", ")}</span>. Each row creates a dispute and runs the eligibility engine.</p>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button className="mini" onClick={() => { setCsv(SAMPLE); setPreview(parseCSV(SAMPLE)); }}>Load sample</button>
                <label className="mini" style={{ cursor: "pointer" }}>Upload .csv<input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => readFile(e, (t) => { setCsv(t); setPreview(parseCSV(t)); })} /></label>
                <button className="mini" onClick={() => setPreview(parseCSV(csv))} disabled={!csv.trim()}>Preview</button>
              </div>
              <textarea style={ta} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE} />
              {preview && preview.rows.length > 0 && (
                <div className="panel" style={{ marginTop: 12 }}>
                  <div className="ph" style={{ fontSize: 14 }}>{preview.rows.length} rows detected<span className="act muted" style={{ fontSize: 11 }}>{preview.headers.join(" · ")}</span></div>
                  <div style={{ overflow: "auto", maxHeight: 190 }}>
                    <table><thead><tr>{preview.headers.slice(0, 7).map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
                      {preview.rows.slice(0, 5).map((r, i) => <tr key={i}>{preview.headers.slice(0, 7).map((h) => <td key={h} className="mono" style={{ fontSize: 11 }}>{r[h]}</td>)}</tr>)}
                    </tbody></table>
                  </div>
                </div>
              )}
              <button className="btn btn-a" style={{ marginTop: 14 }} disabled={busy || !csv.trim()} onClick={importDisputes}>{busy ? "Importing…" : "Import disputes"}</button>
            </div>
          )}

          {mode === "edi" && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Paste a raw X12 <b>837P</b> payload. It's parsed into claims and auto-creates disputes (NPI, TIN, CPT, DOS, billed vs. paid).</p>
              <div style={{ marginBottom: 10 }}>
                <label className="rlabel" style={{ display: "block" }}>Attach to plan (optional)</label>
                <select className="dsel" value={plan} onChange={(e) => setPlan(e.target.value)} style={{ padding: "9px 11px", minWidth: 240 }}>
                  <option value="">— auto / none —</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <label className="mini" style={{ cursor: "pointer", marginLeft: 8 }}>Upload file<input type="file" style={{ display: "none" }} onChange={(e) => readFile(e, setEdi)} /></label>
              </div>
              <textarea style={ta} value={edi} onChange={(e) => setEdi(e.target.value)} placeholder="ISA*00* … *GS*HC* … *ST*837* …" />
              <button className="btn btn-a" style={{ marginTop: 14 }} disabled={busy || !edi.trim()} onClick={ingestEdi}>{busy ? "Ingesting…" : "Ingest 837"}</button>
            </div>
          )}

          {mode === "reference" && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Bulk-add the entities disputes attach to. Pick a type and paste a CSV.</p>
              <div className="seg" style={{ marginBottom: 12 }}>
                {[["plans", "Plans"], ["employers", "Employers"], ["initiators", "Initiators"]].map(([k, l]) => <button key={k} className={refKind === k ? "on" : ""} onClick={() => setRefKind(k)}>{l}</button>)}
              </div>
              <p className="muted" style={{ fontSize: 12 }}>Columns: {refKind === "plans" ? <span className="mono">name, plan_type</span> : refKind === "employers" ? <span className="mono">name, broker_name</span> : <span className="mono">name, kind, pe_backed</span>}</p>
              <textarea style={ta} value={refCsv} onChange={(e) => setRefCsv(e.target.value)} placeholder={refKind === "plans" ? "name,plan_type\nAcme Mfg PPO,self_funded_erisa" : refKind === "employers" ? "name,broker_name\nAcme Manufacturing,Marsh McLennan" : "name,kind,pe_backed\nHaloMD,billing_agent,true"} />
              <button className="btn btn-a" style={{ marginTop: 14 }} disabled={busy || !refCsv.trim()} onClick={importRef}>{busy ? "Importing…" : `Import ${refKind}`}</button>
            </div>
          )}

          {mode === "clearinghouse" && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>Register a clearinghouse so claims flow in continuously. Saves a pending connection; the live feed activates once access is provisioned (EDI + credentials).</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 520 }}>
                <div><label className="rlabel" style={{ display: "block" }}>Provider</label>
                  <select className="dsel" value={chProvider} onChange={(e) => setChProvider(e.target.value)} style={{ padding: "10px 12px", width: "100%" }}>
                    {["Availity", "Waystar", "Optum", "Office Ally", "Change Healthcare"].map((p) => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div><label className="rlabel" style={{ display: "block" }}>Account / submitter ID</label>
                  <input style={inp} value={chAccount} onChange={(e) => setChAccount(e.target.value)} placeholder="e.g. AV-1029384" /></div>
              </div>
              <button className="btn btn-a" style={{ marginTop: 16 }} disabled={busy} onClick={connectCh}>{busy ? "Saving…" : "Save connection"}</button>
            </div>
          )}

          {result && (
            <div className="panel" style={{ marginTop: 16, borderRadius: 14 }}>
              <div className="pb" style={{ paddingTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {result.kind === "disputes" && <><span className="badge b-green"><i className="dot d-green" />{result.created} disputes created &amp; scored</span>{result.failed > 0 && <span className="badge b-red"><i className="dot d-red" />{result.failed} failed</span>}</>}
                {result.kind === "reference" && <span className="badge b-green"><i className="dot d-green" />{result.imported} {result.kind_label || result.kind} imported</span>}
                {result.kind === "edi" && <span className="badge b-green"><i className="dot d-green" />837 ingested{result.disputes ? ` · ${result.disputes} disputes` : ""}</span>}
                {result.kind === "clearinghouse" && <span className="badge b-amber"><i className="dot d-amber" />{result.provider} connection saved · {result.status}</span>}
                {Array.isArray(result.errors) && result.errors.length > 0 && <span className="muted" style={{ fontSize: 11 }}>{result.errors.slice(0, 2).map((e) => e.error).join("; ")}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
