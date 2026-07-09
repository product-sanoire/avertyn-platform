// ============================================================================
// Adapter: email_event  (read-only, event-driven — the "webhook" you get today)
//
// The Federal IDR process notifies parties by EMAIL (deadlines approaching, an
// offer posted, a determination issued). There is no CMS webhook, but an inbound
// mailbox + parser is a webhook in practice: forward the portal's notification
// address to an Avertyn ingest mailbox, and each message becomes an event within
// seconds. This is the closest thing to real-time push CMS exposes today, and it
// needs no portal credentials — so it too avoids the US-only/identity surface.
// READ-ONLY: signals only, cannot push submissions.
//
// The mail webhook (e.g. an inbound-parse endpoint) hands a parsed message in via
// ctx.connection.config.email. This adapter classifies it and emits one event.
// ============================================================================

import { normalizeEvent, dedupeKey } from '../mapping.js';
import { pushUnsupported } from '../adapter.js';

/** @type {import('../adapter.js').GatewayCapabilities} */
export const capabilities = {
  canPull: true,
  canPush: false,
  realtime: true,          // arrives seconds after CMS sends the notice
  transport: 'inbox',
  usPresenceRequired: false,
  mode: 'email_event',
};

// Very small classifier over notification subjects/bodies. Extend with real
// CMS notice templates once samples are on hand.
const PATTERNS = [
  [/determination|award (issued|decision)/i, 'determination_issued'],
  [/(response|offer).*(due|deadline)|deadline (approaching|reminder)/i, 'deadline_set'],
  [/offer (submitted|received|posted)/i, 'offer_recorded'],
  [/new dispute|dispute initiated against/i, 'dispute_discovered'],
  [/status|phase (change|update)/i, 'status_changed'],
];

/** @type {import('../adapter.js').GatewayAdapter['pull']} */
export async function pull(ctx) {
  const mail = ctx.connection?.config?.email;
  if (!mail) return { events: 0 };

  const text = `${mail.subject || ''}\n${mail.text || ''}`;
  const kind = (PATTERNS.find(([re]) => re.test(text)) || [null, 'status_changed'])[1];
  const ref = extractDisputeRef(text);

  const raw = {
    disputeNumber: ref,
    phase: matchAfter(text, /phase[:\s]+([A-Za-z ]+)/i),
    outcome: matchAfter(text, /in favor of ([A-Za-z\- ]+party)/i),
    due: matchAfter(text, /due (?:by|on)[:\s]+([0-9/\-]+)/i),
    subject: mail.subject,
  };
  await ctx.emit(kind, dedupeKey(ref, kind, mail.messageId || mail.subject || ''), {
    gateway_ref: ref, raw, normalized: normalizeEvent(kind, raw),
  });
  ctx.log(`[email] ${kind} for dispute ${ref}`);
  return { events: 1 };
}

/** @type {import('../adapter.js').GatewayAdapter['push']} */
export async function push() {
  return pushUnsupported('email_event');
}

function extractDisputeRef(text) {
  const m = text.match(/dispute\s*(?:#|no\.?|number)?\s*([A-Z0-9\-]{6,})/i);
  return m ? m[1] : null;
}
function matchAfter(text, re) { const m = text.match(re); return m ? m[1].trim() : null; }

export default { capabilities, pull, push };
