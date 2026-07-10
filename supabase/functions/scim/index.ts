// Avertyn — SCIM 2.0 provisioning endpoint (RFC 7643/7644 core Users).
// Real IdP integration surface: Okta / Azure AD / OneLogin point their SCIM
// base URL at /functions/v1/scim and authenticate with a bearer token that
// is issued in Admin → Access. The token's SHA-256 maps to an org; every
// operation is org-scoped by that mapping. Backed by scim_provision_user /
// scim_deprovision_user + the app_users table.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERR = "urn:ietf:params:scim:api:messages:2.0:Error";

function db() { return createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }); }
async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/scim+json" } });
}
function err(status: number, detail: string, scimType?: string) {
  return json({ schemas: [SCIM_ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
}
function toScim(u: any) {
  return {
    schemas: [SCIM_USER],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: u.email,
    active: u.active,
    name: { formatted: u.full_name },
    displayName: u.full_name,
    emails: [{ value: u.email, primary: true }],
    roles: u.role ? [{ value: u.role, primary: true }] : [],
    meta: { resourceType: "User", created: u.created_at, location: `/scim/Users/${u.id}` },
  };
}
function roleFrom(body: any, fallback = "analyst"): string {
  const r = body?.roles?.[0]?.value || body?.title ||
    body?.["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]?.department;
  return (typeof r === "string" && r.trim()) ? r.trim().toLowerCase() : fallback;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // path after the "scim" function segment
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("scim");
  const seg = i >= 0 ? parts.slice(i + 1) : parts;
  const resource = seg[0] || "";
  const rid = seg[1] || "";

  // ---- unauthenticated discovery ----
  if (req.method === "GET" && resource === "ServiceProviderConfig") {
    return json({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://platform.avertyn.com",
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
      sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token",
        description: "Authentication via the SCIM bearer token issued in Avertyn Admin → Access." }],
    });
  }

  // ---- authenticate: bearer -> org ----
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return err(401, "Missing bearer token");
  const supa = db();
  const hash = await sha256Hex(token);
  const { data: tok } = await supa.from("scim_tokens").select("id, org_id").eq("token_hash", hash).maybeSingle();
  if (!tok) return err(401, "Invalid bearer token");
  const org = tok.org_id as string;
  supa.from("scim_tokens").update({ last_used: new Date().toISOString() }).eq("id", tok.id).then(() => {});

  try {
    if (resource !== "Users") return err(404, `Unsupported resource '${resource || "/"}'`);

    // GET /Users  (list, optional userName filter) or GET /Users/{id}
    if (req.method === "GET") {
      if (rid) {
        const { data: u } = await supa.from("app_users").select("*").eq("org_id", org).eq("id", rid).maybeSingle();
        if (!u) return err(404, "User not found");
        return json(toScim(u));
      }
      const filter = url.searchParams.get("filter") || "";
      const m = filter.match(/userName\s+eq\s+"([^"]+)"/i);
      let q = supa.from("app_users").select("*").eq("org_id", org);
      if (m) q = q.eq("email", m[1]);
      const { data: rows } = await q.order("created_at", { ascending: true });
      const list = rows || [];
      return json({ schemas: [SCIM_LIST], totalResults: list.length, startIndex: 1,
        itemsPerPage: list.length, Resources: list.map(toScim) });
    }

    // POST /Users  (create / provision)
    if (req.method === "POST" && !rid) {
      const b = await req.json();
      const email = b.userName || b.emails?.[0]?.value;
      if (!email) return err(400, "userName is required", "invalidValue");
      const name = b.name?.formatted || b.displayName || [b.name?.givenName, b.name?.familyName].filter(Boolean).join(" ") || email;
      const { error: e } = await supa.rpc("scim_provision_user",
        { p_org: org, p_email: email, p_name: name, p_role: roleFrom(b), p_external_id: b.externalId ?? null });
      if (e) return err(409, e.message, "uniqueness");
      const { data: u } = await supa.from("app_users").select("*").eq("org_id", org).eq("email", email).maybeSingle();
      return json(toScim(u), 201);
    }

    // resolve target user for PUT/PATCH/DELETE
    if (rid) {
      const { data: u } = await supa.from("app_users").select("*").eq("org_id", org).eq("id", rid).maybeSingle();
      if (!u) return err(404, "User not found");

      if (req.method === "PUT") {
        const b = await req.json();
        const patch: any = { active: b.active ?? u.active };
        if (b.name?.formatted || b.displayName) patch.full_name = b.name?.formatted || b.displayName;
        if (b.roles?.[0]?.value) patch.role = String(b.roles[0].value).toLowerCase();
        if (b.externalId) patch.external_id = b.externalId;
        const { data: up } = await supa.from("app_users").update(patch).eq("id", u.id).select("*").maybeSingle();
        return json(toScim(up));
      }

      if (req.method === "PATCH") {
        const b = await req.json();
        const patch: any = {};
        for (const op of (b.Operations || b.operations || [])) {
          const path = (op.path || "").toLowerCase();
          const val = op.value;
          if (path === "active" || (val && typeof val.active === "boolean")) {
            patch.active = typeof val === "object" ? val.active : (val === true || val === "True" || val === "true");
          }
          if (path === "name.formatted" || path === "displayname") patch.full_name = val;
          if (path === "roles" && Array.isArray(val) && val[0]?.value) patch.role = String(val[0].value).toLowerCase();
          if (!op.path && val && typeof val === "object") {
            if (typeof val.active === "boolean") patch.active = val.active;
            if (val.displayName) patch.full_name = val.displayName;
          }
        }
        if (Object.keys(patch).length === 0) return json(toScim(u));
        const { data: up } = await supa.from("app_users").update(patch).eq("id", u.id).select("*").maybeSingle();
        return json(toScim(up));
      }

      if (req.method === "DELETE") {
        await supa.rpc("scim_deprovision_user", { p_org: org, p_email: u.email });
        return new Response(null, { status: 204 });
      }
    }

    return err(405, `Method ${req.method} not allowed on ${url.pathname}`);
  } catch (e) {
    return err(500, (e as Error).message || "SCIM error");
  }
});
