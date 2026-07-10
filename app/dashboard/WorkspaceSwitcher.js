"use client";
// Masthead workspace switcher — lists the orgs the signed-in account belongs to
// and switches the active one (updates app_users.org_id, which auth_org_id reads,
// so all RLS follows). Reloads into the chosen workspace.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";

const TIER_LABEL = { starter: "Starter", pro: "Pro", enterprise: "Enterprise" };

export function WorkspaceSwitcher({ fallback }) {
  const [orgs, setOrgs] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await supabase.rpc("my_orgs"); setOrgs(data || []); } catch (_) {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = orgs.find((o) => o.active);
  const name = active?.name || fallback || "Workspace";

  async function pick(o) {
    if (o.active) { setOpen(false); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("switch_org", { p_org: o.org_id });
      if (error) throw error;
      if (data && data.ok) { window.location.assign("/"); return; }
    } catch (_) {}
    setBusy(false); setOpen(false);
  }

  return (
    <div className="wsw">
      <button className="switch2" title={name} onClick={() => setOpen((v) => !v)}>
        <span className="col"><span className="eb">Workspace</span><span className="nm">{name}</span></span>
        <span className="cv">⌄</span>
      </button>
      {open && (
        <>
          <div className="wsw-bg" onClick={() => setOpen(false)} />
          <div className="wsw-menu" role="menu">
            <div className="wsw-h">Switch workspace</div>
            {orgs.length === 0 ? <div className="wsw-empty">No other workspaces.</div> : orgs.map((o) => (
              <div key={o.org_id} className={"wsw-item" + (o.active ? " on" : "")} role="menuitem" onClick={() => pick(o)}>
                <div className="wsw-nm"><b>{o.name}</b><span className="wsw-tier">{TIER_LABEL[o.tier] || o.tier}</span></div>
                {o.active ? <span className="wsw-check">✓ Current</span> : <span className="wsw-go">{busy ? "…" : "Switch →"}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
