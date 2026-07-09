// ============================================================================
// Avertyn — IDR Gateway connector (public surface)
//
// import { syncConnection, getAdapter, allCapabilities } from '@/lib/idr-gateway';
//
// The connector is mechanism-agnostic: the same tables, RPCs, staging UI and
// sync engine work whether the org reaches the CMS Federal IDR Gateway via an
// assisted browser session, headless RPA, exported reports, notification email,
// or (future) an official API. Swapping mechanisms is a one-field change on
// idr_connections.adapter — no downstream code changes.
// ============================================================================

export { getAdapter, allCapabilities, ADAPTERS } from './registry.js';
export { pullOnce, pushQueued, syncConnection } from './sync.js';
export { normalizeEvent, dedupeKey, PHASE_TO_STATE, OUTCOME_TO_DISPOSITION, DEADLINE_TO_KIND } from './mapping.js';
export { pushUnsupported, baseCapabilities } from './adapter.js';
