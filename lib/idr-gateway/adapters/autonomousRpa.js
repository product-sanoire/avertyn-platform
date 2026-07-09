// ============================================================================
// Adapter: autonomous_rpa  (headless / lights-out)
//
// Drives the Gateway with no human present, from US-based infrastructure using a
// verified SERVICE identity the org has registered for the purpose. Highest
// automation; also the highest compliance/ToS surface — it must satisfy the
// Gateway's US-only + identity-verification controls without a live person, and
// portal terms may restrict automated access. Gate this behind an explicit,
// per-org opt-in and legal review (see the plan's risk section).
//
// Implementation runs a Playwright/CDP worker on US infra. This file is the
// adapter seam; the actual browser driver lives in a separate worker process
// and is invoked through ctx.connection.config.driverEndpoint. Kept out of the
// Next.js client bundle — import only from a server route / worker.
// ============================================================================

import { normalizeEvent, dedupeKey } from '../mapping.js';

/** @type {import('../adapter.js').GatewayCapabilities} */
export const capabilities = {
  canPull: true,
  canPush: true,
  realtime: true,          // polled on the connection's poll_interval_sec
  transport: 'headless',
  usPresenceRequired: true, // MUST run on US infra w/ a verified service identity
  mode: 'autonomous_rpa',
};

/**
 * Poll the Gateway dashboard for this org's disputes and emit changed rows.
 * The headless worker returns already-parsed rows; resume via sync_cursor.
 * @type {import('../adapter.js').GatewayAdapter['pull']}
 */
export async function pull(ctx) {
  const driver = await callDriver(ctx, 'scrapeDashboard', { cursor: ctx.connection.sync_cursor });
  let n = 0;
  for (const raw of driver.rows ?? []) {
    const kind = raw.outcome ? 'determination_issued'
      : raw.due ? 'deadline_set'
      : raw.isNew ? 'dispute_discovered'
      : 'status_changed';
    await ctx.emit(kind, dedupeKey(raw.disputeNumber, kind, raw.phase || raw.due || raw.outcome || ''), {
      gateway_ref: raw.disputeNumber, raw, normalized: normalizeEvent(kind, raw),
    });
    n++;
  }
  ctx.log(`[rpa] scraped ${n} rows`);
  return { events: n, cursor: driver.cursor };
}

/**
 * Perform the submission end-to-end in the headless session. On success capture
 * the Gateway confirmation number as the receipt.
 * @type {import('../adapter.js').GatewayAdapter['push']}
 */
export async function push(ctx, submission) {
  try {
    const res = await callDriver(ctx, 'submit', { kind: submission.kind, payload: submission.payload });
    if (!res.ok) return { ok: false, error: res.error || 'driver reported failure' };
    ctx.log(`[rpa] submitted ${submission.kind}; receipt ${res.confirmationNumber}`);
    return { ok: true, receipt: { confirmationNumber: res.confirmationNumber, at: res.at, docRef: res.docRef } };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Thin RPC to the out-of-process browser worker (never bundled client-side).
async function callDriver(ctx, op, args) {
  const endpoint = ctx.connection?.config?.driverEndpoint;
  if (!endpoint) throw new Error('autonomous_rpa: no driverEndpoint configured');
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, connectionId: ctx.connection.id, args }),
    signal: ctx.signal,
  });
  if (!r.ok) throw new Error(`driver ${op} -> HTTP ${r.status}`);
  return r.json();
}

export default { capabilities, pull, push };
