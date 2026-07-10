"use client";
// Persistent "Getting started" launcher shown on the Overview until the operator
// finishes onboarding (or dismisses it). Auto-hides once every required step for
// the tier is satisfied — and stamps the org onboarded so it never nags again.
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { progressFor } from "../onboarding/steps";

export function GettingStarted() {
  const router = useRouter();
  const [st, setSt] = useState(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await supabase.rpc("onboarding_state"); if (data && data.ok) setSt(data); } catch (_) {}
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);
  useEffect(() => {
    if (!st || st.onboarded_at) return;
    const p = progressFor(st);
    if (p.pct === 100) { (async () => { try { await supabase.rpc("onboarding_complete"); } catch (_) {} setHidden(true); })(); }
  }, [st]);

  if (!st || hidden || st.onboarded_at || (st.onboarding && st.onboarding.dismissed)) return null;
  const prog = progressFor(st);
  if (prog.total === 0 || prog.pct === 100) return null;

  async function dismiss(e) { e.stopPropagation(); try { await supabase.rpc("onboarding_dismiss", { p_dismissed: true }); } catch (_) {} setHidden(true); }

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
      </div>
      <div className="gs-actions">
        <button className="gs-resume" onClick={(e) => { e.stopPropagation(); router.push("/onboarding"); }}>Resume setup →</button>
        <button className="gs-x" title="Dismiss" onClick={dismiss}>✕</button>
      </div>
    </div>
  );
}
