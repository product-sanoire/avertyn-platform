"use client";
// Avertyn — Admin. Three surfaces:
//   • Access   — SSO (SAML/OIDC), SCIM provisioning tokens, users & roles
//   • Reports  — scheduled reports (pg_cron) over the custom-report engine
//   • Integrations — the eligibility pre-screen API (reused Tier-A view)
import { useEffect, useState, useCallback } from "react";
import { ApiKeysView } from "./ApiKeys";
import { CeilingsView } from "./ceilings";
import { supabase } from "../../lib/supabaseClient";
import { useLive } from "../../lib/useLive";
import { IntegrationsView, DeadlinesView } from "./tiera";

const ROLES = ["admin", "manager", "analyst", "auditor", "viewer"];
const METRICS = [["count", "Dispute count"], ["defended", "Dollars defended"], ["demand", "Total demand"], ["qpa", "Total QPA"], ["avg_score", "Avg ineligibility"]];
const DIMS = [["initiator", "Initiator"], ["plan", "Plan"], ["state", "Workflow state"], ["cpt", "CPT"], ["month", "Month"]];
const CADENCE = ["hourly", "daily", "weekly", "monthly"];
const SCIM_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ssjougrsaecdwfuxeasd.supabase.co") + "/functions/v1/scim";
const ADMIN = [["roi", "ROI"], ["access", "Access"], ["reports", "Reports"], ["model", "Model"], ["governance", "Governance"], ["audit", "Audit"], ["alerts", "Alerts"], ["qpa", "QPA index"], ["ceilings", "Ceilings"], ["integrations", "Integrations"], ["api", "API"], ["webhooks", "Webhooks"]];

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
          <h1 className="vh">Org controls</h1>
          <span className="sub">Identity, provisioning, scheduled reporting and API distribution — the controls IT and compliance ask for</span>
        </div>
        <div className="seg">
          {ADMIN.map(([k, l]) => <button key={k} className={seg === k ? "on" : ""} onClick={() => setSeg(k)}>{l}</button>)}
        </div>
      </div>
      {seg === "roi" ? <RoiView orgId={orgId} onErr={onErr} />
        : seg === "access" ? <AccessView orgId={orgId} onErr={onErr} />
        : seg === "reports" ? <ReportsView orgId={orgId} onErr={onErr} />
        : seg === "model" ? <ModelView orgId={orgId} onErr={onErr} />
        : seg === "governance" ? <GovernanceView orgId={orgId} onErr={onErr} />
        : seg === "webhooks" ? <WebhooksView orgId={orgId} onErr={onErr} />
        : seg === "audit" ? <AuditView orgId={orgId} onErr={onErr} />
        : seg === "alerts" ? <DeadlinesView orgId={orgId} onErr={onErr} embedded />
        : seg === "qpa" ? <QpaIndexView onErr={onErr} />
        : seg === "ceilings" ? <CeilingsView orgId={orgId} onErr={onErr} />
        : seg === "integrations" ? <IntegrationsView onErr={onErr} embedded />
        : <ApiKeysView onErr={onErr} />}
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

      {/* Getting started checklist — bring the Overview launcher back */}
      <GettingStartedControl onErr={onErr} />
    </div>
  );
}

