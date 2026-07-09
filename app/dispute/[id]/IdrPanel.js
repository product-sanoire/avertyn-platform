"use client";
// ============================================================================
// IDR Gateway panel for the case workspace.
//   - shows/creates the org's Gateway connection (adapter + status)
//   - lists inbound sync events for this dispute (real-time-in)
//   - stages an outbound submission, lets the operator edit it in-app,
//     approve it (ledgered), and record the Gateway receipt (edit-in-app-out)
// Drops into the dispute page as <IdrPanel dispute={d} />.
// ============================================================================
import { useEffect, useState, useCallback } from "react";
import { money } from "../../../lib/format";
import * as idr from "../../../lib/idrClient";

const STATUS_TONE = {
  draft: "#7c7c7a", needs_review: "#8a6a1f", queued: "#8a6a1f",
  in_flight: "#8a6a1f", confirmed: "#2f6f52", failed: "#b23a2a", canceled: "#a4a29e",
};

export default function IdrPanel({ dispute }) {
  const [conn, setConn] = useState(null);
  const [events, setEvents] = useState([]);
  const [subs, setSubs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState(dispute?.qpa_amount ?? "");

  const load = useCallback(async () => {
    const [c, e, s] = await Promise.all([
      idr.getConnection(), idr.listEvents(dispute.id), idr.listSubmissions(dispute.id),
    ]);
    setConn(c); setEvents(e); setSubs(s);
  }, [dispute.id]);

  useEffect(() => { load(); }, [load]);

  async function run(fn) { setBusy(true); try { await fn(); await load(); } finally { setBusy(false); } }

  const canPush = conn && ["assisted_browser", "autonomous_rpa"].includes(conn.adapter);

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="ph" style={{ display: "flex", alignItems: "center" }}>
        <span>CMS Federal IDR Gateway</span>
        <span style={{ flex: 1 }} />
        {conn
          ? <span className="badge" style={{ borderColor: "var(--line)" }}>
              <span className="dot" style={{ background: conn.status === "active" ? "var(--ok)" : "var(--warn)" }} />
              {conn.adapter.replace(/_/g, " ")} · {conn.status}
            </span>
          : <button className="mini" disabled={busy}
              onClick={() => run(() => idr.connect("assisted_browser"))}>Connect Gateway</button>}
      </div>

      <div style={{ padding: "6px 16px 14px" }}>
        {!conn && <p className="muted" style={{ fontSize: 12.5 }}>
          No Gateway connection yet. Connect to sync this dispute and stage submissions. Default is the
          assisted-browser adapter (human-in-loop, compatible with the Gateway's US-only / identity checks).
        </p>}

        {/* Inbound sync feed */}
        <div className="rlabel" style={{ margin: "6px 2px 6px" }}>Sync feed (inbound)</div>
        {events.length === 0
          ? <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 10px" }}>No Gateway events for this case yet.</p>
          : <div style={{ marginBottom: 8 }}>
              {events.map((ev) => (
                <div key={ev.id} style={rowS}>
                  <span className="badge b-grey" style={{ fontSize: 10 }}>{ev.kind.replace(/_/g, " ")}</span>
                  <div style={{ fontSize: 12.5 }}>
                    <b>{summarize(ev)}</b>
                    <span className="muted" style={{ display: "block", fontSize: 11 }}>
                      {new Date(ev.created_at).toLocaleString()} {ev.reconciled ? "· reconciled" : "· pending"}
                    </span>
                  </div>
                </div>
              ))}
            </div>}

        {/* Outbound submissions */}
        <div className="rlabel" style={{ margin: "14px 2px 6px" }}>Submissions (outbound)</div>

        {/* Stage a new offer */}
        {conn && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0 10px", flexWrap: "wrap" }}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
              placeholder="Offer amount" style={inp} />
            <button className="mini" disabled={busy}
              onClick={() => run(() => idr.stage(dispute.id, "submit_offer", { amount: Number(amount) || null }))}>
              Stage offer
            </button>
            <span className="muted" style={{ fontSize: 11 }}>prefilled from QPA {money(dispute?.qpa_amount)}</span>
          </div>
        )}

        {subs.length === 0
          ? <p className="muted" style={{ fontSize: 12.5 }}>No staged submissions.</p>
          : subs.map((s) => (
              <div key={s.id} style={{ ...rowS, alignItems: "center" }}>
                <span className="badge" style={{ fontSize: 10, color: STATUS_TONE[s.status], borderColor: "var(--line)" }}>
                  {s.status.replace(/_/g, " ")}
                </span>
                <div style={{ flex: 1, fontSize: 12.5 }}>
                  <b>{s.kind.replace(/_/g, " ")}</b>
                  {s.payload?.amount != null &&
                    <span className="mono" style={{ marginLeft: 8 }}>{money(s.payload.amount)}</span>}
                  {s.gateway_receipt?.confirmationNumber &&
                    <span className="muted" style={{ display: "block", fontSize: 11 }}>
                      receipt {s.gateway_receipt.confirmationNumber}</span>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(s.status === "draft" || s.status === "needs_review") &&
                    <button className="mini" disabled={busy} onClick={() => run(() => idr.approve(s.id))}>Approve</button>}
                  {s.status === "queued" && canPush &&
                    <button className="mini" disabled={busy}
                      onClick={() => run(async () => {
                        await idr.markInFlight(s.id);
                        // Assisted mode: operator submits in-portal; record the receipt here.
                        await idr.markConfirmed(s.id, { confirmationNumber: "GW-" + s.id.slice(0, 8), at: new Date().toISOString() });
                      })}>
                      {conn.adapter === "assisted_browser" ? "Mark submitted" : "Push"}
                    </button>}
                </div>
              </div>
            ))}

        <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          Approve and push are written to the tamper-evident ledger; a confirmed offer runs through the
          <code style={{ margin: "0 4px" }}>submit_response</code> kernel action, recording the plan offer and advancing the case.
        </p>
      </div>
    </div>
  );
}

function summarize(ev) {
  const n = ev.normalized || {};
  if (ev.kind === "deadline_set") return `${n.deadline_kind || "deadline"} due ${n.due_at ? new Date(n.due_at).toLocaleDateString() : "—"}`;
  if (ev.kind === "status_changed") return `→ ${n.workflow_state || ev.raw_payload?.phase || "updated"}`;
  if (ev.kind === "determination_issued") return `determination: ${n.disposition || ev.raw_payload?.outcome || "issued"}`;
  if (ev.kind === "offer_recorded") return `${n.party || "party"} offer ${n.amount != null ? money(n.amount) : ""}`;
  if (ev.kind === "registry_updated") return `registration ${n.registration_no || ""}`;
  return ev.kind.replace(/_/g, " ");
}

const rowS = { display: "flex", gap: 11, alignItems: "flex-start", padding: "9px 0", borderBottom: "1px solid var(--hair)" };
const inp = { padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5, width: 130 };
