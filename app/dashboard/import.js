"use client";
// Avertyn — Import hub. Bulk-load your data: disputes (CSV), claims (EDI 837),
// reference data (plans/employers/initiators), and clearinghouse connections.
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const MODES = [["disputes", "Disputes · CSV"], ["edi", "Claims · EDI 837"], ["reference", "Org setup"], ["clearinghouse", "Clearinghouse"]];
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
  const [mode, setMode] = useState("disputes");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

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

  const ta = { width: "100%", minHeight: 190, padding: "13px 15px", border: "0", borderRadius: 12, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", font: "inherit", fontFamily: "var(--num)", fontSize: 12, lineHeight: 1.6, resize: "vertical" };
  const inp = { width: "100%", padding: "11px 13px", border: 0, borderRadius: 10, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", font: "inherit", fontSize: 13 };

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
