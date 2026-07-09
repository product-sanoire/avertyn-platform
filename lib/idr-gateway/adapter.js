// ============================================================================
// Avertyn — IDR Gateway adapter contract
//
// The connector is mechanism-agnostic. Everything above this file (sync
// orchestrator, staging UI, Supabase tables/RPCs) is identical no matter HOW an
// org actually reaches the CMS Federal IDR Gateway. Only the adapter changes.
//
// An adapter implements two directions:
//   pull(ctx)  -> observe portal state, emit normalized inbound events
//   push(ctx, submission) -> perform one staged outbound submission
//
// plus a static `capabilities` descriptor so the UI can gray out actions a
// given mechanism can't do (e.g. report-ingest is read-only; email-event can't
// push).
//
// This file is plain JS with JSDoc typedefs to match the app (no TS build).
// ============================================================================

/**
 * @typedef {'assisted_browser'|'autonomous_rpa'|'report_ingest'|'email_event'|'api'} AdapterMode
 */

/**
 * @typedef {Object} GatewayCapabilities
 * @property {boolean} canPull        Can observe inbound portal state at all.
 * @property {boolean} canPush        Can perform outbound submissions.
 * @property {boolean} realtime       Push/pull happen live (vs. batch/manual).
 * @property {'live_session'|'headless'|'file'|'inbox'|'http'} transport
 * @property {boolean} usPresenceRequired  True when the mechanism must originate
 *                                         from a US-verified identity/session
 *                                         (Gateway US-only + identity checks).
 * @property {AdapterMode} mode
 */

/**
 * Everything an adapter call needs. Injected by the orchestrator so adapters
 * stay free of app-wide singletons and are unit-testable.
 * @typedef {Object} AdapterContext
 * @property {import('@supabase/supabase-js').SupabaseClient} supabase
 * @property {Object} connection            Row from idr_connections.
 * @property {(kind:string, dedupeKey:string, fields:Object)=>Promise<any>} emit
 *           Normalize + persist one inbound event via rpc('idr_ingest_event').
 * @property {(msg:string, extra?:Object)=>void} log
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} PushResult
 * @property {boolean} ok
 * @property {Object} [receipt]   Gateway confirmation (number, timestamp, doc ref).
 * @property {string} [error]
 * @property {boolean} [needsHuman] True when the mechanism handed off to a person
 *                                  (assisted mode) and completion is out-of-band.
 */

/**
 * The contract every adapter satisfies.
 * @typedef {Object} GatewayAdapter
 * @property {GatewayCapabilities} capabilities
 * @property {(ctx:AdapterContext)=>Promise<{events:number, cursor?:Object}>} pull
 * @property {(ctx:AdapterContext, submission:Object)=>Promise<PushResult>} push
 */

/**
 * Helper: a push result for mechanisms that cannot push.
 * @param {AdapterMode} mode
 * @returns {PushResult}
 */
export function pushUnsupported(mode) {
  return { ok: false, error: `adapter "${mode}" is read-only; use assisted_browser or autonomous_rpa to submit` };
}

/** Base capabilities every adapter overrides. */
export const baseCapabilities = /** @type {GatewayCapabilities} */ ({
  canPull: false,
  canPush: false,
  realtime: false,
  transport: 'file',
  usPresenceRequired: true, // Gateway is US-only + identity-verified by default
  mode: 'report_ingest',
});
