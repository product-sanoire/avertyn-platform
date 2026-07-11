"use client";
// Avertyn — Legal register (/authorities).
// The living registry of the regulations/citations that back every brief. Shows each
// authority with its status, last-verified date and source; a review queue for
// AI-proposed substantive changes (approve/dismiss); and an on-demand "Verify now".
// Low-risk AI updates (renumbering, effective-date notes) auto-apply and flow straight
// into generated documents via the {{cite.CODE}} tokens; substantive changes wait here.
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

const STATUS_TONE = { verified: "green", flagged: "red", pending: "amber", superseded: "red", unverified: "grey" };

export default function AuthoritiesPage({ embedded }) {
  const [auths, setAuths] = useState([]);
  const [revs, setRevs] = useState([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const [{ data: a }, { data: r }] = await Promise.all([
      supabase.rpc("list_authorities"),
      supabase.rpc("list_authority_revisions", { p_open_only: true }),
    ]);
    setAuths(a || []); setRevs(r || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const proposals = revs.filter((r) => r.state === "proposed");
  const autoApplied = revs.filter((r) => r.state === "auto_applied");
  const lastChecked = auths.reduce((m, a) => (a.last_verified_at && a.last_verified_at > m ? a.last_verified_at : m), "");

  async function verifyNow() {
    setBusy("verify"); setErr(""); setMsg("");
    try {
      const { data, error } = await supabase.functions.invoke("verify-authorities", { body: {} });
      if (error) throw error;
      if (data?.ok === false) { setErr(data.reason || "Verification unavailable."); }
      else setMsg(`Checked ${data.checked}: ${data.verified} unchanged, ${data.auto_applied} auto-applied, ${data.held_for_review} held for review.`);
      await load();
    } catch (e) { setErr("Verify now unavailable: " + (e.message || e) + " · the weekly automatic check still runs."); }
    setBusy("");
  }
  async function decide(id, decision) {
    setBusy(id + decision);
    const { data, error } = await supabase.rpc("decide_authority_revision", { p_id: id, p_decision: decision });
    if (error || data?.ok === false) setErr(error?.message || data?.reason || "Action failed.");
    await load(); setBusy("");
  }

  const byTopic = auths.reduce((acc, a) => { (acc[a.topic || "Other"] ||= []).push(a); return acc; }, {});

  return (
    <div>
      {!embedded && (<div className="topbar"><span className="logo">A</span><b>Avertyn</b>
        <span style={{ color: "#d3cccd", fontSize: 13 }}>· Legal register</span></div>)}
      <div className="wrap" style={{ maxWidth: 1120, margin: embedded ? "0 auto" : "18px auto", padding: "0 22px" }}>
        {!embedded && <Link href="/" className="muted">← Command center</Link>}
        <div className="dh" style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div><h1>Legal register</h1>
            <span className="sub">The regulations and citations behind every brief — kept current by AI, verified against eCFR and the Federal Register. Documents cite these by reference, so an approved update flows into every new document automatically.</span></div>
          <div style={{ textAlign: "right" }}>
            <button className="btn btn-a" disabled={busy === "verify"} onClick={verifyNow}>{busy === "verify" ? "Verifying…" : "Verify now"}</button>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {lastChecked ? "Last verified " + new Date(lastChecked).toLocaleDateString() : "Not yet verified"} · auto-checks weekly
            </div>
          </div>
        </div>

        {err && <div className="badge b-red" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}
        {msg && <div className="badge b-green" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-green" />{msg}</div>}

        {/* Review queue */}
        {proposals.length > 0 && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="ph">Needs review · {proposals.length} substantive change{proposals.length === 1 ? "" : "s"}
              <span className="act"><span className="muted">AI-proposed; not applied until you approve</span></span></div>
            <div className="pb" style={{ paddingTop: 10 }}>
              {proposals.map((r) => (
                <div key={r.id} className="clause-row" style={{ borderColor: "var(--sig-line)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      <b className="code-in">{r.authority_code}</b> <span className="badge b-amber" style={{ marginLeft: 6 }}>{r.kind || "change"}</span>
                      <div style={{ fontSize: 13, marginTop: 4 }}>{r.field}: <span className="muted">{r.old_value || "—"}</span> → <b>{r.new_value}</b></div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{r.rationale}
                        {r.source_url && <> · <a href={r.source_url} target="_blank" rel="noreferrer">source</a></>}
                        {r.confidence != null && <> · confidence {Math.round(r.confidence * 100)}%</>}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <button className="btn btn-s" disabled={busy === r.id + "approve"} onClick={() => decide(r.id, "approve")}>Approve</button>
                      <button className="mini" disabled={busy === r.id + "dismiss"} onClick={() => decide(r.id, "dismiss")}>Dismiss</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {autoApplied.length > 0 && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="ph">Recently auto-applied · {autoApplied.length}<span className="act"><span className="muted">low-risk updates already live in documents</span></span></div>
            <div className="pb" style={{ paddingTop: 8 }}>
              {autoApplied.slice(0, 8).map((r) => (
                <div key={r.id} className="ver-row">
                  <span className="code-in vv">{r.authority_code}</span>
                  <span>{r.field}: {r.old_value} → {r.new_value}</span>
                  <span style={{ flex: 1 }} />
                  <span>{new Date(r.proposed_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Register */}
        {Object.keys(byTopic).sort().map((topic) => (
          <div className="panel" key={topic} style={{ marginTop: 16 }}>
            <div className="ph">{topic}</div>
            <div className="pb" style={{ paddingTop: 6 }}>
              {byTopic[topic].map((a) => (
                <div key={a.code} style={{ padding: "11px 0", borderBottom: "1px solid var(--hair,#eee)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                    <div style={{ minWidth: 0 }}>
                      <b style={{ fontFamily: "var(--num,monospace)" }}>{a.citation}</b>
                      {!a.operative && <span className="badge b-amber" style={{ marginLeft: 8 }}>pending</span>}
                      <span className="code-in muted" style={{ marginLeft: 8, fontSize: 11 }}>{a.code}</span>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{a.summary}</div>
                      {a.mirrors && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Mirrors: {a.mirrors}</div>}
                      {a.effective_note && <div style={{ fontSize: 11.5, marginTop: 3, color: "var(--warn,#916412)" }}>⚑ {a.effective_note}</div>}
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className={"badge b-" + (STATUS_TONE[a.status] || "grey")}><i className={"dot d-" + (STATUS_TONE[a.status] || "grey")} />{a.status}</span>
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {a.last_verified_at ? "verified " + new Date(a.last_verified_at).toLocaleDateString() : "unverified"}
                        {a.source_url && <> · <a href={a.source_url} target="_blank" rel="noreferrer">eCFR</a></>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
