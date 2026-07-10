"use client";
// Avertyn — Document Composer.
// "Automatic template creation for argument documents": pick a template, answer a
// few questions (most fields auto-fill from the case), watch a live preview build,
// generate, then edit it like a doc, sign it (tamper-evident seal), and export.
// Backed entirely by the template-engine RPCs (list_doc_templates, get_doc_template,
// preview_document, generate_document_from_template, save_document_content,
// list_documents, get_document, sign_document).
import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "../../../lib/supabaseClient";

const KIND_LABEL = {
  challenge_letter: "Eligibility challenge",
  position_statement: "Position statement",
  open_negotiation: "Open-negotiation notice",
  offer_letter: "Settlement offer",
  idr_initiation_response: "Response to IDR initiation",
  idre_conflict_objection: "IDRE conflict objection",
  extension_request: "Extension request",
  idre_info_response: "IDRE information response",
  batching_objection: "Batching objection",
  qpa_disclosure: "QPA disclosure",
  award_remittance: "Award remittance",
  cms_complaint_response: "Complaint response",
  cost_share_correction: "Cost-share correction",
  member_protection_notice: "Member protection notice",
  state_redirection: "State-process redirection",
  comprehensive_brief: "Comprehensive IDR brief",
  eligibility_brief: "Eligibility brief",
  qpa_brief: "QPA / payment-amount brief",
  idr_cover_letter: "IDR cover letter",
  settlement_closure_notice: "Settlement closure notice",
  general_letter: "General letter",
  case_packet: "Filing packet",
};

