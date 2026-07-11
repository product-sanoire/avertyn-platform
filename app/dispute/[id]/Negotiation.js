"use client";
// Avertyn — QPA calculator + negotiation tracker.
// TPAs negotiate in terms of "percent of QPA", so this panel (1) derives the
// Qualifying Payment Amount from the plan's contracted rates using the NSA
// median + CPI-U method, (2) lays out an offer ladder as multiples of that QPA,
// and (3) tracks the round-by-round back-and-forth, each move stored as a % of QPA.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { money } from "../../../lib/format";

const card = { background: "var(--card,#fff)", border: "1px solid var(--line,#eee)", borderRadius: 14, padding: "18px 20px", marginTop: 16 };
const fld = { padding: "7px 10px", fontSize: 13 };
const lbl = { fontSize: 11.5, color: "var(--mut,#6b625f)", fontWeight: 600 };

const LADDER = [100, 110, 125, 150];
const STATUS_TONE = { open: "amber", countered: "grey", accepted: "green", rejected: "red", withdrawn: "grey" };
const STATUS_LABEL = { open: "Open", countered: "Countered", accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn" };
const pctOf = (amt, qpa) => (qpa > 0 ? Math.round((Number(amt) / qpa) * 1000) / 10 : null);

export default function Negotiation({ dispute, onChanged }) {
  const disputeId = dispute?.id;
  const qpa = Number(dispute?.qpa_amount || 0);
  const demand = Number(dispute?.demand_amount || 0);
  const ceiling = Number(dispute?.ceiling_override || 0) || (qpa > 0 ? Math.round(qpa * 1.5 * 100) / 100 : 0);

  const [rates, setRates] = useState([]);
  const [offers, setOffers] = useState([]);
  const [qpaRec, setQpaRec] = useState(null);   // qpa_records: regional median, defensible ceiling
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [calc, setCalc] = useState(null);
  const [rateForm, setRateForm] = useState({ source: "", contracted_rate: "" });
  const [move, setMove] = useState({ party: "plan", mode: "pct", value: "", kind: "counter", note: "" });

  const load = useCallback(async () => {
    if (!disputeId) return;
    try {
      const [{ data: r, error: e1 }, { data: o, error: e2 }, { data: qr }] = await Promise.all([
        supabase.rpc("list_qpa_rates", { p_dispute: disputeId }),
        supabase.from("offers").select("id, party, kind, amount, pct_of_qpa, round_no, status, note, submitted_at").eq("dispute_id", disputeId).order("round_no", { ascending: true }),
        supabase.from("qpa_records").select("benchmark_regional, defensible_ceiling").eq("dispute_id", disputeId).maybeSingle(),
      ]);
      if (e1) throw e1; if (e2) throw e2;
      setRates(r || []); setOffers(o || []); setQpaRec(qr || null);
    } catch (e) { setErr(e.message || String(e)); }
  }, [disputeId]);

  // Independent benchmark each offer is measured against: regional median,
  // falling back to the defensible ceiling.
  const bench = (() => {
    const fh = Number(qpaRec?.benchmark_regional || 0);
    if (fh > 0) return { v: fh, label: "Regional median", short: "Regional" };
    const dc = Number(qpaRec?.defensible_ceiling || 0) || ceiling;
    return dc > 0 ? { v: dc, label: "defensible ceiling", short: "ceiling" } : null;
  })();
  useEffect(() => { load(); }, [load]);

  // ---- QPA calculator ------------------------------------------------------
  async function addRate() {
    if (!rateForm.contracted_rate) return;
    setBusy("rate"); setErr("");
    try {
      const { error } = await supabase.rpc("add_qpa_rate", { p_dispute: disputeId, p_source: rateForm.source || null, p_rate: Number(rateForm.contracted_rate) });
      if (error) throw error;
      setRateForm({ source: "", contracted_rate: "" }); await load();
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function removeRate(id) {
    setBusy("rate:" + id); setErr("");
    try { const { error } = await supabase.rpc("remove_qpa_rate", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function computeQpa() {
    setBusy("compute"); setErr("");
    try {
      const { data, error } = await supabase.rpc("compute_qpa", { p_dispute: disputeId, p_apply: true });
      if (error) throw error;
      if (data?.ok === false) { setErr(data.reason === "no_rates" ? "Add at least one contracted rate first." : (data.reason || "Could not compute.")); }
      else { setCalc(data); onChanged && onChanged(); }
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  const rateVals = rates.map((r) => Number(r.contracted_rate)).sort((a, b) => a - b);
  const previewMedian = rateVals.length ? (rateVals.length % 2 ? rateVals[(rateVals.length - 1) / 2] : (rateVals[rateVals.length / 2 - 1] + rateVals[rateVals.length / 2]) / 2) : null;

  // ---- Negotiation ---------------------------------------------------------
  async function addMove() {
    if (move.value === "") return;
    setBusy("move"); setErr("");
    try {
      const args = { p_dispute: disputeId, p_party: move.party, p_kind: move.kind, p_note: move.note || null,
        p_pct: move.mode === "pct" ? Number(move.value) : null, p_amount: move.mode === "amt" ? Number(move.value) : null };
      const { data, error } = await supabase.rpc("add_negotiation_offer", args);
      if (error) throw error;
      if (data?.ok === false) { setErr(data.reason || "Could not record the move."); }
      else { setMove({ ...move, value: "", note: "" }); await load(); }
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function setStatus(id, status) {
    setBusy("st:" + id); setErr("");
    try { const { error } = await supabase.rpc("set_offer_status", { p_id: id, p_status: status }); if (error) throw error; await load(); }
    catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function removeMove(id) {
    if (typeof window !== "undefined" && !window.confirm("Remove this move from the ledger?")) return;
    setBusy("rm:" + id); setErr("");
    try { const { error } = await supabase.rpc("remove_negotiation_offer", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }

  // Suggested next counter (plan side): midpoint of the last two live offers,
  // else a 125%-of-QPA opening.
  const suggestion = (() => {
    if (qpa <= 0) return null;
    const lastProv = [...offers].reverse().find((o) => o.party === "initiator");
    const lastPlan = [...offers].reverse().find((o) => o.party === "plan");
    if (lastProv && lastPlan) {
      const amt = Math.round((Number(lastProv.amount) + Number(lastPlan.amount)) / 2 * 100) / 100;
      return { amt, pct: pctOf(amt, qpa), basis: "midpoint of the last plan and provider offers" };
    }
    if (lastProv) { const amt = Math.round(qpa * 1.25 * 100) / 100; return { amt, pct: 125, basis: "125% of QPA opening" }; }
    const amt = Math.round(qpa * 1.25 * 100) / 100;
    return { amt, pct: 125, basis: "125% of QPA opening" };
  })();

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontFamily: "var(--disp,serif)", fontSize: 16 }}>QPA calculator &amp; negotiation</b>
        <span className="badge b-ink"><i className="dot d-ink" />QPA {qpa > 0 ? money(qpa) : "—"}</span>
        {demand > 0 && qpa > 0 && <span className="badge b-red" title="Provider demand as a multiple of QPA"><i className="dot d-red" />Demand {pctOf(demand, qpa)}% of QPA</span>}
      </div>

      {err && <div className="badge b-red" style={{ display: "inline-flex", gap: 8, margin: "10px 0" }}><i className="dot d-red" />{err}</div>}

      {/* ---- QPA calculator ---- */}
      <div className="rlabel" style={{ marginTop: 14 }}>Contracted rates → QPA <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>(NSA median, CPI-U trended)</span></div>
      <div style={{ marginTop: 6 }}>
        {rates.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, padding: "4px 0" }}>No contracted rates entered. Add the plan's in-network rates for this service to derive the QPA.</p>
        ) : rates.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line,#eee)" }}>
            <b className="mono" style={{ minWidth: 90 }}>{money(r.contracted_rate)}</b>
            <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>{r.source || "—"}</span>
            <button className="mini" disabled={busy === "rate:" + r.id} onClick={() => removeRate(r.id)}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0 4px" }}>
        <input className="dsel" placeholder="Payer / network" value={rateForm.source} onChange={(e) => setRateForm({ ...rateForm, source: e.target.value })} style={{ ...fld, width: 150 }} />
        <input className="dsel" type="number" placeholder="Contracted $" value={rateForm.contracted_rate} onChange={(e) => setRateForm({ ...rateForm, contracted_rate: e.target.value })} style={{ ...fld, width: 130 }} />
        <button className="mini" disabled={busy === "rate"} onClick={addRate}>{busy === "rate" ? "Adding…" : "+ Add rate"}</button>
        {previewMedian != null && <span className="muted" style={{ fontSize: 11.5 }}>median of {rateVals.length}: {money(previewMedian)}</span>}
        <button className="btn btn-a" disabled={busy === "compute" || rates.length === 0} onClick={computeQpa} style={{ padding: "8px 14px", marginLeft: "auto" }}>{busy === "compute" ? "Computing…" : "Compute QPA →"}</button>
      </div>
      {calc?.ok && (
        <div style={{ background: "var(--sunk,#f1eee9)", borderRadius: 10, padding: "10px 12px", margin: "4px 0 8px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={"badge b-" + (calc.basis === "cms" ? "green" : "amber")}><i className={"dot d-" + (calc.basis === "cms" ? "green" : "amber")} />{calc.basis === "cms" ? "CMS-published factor · defensible" : "CPI-U estimate"}</span>
            <b className="mono">QPA {money(calc.qpa)}</b>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8 }}>
            {calc.cms_factor != null && (
              <div>
                <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>CMS {calc.service_year} official</div>
                <div><b className="mono">{money(calc.cms_qpa)}</b> <span className="muted mono" style={{ fontSize: 11.5 }}>×{Number(calc.cms_factor).toFixed(7)}</span></div>
                {calc.cms_source && <div className="muted" style={{ fontSize: 10.5 }}>{calc.cms_source}</div>}
              </div>
            )}
            <div>
              <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>CPI-U estimate</div>
              <div><b className="mono">{money(calc.cpi_qpa)}</b> <span className="muted mono" style={{ fontSize: 11.5 }}>×{Number(calc.cpi_factor).toFixed(5)}</span></div>
            </div>
            {calc.delta != null && (
              <div>
                <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>Reconciliation Δ</div>
                <div><b className="mono" style={{ color: Math.abs(Number(calc.delta)) >= 0.01 ? "var(--sig,#a8321f)" : "var(--ok,#2e6b4c)" }}>{Number(calc.delta) > 0 ? "+" : ""}{money(calc.delta)}</b> <span className="muted" style={{ fontSize: 11 }}>CPI-U vs CMS</span></div>
              </div>
            )}
          </div>
          {calc.cms_factor == null && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>No CMS-published factor on file for {calc.service_year} — using the CPI-U estimate. Add the official factor under Admin → QPA index.</div>}
          {calc.index_year !== calc.service_year && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>CPI-U for {calc.service_year} not on file; used {calc.index_year}.</div>}
        </div>
      )}

      {/* ---- Offer ladder ---- */}
      {qpa > 0 && (
        <>
          <div className="rlabel" style={{ marginTop: 12 }}>Offer ladder <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>(as % of QPA — click to stage a plan offer)</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            {LADDER.map((p) => {
              const amt = Math.round(qpa * p / 100 * 100) / 100;
              return (
                <button key={p} className="kpi-tile" style={{ cursor: "pointer", minWidth: 96, textAlign: "left" }} title={`Stage a plan offer at ${p}% of QPA`}
                  onClick={() => setMove({ party: "plan", mode: "pct", value: String(p), kind: "counter", note: "" })}>
                  <div className="l">{p}% of QPA</div>
                  <div className="n" style={{ fontSize: 17 }}>{money(amt)}</div>
                </button>
              );
            })}
            <div className="kpi-tile" style={{ minWidth: 120 }} title="Defensible ceiling (override or 150% of QPA)">
              <div className="l">Defensible ceiling</div>
              <div className="n" style={{ fontSize: 17 }}>{money(ceiling)}</div>
            </div>
          </div>
        </>
      )}

      {/* ---- Negotiation timeline ---- */}
      <div className="rlabel" style={{ marginTop: 16 }}>Negotiation ledger <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>· {offers.length} move{offers.length === 1 ? "" : "s"}</span></div>
      {suggestion && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--sunk,#f1eee9)", borderRadius: 10, padding: "8px 12px", margin: "8px 0" }}>
          <span className="badge b-green"><i className="dot d-green" />Suggested counter</span>
          <b className="mono">{money(suggestion.amt)}</b>
          <span className="muted" style={{ fontSize: 12 }}>{suggestion.pct}% of QPA · {suggestion.basis}</span>
          <button className="mini" style={{ marginLeft: "auto" }} onClick={() => setMove({ party: "plan", mode: "amt", value: String(suggestion.amt), kind: "counter", note: "" })}>Use →</button>
        </div>
      )}

      {offers.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, padding: "4px 0" }}>No offers logged yet.</p>
      ) : (
        <div style={{ marginTop: 4 }}>
          {offers.map((o) => (
            <div key={o.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line,#eee)" }}>
              <span className="mono muted" style={{ minWidth: 30, fontSize: 12 }}>#{o.round_no ?? "—"}</span>
              <span className={"badge b-" + (o.party === "plan" ? "ind" : "amber")} style={{ minWidth: 74, justifyContent: "center" }}>{o.party === "plan" ? "Plan" : "Provider"}</span>
              <b className="mono" style={{ minWidth: 92 }}>{money(o.amount)}</b>
              <span className="muted mono" style={{ minWidth: 70, fontSize: 12 }}>{o.pct_of_qpa != null ? o.pct_of_qpa + "% QPA" : "—"}</span>
              <span className="muted" style={{ flex: 1, fontSize: 12 }}>{[(o.kind || "").replace(/_/g, " "), o.note].filter(Boolean).join(" · ")}</span>
              {bench && (() => { const bp = Math.round(Number(o.amount) / bench.v * 100); const over = Number(o.amount) > bench.v; return (
                <span className={"badge b-" + (over ? "red" : "green")} title={`${o.party === "plan" ? "Plan" : "Provider"} offer vs ${bench.label} (${money(bench.v)})`}>
                  <i className={"dot d-" + (over ? "red" : "green")} />{bp}% of {bench.short} · {over ? "above" : "at/below"}
                </span>
              ); })()}
              <span className={"badge b-" + (STATUS_TONE[o.status] || "grey")}><i className={"dot d-" + (STATUS_TONE[o.status] || "grey")} />{STATUS_LABEL[o.status] || o.status}</span>
              {o.status !== "accepted" && <button className="mini" disabled={busy === "st:" + o.id} onClick={() => setStatus(o.id, "accepted")} title="Mark accepted">✓</button>}
              {o.status !== "rejected" && <button className="mini" disabled={busy === "st:" + o.id} onClick={() => setStatus(o.id, "rejected")} title="Mark rejected">✕ rej</button>}
              <button className="mini" disabled={busy === "rm:" + o.id} onClick={() => removeMove(o.id)} title="Remove">🗑</button>
            </div>
          ))}
        </div>
      )}

      {/* Add a move */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <select className="dsel" value={move.party} onChange={(e) => setMove({ ...move, party: e.target.value })} style={fld}>
          <option value="plan">Plan offer</option>
          <option value="initiator">Provider offer</option>
        </select>
        <div className="seg" style={{ padding: 3 }}>
          <button className={move.mode === "pct" ? "on" : ""} onClick={() => setMove({ ...move, mode: "pct" })} title="Enter as % of QPA">% of QPA</button>
          <button className={move.mode === "amt" ? "on" : ""} onClick={() => setMove({ ...move, mode: "amt" })} title="Enter a dollar amount">$ amount</button>
        </div>
        <input className="dsel" type="number" placeholder={move.mode === "pct" ? "e.g. 125" : "$ amount"} value={move.value} onChange={(e) => setMove({ ...move, value: e.target.value })} style={{ ...fld, width: 110 }} />
        {move.mode === "pct" && qpa > 0 && move.value !== "" && <span className="muted mono" style={{ fontSize: 12 }}>= {money(Math.round(qpa * Number(move.value) / 100 * 100) / 100)}</span>}
        {move.mode === "amt" && qpa > 0 && move.value !== "" && <span className="muted mono" style={{ fontSize: 12 }}>= {pctOf(Number(move.value), qpa)}% QPA</span>}
        <input className="dsel" placeholder="Note (optional)" value={move.note} onChange={(e) => setMove({ ...move, note: e.target.value })} style={{ ...fld, width: 170 }} />
        <button className="btn btn-a" disabled={busy === "move" || move.value === ""} onClick={addMove} style={{ padding: "8px 14px" }}>{busy === "move" ? "Recording…" : "Record move"}</button>
      </div>
      {qpa <= 0 && <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Tip: compute or set a QPA above to enter offers as a percentage.</p>}
    </div>
  );
}
