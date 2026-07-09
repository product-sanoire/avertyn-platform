// ============================================================================
// Field mapping: CMS Federal IDR Gateway vocabulary  <->  Avertyn schema
//
// One place to translate what the Gateway shows (portal columns, email fields,
// report headers) into Avertyn's field names. Keeping this isolated means a
// change to the portal's wording touches exactly one file.
//
// NOTE: portal labels below are placeholders based on the public IDR forms and
// the announced Gateway dashboard. Confirm against the live Gateway and adjust.
// ============================================================================

/** Gateway "process phase" -> disputes.workflow_state */
export const PHASE_TO_STATE = {
  'Open Negotiation':        'triage',
  'Eligibility Review':      'eligibility_review',
  'IDR Initiated':           'response_prep',
  'Offer Submission':        'response_prep',
  'Awaiting Determination':  'awaiting_determination',
  'Payment':                 'award_payment',
  'Closed':                  'closed',
};

/** Gateway determination outcome -> disputes.disposition */
export const OUTCOME_TO_DISPOSITION = {
  'In favor of initiating party':      'provider_win',
  'In favor of non-initiating party':  'plan_win',
  'Settled':                           'settled',
  'Withdrawn':                         'withdrawn',
  'Ineligible':                        'eligibility_challenged',
};

/** Gateway deadline label -> deadlines.kind */
export const DEADLINE_TO_KIND = {
  'Open Negotiation End': 'open_negotiation',
  'IDR Initiation':       'initiation',
  'Response Due':         'response',
  'Document Request':     'document_request',
  'Payment Due':          'payment',
};

/**
 * Normalize a raw observed portal row into Avertyn's event vocabulary.
 * Adapters compute `raw`; this returns the `normalized` jsonb stored on the event.
 * @param {string} kind idr_event_kind
 * @param {Object} raw  as-observed fields
 * @returns {Object}
 */
export function normalizeEvent(kind, raw) {
  switch (kind) {
    case 'status_changed':
      return { workflow_state: PHASE_TO_STATE[raw.phase] ?? null, phase_raw: raw.phase };
    case 'determination_issued':
      return { disposition: OUTCOME_TO_DISPOSITION[raw.outcome] ?? null, outcome_raw: raw.outcome,
               award_amount: num(raw.awardAmount) };
    case 'deadline_set':
      return { deadline_kind: DEADLINE_TO_KIND[raw.label] ?? 'response', due_at: toIso(raw.due) };
    case 'offer_recorded':
      return { party: /initiat/i.test(raw.party || '') ? 'initiator' : 'plan', amount: num(raw.amount) };
    case 'dispute_discovered':
      return { gateway_ref: raw.disputeNumber, initiator: raw.initiatingParty,
               demand_amount: num(raw.disputedAmount), cpt_code: raw.serviceCode };
    default:
      return { ...raw };
  }
}

/**
 * A stable idempotency key so the same portal fact seen twice (poll overlap, or
 * email + report describing one determination) collapses to a single event.
 * @param {string} gatewayRef
 * @param {string} kind
 * @param {string} discriminator e.g. a phase name, due date, or offer id
 */
export function dedupeKey(gatewayRef, kind, discriminator = '') {
  return [gatewayRef || 'unknown', kind, discriminator].join('|');
}

const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[^0-9.\-]/g, '')));
const toIso = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(+d) ? d.toISOString() : null; };
