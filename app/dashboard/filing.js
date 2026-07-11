"use client";
// Avertyn — Batch filing operator surface. The regulated pipeline:
//   build batches (2026 batching rules) → select a certified IDRE (conflict-aware,
//   re-selectable) → file the submission. Every step is a ledgered batch action.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useLive } from "../../lib/useLive";
import { money } from "../../lib/format";

const STATUS_TONE = { draft: "grey", idre_pending: "amber", filed: "green" };
const STATUS_LABEL = { draft: "Draft", idre_pending: "IDRE pending", filed: "Filed" };
const STEPS = [["draft", "Built"], ["idre_pending", "IDRE selected"], ["filed", "Filed"]];

export function FilingView({ orgId, onErr, initialBatch, onConsumeInitial }) {
  const [batches, setBatches] = useState([]);
  const [sels, setSels] = useState([]);      // idre_selections (latest per batch)
  const [subs, setSubs] = useState([]);      // portal_submissions
  const [idres, setIdres] = useState([]);    // active IDRE entities
  const [conn, setConn] = useState(null);    // idr connection (registration no)
  const [unbatched, setUnbatched] = useState(0);
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [pick, setPick] = useState("");
  const [behavior, setBehavior] = useState([]);

  const load = useCallback(async () => {
    try {
      const [b, s, p, e, c, u] = await Promise.all([
        supabase.from("batches").select("id, status, line_count, service_category, basis, created_at, plans(name), initiators(name)").order("created_at", { ascending: false }),
        supabase.from("idre_selections").select("id, batch_id, status, created_at, idre_entities(name)").order("created_at", { ascending: false }),
        supabase.from("portal_submissions").select("batch_id, submission_ref, status, submitted_at, registration_number").order("created_at", { ascending: false }),
        supabase.from("idre_entities").select("id, name, specialties, active").eq("active", true).order("name"),
        supabase.from("idr_connections").select("registration_no, legal_name, status").limit(1).maybeSingle(),
        supabase.from("disputes").select("id", { count: "exact", head: true }).eq("disposition", "open").in("workflow_state", ["intake", "triage", "eligibility_review", "qpa_defense", "response_prep"]),
      ]);
      if (b.error) throw b.error;
      setBatches(b.data || []); setSels(s.data || []); setSubs(p.data || []);
      setIdres(e.data || []); setConn(c.data || null); setUnbatched(u.count || 0);
    } catch (er) { onErr(er.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!orgId) return; supabase.rpc("idre_scorecard", { p_org: orgId }).then(({ data }) => setBehavior(data || [])); }, [orgId]);
  useLive("filing", ["batches", "batch_disputes", "idre_selections", "portal_submissions"], load);
  // Preselect a batch handed over from the Cases queue ("Batch & file").
  useEffect(() => { if (initialBatch) { setSel(initialBatch); onConsumeInitial && onConsumeInitial(); } }, [initialBatch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sel) { setLines([]); return; }
    let live = true;
    supabase.from("batch_disputes").select("disputes(id, external_ref, cpt_code, demand_amount, qpa_amount, eligibility_score, workflow_state)").eq("batch_id", sel)
      .then(({ data }) => { if (live) setLines((data || []).map((r) => r.disputes).filter(Boolean)); });
    return () => { live = false; };
  }, [sel]);

  const selFor = (bid) => sels.find((s) => s.batch_id === bid);
  const subFor = (bid) => subs.find((s) => s.batch_id === bid);
  const selBatch = batches.find((b) => b.id === sel) || null;

  async function run(key, fn, okMsg) {
    setBusy(key); setNote("");
    try { const r = await fn(); if (r?.error) throw r.error; if (r?.data?.ok === false) throw new Error(r.data.reason || "Action failed."); setNote(okMsg || "Done."); await load(); }
    catch (er) { onErr(er.message); }
    setBusy("");
  }
  const batchAct = (action, batch, params) => supabase.rpc("execute_batch_action", { p_action: action, p_batch: batch, p_params: params || {}, p_actor: "operator", p_rationale: `Operator ${action.replace(/_/g, " ")}` });

  const buildBatches = () => run("build", () => supabase.rpc("build_batches", { p_org: orgId }), "Batches rebuilt from open disputes.");
  const autoSelect = (bid) => run("idre" + bid, () => supabase.rpc("select_idre", { p_batch: bid }), "IDRE auto-selected (conflict-aware).");
  const selectIdre = (bid) => { if (!pick) return; const cur = selFor(bid); return run("idre" + bid, () => batchAct("select_idre", bid, { idre_id: pick, reselection_of: cur?.status === "proposed" ? cur.id : undefined }), "IDRE selected."); };
  const fileBatch = (bid) => run("file" + bid, () => batchAct("file_submission", bid, { registration_number: conn?.registration_no || null }), "Submission filed to the IDR portal queue.");

  const draftN = batches.filter((b) => b.status === "draft").length;
  const pendN = batches.filter((b) => b.status === "idre_pending").length;
  const filedN = batches.filter((b) => b.status === "filed").length;

  return (
    <div>
      <div className="dh"><h1 className="vh">The pipeline</h1>
        <span className="sub">Batch open disputes under the 2026 batching rules, select a certified IDRE, and file — one regulated, ledgered pipeline</span></div>

      <div className="cards" style={{ marginTop: 14 }}>
        <div className="kpi-tile"><div className="l">Unbatched open</div><div className="n">{unbatched}</div><div className="goal">{unbatched ? "ready to batch" : "all batched"}</div></div>
        <div className="kpi-tile"><div className="l">Draft batches</div><div className="n">{draftN}</div><div className="goal">need an IDRE</div></div>
        <div className="kpi-tile"><div className="l">IDRE pending</div><div className="n">{pendN}</div><div className="goal">ready to file</div></div>
        <div className="kpi-tile"><div className="l">Filed</div><div className="n">{filedN}</div><div className="goal good">submitted</div></div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-a" disabled={busy === "build"} onClick={buildBatches}>{busy === "build" ? "Building…" : "Build batches from open disputes"}</button>
        {conn && <span className="badge b-grey">Registration {conn.registration_no || "—"}</span>}
        {note && <span className="badge b-green"><i className="dot d-green" />{note}</span>}
      </div>

      {behavior.length > 0 && (
        <div className="panel" style={{ margin: "16px 0 0" }}>
          <div className="ph">IDRE scorecard<span className="act"><span className="muted" style={{ fontSize: 11 }}>payer-ruling rate from resolved awards — prefer the IDREs that rule for the plan</span></span></div>
          <div className="pb" style={{ paddingTop: 6 }}>
            <table>
              <thead><tr><th>IDRE</th><th>Payer-win rate</th><th>Resolved</th><th>Selections</th></tr></thead>
              <tbody>
                {behavior.slice().sort((a, b) => (Number(b.payer_win_rate) || -1) - (Number(a.payer_win_rate) || -1)).map((b, i) => {
                  const r = b.payer_win_rate == null ? null : Number(b.payer_win_rate);
                  const tone = r == null ? "grey" : r >= 0.7 ? "green" : r >= 0.5 ? "amber" : "red";
                  return (
                    <tr key={i}>
                      <td><b>{b.idre}</b></td>
                      <td><span className={"badge b-" + tone}><i className={"dot d-" + tone} />{r == null ? "no data yet" : Math.round(r * 100) + "%"}</span></td>
                      <td className="mono">{b.resolved || 0}</td>
                      <td className="mono">{b.selections}{Number(b.reselections) > 0 ? ` · ${b.reselections} re` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="filing">
        <div className="panel" style={{ margin: "16px 0 0" }}>
          <div className="ph">Batches<span className="act"><span className="muted" style={{ fontSize: 11 }}>{batches.length} total · grouped by plan · initiator · service category</span></span></div>
          {batches.length === 0 ? <p className="muted" style={{ padding: 16 }}>No batches yet. Build them from your open disputes above.</p> : (
            <div className="pb" style={{ padding: 10 }}>
              {batches.map((b) => {
                const s = selFor(b.id); const sub = subFor(b.id);
                const on = b.id === sel;
                return (
                  <div key={b.id} className={"batchcard" + (on ? " on" : "")} onClick={() => setSel(on ? null : b.id)}>
                    <div className="bcmain">
                      <div>
                        <b>{b.plans?.name || "—"}</b> <span className="muted">vs {b.initiators?.name || "—"}</span>
                        <div className="sub">{b.service_category || "general"} · {b.line_count || 0} line{(b.line_count || 0) === 1 ? "" : "s"}{s?.idre_entities?.name ? " · IDRE " + s.idre_entities.name : ""}{sub?.submission_ref ? " · " + sub.submission_ref : ""}</div>
                      </div>
                      <span className={"badge b-" + (STATUS_TONE[b.status] || "grey")}><i className={"dot d-" + (STATUS_TONE[b.status] || "grey")} />{STATUS_LABEL[b.status] || b.status}</span>
                    </div>
                    <div className="stepper">
                      {STEPS.map(([k, lbl], i) => {
                        const idx = ["draft", "idre_pending", "filed"].indexOf(b.status);
                        const done = i <= idx;
                        return <div key={k} className={"step" + (done ? " done" : "")}><span className="sd" />{lbl}</div>;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selBatch && (
          <div className="panel" style={{ margin: "16px 0 0" }}>
            <div className="ph">Batch · {selBatch.plans?.name} vs {selBatch.initiators?.name}
              <span className="act"><span className={"badge b-" + (STATUS_TONE[selBatch.status] || "grey")}>{STATUS_LABEL[selBatch.status] || selBatch.status}</span></span>
            </div>
            <div className="pb" style={{ paddingTop: 12 }}>
              {lines.length > 0 && (() => {
                const dem = lines.reduce((a, l) => a + Number(l.demand_amount || 0), 0);
                const q = lines.reduce((a, l) => a + Number(l.qpa_amount || 0), 0);
                return (
                  <div className="cards" style={{ marginBottom: 16 }}>
                    <div className="kpi-tile"><div className="l">Lines</div><div className="n">{lines.length}</div></div>
                    <div className="kpi-tile"><div className="l">Total demand</div><div className="n">{money(dem)}</div></div>
                    <div className="kpi-tile"><div className="l">At stake vs QPA</div><div className="n">{money(dem - q)}</div><div className="goal">defended if it holds</div></div>
                  </div>
                );
              })()}
              {/* IDRE selection */}
              <div className="rlabel">Certified IDRE</div>
              {(() => { const s = selFor(selBatch.id); return (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                  {s?.idre_entities?.name && <span className="badge b-ink"><i className="dot d-ink" />{s.idre_entities.name}{s.status === "reselected" ? " (reselected)" : ""}</span>}
                  <select className="dsel" value={pick} onChange={(e) => setPick(e.target.value)} style={{ padding: "8px 10px" }}>
                    <option value="">Choose IDRE…</option>
                    {idres.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.specialties}</option>)}
                  </select>
                  <button className="btn btn-s" disabled={!pick || busy === "idre" + selBatch.id} onClick={() => selectIdre(selBatch.id)}>{s ? "Re-select" : "Select"}</button>
                  <button className="mini" disabled={busy === "idre" + selBatch.id} onClick={() => autoSelect(selBatch.id)}>Auto (conflict-aware)</button>
                </div>
              ); })()}

              {/* File */}
              <div className="rlabel">File submission</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                <button className="btn btn-a" disabled={selBatch.status === "filed" || selBatch.status === "draft" || busy === "file" + selBatch.id}
                  onClick={() => fileBatch(selBatch.id)}>
                  {busy === "file" + selBatch.id ? "Filing…" : selBatch.status === "filed" ? "Filed ✓" : "File to IDR portal"}
                </button>
                {subFor(selBatch.id)?.submission_ref && <span className="badge b-green">{subFor(selBatch.id).submission_ref} · {subFor(selBatch.id).status}</span>}
                {selBatch.status === "draft" && <span className="muted" style={{ fontSize: 11.5 }}>Select an IDRE first.</span>}
              </div>

              {/* Lines */}
              <div className="rlabel" style={{ marginTop: 16 }}>Lines in this batch · {lines.length}</div>
              {lines.length === 0 ? <p className="muted">Loading lines…</p> : (
                <table>
                  <thead><tr><th>Dispute</th><th>CPT</th><th>Demand</th><th>QPA</th><th>Ineligibility</th><th>State</th></tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td><b>#{l.external_ref}</b></td>
                        <td className="mono">{l.cpt_code}</td>
                        <td className="mono">{money(l.demand_amount)}</td>
                        <td className="mono">{money(l.qpa_amount)}</td>
                        <td className="mono">{l.eligibility_score ?? "—"}{l.eligibility_score >= 60 && <span className="badge b-red" style={{ marginLeft: 5 }}>weak</span>}</td>
                        <td>{(l.workflow_state || "").replace(/_/g, " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
