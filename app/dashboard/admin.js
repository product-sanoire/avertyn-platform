"use client";
// Avertyn — Admin. Three surfaces:
//   • Access   — SSO (SAML/OIDC), SCIM provisioning tokens, users & roles
//   • Reports  — scheduled reports (pg_cron) over the custom-report engine
//   • Integrations — the eligibility pre-screen API (reused Tier-A view)
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useLive } from "../../lib/useLive";
import { IntegrationsView, DeadlinesView } from "./tiera";

const ROLES = ["admin", "manager", "analyst", "auditor", "viewer"];
const METRICS = [["count", "Dispute count"], ["defended", "Dollars defended"], ["demand", "Total demand"], ["qpa", "Total QPA"], ["avg_score", "Avg ineligibility"]];
const DIMS = [["initiator", "Initiator"], ["plan", "Plan"], ["state", "Workflow state"], ["cpt", "CPT"], ["month", "Month"]];
const CADENCE = ["hourly", "daily", "weekly", "monthly"];
const SCIM_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ssjougrsaecdwfuxeasd.supabase.co") + "/functions/v1/scim";
const ADMIN = [["access", "Access"], ["reports", "Reports"], ["alerts", "Alerts"], ["integrations", "Integrations"]];

async function sha256Hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function genToken(pfx) {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return pfx + [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function money(n) { return n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }

export function AdminView({ orgId, onErr }) {
  const [seg, setSeg] = useState("access");
  return (
    <div>
      <div className="shead">
        <div className="stitle">
          <h1>Admin</h1>
          <span className="sub">Identity, provisioning, scheduled reporting and API distribution — the controls IT and compliance ask for</span>
        </div>
        <div className="seg">
          {ADMIN.map(([k, l]) => <button key={k} className={seg === k ? "on" : ""} onClick={() => setSeg(k)}>{l}</button>)}
        </div>
      </div>
      {seg === "access" ? <AccessView orgId={orgId} onErr={onErr} />
        : seg === "reports" ? <ReportsView orgId={orgId} onErr={onErr} />
        : seg === "alerts" ? <DeadlinesView orgId={orgId} onErr={onErr} embedded />
        : <IntegrationsView onErr={onErr} embedded />}
    </div>
  );
}

// ============================================================ Access
function AccessView({ orgId, onErr }) {
  const [sso, setSso] = useState(null);
  const [form, setForm] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [users, setUsers] = useState([]);
  const [fresh, setFresh] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [nu, setNu] = useState({ email: "", full_name: "", role: "analyst" });

  const load = useCallback(async () => {
    try {
      const [s, t, u] = await Promise.all([
        supabase.from("sso_connections").select("*").limit(1).maybeSingle(),
        supabase.from("scim_tokens").select("id, label, last_used, created_at").order("created_at", { ascending: false }),
        supabase.from("app_users").select("id, email, full_name, role, active, external_id, created_at").order("created_at", { ascending: true }),
      ]);
      setSso(s.data || null);
      setForm(s.data || { protocol: "oidc", idp_name: "", email_domain: "", entity_id: "", sso_url: "", certificate: "", client_id: "", default_role: "analyst", enforced: false, status: "active" });
      setTokens(t.data || []); setUsers(u.data || []);
    } catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("access", ["app_users", "scim_tokens", "sso_connections"], load);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function saveSso() {
    setBusy("sso");
    try {
      const row = { protocol: form.protocol, idp_name: form.idp_name, email_domain: form.email_domain, entity_id: form.entity_id, sso_url: form.sso_url, certificate: form.certificate || null, client_id: form.client_id || null, default_role: form.default_role, enforced: !!form.enforced, status: form.status || "active" };
      let error;
      if (sso?.id) ({ error } = await supabase.from("sso_connections").update(row).eq("id", sso.id));
      else ({ error } = await supabase.from("sso_connections").insert({ ...row, org_id: orgId }));
      if (error) throw error;
      await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function makeToken() {
    setBusy("tok");
    try {
      const tok = genToken("avn_scim_");
      const hash = await sha256Hex(tok);
      const { error } = await supabase.from("scim_tokens").insert({ org_id: orgId, token_hash: hash, label: label.trim() || "SCIM token" });
      if (error) throw error;
      setFresh(tok); setLabel(""); await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function revokeToken(id) {
    try { const { error } = await supabase.from("scim_tokens").delete().eq("id", id); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }
  async function setRole(id, role) {
    try { const { error } = await supabase.from("app_users").update({ role }).eq("id", id); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }
  async function setActive(id, active) {
    try { const { error } = await supabase.from("app_users").update({ active }).eq("id", id); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }
  async function addUser() {
    if (!nu.email.trim()) return;
    setBusy("user");
    try {
      const { error } = await supabase.rpc("scim_provision_user", { p_org: orgId, p_email: nu.email.trim(), p_name: nu.full_name.trim() || nu.email.trim(), p_role: nu.role });
      if (error) throw error;
      setNu({ email: "", full_name: "", role: "analyst" }); await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }

  if (!form) return <p className="muted">Loading…</p>;
  return (
    <div>
      {/* SSO */}
      <div className="panel">
        <div className="ph">Single sign-on
          <span className="act">{sso?.status && <span className={"badge " + (sso.enforced ? "b-green" : "b-amber")}><i className={"dot d-" + (sso.enforced ? "green" : "amber")} />{sso.enforced ? "Enforced" : "Optional"}</span>}</span>
        </div>
        <div className="pb" style={{ paddingTop: 14 }}>
          <div className="fgrid">
            <Field l="Protocol"><select className="dsel" value={form.protocol} onChange={(e) => setF("protocol", e.target.value)}><option value="oidc">OIDC</option><option value="saml">SAML 2.0</option></select></Field>
            <Field l="Identity provider"><input value={form.idp_name || ""} onChange={(e) => setF("idp_name", e.target.value)} placeholder="Okta / Azure AD / OneLogin" /></Field>
            <Field l="Email domain"><input value={form.email_domain || ""} onChange={(e) => setF("email_domain", e.target.value)} placeholder="acme.com" /></Field>
            <Field l="Default role"><select className="dsel" value={form.default_role} onChange={(e) => setF("default_role", e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
            <Field l={form.protocol === "saml" ? "Entity ID (issuer)" : "Issuer URL"}><input value={form.entity_id || ""} onChange={(e) => setF("entity_id", e.target.value)} placeholder="https://idp.example/…" /></Field>
            <Field l={form.protocol === "saml" ? "SAML SSO URL" : "Authorization endpoint"}><input value={form.sso_url || ""} onChange={(e) => setF("sso_url", e.target.value)} placeholder="https://idp.example/sso" /></Field>
            {form.protocol === "oidc"
              ? <Field l="Client ID"><input value={form.client_id || ""} onChange={(e) => setF("client_id", e.target.value)} placeholder="0oa…" /></Field>
              : <Field l="Signing certificate (PEM)" wide><textarea value={form.certificate || ""} onChange={(e) => setF("certificate", e.target.value)} rows={3} placeholder="-----BEGIN CERTIFICATE-----" /></Field>}
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--mut)" }}>
              <input type="checkbox" checked={!!form.enforced} onChange={(e) => setF("enforced", e.target.checked)} />Enforce SSO for this domain (block password login)
            </label>
            <button className="btn btn-a" style={{ marginLeft: "auto" }} disabled={busy === "sso"} onClick={saveSso}>{busy === "sso" ? "Saving…" : sso?.id ? "Update SSO" : "Enable SSO"}</button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>Reply URL / ACS: <code className="mono">{(process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ssjougrsaecdwfuxeasd.supabase.co")}/auth/v1/callback</code> — register this with your IdP. Enforcement is applied at login once your IdP handshake is verified.</p>
        </div>
      </div>

      {/* SCIM */}
      <div className="panel">
        <div className="ph">SCIM provisioning
          <span className="act" style={{ display: "flex", gap: 8 }}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Token label…" style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12 }} />
            <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "tok"} onClick={makeToken}>{busy === "tok" ? "Minting…" : "Mint token"}</button>
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <span className="badge b-ink">SCIM 2.0</span>
            <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{SCIM_BASE}</code>
            <button className="mini" onClick={() => navigator.clipboard?.writeText(SCIM_BASE)}>Copy base URL</button>
          </div>
          {fresh && (
            <div style={{ background: "#f4f3f1", border: "1px solid var(--ok)", borderRadius: 10, padding: "11px 13px", marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "var(--ok)", fontWeight: 600, marginBottom: 6 }}>New token — copy it now, it won't be shown again. Paste it as the bearer token in your IdP's SCIM config.</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{fresh}</code>
                <button className="mini" onClick={() => navigator.clipboard?.writeText(fresh)}>Copy</button>
                <button className="mini" onClick={() => setFresh("")}>Done</button>
              </div>
            </div>
          )}
          {tokens.length === 0 ? <p className="muted">No SCIM tokens yet. Mint one and give it to your IdP to auto-provision users.</p> : (
            <table>
              <thead><tr><th>Label</th><th>Last used</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.label}</b></td>
                    <td className="muted" style={{ fontSize: 11 }}>{t.last_used ? new Date(t.last_used).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{new Date(t.created_at).toLocaleDateString()}</td>
                    <td><button className="mini" onClick={() => revokeToken(t.id)}>Revoke</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Users */}
      <div className="panel">
        <div className="ph">Users &amp; roles
          <span className="act" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} placeholder="email@org.com" style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12, width: 150 }} />
            <input value={nu.full_name} onChange={(e) => setNu({ ...nu, full_name: e.target.value })} placeholder="Full name" style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12, width: 120 }} />
            <select className="dsel" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
            <button className="btn btn-s" style={{ padding: "7px 12px" }} disabled={busy === "user"} onClick={addUser}>Add</button>
          </span>
        </div>
        {users.length === 0 ? <p className="muted" style={{ padding: 16 }}>No users yet.</p> : (
          <table>
            <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Source</th><th>Status</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.full_name || "—"}</b></td>
                  <td className="mono" style={{ fontSize: 11 }}>{u.email}</td>
                  <td><select className="dsel" value={u.role || "analyst"} onChange={(e) => setRole(u.id, e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></td>
                  <td>{u.external_id ? <span className="badge b-grey">SCIM</span> : <span className="badge b-grey">manual</span>}</td>
                  <td><button className={"badge " + (u.active ? "b-green" : "b-grey")} onClick={() => setActive(u.id, !u.active)} style={{ cursor: "pointer", border: 0 }}>{u.active ? "active" : "inactive"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ l, wide, children }) {
  return <label className={"afield" + (wide ? " wide" : "")}><span className="rlabel" style={{ margin: "0 0 4px" }}>{l}</span>{children}</label>;
}

// ============================================================ Reports
function ReportsView({ orgId, onErr }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [form, setForm] = useState({ name: "", metric: "defended", dim: "initiator", cadence: "weekly", recipients: "" });
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try { const { data, error } = await supabase.from("scheduled_reports").select("*").order("created_at", { ascending: false }); if (error) throw error; setRows(data || []); }
    catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("reports", ["scheduled_reports"], load);

  useEffect(() => {
    let live = true;
    if (!orgId) return;
    supabase.rpc("report_custom", { p_org: orgId, p_metric: form.metric, p_dim: form.dim }).then(({ data }) => { if (live) setPreview(data || null); });
    return () => { live = false; };
  }, [orgId, form.metric, form.dim]);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function create() {
    if (!form.name.trim()) return;
    setBusy("create");
    try {
      const { error } = await supabase.from("scheduled_reports").insert({ org_id: orgId, name: form.name.trim(), metric: form.metric, dim: form.dim, cadence: form.cadence, recipients: form.recipients.trim() });
      if (error) throw error;
      setForm({ ...form, name: "", recipients: "" }); await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function runNow(id) {
    setBusy("run" + id); setNote("");
    try {
      const { data, error } = await supabase.rpc("run_scheduled_report", { p_id: id });
      if (error) throw error;
      setNote(`Ran “${data?.report}” — total ${data?.total} · queued to ${data?.recipients ?? 0} recipient(s).`);
      await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function del(id) {
    try { const { error } = await supabase.from("scheduled_reports").delete().eq("id", id); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }

  const prevRows = (preview?.rows || []).slice(0, 6);
  const prevMax = Math.max(1, ...prevRows.map((r) => Number(r.value) || 0));
  const isMoney = ["defended", "demand", "qpa"].includes(form.metric);

  return (
    <div>
      <div className="panel">
        <div className="ph">New scheduled report<span className="act"><span className="muted" style={{ fontSize: 11 }}>runs on pg_cron, delivered to recipients via your notification channels</span></span></div>
        <div className="pb" style={{ paddingTop: 14 }}>
          <div className="fgrid">
            <Field l="Report name"><input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="Weekly defended dollars by initiator" /></Field>
            <Field l="Metric"><select className="dsel" value={form.metric} onChange={(e) => setF("metric", e.target.value)}>{METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field l="Group by"><select className="dsel" value={form.dim} onChange={(e) => setF("dim", e.target.value)}>{DIMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field l="Cadence"><select className="dsel" value={form.cadence} onChange={(e) => setF("cadence", e.target.value)}>{CADENCE.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field l="Recipients (comma-separated email)" wide><input value={form.recipients} onChange={(e) => setF("recipients", e.target.value)} placeholder="broker@acme.com, cfo@acme.com" /></Field>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div className="rlabel">Live preview · {METRICS.find((m) => m[0] === form.metric)?.[1]} by {DIMS.find((d) => d[0] === form.dim)?.[1]}</div>
              {prevRows.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No data for this cut yet.</p> : prevRows.map((r, i) => {
                const w = (Number(r.value) / prevMax) * 100;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
                    <div style={{ width: 130, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
                    <div style={{ flex: 1, height: 12, background: "var(--sunk)", borderRadius: 999, overflow: "hidden" }}><div style={{ height: "100%", width: w + "%", background: "var(--c-indigo)", borderRadius: 999 }} /></div>
                    <div className="mono" style={{ width: 76, textAlign: "right", fontSize: 12 }}>{isMoney ? money(r.value) : r.value}</div>
                  </div>
                );
              })}
            </div>
            <button className="btn btn-a" disabled={busy === "create" || !form.name.trim()} onClick={create}>{busy === "create" ? "Saving…" : "Schedule report"}</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">Scheduled reports<span className="act">{note && <span className="badge b-green"><i className="dot d-green" />{note}</span>}</span></div>
        {rows.length === 0 ? <p className="muted" style={{ padding: 16 }}>No scheduled reports yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Cut</th><th>Cadence</th><th>Recipients</th><th>Last run</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{METRICS.find((m) => m[0] === r.metric)?.[1] || r.metric} · {DIMS.find((d) => d[0] === r.dim)?.[1] || r.dim}</td>
                  <td><span className="badge b-grey">{r.cadence}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.recipients || "—"}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.last_run ? new Date(r.last_run).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never"}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="mini" disabled={busy === "run" + r.id} onClick={() => runNow(r.id)}>{busy === "run" + r.id ? "Running…" : "Run now"}</button>
                    <button className="mini" onClick={() => del(r.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
