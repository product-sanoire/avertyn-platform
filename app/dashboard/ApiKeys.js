// Avertyn Admin — API keys & webhooks management.
// Drop into app/dashboard/ and render inside the Admin tab, e.g. <ApiKeysView onErr={setErr} />.
// Uses the design-system classes already in globals.css (.panel/.ph/.btn/.badge/.rlabel/...).
"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";

const SCOPES = [
  ["cases:read:basic", "Read cases — redacted (no PHI, no amounts)"],
  ["cases:read", "Read cases + financials/identifiers"],
  ["cases:read:phi", "Read cases incl. PHI — needs BAA"],
  ["cases:write", "Create disputes, run actions"],
  ["metrics:read", "Read scorecards & exposure"],
  ["documents:read", "Read documents"],
  ["webhooks:manage", "Manage webhooks"],
];
const EVENTS = ["dispute.created", "dispute.state_changed", "eligibility.scored", "award.paid", "document.signed", "action.staged"];

export function ApiKeysView({ onErr }) {
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState("");
  const [newKey, setNewKey] = useState(null);         // { plaintext } shown once
  const [form, setForm] = useState({ name: "", env: "live", scopes: new Set(["cases:read"]) });
  const [hook, setHook] = useState({ url: "", events: new Set(["dispute.state_changed"]) });

  const load = useCallback(async () => {
    try {
      const [{ data: k }, { data: w }, { data: u }] = await Promise.all([
        supabase.from("api_keys").select("id, name, key_prefix, scopes, environment, created_at, last_used_at, revoked_at").order("created_at", { ascending: false }),
        supabase.from("webhook_endpoints").select("id, url, events, active, created_at").order("created_at", { ascending: false }),
        supabase.from("api_usage").select("billable_units, created_at").gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString()),
      ]);
      setKeys(k || []); setHooks(w || []);
      setUsage((u || []).reduce((a, r) => a + (r.billable_units || 0), 0));
    } catch (e) { onErr?.(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  async function createKey() {
    setBusy("create");
    try {
      const { data, error } = await supabase.rpc("api_key_create", {
        p_name: form.name || "Untitled key", p_scopes: [...form.scopes], p_environment: form.env,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      setNewKey(row);                    // show plaintext once
      setForm({ name: "", env: "live", scopes: new Set(["cases:read"]) });
      await load();
    } catch (e) { onErr?.(e.message); }
    setBusy("");
  }
  async function revoke(id) {
    setBusy("rev" + id);
    try { const { error } = await supabase.rpc("api_key_revoke", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { onErr?.(e.message); } setBusy("");
  }
  async function addHook() {
    setBusy("hook");
    try {
      const { error } = await supabase.rpc("webhook_register", { p_url: hook.url, p_events: [...hook.events] });
      if (error) throw error;
      setHook({ url: "", events: new Set(["dispute.state_changed"]) });
      await load();
    } catch (e) { onErr?.(e.message); } setBusy("");
  }
  async function delHook(id) {
    try { const { error } = await supabase.rpc("webhook_delete", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { onErr?.(e.message); }
  }
  const toggle = (set, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };

  return (
    <div>
      <div className="dh"><h1>API &amp; integrations</h1>
        <span className="sub">Issue keys so your apps can read and write Avertyn data · {usage != null ? usage.toLocaleString() : "—"} calls in 30d</span></div>

      {/* create key */}
      <div className="panel">
        <div className="ph">Create an API key</div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Key name (e.g. Acme CRM sync)"
              style={{ flex: 1, minWidth: 220, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit" }} />
            <select value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit" }}>
              <option value="live">Live</option><option value="test">Test (sandbox)</option>
            </select>
          </div>
          <div className="rlabel" style={{ marginTop: 14 }}>Scopes · least privilege</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {SCOPES.map(([s, label]) => (
              <label key={s} className={"badge" + (form.scopes.has(s) ? " b-ink" : "")} style={{ cursor: "pointer", padding: "6px 10px" }}>
                <input type="checkbox" checked={form.scopes.has(s)} onChange={() => setForm({ ...form, scopes: toggle(form.scopes, s) })} style={{ marginRight: 6 }} />
                {s}<span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>{label}</span>
              </label>
            ))}
          </div>
          <button className="btn btn-a" style={{ marginTop: 14 }} disabled={busy === "create"} onClick={createKey}>
            {busy === "create" ? "Creating…" : "Create key"}
          </button>
          {form.env === "live" && <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Live keys touch real PHI — ensure a BAA is on file for the consumer before sharing.</p>}
        </div>
      </div>

      {/* show-once plaintext */}
      {newKey && (
        <div className="panel" style={{ borderColor: "var(--sig-line)" }}>
          <div className="ph">Copy your key now — it won't be shown again</div>
          <div className="pb" style={{ paddingTop: 12 }}>
            <code className="mono" style={{ display: "block", padding: "12px 14px", background: "var(--sunk)", borderRadius: 10, wordBreak: "break-all", fontSize: 13 }}>{newKey.plaintext}</code>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-s" onClick={() => navigator.clipboard?.writeText(newKey.plaintext)}>Copy</button>
              <button className="btn btn-s" onClick={() => setNewKey(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* keys table */}
      <div className="panel">
        <div className="ph">Keys</div>
        {keys.length === 0 ? <p className="muted" style={{ padding: 16 }}>No keys yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Env</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                  <td><b>{k.name}</b></td>
                  <td className="mono">{k.key_prefix}…</td>
                  <td><span className={"badge " + (k.environment === "live" ? "b-ink" : "b-grey")}>{k.environment}</span></td>
                  <td className="muted" style={{ fontSize: 11 }}>{(k.scopes || []).join(", ")}</td>
                  <td className="mono">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "—"}</td>
                  <td>{k.revoked_at ? <span className="badge b-red">revoked</span>
                    : <button className="mini" disabled={busy === "rev" + k.id} onClick={() => revoke(k.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* webhooks */}
      <div className="panel">
        <div className="ph">Webhook endpoints
          <span className="act"><span className="muted" style={{ fontSize: 11 }}>we POST signed events to your URL</span></span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://your-app.com/avertyn/webhook"
              style={{ flex: 1, minWidth: 260, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit" }} />
            <button className="btn btn-s" disabled={busy === "hook" || !hook.url} onClick={addHook}>{busy === "hook" ? "Adding…" : "Add endpoint"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {EVENTS.map((ev) => (
              <label key={ev} className={"badge" + (hook.events.has(ev) ? " b-ink" : "")} style={{ cursor: "pointer", padding: "5px 9px" }}>
                <input type="checkbox" checked={hook.events.has(ev)} onChange={() => setHook({ ...hook, events: toggle(hook.events, ev) })} style={{ marginRight: 5 }} />{ev}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            {hooks.length === 0 ? <p className="muted">No endpoints.</p> : hooks.map((h) => (
              <div key={h.id} className="frow" style={{ alignItems: "center" }}>
                <div style={{ flex: 1 }}><b className="mono" style={{ fontSize: 12 }}>{h.url}</b>
                  <div className="sub">{(h.events || []).join(", ") || "all events"}</div></div>
                <button className="mini" onClick={() => delHook(h.id)}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
