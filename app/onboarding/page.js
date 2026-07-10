"use client";
// Avertyn — operator onboarding. A branded, tier-aware guided setup that takes a
// new operator from nothing to a working platform, auto-advancing as real data
// lands. Resumable; deep-links into the app for heavier steps and offers inline
// quick-setup for the essentials.
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { TIERS, GROUPS, stepsForTier, stepDone, progressFor } from "./steps";

const KINDS = ["Third-party administrator", "Plan administrator", "Self-funded employer", "Broker / consultant", "Health plan"];
const ROLES = ["admin", "manager", "analyst", "auditor", "viewer"];

export default function Onboarding() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);            // expanded step key
  const [tierOpen, setTierOpen] = useState(false);
  const [company, setCompany] = useState({ name: "", kind: KINDS[0] });
  const [planF, setPlanF] = useState({ name: "", plan_type: "", employer: "" });
  const [teamF, setTeamF] = useState({ email: "", full_name: "", role: "analyst" });
  const mounted = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.push("/login"); return; }
      const { data, error } = await supabase.rpc("onboarding_state");
      if (error) throw error;
      if (data?.ok === false) { setErr("No workspace is linked to your account yet."); setLoading(false); return; }
      setSt(data);
      if (!mounted.current) { setCompany((c) => ({ ...c, name: data.org?.name || "", kind: data.org?.kind || KINDS[0] })); mounted.current = true; }
      setLoading(false);
    } catch (e) { setErr(e.message || String(e)); setLoading(false); }
  }, [router]);
  useEffect(() => { load(); }, [load]);
  // re-detect when returning from a deep-linked step
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [load]);

  async function rpc(name, args, tag) {
    setBusy(tag || name); setErr("");
    try { const { error } = await supabase.rpc(name, args); if (error) throw error; await load(); }
    catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  const chooseTier = (t) => rpc("onboarding_set_tier", { p_tier: t }, "tier:" + t);
  async function saveCompany() {
    setBusy("company"); setErr("");
    try {
      const { error } = await supabase.rpc("set_org_profile", { p_name: company.name, p_kind: company.kind }); if (error) throw error;
      await supabase.rpc("onboarding_mark", { p_key: "company", p_done: true });
      setOpen(null); await load();
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function addPlan() {
    if (!planF.name.trim()) return;
    setBusy("plan"); setErr("");
    try {
      const { error } = await supabase.rpc("onboarding_add_plan", { p_name: planF.name, p_plan_type: planF.plan_type || null, p_employer: planF.employer || null });
      if (error) throw error; setPlanF({ name: "", plan_type: "", employer: "" }); await load();
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  async function inviteTeam() {
    if (!teamF.email.trim() || !st?.org?.id) return;
    setBusy("team"); setErr("");
    try {
      const { error } = await supabase.rpc("scim_provision_user", { p_org: st.org.id, p_email: teamF.email.trim(), p_name: teamF.full_name.trim() || teamF.email.trim(), p_role: teamF.role });
      if (error) throw error; setTeamF({ email: "", full_name: "", role: "analyst" }); await load();
    } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  }
  const confirmStep = (key) => rpc("onboarding_mark", { p_key: key, p_done: true }, "confirm:" + key);
  const goto = (href) => { router.push(href); };
  async function dismiss() { try { await supabase.rpc("onboarding_dismiss", { p_dismissed: true }); } catch (_) {} router.push("/"); }
  async function finish() { try { await supabase.rpc("onboarding_complete"); } catch (_) {} router.push("/"); }

  if (loading) return <div className="onb-shell"><div className="onb-wrap"><p className="muted" style={{ color: "#cfc9c2" }}>Loading your setup…</p></div></div>;
  if (!st) return <div className="onb-shell"><div className="onb-wrap"><p style={{ color: "#e7c9c0" }}>{err || "Couldn't load onboarding."}</p></div></div>;

  const tier = st.tier || "starter";
  const prog = progressFor(st);
  const complete = prog.done === prog.total && prog.total > 0;
  const R = 46, C = 2 * Math.PI * R, off = C * (1 - prog.pct / 100);
  const s = st.signals || {};

  const groupSteps = (g) => stepsForTier(tier).filter((x) => x.group === g);

  return (
    <div className="onb-shell">
      {/* top bar */}
      <div className="onb-top">
        <div className="onb-brand">
          <span className="onb-mark"><svg viewBox="0 0 512 512"><g fill="none" stroke="#F5F4F2" strokeWidth="44" strokeLinecap="butt" strokeLinejoin="round"><path d="M172 374 L244 196" /><path d="M340 374 L268 196" /></g><circle cx="256" cy="182" r="27" fill="#B23A2A" /></svg></span>
          <span>Avertyn setup</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="onb-ghost" onClick={dismiss}>Skip for now</button>
          <button className="onb-enter" onClick={finish}>Enter platform →</button>
        </div>
      </div>

      <div className="onb-wrap">
        {/* hero */}
        <div className="onb-hero">
          <div className="onb-ring">
            <svg viewBox="0 0 110 110">
              <circle cx="55" cy="55" r={R} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="9" />
              <circle cx="55" cy="55" r={R} fill="none" stroke={complete ? "#5fbf8a" : "#B23A2A"} strokeWidth="9" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 55 55)" style={{ transition: "stroke-dashoffset .5s ease" }} />
              <text x="55" y="52" textAnchor="middle" fontFamily="var(--num)" fontSize="24" fontWeight="600" fill="#fff">{prog.pct}%</text>
              <text x="55" y="70" textAnchor="middle" fontFamily="var(--sans)" fontSize="9" fill="rgba(255,255,255,.6)">{prog.done}/{prog.total} done</text>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="onb-h1">{complete ? "You're all set." : "Let's get you filing."}</h1>
            <p className="onb-sub">
              {complete
                ? "Your platform is fully configured. Jump in — everything below can still be revisited from Admin."
                : prog.next ? <>Next: <b style={{ color: "#fff" }}>{prog.next.title}</b> · about {prog.remainMin} min of setup left.</>
                : "Pick a plan to tailor your setup."}
            </p>
            <div className="onb-tierchip">
              <span className="onb-plan">{TIERS.find((t) => t.key === tier)?.name} plan</span>
              <button className="onb-link" onClick={() => setTierOpen((v) => !v)}>{tierOpen ? "Close" : "Change plan"}</button>
            </div>
          </div>
        </div>

        {err && <div className="onb-err">{err}</div>}

        {/* tier picker */}
        {tierOpen && (
          <div className="onb-tiers">
            {TIERS.map((t) => (
              <div key={t.key} className={"onb-tier" + (t.key === tier ? " on" : "")} onClick={() => { chooseTier(t.key); setTierOpen(false); }}>
                <div className="onb-tier-h"><b>{t.name}</b>{t.key === tier && <span className="onb-badge">Current</span>}</div>
                <div className="onb-tier-tag">{t.tag}</div>
                <p className="onb-tier-blurb">{t.blurb}</p>
                <ul>{t.feats.map((f, i) => <li key={i}>{f}</li>)}</ul>
                <button className={"onb-tier-btn" + (t.key === tier ? " on" : "")}>{t.key === tier ? "Selected" : "Choose " + t.name}</button>
              </div>
            ))}
          </div>
        )}

        {complete && (
          <div className="onb-done">
            <b>🎉 Setup complete — {TIERS.find((t) => t.key === tier)?.name} plan.</b>
            <button className="onb-enter" onClick={finish}>Enter your platform →</button>
          </div>
        )}

        {/* step groups */}
        {GROUPS.map((g) => {
          const gs = groupSteps(g); if (gs.length === 0) return null;
          const gdone = gs.filter((x) => stepDone(x, st)).length;
          return (
            <div key={g} className="onb-group">
              <div className="onb-glabel">{g}<span className="onb-gcount">{gdone}/{gs.length}</span></div>
              {gs.map((step, i) => {
                const done = stepDone(step, st);
                const isOpen = open === step.key && !done;
                return (
                  <div key={step.key} className={"onb-card" + (done ? " done" : "") + (step.milestone ? " milestone" : "")}>
                    <div className="onb-card-h" onClick={() => setOpen(isOpen ? null : step.key)}>
                      <span className={"onb-check" + (done ? " on" : "")}>{done ? "✓" : i + 1}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="onb-card-t">{step.title}{step.milestone && <span className="onb-badge amber">Activation</span>}</div>
                        <div className="onb-card-d">{step.desc}</div>
                      </div>
                      {done ? <span className="onb-done-tag">Done</span> : <span className="onb-chev">{isOpen ? "▾" : "▸"}</span>}
                    </div>

                    {isOpen && (
                      <div className="onb-card-b">
                        {step.kind === "inline" && step.key === "company" && (
                          <div className="onb-form">
                            <label>Legal name<input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} placeholder="Acme Plan Administrators, LLC" /></label>
                            <label>Operator type<select value={company.kind} onChange={(e) => setCompany({ ...company, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
                            <button className="onb-btn" disabled={busy === "company"} onClick={saveCompany}>{busy === "company" ? "Saving…" : "Save"}</button>
                          </div>
                        )}
                        {step.kind === "inline" && step.key === "plans" && (
                          <>
                            <div className="onb-hint">{s.plans || 0} plan{(s.plans || 0) === 1 ? "" : "s"} · {s.employers || 0} sponsor{(s.employers || 0) === 1 ? "" : "s"} added.</div>
                            <div className="onb-form">
                              <label>Plan name<input value={planF.name} onChange={(e) => setPlanF({ ...planF, name: e.target.value })} placeholder="Summit HDHP" /></label>
                              <label>Plan type<input value={planF.plan_type} onChange={(e) => setPlanF({ ...planF, plan_type: e.target.value })} placeholder="HDHP / PPO / EPO" /></label>
                              <label>Sponsor / employer<input value={planF.employer} onChange={(e) => setPlanF({ ...planF, employer: e.target.value })} placeholder="Harbor Benefits" /></label>
                              <button className="onb-btn" disabled={busy === "plan" || !planF.name.trim()} onClick={addPlan}>{busy === "plan" ? "Adding…" : "+ Add plan"}</button>
                            </div>
                          </>
                        )}
                        {step.kind === "inline" && step.key === "team" && (
                          <>
                            <div className="onb-hint">{s.users || 0} member{(s.users || 0) === 1 ? "" : "s"}{s.sso ? " · SSO enabled" : ""}.</div>
                            <div className="onb-form">
                              <label>Email<input value={teamF.email} onChange={(e) => setTeamF({ ...teamF, email: e.target.value })} placeholder="teammate@yourtpa.com" /></label>
                              <label>Name<input value={teamF.full_name} onChange={(e) => setTeamF({ ...teamF, full_name: e.target.value })} placeholder="Jordan Ellis" /></label>
                              <label>Role<select value={teamF.role} onChange={(e) => setTeamF({ ...teamF, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
                              <button className="onb-btn" disabled={busy === "team" || !teamF.email.trim()} onClick={inviteTeam}>{busy === "team" ? "Adding…" : "+ Invite"}</button>
                            </div>
                            <button className="onb-link" onClick={() => goto("/?tab=admin")}>Set up SSO / SCIM instead →</button>
                          </>
                        )}
                        {(step.kind === "link" || step.kind === "confirm") && (
                          <div className="onb-actions">
                            {step.href && <button className="onb-btn" onClick={() => goto(step.href)}>{step.cta || "Open"} →</button>}
                            {step.kind === "confirm" && <button className="onb-btn ghost" disabled={busy === "confirm:" + step.key} onClick={() => confirmStep(step.key)}>{busy === "confirm:" + step.key ? "…" : (step.confirmLabel || "Mark done")}</button>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        <div className="onb-foot">
          <button className="onb-ghost" onClick={dismiss}>I'll finish later</button>
          <span className="muted" style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>Progress saves automatically. Resume any time from the home screen.</span>
        </div>
      </div>
    </div>
  );
}
