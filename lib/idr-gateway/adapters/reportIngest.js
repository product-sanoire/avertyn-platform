// ============================================================================
// Adapter: report_ingest  (read-only, batch)
//
// The announced IDR Gateway gives an org "dispute dashboards and reports". This
// adapter ingests those exported reports (CSV/XLSX the operator downloads, or a
// scheduled export drop) and turns each row into an inbound event. No portal
// automation, no credentials in Avertyn — so it sidesteps the US-only/identity
// concerns entirely. It is READ-ONLY: it cannot push submissions.
//
// Lowest-risk way to get "real-time-ish" sync: pair a frequent report drop with
// this ingester. Freshness is bounded by how often the report is produced.
// ============================================================================

import { normalizeEvent, dedupeKey } from '../mapping.js';
import { pushUnsupported } from '../adapter.js';

/** @type {import('../adapter.js').GatewayCapabilities} */
export const capabilities = {
  canPull: true,
  canPush: false,
  realtime: false,         // as fresh as the report cadence
  transport: 'file',
  usPresenceRequired: false, // works from an already-exported file
  mode: 'report_ingest',
};

/**
 * Parse rows handed in via ctx.connection.config.report (already-parsed array of
 * objects — CSV/XLSX parsing happens at the upload boundary) and emit events.
 * @type {import('../adapter.js').GatewayAdapter['pull']}
 */
export async function pull(ctx) {
  const rows = ctx.connection?.config?.report?.rows ?? [];
  let n = 0;
  for (const raw of rows) {
    // A report row is a full snapshot of a dispute; emit the salient facts.
    const emits = [];
    if (raw.phase)   emits.push(['status_changed', raw.phase]);
    if (raw.due)     emits.push(['deadline_set', raw.due]);
    if (raw.outcome) emits.push(['determination_issued', raw.outcome]);
    if (!emits.length) emits.push(['dispute_discovered', 'new']);

    for (const [kind, disc] of emits) {
      await ctx.emit(kind, dedupeKey(raw.disputeNumber, kind, String(disc)), {
        gateway_ref: raw.disputeNumber, raw, normalized: normalizeEvent(kind, raw),
      });
      n++;
    }
  }
  ctx.log(`[report] ingested ${n} events from ${rows.length} report rows`);
  return { events: n };
}

/** @type {import('../adapter.js').GatewayAdapter['push']} */
export async function push() {
  return pushUnsupported('report_ingest');
}

export default { capabilities, pull, push };
