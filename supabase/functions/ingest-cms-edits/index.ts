// Avertyn — ingest-cms-edits edge function.
// Loads official CMS NCCI PTP and MUE quarterly files into the payment-integrity
// reference tables (ncci_edits / mue_values) via the SECURITY DEFINER RPCs
// ingest_ncci_ptp / ingest_mue. Deployed with verify_jwt=true; the RPCs are
// called with the CALLER's JWT, so the RPC-level admin gate (_require_admin)
// is what actually authorizes the write — a non-admin JWT is rejected there.
//
// POST body (JSON):
//   { kind: "ncci" | "mue",
//     quarter: "2026Q3",
//     service_type?: "practitioner" | "hospital" | "dme",   // mue only, default practitioner
//     csv?: "<raw csv text>",       // OR
//     url?: "https://.../file.csv", // a DIRECT csv url (CMS ships zips — unzip first) OR
//     rows?: [ {...} ],             // already-parsed rows (skips CSV parsing)
//     source_url?: "https://www.cms.gov/...",
//     batch_size?: 1000,
//     columns?: { column1_code:"Column 1", ... }  // optional explicit header overrides
//   }
//
// CMS file column auto-detection (case-insensitive "contains"):
//   NCCI PTP: Column 1 / Column 2, Modifier (0|1|9), Effective Date, Deletion Date, PTP Edit Rationale
//   MUE:      HCPCS/CPT Code, ...MUE Value, MUE Adjudication Indicator (MAI), MUE Rationale
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// --- Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF) ---
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", i = 0, inQ = false;
  const s = text.replace(/^﻿/, ""); // strip BOM
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const norm = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();
function findCol(headers: string[], preds: ((h: string) => boolean)[]): number {
  for (const p of preds) { const idx = headers.findIndex((h) => p(norm(h))); if (idx >= 0) return idx; }
  return -1;
}
// CMS dates: "20140101" | "1/1/2014" | "" | "*"
function toISO(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t || t === "*") return null;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(t);
  return isNaN(+d) ? null : d.toISOString().slice(0, 10);
}

function rowsFromCSV(kind: string, csv: string, over: Record<string, string> = {}) {
  const grid = parseCSV(csv);
  if (grid.length < 2) return [];
  const headers = grid[0];
  const hasOver = Object.keys(over).length > 0;
  const col = (key: string, preds: ((h: string) => boolean)[]) =>
    hasOver && over[key] ? headers.findIndex((h) => norm(h) === norm(over[key])) : findCol(headers, preds);

  if (kind === "ncci") {
    const c1 = col("column1_code", [(h) => h.includes("column 1"), (h) => h.includes("column one")]);
    const c2 = col("column2_code", [(h) => h.includes("column 2"), (h) => h.includes("column two")]);
    const mod = col("modifier_allowed", [(h) => h.includes("modifier")]);
    const eff = col("effective_date", [(h) => h.includes("effective")]);
    const del = col("deletion_date", [(h) => h.includes("deletion")]);
    const rat = col("rationale", [(h) => h.includes("rationale")]);
    if (c1 < 0 || c2 < 0) throw new Error("Could not locate Column 1 / Column 2 headers");
    return grid.slice(1).map((r) => ({
      column1_code: (r[c1] || "").trim(),
      column2_code: (r[c2] || "").trim(),
      modifier_allowed: mod >= 0 ? parseInt((r[mod] || "0").trim() || "0", 10) : 0,
      effective_date: eff >= 0 ? toISO(r[eff]) : null,
      deletion_date: del >= 0 ? toISO(r[del]) : null,
      rationale: rat >= 0 ? (r[rat] || "").trim() : null,
    })).filter((x) => x.column1_code && x.column2_code);
  }
  // mue
  const hc = col("hcpcs", [(h) => h.includes("hcpcs"), (h) => h.includes("cpt")]);
  const mv = col("mue_value", [(h) => h.includes("mue value"), (h) => h.includes("mue")]);
  const mai = col("mai", [(h) => h.includes("adjudication"), (h) => h.includes("mai")]);
  const rat = col("rationale", [(h) => h.includes("rationale")]);
  if (hc < 0 || mv < 0) throw new Error("Could not locate HCPCS / MUE value headers");
  return grid.slice(1).map((r) => ({
    hcpcs: (r[hc] || "").trim(),
    mue_value: parseInt((r[mv] || "0").trim() || "0", 10),
    mai: mai >= 0 ? parseInt((r[mai] || "1").trim() || "1", 10) : 1,
    rationale: rat >= 0 ? (r[rat] || "").trim() : null,
  })).filter((x) => x.hcpcs && Number.isFinite(x.mue_value));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const auth = req.headers.get("Authorization") || "";
  if (!auth) return json({ error: "missing Authorization" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const kind = (body.kind || "").toLowerCase();
  if (kind !== "ncci" && kind !== "mue") return json({ error: "kind must be 'ncci' or 'mue'" }, 400);
  if (!body.quarter) return json({ error: "quarter is required (e.g. '2026Q3')" }, 400);

  // Resolve the source rows
  let rows: any[] = [];
  try {
    if (Array.isArray(body.rows)) rows = body.rows;
    else {
      let csv = body.csv as string | undefined;
      if (!csv && body.url) {
        const r = await fetch(body.url);
        if (!r.ok) return json({ error: `fetch ${body.url} -> ${r.status}` }, 400);
        csv = await r.text();
      }
      if (!csv) return json({ error: "provide one of: rows[], csv, or url" }, 400);
      rows = rowsFromCSV(kind, csv, body.columns || {});
    }
  } catch (e) { return json({ error: "parse failed: " + (e as Error).message }, 400); }

  if (!rows.length) return json({ error: "no rows parsed" }, 400);

  const fn = kind === "ncci" ? "ingest_ncci_ptp" : "ingest_mue";
  const batch = Math.min(Math.max(parseInt(body.batch_size || "1000", 10) || 1000, 50), 5000);
  let parsed = 0, upserted = 0, batches = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const payload: Record<string, unknown> = kind === "ncci"
      ? { p_quarter: body.quarter, p_rows: chunk, p_source_url: body.source_url ?? null }
      : { p_quarter: body.quarter, p_rows: chunk, p_service_type: body.service_type ?? "practitioner", p_source_url: body.source_url ?? null };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: auth },
      body: JSON.stringify(payload),
    });
    const txt = await resp.text();
    if (!resp.ok) { errors.push(`batch ${batches}: ${resp.status} ${txt.slice(0, 300)}`); if (errors.length > 5) break; continue; }
    try { const d = JSON.parse(txt); parsed += d.parsed ?? chunk.length; upserted += d.upserted ?? 0; } catch { parsed += chunk.length; }
    batches++;
  }

  return json({
    ok: errors.length === 0, kind, quarter: body.quarter,
    total_rows: rows.length, batches, parsed, upserted,
    errors: errors.length ? errors : undefined,
  }, errors.length ? 207 : 200);
});