export default function Composer({ dispute }) {
  const id = dispute?.id;
  const [docs, setDocs] = useState([]);
  const [view, setView] = useState("list");      // list | wizard | editor
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [packetOpen, setPacketOpen] = useState(false);
  const [packetSigner, setPacketSigner] = useState("");

  const loadDocs = useCallback(async () => {
    if (!id) return;
    const { data, error } = await supabase.rpc("list_documents", { p_dispute: id });
    if (error) { setErr(error.message); return; }
    setDocs(data || []);
  }, [id]);
  useEffect(() => { loadDocs(); }, [loadDocs]);

  // ---- evidence ----
  const [evidence, setEvidence] = useState([]);
  const [evBusy, setEvBusy] = useState(false);
  const loadEvidence = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase.rpc("list_evidence", { p_dispute: id });
    setEvidence(data || []);
  }, [id]);
  useEffect(() => { loadEvidence(); }, [loadEvidence]);

  async function uploadEvidence(file) {
    if (!file) return;
    setEvBusy(true); setErr("");
    try {
      const orgId = dispute?.org_id;
      const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const path = `${orgId}/${id}/${crypto.randomUUID()}-${safe}`;
      const up = await supabase.storage.from("evidence").upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (up.error) throw up.error;
      const { data: evId, error: ae } = await supabase.rpc("add_evidence", {
        p_dispute: id, p_path: path, p_filename: file.name, p_mime: file.type || "application/octet-stream", p_size: file.size });
      if (ae) throw ae;
      await loadEvidence();
      // fire-and-refresh: AI scan
      supabase.functions.invoke("scan-evidence", { body: { evidence_id: evId } })
        .then(() => loadEvidence())
        .catch(() => loadEvidence());
    } catch (e) { setErr("Upload failed: " + (e.message || e)); }
    setEvBusy(false);
  }
  async function rescan(evId) {
    setEvBusy(true);
    await supabase.functions.invoke("scan-evidence", { body: { evidence_id: evId } }).catch(() => {});
    await loadEvidence(); setEvBusy(false);
  }
  async function removeEvidence(evId) {
    await supabase.rpc("delete_evidence", { p_id: evId });
    loadEvidence();
  }

  // ---- wizard state ----
  const [templates, setTemplates] = useState([]);
  const [tpl, setTpl] = useState(null);          // {code, title, questions:[]}
  const [answers, setAnswers] = useState({});
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);

  async function openWizard() {
    setErr("");
    const { data: list } = await supabase.rpc("list_doc_templates");
    setTemplates(list || []);
    const first = (list || []).find((t) => t.code === "challenge_letter") || (list || [])[0];
    if (!first) { setErr("No templates configured yet."); return; }
    await pickTemplate(first.code);
    setView("wizard");
  }

  async function pickTemplate(code) {
    const { data, error } = await supabase.rpc("get_doc_template", { p_code: code });
    if (error || !data?.ok) { setErr(error?.message || "Template not found."); return; }
    const init = {};
    (data.questions || []).forEach((q) => { if (q.default !== null && q.default !== undefined) init[q.key] = q.default; });
    setTpl(data);
    setAnswers(init);
    refreshPreview(code, init);
  }

  const refreshPreview = useCallback(async (code, ans) => {
    setPreviewing(true);
    const { data, error } = await supabase.rpc("preview_document", { p_dispute: id, p_code: code, p_answers: ans });
    setPreviewing(false);
    if (error) { setErr(error.message); return; }
    setPreview(data?.html || "");
  }, [id]);

  // debounce preview on answer change
  const debRef = useRef(null);
  function setAnswer(key, val) {
    const next = { ...answers, [key]: val };
    setAnswers(next);
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => refreshPreview(tpl.code, next), 250);
  }

  async function aiDraft(q) {
    setBusy("ai:" + q.key); setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("draft-section", {
        body: { dispute_id: id, template_code: tpl.code, field: q.key, guidance: q.ai_prompt || "" },
      });
      if (error) throw error;
      if (data?.ok && data.text) setAnswer(q.key, data.text);
      else setErr(data?.reason || "AI drafting is not configured yet (set ANTHROPIC_API_KEY on the draft-section function).");
    } catch (e) {
      setErr("AI drafting unavailable: " + (e.message || e) + ". You can type the paragraph manually.");
    }
    setBusy("");
  }

  async function generate() {
    const missing = (tpl.questions || []).filter((q) => q.required && !String(answers[q.key] ?? "").trim());
    if (missing.length) { setErr("Please fill: " + missing.map((m) => m.prompt).join(", ")); return; }
    setBusy("gen"); setErr("");
    const { data, error } = await supabase.rpc("generate_document_from_template", { p_dispute: id, p_code: tpl.code, p_answers: answers });
    setBusy("");
    if (error) { setErr(error.message); return; }
    await loadDocs();
    openEditor(data);          // data = new doc uuid
  }

  // ---- one-click filing packet: auto-assembles the right templates into one brief ----
  async function assemblePacket() {
    if (!packetSigner.trim()) { setErr("Enter a signer name for the packet."); return; }
    setBusy("packet"); setErr("");
    const { data, error } = await supabase.rpc("assemble_case_packet", {
      p_dispute: id,
      p_answers: { signer_name: packetSigner.trim(), signer_title: "Authorized Plan Representative" },
    });
    setBusy("");
    if (error) { setErr(error.message); return; }
    setPacketOpen(false); setPacketSigner("");
    await loadDocs();
    openEditor(data);          // data = new packet doc uuid
  }

  // ---- unified packet: server renders the brief to PDF + appends exhibits, one continuous file ----
  async function downloadPacketPdf() {
    if (!doc?.id) return;
    setBusy("packetpdf"); setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("export-packet", { body: { dispute_id: id, doc_id: doc.id } });
      if (error) throw error;
      if (data?.ok && data.url) window.open(data.url, "_blank");
      else setErr(data?.reason || "Could not build the packet PDF.");
    } catch (e) {
      setErr("Packet PDF unavailable: " + (e.message || e));
    }
    setBusy("");
  }

  // ---- exhibits: server merges scanned evidence into one page-numbered PDF ----
  async function downloadExhibits() {
    setBusy("exhibits"); setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("export-exhibits", { body: { dispute_id: id } });
      if (error) throw error;
      if (data?.ok && data.url) window.open(data.url, "_blank");
      else setErr(data?.reason || "Could not build the exhibits PDF.");
    } catch (e) {
      setErr("Exhibits export unavailable: " + (e.message || e));
    }
    setBusy("");
  }

  // ---- editor state ----
  const [doc, setDoc] = useState(null);          // full doc from get_document
  const [signer, setSigner] = useState("");
  const [saveState, setSaveState] = useState("");
  const [preflight, setPreflight] = useState(null);
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);
  const edRef = useRef(null);
  const saveTimer = useRef(null);

  async function loadMeta(docId) {
    const [{ data: pf }, { data: vs }] = await Promise.all([
      supabase.rpc("document_preflight", { p_doc: docId }),
      supabase.rpc("list_document_versions", { p_doc: docId }),
    ]);
    setPreflight(pf && pf.ok ? pf : null);
    setVersions(vs || []);
  }

  async function openEditor(docId) {
    setErr("");
    const { data, error } = await supabase.rpc("get_document", { p_doc: docId });
    if (error || !data?.ok) { setErr(error?.message || "Could not open document."); return; }
    setDoc(data);
    setSigner(data.answers?.signer_name || "");
    setShowVersions(false);
    setView("editor");
    loadMeta(docId);
    setTimeout(() => { if (edRef.current) edRef.current.innerHTML = data.content || ""; }, 0);
  }

  function onEdit() {
    if (!doc || doc.esign_status === "signed") return;
    setSaveState("editing");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 900);
  }
  async function saveNow() {
    if (!doc || !edRef.current) return;
    setSaveState("saving");
    const html = edRef.current.innerHTML;
    const { data, error } = await supabase.rpc("save_document_content", { p_doc: doc.id, p_content: html });
    if (error || data?.ok === false) { setSaveState(""); setErr(error?.message || data?.reason || "Save failed."); return; }
    setSaveState("saved"); setDoc((d) => ({ ...d, content: html }));
    loadDocs(); loadMeta(doc.id);
  }
  const fmt = (cmd, val) => { document.execCommand(cmd, false, val); edRef.current?.focus(); onEdit(); };

  async function signDoc() {
    if (!signer.trim()) { setErr("Enter a signer name to sign."); return; }
    if (preflight && preflight.errors > 0) { setErr("Resolve the pre-flight errors before signing."); return; }
    await saveNow();
    setBusy("sign");
    const { data, error } = await supabase.rpc("sign_document", { p_doc: doc.id, p_signer: signer.trim() });
    setBusy("");
    if (error || data?.ok === false) { setErr(error?.message || data?.reason || "Sign failed."); return; }
    setDoc((d) => ({ ...d, esign_status: "signed", signed_by: signer.trim(), sha256: data.seal }));
    loadDocs(); loadMeta(doc.id);
  }

  const orgName = dispute?.plans?.name || dispute?.plan_legal_name || "Plan Administrator";
  const footer = `Re: Federal IDR Dispute ${dispute?.external_ref || ""} · ${doc?.title || ""}`;
  function exportPDF() {
    const html = edRef.current ? edRef.current.innerHTML : doc.content;
    const w = window.open("", "_blank");
    if (!w) { setErr("Pop-up blocked — allow pop-ups to export."); return; }
    w.document.write(printShell(doc.title, html, orgName, footer));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }
  function exportDOCX() {
    const html = edRef.current ? edRef.current.innerHTML : doc.content;
    const blob = new Blob(["﻿", wordShell(doc.title, html, orgName, footer)], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = safeName(doc.title) + ".doc"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!id) return null;

  // ---------- LIST ----------
  if (view === "list") {
    return (
      <div>
        {err && <Err msg={err} onClose={() => setErr("")} />}
        <div style={rowBetween}>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {docs.length} document{docs.length === 1 ? "" : "s"} · generated from templates, editable, e-signable
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {packetOpen ? (
              <>
                <input className="dsel" placeholder="Signer name" value={packetSigner}
                  onChange={(e) => setPacketSigner(e.target.value)} style={{ padding: "8px 10px", minWidth: 150 }} />
                <button className="btn btn-a" disabled={busy === "packet"} onClick={assemblePacket}>
                  {busy === "packet" ? "Assembling…" : "Build packet →"}
                </button>
                <button className="mini" onClick={() => { setPacketOpen(false); setPacketSigner(""); }}>Cancel</button>
              </>
            ) : (
              <button className="btn btn-s" onClick={() => setPacketOpen(true)} title="Auto-assemble the arguments that fit this case into one multi-section brief">
                ⤓ One-click filing packet
              </button>
            )}
            <button className="btn btn-a" onClick={openWizard}>+ New from template</button>
          </div>
        </div>
        {docs.length === 0 ? (
          <p className="muted" style={{ padding: "12px 0" }}>No documents yet. Generate an argument document from a template — it auto-fills from this case.</p>
        ) : (
          <div style={{ marginTop: 10 }}>
            {docs.map((dc) => (
              <div key={dc.id} style={docRow}>
                <div>
                  <b>{dc.title}</b>
                  <span className="muted" style={{ display: "block", fontSize: 12 }}>
                    {KIND_LABEL[dc.kind] || dc.kind} · updated {new Date(dc.updated_at).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={"badge b-" + (dc.esign_status === "signed" ? "green" : "grey")}>
                    <i className={"dot d-" + (dc.esign_status === "signed" ? "green" : "grey")} />
                    {dc.esign_status === "signed" ? "Signed" : "Draft"}
                  </span>
                  <button className="mini" onClick={() => openEditor(dc.id)}>Open</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Evidence — upload existing case documents; AI scans them into the argument */}
        <div className="rlabel" style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Evidence &amp; exhibits</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {evidence.some((ev) => ev.status === "scanned") && (
              <button className="mini" disabled={busy === "exhibits"} onClick={downloadExhibits}
                title="Merge every scanned document into one page-numbered exhibit bundle">
                {busy === "exhibits" ? "Building…" : "⤓ Exhibits PDF"}
              </button>
            )}
            <label className="mini" style={{ cursor: "pointer" }}>
              {evBusy ? "Uploading…" : "+ Upload document"}
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" style={{ display: "none" }}
                disabled={evBusy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; uploadEvidence(f); }} />
            </label>
          </div>
        </div>
        {evidence.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>Upload the open-negotiation notice, EOB/remittance, the initiator's filing, or contracts. Claude scans each and, once scanned, it's cited as an exhibit and folded into the AI-drafted argument.</p>
        ) : (
          <div>
            {evidence.map((ev) => {
              const tone = ev.status === "scanned" ? "green" : ev.status === "error" ? "red" : "amber";
              return (
                <div key={ev.id} style={docRow}>
                  <div style={{ minWidth: 0 }}>
                    <b>{ev.filename}</b>
                    <span className="muted" style={{ display: "block", fontSize: 12 }}>
                      {ev.status === "scanned" && ev.summary?.one_liner ? ev.summary.one_liner
                        : ev.status === "error" ? ("Scan failed: " + (ev.error || "unknown"))
                        : ev.status === "scanning" ? "Scanning…" : "Uploaded — not scanned"}
                    </span>
                    {ev.status === "scanned" && Array.isArray(ev.summary?.relevance) && ev.summary.relevance.length > 0 && (
                      <span className="muted" style={{ fontSize: 11 }}>
                        Supports: {ev.summary.relevance.map((r) => r.code).join(", ")}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className={"badge b-" + tone}><i className={"dot d-" + tone} />{ev.status}</span>
                    {ev.status !== "scanning" && <button className="mini" disabled={evBusy} onClick={() => rescan(ev.id)}>Scan</button>}
                    <button className="mini" onClick={() => removeEvidence(ev.id)}>✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ---------- WIZARD ----------
  if (view === "wizard" && tpl) {
    return (
      <div>
        {err && <Err msg={err} onClose={() => setErr("")} />}
        <div style={rowBetween}>
          <select className="dsel" value={tpl.code} onChange={(e) => pickTemplate(e.target.value)} style={{ padding: "8px 10px" }}>
            {templates.map((t) => <option key={t.code} value={t.code}>{t.title}</option>)}
          </select>
          <div style={{ display: "flex", gap: 8 }}>
            <a className="mini" href="/templates" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Manage templates ↗</a>
            <button className="mini" onClick={() => setView("list")}>← Cancel</button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{tpl.description}</p>

        <div style={wizardGrid}>
          {/* Questions */}
          <div>
            <div className="rlabel">Questions</div>
            {(tpl.questions || []).map((q) => (
              <div key={q.key} style={{ margin: "12px 0" }}>
                <label style={qLabel}>{q.prompt}{q.required && <span style={{ color: "var(--red,#b23a2a)" }}> *</span>}</label>
                {q.help && <div className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>{q.help}</div>}
                <QField q={q} value={answers[q.key]} onChange={(v) => setAnswer(q.key, v)}
                  ai={q.ai_assist ? () => aiDraft(q) : null} aiBusy={busy === "ai:" + q.key} />
              </div>
            ))}
            <button className="btn btn-a" disabled={busy === "gen"} onClick={generate} style={{ marginTop: 6 }}>
              {busy === "gen" ? "Generating…" : "Generate document →"}
            </button>
          </div>

          {/* Live preview */}
          <div>
            <div className="rlabel">Live preview {previewing && <span className="muted" style={{ fontWeight: 400 }}>· updating…</span>}</div>
            <div className="doc-preview" dangerouslySetInnerHTML={{ __html: preview || "<p class='muted'>Preview will appear here.</p>" }} />
          </div>
        </div>
      </div>
    );
  }

  // ---------- EDITOR ----------
  if (view === "editor" && doc) {
    const signed = doc.esign_status === "signed";
    return (
      <div>
        {err && <Err msg={err} onClose={() => setErr("")} />}
        <div style={rowBetween}>
          <button className="mini" onClick={() => { setView("list"); setDoc(null); }}>← All documents</button>
          <span className="muted" style={{ fontSize: 12 }}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : signed ? "Sealed — read-only" : ""}
          </span>
        </div>
        <h3 style={{ fontFamily: "var(--disp,serif)", margin: "8px 0 4px" }}>{doc.title}</h3>

        {!signed && (
          <div className="doc-toolbar">
            <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("bold")}><b>B</b></button>
            <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("italic")}><i>I</i></button>
            <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("formatBlock", "H3")}>H</button>
            <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("insertUnorderedList")}>• List</button>
            <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("insertOrderedList")}>1. List</button>
            <span style={{ flex: 1 }} />
            <button className="mini" onClick={saveNow}>Save</button>
          </div>
        )}

        <div
          ref={edRef}
          className="doc-editor"
          contentEditable={!signed}
          suppressContentEditableWarning
          onInput={onEdit}
          spellCheck
        />

        {preflight && preflight.issues && preflight.issues.length > 0 && (
          <div className="doc-flags">
            <div className="rlabel" style={{ margin: "4px 2px 2px" }}>
              Pre-flight · {preflight.errors} error{preflight.errors === 1 ? "" : "s"}, {preflight.warnings} warning{preflight.warnings === 1 ? "" : "s"}
            </div>
            {preflight.issues.map((it, i) => (
              <div key={i} className={"doc-flag " + it.level}>
                <b style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: ".08em" }}>{it.level}</b>
                <span>{it.msg}</span>
              </div>
            ))}
          </div>
        )}

        <div className="doc-actions">
          {!signed ? (
            <>
              <input className="dsel" placeholder="Signer name" value={signer} onChange={(e) => setSigner(e.target.value)} style={{ padding: "8px 10px", minWidth: 180 }} />
              <button className="btn btn-s" disabled={busy === "sign"} onClick={signDoc}>{busy === "sign" ? "Sealing…" : "Sign & seal"}</button>
            </>
          ) : (
            <span className="badge b-green"><i className="dot d-green" />Signed by {doc.signed_by} · seal {String(doc.sha256).slice(0, 12)}…</span>
          )}
          <span style={{ flex: 1 }} />
          <button className="mini" onClick={() => setShowVersions((v) => !v)}>{showVersions ? "Hide" : "History"} ({versions.length})</button>
          <button className="btn btn-s" disabled={busy === "packetpdf"} onClick={downloadPacketPdf}
            title="Render the brief to PDF and append your scanned exhibits — one continuously page-numbered filing packet">
            {busy === "packetpdf" ? "Building packet…" : "⤓ Filing packet PDF"}
          </button>
          <button className="mini" onClick={exportPDF}>Export PDF</button>
          <button className="mini" onClick={exportDOCX}>Export Word</button>
        </div>

        {showVersions && (
          <div style={{ marginTop: 10 }}>
            <div className="rlabel">Version history</div>
            {versions.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No versions recorded.</p> :
              versions.map((v) => (
                <div key={v.version} className="ver-row">
                  <span className="vv">v{v.version}</span>
                  <span>{v.event}</span>
                  <span>· {v.actor || "—"}</span>
                  <span style={{ flex: 1 }} />
                  <span className="mono">{v.sha256}…</span>
                  <span>{new Date(v.created_at).toLocaleString()}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ---- field renderer ----
function QField({ q, value, onChange, ai, aiBusy }) {
  if (q.input_type === "boolean") {
    return (
      <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span className="muted" style={{ fontSize: 12.5 }}>{value ? "Included" : "Excluded"}</span>
      </label>
    );
  }
  if (q.input_type === "select") {
    return (
      <select className="dsel" value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ padding: "8px 10px", width: "100%" }}>
        {(q.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (q.input_type === "textarea") {
    return (
      <div>
        <textarea className="dsel" value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={4}
          style={{ padding: "8px 10px", width: "100%", resize: "vertical", fontFamily: "inherit" }} />
        {ai && <button className="mini" disabled={aiBusy} onClick={ai} style={{ marginTop: 6 }}>{aiBusy ? "Drafting…" : "AI draft"}</button>}
      </div>
    );
  }
  return (
    <input className="dsel" value={value ?? ""} onChange={(e) => onChange(e.target.value)}
      type={q.input_type === "number" ? "number" : "text"} style={{ padding: "8px 10px", width: "100%" }} />
  );
}

function Err({ msg, onClose }) {
  return (
    <div className="badge b-red" style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
      <i className="dot d-red" /> {msg} <span style={{ cursor: "pointer", marginLeft: 6 }} onClick={onClose}>✕</span>
    </div>
  );
}

// ---- export shells (zero-dependency, filing-grade) ----
const DOC_CSS = `
  @page{margin:0.9in 1in;size:letter}
  body{font-family:Georgia,'Times New Roman',serif;color:#1a1614;line-height:1.55;max-width:680px;margin:40px auto;padding:0 24px}
  .letterhead{border-bottom:2px solid #1a1614;padding-bottom:8px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:baseline}
  .letterhead .lh-org{font-family:Georgia,serif;font-weight:700;font-size:15px;letter-spacing:.02em}
  .letterhead .lh-sub{color:#6b625f;font-size:11px;text-transform:uppercase;letter-spacing:.14em}
  p{margin:0 0 12px}.doc-meta{color:#6b625f;font-size:13px}.sig{margin:14px 0 2px}
  ol.grounds{margin:6px 0 14px 22px}ol.grounds li{margin:0 0 9px}
  .cite{color:#8f2c17;font-size:12px;font-family:Arial,sans-serif}
  table.bench{border-collapse:collapse;margin:8px 0 14px;font-size:13px;width:100%}
  table.bench th{text-align:left;border-bottom:1.5px solid #1a1614;padding:6px 8px;color:#3a3d44}
  table.bench td{border-bottom:1px solid #ddd;padding:6px 8px}
  ul.exhibits{margin:6px 0 14px 20px}ul.exhibits li{margin:0 0 6px}
  h3{font-size:16px;margin:16px 0 8px}
  .page-break{page-break-before:always;break-before:page}
  .foot{margin-top:26px;padding-top:8px;border-top:1px solid #ccc;color:#8a857f;font-size:10.5px;font-family:Arial,sans-serif;display:flex;justify-content:space-between}
  @media print{body{margin:0 auto}}`;
function letterhead(org) {
  return `<div class="letterhead"><span class="lh-org">${esc(org || "Plan Administrator")}</span><span class="lh-sub">Federal IDR · Confidential</span></div>`;
}
function printShell(title, html, org, footer) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${DOC_CSS}</style></head><body>${letterhead(org)}${html}<div class="foot"><span>${esc(footer || "")}</span><span>Generated by Avertyn</span></div></body></html>`;
}
function wordShell(title, html, org, footer) {
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset="utf-8"><title>${esc(title)}</title><style>${DOC_CSS}</style></head><body>${letterhead(org)}${html}<div class="foot"><span>${esc(footer || "")}</span><span>Generated by Avertyn</span></div></body></html>`;
}
const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const safeName = (s) => String(s || "document").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

// ---- inline layout ----
const rowBetween = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" };
const docRow = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--line,#eee)" };
const wizardGrid = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)", gap: 20, marginTop: 12, alignItems: "start" };
const qLabel = { display: "block", fontWeight: 600, fontSize: 13, marginBottom: 2 };
