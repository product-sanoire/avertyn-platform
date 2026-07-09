// ============================================================================
// Adapter: assisted_browser  (human-in-the-loop / co-pilot)
//
// Runs inside the OPERATOR'S OWN US-based, identity-verified Gateway session —
// a browser extension or a Claude-in-Chrome style helper. Avertyn never holds
// portal credentials and never impersonates the user; it reads the page the
// operator is already looking at and pre-fills forms the operator reviews and
// clicks "Submit" on themselves.
//
// This is the most compliant model against the Gateway's US-only +
// identity-verification controls, because the human is genuinely present.
// Trade-off: pushes are not "lights-out" — they complete when the operator acts.
// ============================================================================

import { normalizeEvent, dedupeKey } from '../mapping.js';

/** @type {import('../adapter.js').GatewayCapabilities} */
export const capabilities = {
  canPull: true,
  canPush: true,
  realtime: true,          // reflects whatever the operator is viewing, live
  transport: 'live_session',
  usPresenceRequired: true,
  mode: 'assisted_browser',
};

/**
 * Observe the operator's current Gateway view (dashboard rows, case detail) and
 * emit events. The DOM read is performed by the browser helper and handed in via
 * ctx.connection.config.pageSnapshot, so this file has no direct DOM coupling.
 * @type {import('../adapter.js').GatewayAdapter['pull']}
 */
export async function pull(ctx) {
  const rows = ctx.connection?.config?.pageSnapshot?.rows ?? [];
  let n = 0;
  for (const raw of rows) {
    const kind = inferKind(raw);
    await ctx.emit(kind, dedupeKey(raw.disputeNumber, kind, raw.phase || raw.due || ''), {
      gateway_ref: raw.disputeNumber,
      raw,
      normalized: normalizeEvent(kind, raw),
    });
    n++;
  }
  ctx.log(`[assisted] observed ${n} rows from operator session`);
  return { events: n };
}

/**
 * "Push" = pre-fill the Gateway form for this submission and hand it to the
 * operator. Returns needsHuman:true; the browser helper fills fields from
 * `submission.payload`, the operator reviews and submits, then the helper calls
 * back with the receipt (idr_advance_submission -> confirmed).
 * @type {import('../adapter.js').GatewayAdapter['push']}
 */
export async function push(ctx, submission) {
  ctx.log(`[assisted] prefilled ${submission.kind} for dispute ${submission.dispute_id}; awaiting operator submit`);
  // The helper renders submission.payload into the on-screen form. Nothing is
  // sent server-side; completion is confirmed out-of-band by the operator.
  return { ok: true, needsHuman: true };
}

function inferKind(raw) {
  if (raw.outcome) return 'determination_issued';
  if (raw.due) return 'deadline_set';
  if (raw.phase) return 'status_changed';
  if (raw.disputeNumber && raw.isNew) return 'dispute_discovered';
  return 'status_changed';
}

export default { capabilities, pull, push };