// Lets an admin re-show the Overview getting-started launcher after it was hidden
// (either the per-session ✕ or a permanent dismiss from the full setup page).
function GettingStartedControl({ onErr }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function showAgain() {
    setBusy(true);
    try {
      try { sessionStorage.removeItem("avertyn.gs.hiddenThisSession"); } catch (_) {}
      const { error } = await supabase.rpc("onboarding_dismiss", { p_dismissed: false });
      if (error) throw error;
      setDone(true);
    } catch (e) { onErr?.(e.message); }
    setBusy(false);
  }
  return (
    <div className="panel">
      <div className="ph">Getting started checklist
        <span className="act"><span className="muted" style={{ fontSize: 11 }}>the setup launcher on your Overview</span></span>
      </div>
      <div className="pb" style={{ paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {done ? "Restored — open the Overview tab and it's back."
                : "Hidden the getting-started launcher? Bring it back to your Overview."}
        </p>
        <button className="btn btn-s" disabled={busy || done} onClick={showAgain}>
          {busy ? "Restoring…" : done ? "Restored ✓" : "Show on Overview"}
        </button>
      </div>
    </div>
  );
}

function Field({ l, wide, children }) {
  return <label className={"afield" + (wide ? " wide" : "")}><span className="rlabel" style={{ margin: "0 0 4px" }}>{l}</span>{children}</label>;
}

// ============================================================ Audit trail
// Surfaces the tamper-evident action ledger: the hash-chain integrity check
// (verify_ledger) plus a filterable, exportable view over audit_export(). This is
// the auditor/compliance surface — every automated and human action, its effect,
// legal citations and rationale, in an order-preserving hash chain.
function summarizeEffect(e) {
  if (!e || typeof e !== "object") return "—";
  return Object.entries(e).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}
function toCsv(entries) {
  const cols = ["created_at", "dispute_ref", "action", "actor", "effect", "rationale", "citations", "prev_hash", "row_hash"];
  const esc = (s) => { const t = s == null ? "" : String(s); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const rows = entries.map((e) => cols.map((c) => {
    if (c === "effect") return esc(summarizeEffect(e.effect));
    if (c === "citations") return esc(Array.isArray(e.citations) ? e.citations.join("; ") : "");
    return esc(e[c]);
  }).join(","));
  return [cols.join(","), ...rows].join("\n");
}
function download(name, text, type) {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function AuditView({ orgId, onErr }) {
  const [exp, setExp] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(500);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("audit_export", {
        p_from: from ? new Date(from).toISOString() : null,
        p_to: to ? new Date(to + "T23:59:59").toISOString() : null,
        p_limit: Number(limit) || 500,
      });
      if (error) throw error;
      setExp(data || null);
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }, [from, to, limit, onErr]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const v = exp?.ledger_verified;
  const entries = (exp?.entries || []).filter((e) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (e.action || "").toLowerCase().includes(s) || (e.dispute_ref || "").toLowerCase().includes(s)
      || (e.actor || "").toLowerCase().includes(s) || summarizeEffect(e.effect).toLowerCase().includes(s);
  });

  return (
    <div>
      {/* Integrity */}
      <div className="panel">
        <div className="ph">Ledger integrity
          <span className="act">
            {v && <span className={"badge " + (v.ok ? "b-green" : "b-red")}><i className={"dot d-" + (v.ok ? "green" : "red")} />{v.ok ? "Verified — hash chain intact" : `${v.mismatches} mismatch(es)`}</span>}
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>
            Every action Avertyn takes — automated or human — is written to an append-only, SHA-256 hash-chained ledger
            (<span className="mono" style={{ fontSize: 11 }}>action_log</span>). Each row seals the one before it, so a single altered
            or deleted entry breaks the chain and is detected here. Records are retained <b>{exp?.retention_years ?? 6} years</b> per
            45 CFR §164.316(b)(2).
          </p>
          {v && <div className="mono" style={{ fontSize: 12, color: "var(--mut)" }}>{v.rows} rows checked · {v.mismatches} mismatch(es){exp?.generated_at ? ` · as of ${new Date(exp.generated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</div>}
        </div>
      </div>

      {/* Trail */}
      <div className="panel">
        <div className="ph">Audit trail
          <span className="act" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12 }} />
            <span className="muted" style={{ fontSize: 12 }}>→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12 }} />
            <select className="dsel" value={limit} onChange={(e) => setLimit(e.target.value)}>{[100, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n} rows</option>)}</select>
            <button className="btn btn-s" style={{ padding: "6px 12px" }} disabled={busy} onClick={load}>{busy ? "Loading…" : "Apply"}</button>
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter action / case / effect…" style={{ padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5, minWidth: 220 }} />
            <span className="muted" style={{ fontSize: 12 }}>{entries.length} of {exp?.count ?? 0} shown</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="mini" disabled={!entries.length} onClick={() => download(`avertyn-audit-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(entries), "text/csv")}>Download CSV</button>
              <button className="mini" disabled={!exp} onClick={() => download(`avertyn-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exp, null, 2), "application/json")}>Download JSON</button>
            </span>
          </div>
          {entries.length === 0 ? <p className="muted">No ledger entries for this range.</p> : (
            <div style={{ overflow: "auto", maxHeight: 460 }}>
              <table>
                <thead><tr><th>When</th><th>Case</th><th>Action</th><th>Actor</th><th>Effect</th><th>Rationale</th><th>Seal</th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{e.dispute_ref || "—"}</td>
                      <td><span className="badge b-grey">{(e.action || "").replace(/_/g, " ").replace(/\b(idre|idr|qpa|nsa|cpt|drg|rbp|erisa|ncci|mue|tpa|hcpcs|npi|cms|hhs|dol|wc|ptp|mrf)\b/gi, m => m.toUpperCase())}</span></td>
                      <td className="muted" style={{ fontSize: 12 }}>{e.actor || "—"}</td>
                      <td style={{ fontSize: 12, maxWidth: 260 }}>{summarizeEffect(e.effect)}{Array.isArray(e.citations) && e.citations.length > 0 && <div className="mono" style={{ fontSize: 10.5, color: "var(--mut)" }}>{e.citations.join(" · ")}</div>}</td>
                      <td className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>{e.rationale || "—"}</td>
                      <td className="mono" style={{ fontSize: 10.5, color: "var(--mut)" }} title={e.row_hash}>{e.row_hash ? e.row_hash.slice(0, 10) + "…" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================ QPA index (CPI-U)
// The QPA calculator trends the median contracted rate forward from the 2019 base
// year by the CPI-U index. Published BLS annual averages are seeded; estimates for
// years BLS hasn't finalized are editable here so the calc stays current without a
// code change.
const CPI_BASE_YEAR = 2019;
function QpaIndexView({ onErr }) {
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});   // year -> { index_value?, estimated?, cms_factor?, cms_source? }
  const [busy, setBusy] = useState("");
  const [nu, setNu] = useState({ year: "", index_value: "", estimated: true, cms_factor: "", cms_source: "" });

  const load = useCallback(async () => {
    try { const { data, error } = await supabase.rpc("list_cpi_u"); if (error) throw error; setRows(data || []); setEdits({}); }
    catch (e) { onErr(e.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  const base = Number(rows.find((r) => r.year === CPI_BASE_YEAR)?.index_value || 0);
  const setEdit = (year, k, v) => setEdits((e) => ({ ...e, [year]: { ...(e[year] || {}), [k]: v } }));
  const valOf = (r) => (edits[r.year]?.index_value !== undefined ? edits[r.year].index_value : r.index_value);
  const estOf = (r) => (edits[r.year]?.estimated !== undefined ? edits[r.year].estimated : r.estimated);
  const cmsOf = (r) => (edits[r.year]?.cms_factor !== undefined ? edits[r.year].cms_factor : (r.cms_factor ?? ""));
  const srcOf = (r) => (edits[r.year]?.cms_source !== undefined ? edits[r.year].cms_source : (r.cms_source ?? ""));
  const dirty = (r) => edits[r.year] && (Number(valOf(r)) !== Number(r.index_value) || !!estOf(r) !== !!r.estimated
    || String(cmsOf(r)) !== String(r.cms_factor ?? "") || String(srcOf(r)) !== String(r.cms_source ?? ""));

  async function save(year) {
    const r = rows.find((x) => x.year === year);
    setBusy("s" + year);
    try {
      const cf = cmsOf(r); const cms = cf === "" || cf == null ? null : Number(cf);
      const { error } = await supabase.rpc("set_cpi_u", { p_year: year, p_index: Number(valOf(r)), p_estimated: !!estOf(r), p_cms_factor: cms, p_cms_source: srcOf(r) || null });
      if (error) throw error; await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function addYear() {
    if (!nu.year || !nu.index_value) return;
    setBusy("add");
    try {
      const cms = nu.cms_factor === "" ? null : Number(nu.cms_factor);
      const { error } = await supabase.rpc("set_cpi_u", { p_year: Number(nu.year), p_index: Number(nu.index_value), p_estimated: !!nu.estimated, p_cms_factor: cms, p_cms_source: nu.cms_source || null });
      if (error) throw error; setNu({ year: "", index_value: "", estimated: true, cms_factor: "", cms_source: "" }); await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function remove(year) {
    if (year === CPI_BASE_YEAR) { onErr(`${CPI_BASE_YEAR} is the base year and can't be removed.`); return; }
    try { const { error } = await supabase.rpc("remove_cpi_u", { p_year: year }); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }

  return (
    <div>
      <div className="panel">
        <div className="ph">QPA indexing factors
          <span className="act"><span className="muted" style={{ fontSize: 11 }}>base year {CPI_BASE_YEAR} · CMS official factor is authoritative when present</span></span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
            The QPA calculator trends the median 2019 contracted rate to a claim&apos;s service year (45 CFR 149.140). When a
            <b> CMS-published factor</b> exists for that year (IRS notices), the calculator uses it as the defensible figure and
            reconciles it against the internal <b>CPI-U estimate</b> (BLS annual-average index ÷ {CPI_BASE_YEAR}). Edit either here;
            values marked <b>estimated</b> are provisional until BLS/CMS finalize them.
          </p>
          {rows.length === 0 ? <p className="muted">Loading…</p> : (
            <table>
              <thead><tr><th>Year</th><th>CPI-U index</th><th>Est. ×</th><th>CMS factor (official)</th><th>Source</th><th>Δ</th><th>Est.</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const factor = base ? (Number(valOf(r)) / base) : null;
                  const cf = cmsOf(r) === "" || cmsOf(r) == null ? null : Number(cmsOf(r));
                  const delta = (factor != null && cf != null) ? (factor - cf) : null;
                  const isBase = r.year === CPI_BASE_YEAR;
                  return (
                    <tr key={r.year}>
                      <td><b>{r.year}</b>{isBase && <span className="badge b-ink" style={{ marginLeft: 8 }}>base</span>}</td>
                      <td>
                        <input type="number" step="0.001" value={valOf(r)} onChange={(e) => setEdit(r.year, "index_value", e.target.value)}
                          style={{ width: 96, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{factor != null ? "×" + factor.toFixed(5) : "—"}</td>
                      <td>
                        <input type="number" step="0.0000000001" placeholder="—" value={cmsOf(r)} onChange={(e) => setEdit(r.year, "cms_factor", e.target.value)}
                          style={{ width: 128, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
                      </td>
                      <td>
                        <input placeholder="IRS notice…" value={srcOf(r)} onChange={(e) => setEdit(r.year, "cms_source", e.target.value)}
                          style={{ width: 150, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 11.5 }} />
                      </td>
                      <td className="mono" style={{ fontSize: 11.5, color: delta != null && Math.abs(delta) >= 0.0005 ? "var(--sig,#a8321f)" : "var(--mut)" }}>
                        {delta != null ? (delta > 0 ? "+" : "") + delta.toFixed(4) : "—"}
                      </td>
                      <td>
                        <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--mut)" }}>
                          <input type="checkbox" checked={!!estOf(r)} onChange={(e) => setEdit(r.year, "estimated", e.target.checked)} />
                          {estOf(r) ? <span className="badge b-amber">est.</span> : <span className="badge b-green">pub.</span>}
                        </label>
                      </td>
                      <td style={{ display: "flex", gap: 6 }}>
                        <button className="mini" disabled={!dirty(r) || busy === "s" + r.year} onClick={() => save(r.year)}>{busy === "s" + r.year ? "Saving…" : "Save"}</button>
                        {!isBase && <button className="mini" onClick={() => remove(r.year)}>Remove</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
            <span className="rlabel" style={{ margin: 0 }}>Add a year</span>
            <input type="number" placeholder="Year" value={nu.year} onChange={(e) => setNu({ ...nu, year: e.target.value })} style={{ width: 80, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
            <input type="number" step="0.001" placeholder="CPI-U index" value={nu.index_value} onChange={(e) => setNu({ ...nu, index_value: e.target.value })} style={{ width: 110, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
            <input type="number" step="0.0000000001" placeholder="CMS factor (opt.)" value={nu.cms_factor} onChange={(e) => setNu({ ...nu, cms_factor: e.target.value })} style={{ width: 130, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 12.5 }} />
            <input placeholder="Source (opt.)" value={nu.cms_source} onChange={(e) => setNu({ ...nu, cms_source: e.target.value })} style={{ width: 130, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", fontSize: 11.5 }} />
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--mut)" }}>
              <input type="checkbox" checked={nu.estimated} onChange={(e) => setNu({ ...nu, estimated: e.target.checked })} />estimated
            </label>
            <button className="btn btn-a" style={{ padding: "7px 12px" }} disabled={busy === "add" || !nu.year || !nu.index_value} onClick={addYear}>{busy === "add" ? "Adding…" : "Add year"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Governance & SLA oversight
function GovernanceView({ orgId, onErr }) {
  const [gov, setGov] = useState(null);
  const [sla, setSla] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const [{ data: g, error: e1 }, { data: s }] = await Promise.all([
        supabase.rpc("ai_governance_report", { p_org: orgId }),
        supabase.rpc("sla_status", { p_org: orgId }),
      ]);
      if (e1) throw e1;
      setGov(g || null); setSla(s || null);
    } catch (e) { onErr(e.message); }
  }, [orgId, onErr]);
  useEffect(() => { load(); }, [load]);

  async function escalate() {
    setBusy(true); setNote("");
    try { const { data, error } = await supabase.rpc("sla_escalate", { p_org: orgId }); if (error) throw error; setNote(`Escalated ${data?.escalated ?? 0} overdue deadline(s).`); await load(); }
    catch (e) { onErr(e.message); }
    setBusy(false);
  }

  const tile = (label, val, hint, tone) => <div className="kpi-tile"><div className="l">{label}</div><div className="n" style={{ fontFamily: "var(--num,monospace)", color: tone }}>{val}</div>{hint && <div className="goal">{hint}</div>}</div>;
  const a = gov?.automation || {}, ex = gov?.explainability || {}, ho = gov?.human_oversight || {};

  return (
    <div>
      {/* SLA risk */}
      <div className="panel">
        <div className="ph">Deadline SLA risk
          <span className="act" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {note && <span className="badge b-green"><i className="dot d-green" />{note}</span>}
            <button className="btn btn-a" style={{ padding: "6px 12px" }} disabled={busy || !sla || (sla.overdue || 0) === 0} onClick={escalate}>{busy ? "Escalating…" : "Escalate overdue"}</button>
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <div className="cards" style={{ marginBottom: 4 }}>
            {tile("Overdue", sla?.overdue ?? "—", "past due — act now", (sla?.overdue || 0) > 0 ? "var(--sig,#a8321f)" : undefined)}
            {tile("Urgent", sla?.urgent ?? "—", "≤ 3 business days")}
            {tile("Soon", sla?.soon ?? "—", "≤ 7 days")}
          </div>
          {(sla?.items || []).length > 0 && (
            <div style={{ overflow: "auto", maxHeight: 260, marginTop: 8 }}>
              <table>
                <thead><tr><th>Case</th><th>Deadline</th><th>Due</th><th>Urgency</th></tr></thead>
                <tbody>
                  {sla.items.map((it, i) => {
                    const tone = it.urgency === "overdue" ? "red" : it.urgency === "urgent" ? "amber" : "grey";
                    return (
                      <tr key={i}>
                        <td className="mono" style={{ fontSize: 11 }}>{it.dispute_ref}</td>
                        <td style={{ fontSize: 12.5 }}>{it.label}</td>
                        <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{new Date(it.due_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                        <td><span className={"badge b-" + tone}><i className={"dot d-" + tone} />{it.urgency}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* AI governance */}
      {gov && (
        <>
          <div className="panel">
            <div className="ph">AI governance<span className="act"><span className="muted" style={{ fontSize: 11 }}>NAIC / NIST model-risk posture</span></span></div>
            <div className="pb" style={{ paddingTop: 12 }}>
              <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>Every automated action is governed, logged with rationale and legal citations, and reversible under human control — the answers procurement&apos;s AI-governance review asks for.</p>
              <div className="cards">
                {tile("Automated", a.by_agent ?? 0, `of ${a.total_actions ?? 0} actions`)}
                {tile("Human-run", a.by_human ?? 0, "manual actions")}
                {tile("Ledger integrity", ex.ledger_integrity?.ok ? "intact" : `${ex.ledger_integrity?.mismatches ?? "?"} bad`, `${ex.ledger_integrity?.rows ?? 0} rows`, ex.ledger_integrity?.ok ? "var(--ok,#2e7d32)" : "var(--sig,#a8321f)")}
                {tile("With citations", ex.actions_with_citations ?? 0, "explainable")}
                {tile("With rationale", ex.actions_with_rationale ?? 0, "documented")}
                {tile("Override rate", (ho.override_rate_pct ?? 0) + "%", `${ho.approvals_total ?? 0} approvals`)}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="ph">Fairness check<span className="act"><span className="muted" style={{ fontSize: 11 }}>challenge rate by initiator — watch for disparate treatment</span></span></div>
            <table>
              <thead><tr><th>Initiator</th><th>Disputes</th><th>Challenged</th><th>Rate</th></tr></thead>
              <tbody>
                {(gov.fairness_check || []).map((f, i) => (
                  <tr key={i}>
                    <td><b>{f.initiator}</b></td>
                    <td className="mono">{f.disputes}</td>
                    <td className="mono">{f.challenged}</td>
                    <td className="mono">{f.challenge_rate_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="ph">Autonomy policy<span className="act"><span className="muted" style={{ fontSize: 11 }}>per-action mode — auto vs human review</span></span></div>
            <div className="pb" style={{ paddingTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(gov.per_tenant_policy || []).map((p, i) => (
                <span key={i} className={"badge " + (p.mode === "auto" ? "b-grey" : "b-amber")} style={{ padding: "5px 9px" }}>
                  {(p.action || "").replace(/_/g, " ").replace(/\b(idre|idr|qpa|nsa|cpt|drg|rbp|erisa|ncci|mue|tpa|hcpcs|npi|cms|hhs|dol|wc|ptp|mrf)\b/gi, m => m.toUpperCase())} · {p.mode}{p.max_amount ? ` ≤ ${money(p.max_amount)}` : ""}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================ ROI (CFO view)
function RoiView({ orgId, onErr }) {
  const [roi, setRoi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!orgId) return;
    try { const { data, error } = await supabase.rpc("roi_summary", { p_org: orgId }); if (error) throw error; setRoi(data); }
    catch (e) { onErr(e.message); }
  }, [orgId, onErr]);
  useEffect(() => { load(); }, [load]);

  async function scheduleMonthly() {
    setBusy(true); setNote("");
    try {
      const { error } = await supabase.from("scheduled_reports").insert({ org_id: orgId, name: "Monthly ROI — dollars defended", metric: "defended", dim: "month", cadence: "monthly", recipients: "" });
      if (error) throw error;
      setNote("Scheduled — set recipients under Reports.");
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }

  const pct = (v) => v == null ? "—" : (Number(v) <= 1 ? Math.round(Number(v) * 100) : Math.round(Number(v))) + "%";
  const tile = (label, val, hint) => <div className="kpi-tile"><div className="l">{label}</div><div className="n" style={{ fontFamily: "var(--num,monospace)" }}>{val}</div>{hint && <div className="goal">{hint}</div>}</div>;

  if (!roi) return <p className="muted">Loading…</p>;
  const trend = roi.defended_trend || [];
  const mx = Math.max(1, ...trend.map((p) => Number(p.value) || 0));

  return (
    <div>
      <div className="panel">
        <div className="ph">Return on Avertyn
          <span className="act" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {note && <span className="badge b-green"><i className="dot d-green" />{note}</span>}
            <button className="btn btn-s" style={{ padding: "6px 12px" }} disabled={busy} onClick={scheduleMonthly}>Schedule monthly</button>
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "var(--num,monospace)" }}>{money(roi.dollars_defended)}</div>
            <div className="muted" style={{ fontSize: 13 }}>defended against {money(roi.total_demand)} in provider demand · {money(roi.cost_avoided_per_dispute)}/dispute avoided</div>
          </div>
          <div className="cards">
            {tile("At risk vs QPA", money(roi.at_risk_vs_qpa), "exposure defended")}
            {tile("Settled vs demand", pct(roi.avg_settled_pct_of_demand), "lower is better")}
            {tile("Plan-win rate", pct(roi.plan_win_rate), `${roi.resolved} resolved`)}
            {tile("Ineligible caught", roi.ineligible_caught, pct(roi.ineligible_caught_rate) + " of cases")}
            {tile("Default-loss rate", pct(roi.default_loss_rate), "missed deadlines")}
            {tile("Awards on time", pct(roi.award_on_time_rate), "payment SLA")}
          </div>
        </div>
      </div>
      {trend.length > 0 && (
        <div className="panel">
          <div className="ph">Dollars defended over time<span className="act"><span className="muted" style={{ fontSize: 11 }}>by month</span></span></div>
          <div className="pb" style={{ paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90, marginTop: 6 }}>
              {trend.map((p, i) => (
                <div key={i} style={{ flex: 1, textAlign: "center", minWidth: 0 }} title={`${p.label}: ${money(p.value)}`}>
                  <div style={{ height: Math.round((Number(p.value) / mx) * 74) + 2, background: "var(--c-indigo,#3b3550)", borderRadius: "3px 3px 0 0" }} />
                  <div className="muted" style={{ fontSize: 9, marginTop: 3 }}>{p.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================ Webhooks
const WH_EVENTS = ["*", "dispute.created", "dispute.resolved", "payment.scheduled", "document.signed", "determination.issued"];
const WH_TONE = { delivered: "green", failed: "red", retrying: "amber", dispatched: "grey", pending: "grey" };
function WebhooksView({ orgId, onErr }) {
  const [eps, setEps] = useState([]);
  const [dels, setDels] = useState([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(["*"]);
  const [busy, setBusy] = useState("");
  const [fresh, setFresh] = useState(null);   // { url, secret }
  const [reveal, setReveal] = useState({});    // id -> secret

  const load = useCallback(async () => {
    try {
      const [e, d] = await Promise.all([
        supabase.from("webhook_endpoints").select("id, url, events, active, created_at").order("created_at", { ascending: false }),
        supabase.from("webhook_deliveries").select("id, endpoint_id, event, status, attempts, response_code, last_error, created_at").order("created_at", { ascending: false }).limit(25),
      ]);
      setEps(e.data || []); setDels(d.data || []);
    } catch (er) { onErr(er.message); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("webhooks", ["webhook_endpoints", "webhook_deliveries"], load);

  const toggleEvent = (ev) => setEvents((s) => s.includes(ev) ? s.filter((x) => x !== ev) : [...s, ev]);
  async function register() {
    if (!url.trim()) return;
    setBusy("reg");
    try {
      const { data, error } = await supabase.rpc("webhook_create", { p_url: url.trim(), p_events: events });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      setFresh({ url: url.trim(), secret: row?.secret });
      setUrl(""); setEvents(["*"]); await load();
    } catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function revealSecret(id) {
    try { const { data, error } = await supabase.rpc("webhook_secret", { p_id: id }); if (error) throw error; setReveal((r) => ({ ...r, [id]: data })); }
    catch (e) { onErr(e.message); }
  }
  async function rotate(id) {
    setBusy("rot" + id);
    try { const { data, error } = await supabase.rpc("webhook_rotate_secret", { p_id: id }); if (error) throw error; setReveal((r) => ({ ...r, [id]: data })); }
    catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function test(id) {
    setBusy("test" + id);
    try { const { data, error } = await supabase.rpc("webhook_send_test", { p_id: id }); if (error) throw error; if (data?.ok === false) onErr(data.reason); await load(); }
    catch (e) { onErr(e.message); }
    setBusy("");
  }
  async function del(id) {
    try { const { error } = await supabase.rpc("webhook_delete", { p_id: id }); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
  }

  return (
    <div>
      <div className="panel">
        <div className="ph">Register endpoint<span className="act"><span className="muted" style={{ fontSize: 11 }}>signed with HMAC-SHA256 · retried with backoff</span></span></div>
        <div className="pb" style={{ paddingTop: 14 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-endpoint.example/hooks/avertyn" style={{ flex: 1, minWidth: 280, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit", fontSize: 13 }} />
            <button className="btn btn-a" disabled={busy === "reg" || !url.trim()} onClick={register}>{busy === "reg" ? "Registering…" : "Register"}</button>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            {WH_EVENTS.map((ev) => (
              <label key={ev} style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--mut)" }}>
                <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} /><span className="mono">{ev}</span>
              </label>
            ))}
          </div>
          {fresh && (
            <div style={{ background: "#f4f3f1", border: "1px solid var(--ok)", borderRadius: 10, padding: "11px 13px", marginTop: 12 }}>
              <div style={{ fontSize: 11, color: "var(--ok)", fontWeight: 600, marginBottom: 6 }}>Signing secret — copy it now. Verify the X-Avertyn-Signature header (t=&lt;ts&gt;,v1=&lt;hmac&gt;) with it.</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{fresh.secret}</code>
                <button className="mini" onClick={() => navigator.clipboard?.writeText(fresh.secret)}>Copy</button>
                <button className="mini" onClick={() => setFresh(null)}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="ph">Endpoints<span className="act"><span className="muted" style={{ fontSize: 11 }}>{eps.length} registered</span></span></div>
        {eps.length === 0 ? <p className="muted" style={{ padding: 16 }}>No endpoints yet. Register one above to receive signed event deliveries.</p> : (
          <table>
            <thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Secret</th><th></th></tr></thead>
            <tbody>
              {eps.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{e.url}</td>
                  <td>{(e.events || []).map((ev) => <span key={ev} className="badge b-grey" style={{ marginRight: 4 }}>{ev}</span>)}</td>
                  <td><span className={"badge " + (e.active ? "b-green" : "b-grey")}><i className={"dot d-" + (e.active ? "green" : "grey")} />{e.active ? "active" : "off"}</span></td>
                  <td>{reveal[e.id] ? <code className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>{reveal[e.id]}</code> : <button className="mini" onClick={() => revealSecret(e.id)}>Reveal</button>}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="mini" disabled={busy === "test" + e.id} onClick={() => test(e.id)}>Test</button>
                    <button className="mini" disabled={busy === "rot" + e.id} onClick={() => rotate(e.id)}>Rotate</button>
                    <button className="mini" onClick={() => del(e.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="ph">Recent deliveries<span className="act"><span className="muted" style={{ fontSize: 11 }}>last 25</span></span></div>
        {dels.length === 0 ? <p className="muted" style={{ padding: 16 }}>No deliveries yet. Register an endpoint and send a test.</p> : (
          <table>
            <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Error</th></tr></thead>
            <tbody>
              {dels.map((d) => (
                <tr key={d.id}>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.event}</td>
                  <td><span className={"badge b-" + (WH_TONE[d.status] || "grey")}><i className={"dot d-" + (WH_TONE[d.status] || "grey")} />{d.status}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.attempts}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.response_code || "—"}</td>
                  <td className="muted" style={{ fontSize: 11, maxWidth: 200 }}>{d.last_error || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================ Model accuracy
function ModelView({ orgId, onErr }) {
  const [cal, setCal] = useState(null);
  const [snaps, setSnaps] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const [{ data: c, error: e1 }, { data: s }] = await Promise.all([
        supabase.rpc("model_calibration", { p_org: orgId, p_model_version: null, p_record: false }),
        supabase.from("model_calibration_snapshots").select("created_at, n, brier, accuracy, base_rate, mean_pred, separation").order("created_at", { ascending: true }),
      ]);
      if (e1) throw e1;
      setCal(c || null); setSnaps(s || []);
    } catch (e) { onErr(e.message); }
  }, [orgId, onErr]);
  useEffect(() => { load(); }, [load]);

  async function snapshot() {
    setBusy(true);
    try { const { error } = await supabase.rpc("model_calibration", { p_org: orgId, p_model_version: null, p_record: true }); if (error) throw error; await load(); }
    catch (e) { onErr(e.message); }
    setBusy(false);
  }
  async function refit() {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("refit_win_model", { p_org: orgId, p_version: "v1", p_min_n: 8 });
      if (error) throw error;
      if (data?.ok && data?.accepted === false && data?.reason) onErr(`Refit: ${data.reason} (n=${data.n})`);
      await load();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }

  const tile = (label, val, hint) => (
    <div className="kpi-tile"><div className="l">{label}</div><div className="n" style={{ fontFamily: "var(--num,monospace)" }}>{val}</div>{hint && <div className="goal">{hint}</div>}</div>
  );
  const pct = (v) => v == null ? "—" : Math.round(Number(v) * 100) + "%";

  return (
    <div>
      <div className="panel">
        <div className="ph">Win-probability model — accuracy
          <span className="act" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 11 }}>{cal?.model_version ? "version " + cal.model_version : ""}</span>
            <button className="btn btn-s" style={{ padding: "6px 12px" }} disabled={busy || !cal || cal.n === 0} onClick={refit}>{busy ? "Working…" : "Refit from outcomes"}</button>
            <button className="btn btn-s" style={{ padding: "6px 12px" }} disabled={busy || !cal || cal.n === 0} onClick={snapshot}>Record snapshot</button>
          </span>
        </div>
        <div className="pb" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
            Backtest of predicted win-probability against realized outcomes on disputes with a terminal result.
            Lower <b>Brier</b> is better (0 = perfect, 0.25 = a coin flip); <b>separation</b> &gt; 0 means the model scores actual
            wins higher than losses. This is scored live as more disputes resolve.
          </p>
          {!cal ? <p className="muted">Loading…</p> : cal.n === 0 ? (
            <p className="muted">No terminal-outcome disputes with a prediction to score yet — accuracy appears once cases resolve.</p>
          ) : (
            <>
              <div className="cards" style={{ marginBottom: 4 }}>
                {tile("Scored", cal.n, "resolved cases")}
                {tile("Brier (raw)", cal.brier_score, cal.brier_score < 0.25 ? "beats coin-flip" : "review")}
                {tile("Brier (calibrated)", cal.brier_calibrated ?? "—", "after learning")}
                {tile("Accuracy", pct(cal.accuracy_at_0_5), "at 0.5 threshold")}
                {tile("Separation", (cal.separation > 0 ? "+" : "") + cal.separation, cal.separation > 0 ? "discriminating" : "weak")}
                {tile("Base rate", pct(cal.base_rate), "actual win rate")}
              </div>
              {cal.recalibration && (
                <div className="rcard" style={{ padding: "10px 13px", marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontSize: 12.5 }}><b>Recalibration</b> — learned from realized outcomes
                      {cal.recalibration.accepted
                        ? <span className="badge b-green" style={{ marginLeft: 8 }}><i className="dot d-green" />active</span>
                        : <span className="badge b-grey" style={{ marginLeft: 8 }}>{cal.recalibration.note ? "not fit" : "no gain — identity kept"}</span>}
                    </span>
                    {cal.recalibration.accepted && <span className="mono muted" style={{ fontSize: 11 }}>logit ×{cal.recalibration.a} {cal.recalibration.b >= 0 ? "+" : ""}{cal.recalibration.b} · log-loss {cal.recalibration.log_loss_raw} → {cal.recalibration.log_loss_calibrated} · n={cal.recalibration.n}</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Platt scaling on the model&apos;s own scores; accepted only when it lowers log-loss. Re-run &quot;Refit from outcomes&quot; as more cases resolve.</div>
                </div>
              )}
              <div className="rlabel" style={{ marginTop: 14 }}>Calibration — predicted vs actual by probability band</div>
              <table>
                <thead><tr><th>Band</th><th>n</th><th>Avg predicted</th><th>Avg actual</th><th></th></tr></thead>
                <tbody>
                  {(cal.calibration_buckets || []).map((b, i) => {
                    const gap = Math.abs(Number(b.avg_predicted) - Number(b.avg_actual));
                    return (
                      <tr key={i}>
                        <td className="mono">{b.range}</td>
                        <td className="mono">{b.n}</td>
                        <td className="mono">{pct(b.avg_predicted)}</td>
                        <td className="mono">{pct(b.avg_actual)}</td>
                        <td><span className={"badge " + (gap <= 0.1 ? "b-green" : gap <= 0.2 ? "b-amber" : "b-red")}>{gap <= 0.1 ? "well-calibrated" : gap <= 0.2 ? "fair" : "off"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {snaps.length > 0 && (
        <div className="panel">
          <div className="ph">Accuracy over time<span className="act"><span className="muted" style={{ fontSize: 11 }}>{snaps.length} snapshot{snaps.length === 1 ? "" : "s"}</span></span></div>
          <div className="pb" style={{ paddingTop: 12 }}>
            <div className="rlabel">Brier score (lower is better)</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 70, marginTop: 6 }}>
              {(() => { const mx = Math.max(0.25, ...snaps.map((s) => Number(s.brier) || 0)); return snaps.map((s, i) => (
                <div key={i} style={{ flex: 1, textAlign: "center", minWidth: 0 }} title={`${new Date(s.created_at).toLocaleDateString()} · Brier ${s.brier} · n=${s.n}`}>
                  <div style={{ height: Math.round((Number(s.brier) / mx) * 56) + 2, background: "var(--c-indigo)", borderRadius: "3px 3px 0 0" }} />
                  <div className="muted" style={{ fontSize: 9, marginTop: 3 }}>{new Date(s.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
                </div>
              )); })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- report export helpers ----
function reportRowsToCsv(rows, isMoney) {
  const esc = (s) => { const t = s == null ? "" : String(s); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const head = "label,value";
  const body = (rows || []).map((r) => esc(r.label) + "," + esc(isMoney ? Number(r.value).toFixed(2) : r.value)).join("\n");
  return head + "\n" + body;
}
function buildReportHtml({ title, metricLabel, dimLabel, rows, total, trend, isMoney }) {
  const fmt = (v) => (isMoney ? "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }) : v);
  const maxT = Math.max(1, ...((trend?.series || []).map((p) => Number(p.value) || 0)));
  const bars = (trend?.series || []).map((p) => {
    const h = Math.round((Number(p.value) / maxT) * 90) + 2;
    return `<div style="display:inline-block;width:34px;text-align:center;vertical-align:bottom">
      <div style="height:${h}px;background:#3b3550;border-radius:3px 3px 0 0;margin:0 3px"></div>
      <div style="font:10px sans-serif;color:#666;margin-top:3px">${p.label}</div></div>`;
  }).join("");
  const trs = (rows || []).map((r) => `<tr><td style="padding:5px 10px;border-bottom:1px solid #eee">${r.label}</td>
    <td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${fmt(r.value)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:720px;margin:32px auto;padding:0 20px">
    <h1 style="font-size:20px;margin:0 0 2px">${title}</h1>
    <div style="color:#666;margin-bottom:18px">${metricLabel} by ${dimLabel} · generated ${new Date().toLocaleString()}</div>
    ${trend ? `<h3 style="font-size:13px;color:#666;text-transform:uppercase;letter-spacing:.05em">Trend — ${metricLabel} by ${trend.bucket}</h3>
      <div style="border:1px solid #eee;border-radius:8px;padding:14px 10px 8px;white-space:nowrap;overflow-x:auto;margin-bottom:20px">${bars || '<span style="color:#999">no data</span>'}</div>` : ""}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr><th style="text-align:left;padding:5px 10px;border-bottom:2px solid #333">${dimLabel}</th>
        <th style="text-align:right;padding:5px 10px;border-bottom:2px solid #333">${metricLabel}</th></tr></thead>
      <tbody>${trs}</tbody>
      <tfoot><tr><td style="padding:6px 10px;font-weight:600">Total</td>
        <td style="padding:6px 10px;text-align:right;font-weight:600">${fmt(total || 0)}</td></tr></tfoot>
    </table>
    <p style="color:#999;font-size:11px;margin-top:18px">Avertyn · use your browser's Print → Save as PDF to export this report.</p>
  </body></html>`;
}

// ============================================================ Reports
function ReportsView({ orgId, onErr }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [form, setForm] = useState({ name: "", metric: "defended", dim: "initiator", cadence: "weekly", recipients: "" });
  const [preview, setPreview] = useState(null);
  const [trend, setTrend] = useState(null);
  const [bucket, setBucket] = useState("month");

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

  useEffect(() => {
    let live = true;
    if (!orgId) return;
    supabase.rpc("report_trend", { p_org: orgId, p_metric: form.metric, p_bucket: bucket }).then(({ data }) => { if (live) setTrend(data || null); });
    return () => { live = false; };
  }, [orgId, form.metric, bucket]);

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
              <div className="rlabel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>Live preview · {METRICS.find((m) => m[0] === form.metric)?.[1]} by {DIMS.find((d) => d[0] === form.dim)?.[1]}</span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <select className="dsel" value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ fontSize: 11, padding: "3px 6px" }}>
                    {["month", "week", "quarter"].map((b) => <option key={b} value={b}>by {b}</option>)}
                  </select>
                  <button className="mini" disabled={!prevRows.length} onClick={() => download(`avertyn-report-${form.metric}-by-${form.dim}.csv`, reportRowsToCsv(preview?.rows || [], isMoney), "text/csv")}>CSV</button>
                  <button className="mini" disabled={!prevRows.length} onClick={() => download(`avertyn-report-${form.metric}-by-${form.dim}.html`, buildReportHtml({ title: form.name.trim() || `${METRICS.find((m) => m[0] === form.metric)?.[1]} report`, metricLabel: METRICS.find((m) => m[0] === form.metric)?.[1], dimLabel: DIMS.find((d) => d[0] === form.dim)?.[1], rows: preview?.rows || [], total: preview?.total, trend, isMoney }), "text/html")}>Report ↧</button>
                </span>
              </div>
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
              {trend?.series?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="rlabel" style={{ fontSize: 11 }}>Trend · {METRICS.find((m) => m[0] === form.metric)?.[1]} by {bucket}</div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 70, marginTop: 6 }}>
                    {(() => { const mx = Math.max(1, ...trend.series.map((p) => Number(p.value) || 0)); return trend.series.map((p, i) => (
                      <div key={i} style={{ flex: 1, textAlign: "center", minWidth: 0 }} title={`${p.label}: ${isMoney ? money(p.value) : p.value}`}>
                        <div style={{ height: Math.round((Number(p.value) / mx) * 56) + 2, background: "var(--c-indigo)", borderRadius: "3px 3px 0 0" }} />
                        <div className="muted" style={{ fontSize: 9, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</div>
                      </div>
                    )); })()}
                  </div>
                </div>
              )}
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
