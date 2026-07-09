// ============================================================================
// Adapter: api  (reserved — official Gateway API, when/if CMS exposes one)
//
// As of mid-2026 CMS has announced the centralized "IDR Gateway" but has NOT
// published a public API or bulk-exchange spec. This adapter is a placeholder so
// the day an API (or FHIR-based exchange under CMS-0057-F) lands, we implement
// pull/push here and flip the org's connection to `api` — nothing else in the
// connector, the tables, or the staging UI has to change.
//
// The seam is the whole point: RPA/email/report are bridges; the API is the
// destination. Building against the adapter contract now means the migration to
// an official API is a one-file change, not a rewrite.
// ============================================================================

/** @type {import('../adapter.js').GatewayCapabilities} */
export const capabilities = {
  canPull: false,
  canPush: false,
  realtime: true,
  transport: 'http',
  usPresenceRequired: false,
  mode: 'api',
};

/** @type {import('../adapter.js').GatewayAdapter['pull']} */
export async function pull(ctx) {
  ctx.log('[api] not yet available — CMS has not published an IDR Gateway API');
  return { events: 0 };
}

/** @type {import('../adapter.js').GatewayAdapter['push']} */
export async function push() {
  return { ok: false, error: 'official IDR Gateway API not yet available' };
}

export default { capabilities, pull, push };
