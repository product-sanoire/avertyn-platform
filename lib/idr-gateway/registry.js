// ============================================================================
// Adapter registry — pick the implementation for a connection's mode.
// ============================================================================

import assistedBrowser from './adapters/assistedBrowser.js';
import autonomousRpa from './adapters/autonomousRpa.js';
import reportIngest from './adapters/reportIngest.js';
import emailEvent from './adapters/emailEvent.js';
import futureApi from './adapters/futureApi.js';

/** @type {Record<import('./adapter.js').AdapterMode, import('./adapter.js').GatewayAdapter>} */
export const ADAPTERS = {
  assisted_browser: assistedBrowser,
  autonomous_rpa: autonomousRpa,
  report_ingest: reportIngest,
  email_event: emailEvent,
  api: futureApi,
};

/**
 * @param {import('./adapter.js').AdapterMode} mode
 * @returns {import('./adapter.js').GatewayAdapter}
 */
export function getAdapter(mode) {
  const a = ADAPTERS[mode];
  if (!a) throw new Error(`unknown IDR adapter mode: ${mode}`);
  return a;
}

/** Capability descriptor for every mode — handy for rendering the config UI. */
export function allCapabilities() {
  return Object.fromEntries(Object.entries(ADAPTERS).map(([k, v]) => [k, v.capabilities]));
}
