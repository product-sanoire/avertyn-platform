"use client";
// Avertyn — Claims & identifiers panel.
// A case is phase-aware: in Open negotiation it leads with a Claim number; once it
// escalates to Federal IDR it leads with a Dispute number and can batch one or more
// claims (45 CFR §149.510(c)(3)). This panel edits the phase, the claim/dispute
// numbers, and the list of claims bundled into the case.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { money } from "../../../lib/format";

const card = { background: "var(--card,#fff)", border: "1px solid var(--line,#eee)", borderRadius: 14, padding: "18px 20px", marginTop: 16 };
const fld = { padding: "7px 10px", fontSize: 13 };

export default function Claims({ disputeId, dispute, onIdentifiers }) {
  const [claims, setClaims] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [phase, setPhase] = useState(dispute?.phase || "open_negotiation");
  const [claimNo, setClaimNo] = useState(dispute?.claim_number || "");
  const [dispNo, setDispNo] = useState(dispute?.idr_registration_number || "");
  const [internalRef, setInternalRef] = useState(dispute?.external_ref || "");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ claim_number: "", patient_ref: "", cpt_code: "", service_date: "", billed_total: "" });
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_case_claims", { p_dispute: disputeId });
    if (error) { setErr(error.message); return; }
    setClaims(data || []);
  }, [disputeId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setPhase(dispute?.phase || "open_negotiation");
    setClaimNo(dispute?.claim_number || "");
    setDispNo(dispute?.idr_registration_number || "");
    setInternalRef(dispute?.external_ref || "");
  }, [dispute?.phase, dispute?.claim_number, dispute?.idr_registration_number, dispute?.external_ref]);

  async function saveIdentifiers() {
    setBusy("ids"); setErr("");
    const { data, error } = await supabase.rpc("set_case_identifiers", {
      p_dispute: disputeId, p_phase: phase, p_claim_number: claimNo || null, p_dispute_number: dispNo || null, p_internal_ref: internalRef });
    setBusy("");
    if (error || data?.ok === false) { setErr(error?.message || data?.reason || "Could not save identifiers."); return; }
    onIdentifiers && onIdentifiers();
  }
  async function addClaim() {
    setBusy("add"); setErr("");
    const { error } = await supabase.rpc("add_case_claim", {
      p_dispute: disputeId, p_claim_number: form.claim_number || null, p_patient: form.patient_ref || null,
      p_cpt: form.cpt_code || null, p_service_date: form.service_date || null,
      p_billed: form.billed_total !== "" ? Number(form.billed_total) : null });
    setBusy("");
    if (error) { setErr(error.message); return; }
    setAdding(false); setForm({ claim_number: "", patient_ref: "", cpt_code: "", service_date: "", billed_total: "" }); load();
  }
  function beginEdit(c) { setEditId(c.id); setEditForm({ claim_number: c.claim_number || "", patient_ref: c.patient_ref || "", cpt_code: c.cpt_code || "", service_date: c.service_date || "", billed_total: c.billed_total ?? "" }); }
  async function saveEdit() {
    const { error } = await supabase.rpc("update_case_claim", {
      p_id: editId, p_claim_number: editForm.claim_number || null, p_patient: editForm.patient_ref || null,
      p_cpt: editForm.cpt_code || null, p_service_date: editForm.service_date || null,
      p_billed: editForm.billed_total !== "" ? Number(editForm.billed_total) : null });
    if (error) { setErr(error.message); return; }
    setEditId(null); setEditForm(null); load();
  }
  async function removeClaim(id) {
    if (typeof window !== "undefined" && !window.confirm("Remove this claim from the case?")) return;
    const { error } = await supabase.rpc("remove_case_claim", { p_id: id });
    if (error) { setErr(error.message); return; }
    load();
  }

  const isIdr = phase === "idr";
  const totalBilled = claims.reduce((a, c) => a + Number(c.billed_total || 0), 0);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontFamily: "var(--disp,serif)", fontSize: 16 }}>Claims &amp; identifiers</b>
        <span className={"badge b-" + (isIdr ? "green" : "amber")}><i className={"dot d-" + (isIdr ? "green" : "amber")} />{isIdr ? "Federal IDR" : "Open negotiation"}</span>
        <span className="muted" style={{ fontSize: 12 }}>{claims.length} claim{claims.length === 1 ? "" : "s"}{claims.length ? " · " + money(totalBilled) + " billed" : ""}</span>
      </div>

      {err && <div className="badge b-red" style={{ display: "inline-flex", gap: 8, margin: "10px 0" }}><i className="dot d-red" />{err}</div>}

      {/* Phase + identifiers */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", margin: "12px 0 6px" }}>
        <label style={lbl}>Phase
          <select className="dsel" value={phase} onChange={(e) => setPhase(e.target.value)} style={{ ...fld, display: "block", marginTop: 3 }}>
            <option value="open_negotiation">Open negotiation</option>
            <option value="idr">Federal IDR</option>
          </select>
        </label>
        <label style={lbl}>{isIdr ? "Lead claim number" : "Claim number"}
          <input className="dsel" value={claimNo} onChange={(e) => setClaimNo(e.target.value)} placeholder="e.g. CLM-70551-A" style={{ ...fld, display: "block", marginTop: 3, minWidth: 170 }} />
        </label>
        <label style={{ ...lbl, opacity: isIdr ? 1 : 0.55 }}>Dispute number {isIdr ? "" : "(on IDR)"}
          <input className="dsel" value={dispNo} onChange={(e) => setDispNo(e.target.value)} placeholder="Federal IDR dispute no." style={{ ...fld, display: "block", marginTop: 3, minWidth: 190 }} />
        </label>
        <label style={lbl}>Internal case no. <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
          <input className="dsel" value={internalRef} onChange={(e) => setInternalRef(e.target.value)} placeholder="your own ref" style={{ ...fld, display: "block", marginTop: 3, minWidth: 140 }} />
        </label>
        <button className="btn btn-a" disabled={busy === "ids"} onClick={saveIdentifiers} style={{ padding: "8px 14px" }}>{busy === "ids" ? "Saving…" : "Save"}</button>
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "0 0 8px" }}>
        {isIdr
          ? "In Federal IDR the case leads with its dispute number and may batch one or more claims below (same parties/service, per 45 CFR §149.510(c)(3))."
          : "During open negotiation the case leads with its claim number. Escalate to Federal IDR to assign a dispute number and batch multiple claims."}
      </p>

      {/* Claims list */}
      <div className="rlabel" style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Claims in this case</span>
        <button className="mini" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add claim"}</button>
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
          <input className="dsel" placeholder="Claim #" value={form.claim_number} onChange={(e) => setForm({ ...form, claim_number: e.target.value })} style={{ ...fld, width: 130 }} />
          <input className="dsel" placeholder="Patient ref" value={form.patient_ref} onChange={(e) => setForm({ ...form, patient_ref: e.target.value })} style={{ ...fld, width: 120 }} />
          <input className="dsel" placeholder="CPT" value={form.cpt_code} onChange={(e) => setForm({ ...form, cpt_code: e.target.value })} style={{ ...fld, width: 80 }} />
          <input className="dsel" type="date" value={form.service_date} onChange={(e) => setForm({ ...form, service_date: e.target.value })} style={fld} />
          <input className="dsel" type="number" placeholder="Billed $" value={form.billed_total} onChange={(e) => setForm({ ...form, billed_total: e.target.value })} style={{ ...fld, width: 110 }} />
          <button className="btn btn-a" disabled={busy === "add"} onClick={addClaim} style={{ padding: "7px 12px" }}>{busy === "add" ? "Adding…" : "Add"}</button>
        </div>
      )}

      {claims.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, padding: "6px 0" }}>No claims on this case yet.</p>
      ) : (
        <div style={{ marginTop: 4 }}>
          {claims.map((c) => editId === c.id ? (
            <div key={c.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--line,#eee)" }}>
              <input className="dsel" value={editForm.claim_number} onChange={(e) => setEditForm({ ...editForm, claim_number: e.target.value })} placeholder="Claim #" style={{ ...fld, width: 130 }} />
              <input className="dsel" value={editForm.patient_ref} onChange={(e) => setEditForm({ ...editForm, patient_ref: e.target.value })} placeholder="Patient" style={{ ...fld, width: 120 }} />
              <input className="dsel" value={editForm.cpt_code} onChange={(e) => setEditForm({ ...editForm, cpt_code: e.target.value })} placeholder="CPT" style={{ ...fld, width: 80 }} />
              <input className="dsel" type="date" value={editForm.service_date || ""} onChange={(e) => setEditForm({ ...editForm, service_date: e.target.value })} style={fld} />
              <input className="dsel" type="number" value={editForm.billed_total} onChange={(e) => setEditForm({ ...editForm, billed_total: e.target.value })} placeholder="Billed $" style={{ ...fld, width: 110 }} />
              <button className="btn btn-a" onClick={saveEdit} style={{ padding: "7px 12px" }}>Save</button>
              <button className="mini" onClick={() => { setEditId(null); setEditForm(null); }}>Cancel</button>
            </div>
          ) : (
            <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line,#eee)" }}>
              <b style={{ minWidth: 120 }}>{c.claim_number || <span className="muted" style={{ fontWeight: 400 }}>(no claim #)</span>}</b>
              <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>
                {[c.patient_ref, c.cpt_code && ("CPT " + c.cpt_code), c.service_date && new Date(c.service_date).toLocaleDateString(), c.billed_total != null && money(c.billed_total)].filter(Boolean).join(" · ")}
              </span>
              <button className="mini" onClick={() => beginEdit(c)}>Edit</button>
              <button className="mini" onClick={() => removeClaim(c.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const lbl = { fontSize: 11.5, color: "var(--mut,#6b625f)", fontWeight: 600 };
