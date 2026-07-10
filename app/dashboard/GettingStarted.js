"use client";
// Persistent "Getting started" launcher shown on the Overview until onboarding is
// finished. The ✕ hides it only until the next sign-in (per-session, not permanent);
// it can be brought back anytime from Admin → "Getting started checklist".
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { progressFor } from "../onboarding/steps";

const GS_SESSION_KEY = "avertyn.gs.hiddenThisSession";

export function GettingStarted() {
  const router = useRouter();
  const [st, setSt] = useState(null);
  const [hidden, setHidden] = useState(false);

  // Per-session dismissal: honoured for this browser session, cleared on a fresh sign-in.
  useEffect(() => {
    try { if (sessionStorage.getItem(GS_SESSION_KEY) === "1") setHidden(true); } catch (_) {}
  }, []);

  const load = useCallback(async () => {
    try { const { data } = await supabase.rpc("onboarding_state"); if (data && data.ok) setSt(data); } catch (_) {}
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  // A new sign-in clears the per-session dismissal so the checklist returns.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") { try { sessionStorage.removeItem(GS_SESSION_KEY); } catch (_) {} setHidden(false); load(); }
    });
    return () => { try { sub.subscription.unsubscribe(); } catch (_) {} };
  }, [load]);

  useEffect(() => {
    if (!st || st.onboarded_at) return;
    const p = progressFor(st);
    if (p.pct === 100) { (async () => { try { await supabase.rpc("onboarding_complete"); } catch (_) {} setHidden(true); })(); }
  }, [st]);

  if (!st || hidden || st.onboarded_at || (st.onboarding && st.onboarding.dismissed)) return null;
  const prog = progressFor(st);
  if (prog.total === 0 || prog.pct === 100) return null;

  // ✕ hides the launcher for this session only — no permanent server-side dismiss.
  function dismiss(e) {
    e.stopPropagation();
    try { sessionStorage.setItem(GS_SESSION_KEY, "1"); } catch (_) {}
    setHidden(true);
  }

  return (
    <div className="gs-card" onClick={() => router.push("/onboarding")} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") router.push("/onboarding"); }}>
      <div className="gs-ring" style={{ background: `conic-gradient(var(--sig) ${prog.pct * 3.6}deg, rgba(255,255,255,.16) 0)` }}>
        <span>{prog.pct}%</span>
      </div>
      <div className="gs-body">
        <div className="gs-title">Finish setting up Avertyn <span className="gs-count">{prog.done} of {prog.total} steps</span></div>
        <div className="gs-next">{prog.next ? <>Up next <b>{prog.next.title}</b> · about {prog.remainMin} min left</> : "Almost there"}</div>
        <div className="gs-bar"><i style={{ width: `${prog.pct}%` }} /></div>
        <div style={{ marginTop: 9, fontSize: 10.5, lineHeight: 1.4, color: "rgba(255,255,255,.42)" }}>
          The ✕ hides this until your next sign-in · bring it back anytime from{" "}
          <b style={{ color: "rgba(255,255,255,.62)", fontWeight: 600 }}>Admin → Getting started checklist</b>
        </div>
      </div>
      <div className="gs-actions">
        <button className="gs-resume" onClick={(e) => { e.stopPropagation(); router.push("/onboarding"); }}>Resume setup →</button>
        <button className="gs-x" title="Hide until my next sign-in" onClick={dismiss}>✕</button>
      </div>
    </div>
  );
}
