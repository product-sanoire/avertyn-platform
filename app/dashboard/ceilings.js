"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";

function money(n) { return n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }

// Per-plan (with org default) defensible-ceiling policy editor.
// Backed by list_plan_ceilings / set_plan_ceiling / set_org_ceiling RPCs.
export function CeilingsView({ orgId, onErr }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [edits, setEdits] = useState({});           // plan id -> { mode?, value? }
  const [org, setOrg] = useState({ mode: "", value: "" });

  const load = useCallback(async () => {
    try {
      const { data: d, error } = await supabase.rpc("list_plan_ceilings");
      if (error) throw error;
      setData(d); setEdits({});
      setOrg({ mode: d?.org?.ceiling_mode || "", value: d?.org?.ceiling_value ?? "" });
    } catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  const globalPct = data?.global_pct ?? 125;
  const setEdit = (id, k, v) => setEdits((e) => ({ ...e, [id]: { ...(e[id] || {}), [k]: v } }));
  const modeOf = (p) => (edits[p.id]?.mode !== undefined ? edits[p.id].mode : (p.ceiling_mode || ""));
  const valOf = (p) => (edits[p.id]?.value !== undefined ? edits[p.id].value : (p.ceiling_value ?? ""));
  const dirty = (p) => edits[p.id] && (modeOf(p) !== (p.ceiling_mode || "") || String(valOf(p)) !== String(p.ceiling_value ?? ""));
  const fmtPolicy = (mode, value) => mode === "pct_of_qpa" ? value + "% of QPA" : mode === "amount" ? money(value) + " flat" : "—";

  async function savePlan(p) {
    const mode = modeOf(p) || null;
    const val = mode ? Number(valOf(p)) : null;
    if (mode && (!val || val <= 0)) { onErr("Enter a positive value for the ceiling."); return; }
    setBusy("p" + p.id);
    try {
      const { error } = await supabase.rpc("set_plan_ceiling", { p_plan: p.id, p_mode: mode, p_value: val });
      if (error) throw error; await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function saveOrg() {
    const mode = org.mode || null;
    const val = mode ? Number(org.value) : null;
    if (mode && (!val || val <= 0)) { onErr("Enter a positive value for the org default."); return; }
    setBusy("org");
    try {
      const { error } = await supabase.rpc("set_org_ceiling", { p_mode: mode, p_value: val });
      if (error) throw error; await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }

  return (
    <div>
      <div className="panel">
        <div className="ph">Defensible-ceiling policy
          <span className="act"><span className="muted" style={{ fontSize: 11 }}>Precedence: per-case override &rarr; plan &rarr; org default &rarr; global {globalPct}% of QPA</span></span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 14px" }}>
            The <b>defensible ceiling</b> is the most the plan will concede on a case. Set what each plan greenlights &mdash; a
            percent of the QPA or a flat dollar amount &mdash; and it flows into every open case on that plan, the recommended
            offers, and generated documents automatically. A ceiling above the regional benchmark is allowed but <b>flagged</b> on the case.
          </p>

          <div className="rlabel" style={{ marginTop: 0 }}>Org default</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
            <select className="dsel" value={org.mode} onChange={(e) => setOrg({ ...org, mode: e.target.value })} style={{ padding: "8px 10px" }}>
              <option value="">Use global ({globalPct}% of QPA)</option>
              <option value="pct_of_qpa">% of QPA</option>
              <option value="amount">Flat amount</option>
            </select>
            {org.mode && (
              <input type="number" step="1" placeholder={org.mode === "pct_of_qpa" ? "e.g. 130" : "e.g. 900"} value={org.value}
                onChange={(e) => setOrg({ ...org, value: e.target.value })}
                style={{ width: 110, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
            )}
            <span className="muted" style={{ fontSize: 12 }}>{org.mode === "pct_of_qpa" ? "% of each case's QPA" : org.mode === "amount" ? "flat $ per case" : "applies to plans with no policy of their own"}</span>
            <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "org"} onClick={saveOrg}>{busy === "org" ? "Saving…" : "Save org default"}</button>
          </div>

          <div className="rlabel">Per plan</div>
          {!data ? <p className="muted">Loading…</p> : (data.plans || []).length === 0 ? <p className="muted">No plans yet.</p> : (
            <table>
              <thead><tr><th>Plan</th><th>Employer</th><th>Active</th><th>Ceiling</th><th>Value</th><th>Effective</th><th></th></tr></thead>
              <tbody>
                {data.plans.map((p) => {
                  const m = modeOf(p);
                  const inherits = !p.ceiling_mode;
                  const effMode = p.ceiling_mode || data.org?.ceiling_mode || "pct_of_qpa";
                  const effVal = p.ceiling_mode ? p.ceiling_value : (data.org?.ceiling_mode ? data.org.ceiling_value : globalPct);
                  return (
                    <tr key={p.id}>
                      <td><b>{p.name}</b></td>
                      <td className="muted">{p.employer || "—"}</td>
                      <td className="mono">{p.active_cases}</td>
                      <td>
                        <select className="dsel" value={m} onChange={(e) => setEdit(p.id, "mode", e.target.value)} style={{ padding: "6px 9px" }}>
                          <option value="">Inherit</option>
                          <option value="pct_of_qpa">% of QPA</option>
                          <option value="amount">Flat amount</option>
                        </select>
                      </td>
                      <td>
                        {m ? <input type="number" step="1" value={valOf(p)} onChange={(e) => setEdit(p.id, "value", e.target.value)}
                          placeholder={m === "pct_of_qpa" ? "130" : "900"}
                          style={{ width: 88, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} /> : <span className="muted">—</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{fmtPolicy(effMode, effVal)}{inherits && <span className="badge b-grey" style={{ marginLeft: 6 }}>inherited</span>}</td>
                      <td>
                        <button className="mini" disabled={!dirty(p) || busy === "p" + p.id} onClick={() => savePlan(p)}>{busy === "p" + p.id ? "Saving…" : "Save"}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>Saving a policy immediately recomputes the ceiling on every open case for that plan, so cases, recommended offers and autopilot reflect it right away.</p>
        </div>
      </div>
    </div>
  );
}
