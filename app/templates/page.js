"use client";
// Avertyn — Template builder (/templates).
// List every argument-document template, open one to inspect its questions and
// clauses, "Customize for our org" (clones a global template into an editable
// org copy), then edit clause bodies / conditions / questions with a live preview
// rendered against a real dispute. All writes go through admin-gated RPCs.
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

export default function TemplatesPage() {
  const [list, setList] = useState([]);
  const [code, setCode] = useState(null);
  const [tpl, setTpl] = useState(null);          // get_template_full
  const [sampleId, setSampleId] = useState("");
  const [samples, setSamples] = useState([]);
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");

  const loadList = useCallback(async () => {
    const { data } = await supabase.rpc("list_doc_templates");
    setList(data || []);
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  // sample disputes for preview
  useEffect(() => {
    supabase.from("disputes").select("id, external_ref, cpt_code").order("created_at", { ascending: false }).limit(25)
      .then(({ data }) => { setSamples(data || []); if (data && data[0]) setSampleId(data[0].id); });
  }, []);

  const openTemplate = useCallback(async (c) => {
    setErr(""); setMsg("");
    const { data, error } = await supabase.rpc("get_template_full", { p_code: c });
    if (error || !data?.ok) { setErr(error?.message || "Not found."); return; }
    setCode(c); setTpl(data);
  }, []);

  const refreshPreview = useCallback(async () => {
    if (!code || !sampleId) return;
    const { data, error } = await supabase.rpc("preview_document", { p_dispute: sampleId, p_code: code, p_answers: {} });
    if (error) { setErr(error.message); return; }
    setPreview(data?.html || "");
  }, [code, sampleId]);
  useEffect(() => { refreshPreview(); }, [refreshPreview, tpl]);

  async function run(key, fn, ok) {
    setBusy(key); setErr(""); setMsg("");
    try {
      const { data, error } = await fn();
      if (error) throw error;
      if (data?.ok === false) throw new Error(data.reason || "Failed.");
      setMsg(ok || "Saved."); await openTemplate(code); await loadList();
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }

  const customize = () => run("clone", () => supabase.rpc("clone_template_to_org", { p_code: code }), "Cloned to an editable org copy.");
  const saveClause = (c) => run("cl:" + c.key, () => supabase.rpc("upsert_template_clause", { p: { code, ...c } }), "Clause saved.");
  const delClause = (k) => run("dc:" + k, () => supabase.rpc("delete_template_item", { p_code: code, p_kind: "clause", p_key: k }), "Clause removed.");
  const saveQuestion = (q) => run("q:" + q.key, () => supabase.rpc("upsert_template_question", { p: { code, ...q } }), "Question saved.");
  const delQuestion = (k) => run("dq:" + k, () => supabase.rpc("delete_template_item", { p_code: code, p_kind: "question", p_key: k }), "Question removed.");

  return (
    <div>
      <div className="topbar"><span className="logo">A</span><b>Avertyn</b>
        <span style={{ color: "#d3cccd", fontSize: 13 }}>· Template builder</span></div>
      <div className="wrap" style={{ maxWidth: 1180, margin: "18px auto", padding: "0 22px" }}>
        <Link href="/dashboard" className="muted">← Command center</Link>
        <div className="dh" style={{ marginTop: 8 }}><h1>Document templates</h1>
          <span className="sub">Argument-document templates — clone a global template to customize it for your org, then edit clauses and questions with a live preview</span></div>

        {err && <div className="badge b-red" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}
        {msg && <div className="badge b-green" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-green" />{msg}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 22, marginTop: 14, alignItems: "start" }}>
          {/* template list */}
          <div>
            <div className="rlabel">Templates</div>
            <div className="tpl-list">
              {list.map((t) => (
                <div key={t.code} className="tpl-card" onClick={() => openTemplate(t.code)}
                  style={{ outline: code === t.code ? "2px solid var(--sig-line)" : "none" }}>
                  <div><b style={{ fontSize: 13 }}>{t.title.replace(/ —.*$/, "")}</b>
                    <span className="muted" style={{ display: "block", fontSize: 11 }}>{t.kind} · {t.jurisdiction}</span></div>
                </div>
              ))}
            </div>
          </div>

          {/* editor */}
          <div>
            {!tpl ? <p className="muted">Select a template to view or edit it.</p> : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div><b style={{ fontFamily: "var(--disp,serif)", fontSize: 18 }}>{tpl.title.replace(/ —.*$/, "")}</b>
                    <span className={"badge " + (tpl.editable ? "b-green" : "b-grey")} style={{ marginLeft: 10 }}>
                      {tpl.editable ? "Editable (org copy)" : "Global — read-only"}</span></div>
                  {!tpl.editable && <button className="btn btn-a" disabled={busy === "clone"} onClick={customize}>{busy === "clone" ? "Cloning…" : "Customize for our org"}</button>}
                </div>
                <p className="muted" style={{ fontSize: 12.5 }}>{tpl.description}</p>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr)", gap: 20, marginTop: 12, alignItems: "start" }}>
                  {/* clauses + questions */}
                  <div>
                    <div className="rlabel">Questions ({tpl.questions.length})</div>
                    {tpl.questions.map((q) => (
                      <QuestionEditor key={q.key} q={q} editable={tpl.editable} busy={busy}
                        onSave={saveQuestion} onDelete={() => delQuestion(q.key)} />
                    ))}
                    {tpl.editable && <AddRow kind="question" onAdd={saveQuestion} />}

                    <div className="rlabel" style={{ marginTop: 18 }}>Clauses ({tpl.clauses.length})</div>
                    {tpl.clauses.map((c) => (
                      <ClauseEditor key={c.key} c={c} editable={tpl.editable} busy={busy}
                        onSave={saveClause} onDelete={() => delClause(c.key)} />
                    ))}
                    {tpl.editable && <AddRow kind="clause" onAdd={saveClause} />}
                  </div>

                  {/* preview */}
                  <div>
                    <div className="rlabel" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Live preview</span>
                      <select className="dsel" value={sampleId} onChange={(e) => setSampleId(e.target.value)}>
                        {samples.map((s) => <option key={s.id} value={s.id}>#{s.external_ref} · {s.cpt_code}</option>)}
                      </select>
                    </div>
                    <div className="doc-preview" dangerouslySetInnerHTML={{ __html: preview || "<p class='muted'>Preview…</p>" }} />
                    <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                      Tokens: <span className="code-in">{"{{dispute.external_ref}}"}, {"{{money.qpa}}"}, {"{{money.demand}}"}, {"{{qpa.benchmark_table}}"}, {"{{answers.KEY}}"}, {"{{this.name}}"}/{"{{this.authority}}"} (in a findings clause).</span><br/>
                      Conditions (JSON): <span className="code-in">{'{"flag":"has_findings"}'}, {'{"answer":"KEY","equals":true}'}, {'{"not":{...}}'}.</span>
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClauseEditor({ c, editable, busy, onSave, onDelete }) {
  const [row, setRow] = useState({ ...c, include_when: c.include_when ? JSON.stringify(c.include_when) : "" });
  const commit = () => {
    let iw = null;
    if (String(row.include_when).trim()) { try { iw = JSON.parse(row.include_when); } catch { alert("include_when must be valid JSON"); return; } }
    onSave({ key: row.key, seq: Number(row.seq) || 0, body: row.body, include_when: iw, repeat_over: row.repeat_over || "" });
  };
  return (
    <div className="clause-row">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <span className="code-in"><b>{c.key}</b></span>
        <span className="muted" style={{ fontSize: 11 }}>seq {c.seq}{c.repeat_over ? " · repeats " + c.repeat_over : ""}</span>
        <span style={{ flex: 1 }} />
        {editable && <button className="mini" disabled={busy === "cl:" + c.key} onClick={commit}>Save</button>}
        {editable && <button className="mini" onClick={onDelete}>Delete</button>}
      </div>
      <textarea rows={2} value={row.body} disabled={!editable} onChange={(e) => setRow({ ...row, body: e.target.value })} />
      {editable && (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input className="code-in" style={inp} placeholder="seq" value={row.seq} onChange={(e) => setRow({ ...row, seq: e.target.value })} />
          <input className="code-in" style={{ ...inp, flex: 2 }} placeholder='include_when JSON (blank = always)' value={row.include_when} onChange={(e) => setRow({ ...row, include_when: e.target.value })} />
          <input className="code-in" style={inp} placeholder="repeat_over" value={row.repeat_over || ""} onChange={(e) => setRow({ ...row, repeat_over: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function QuestionEditor({ q, editable, busy, onSave, onDelete }) {
  const [row, setRow] = useState({ ...q });
  const commit = () => onSave({
    key: row.key, seq: Number(row.seq) || 0, prompt: row.prompt, help: row.help,
    input_type: row.input_type, required: !!row.required, ai_assist: !!row.ai_assist,
    default: row.default, options: row.options,
  });
  return (
    <div className="clause-row">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="code-in"><b>{q.key}</b></span>
        <span className="muted" style={{ fontSize: 11 }}>{q.input_type}{q.required ? " · required" : ""}{q.ai_assist ? " · AI" : ""}</span>
        <span style={{ flex: 1 }} />
        {editable && <button className="mini" disabled={busy === "q:" + q.key} onClick={commit}>Save</button>}
        {editable && <button className="mini" onClick={onDelete}>Delete</button>}
      </div>
      <input style={{ ...inp, width: "100%", marginTop: 6 }} value={row.prompt} disabled={!editable} onChange={(e) => setRow({ ...row, prompt: e.target.value })} placeholder="Prompt" />
    </div>
  );
}

function AddRow({ kind, onAdd }) {
  const [key, setKey] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <input className="code-in" style={inp} placeholder={"new " + kind + " key"} value={key} onChange={(e) => setKey(e.target.value)} />
      <button className="mini" disabled={!key.trim()} onClick={() => {
        if (kind === "clause") onAdd({ key: key.trim(), seq: 999, body: "<p>New clause</p>", include_when: null, repeat_over: "" });
        else onAdd({ key: key.trim(), seq: 999, prompt: "New question", input_type: "text" });
        setKey("");
      }}>+ Add {kind}</button>
    </div>
  );
}

const inp = { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, border: "1px solid var(--line-2,#ccc)", borderRadius: 6, padding: "6px 8px", background: "#fff", width: 90 };
