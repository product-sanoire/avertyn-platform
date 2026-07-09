// ============================================================================
// Sync orchestrator — the mechanism-independent engine.
//
// It knows nothing about HOW an org reaches the Gateway; it just:
//   pullOnce()   -> ask the adapter to observe, persist events (idr_ingest_event),
//                   then reconcile them into disputes/deadlines (idr_reconcile_event)
//   pushQueued() -> for each queued submission, ask the adapter to push, then
//                   advance its lifecycle (idr_advance_submission)
//
// Every write goes through the Supabase RPCs from the migration, so RLS,
// idempotency, and (for pushes) the ontology-kernel ledger all apply. Adapters
// only ever touch the DB through the injected `emit` closure — never directly.
// ============================================================================

import { getAdapter } from './registry.js';

/**
 * Build the AdapterContext for a connection.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object} connection
 * @param {(m:string,x?:Object)=>void} [logger]
 * @param {AbortSignal} [signal]
 * @returns {import('./adapter.js').AdapterContext}
 */
function makeContext(supabase, connection, logger, signal) {
  const log = logger || ((m) => console.info(m));
  return {
    supabase,
    connection,
    signal,
    log,
    // Normalize + persist one inbound event (idempotent on dedupe_key).
    async emit(kind, dedupeKeyStr, fields) {
      const { error } = await supabase.rpc('idr_ingest_event', {
        p_connection_id: connection.id,
        p_kind: kind,
        p_dedupe_key: dedupeKeyStr,
        p_gateway_ref: fields.gateway_ref ?? null,
        p_raw: fields.raw ?? {},
        p_normalized: fields.normalized ?? {},
      });
      if (error) log(`emit(${kind}) failed: ${error.message}`, { error });
    },
  };
}

/**
 * One inbound sync pass for a connection: observe -> ingest -> reconcile.
 * @returns {Promise<{events:number, reconciled:number}>}
 */
export async function pullOnce(supabase, connection, { logger, signal } = {}) {
  const adapter = getAdapter(connection.adapter);
  if (!adapter.capabilities.canPull) return { events: 0, reconciled: 0 };

  const ctx = makeContext(supabase, connection, logger, signal);
  const { events, cursor } = await adapter.pull(ctx);

  if (cursor) {
    await supabase.from('idr_connections').update({ sync_cursor: cursor }).eq('id', connection.id);
  }

  // Reconcile everything still pending for this org (replayable + auditable).
  const { data: pending } = await supabase
    .from('idr_sync_events').select('id').eq('reconciled', false).limit(500);
  let reconciled = 0;
  for (const e of pending ?? []) {
    const { error } = await supabase.rpc('idr_reconcile_event', { p_event_id: e.id });
    if (!error) reconciled++;
  }
  ctx.log(`[sync] pull: ${events} events, ${reconciled} reconciled`);
  return { events, reconciled };
}

/**
 * Push every queued submission for a connection through the adapter.
 * @returns {Promise<{pushed:number, needsHuman:number, failed:number}>}
 */
export async function pushQueued(supabase, connection, { logger, signal } = {}) {
  const adapter = getAdapter(connection.adapter);
  const ctx = makeContext(supabase, connection, logger, signal);
  if (!adapter.capabilities.canPush) {
    ctx.log(`[sync] adapter ${connection.adapter} cannot push; skipping`);
    return { pushed: 0, needsHuman: 0, failed: 0 };
  }

  const { data: queued } = await supabase
    .from('idr_submissions').select('*')
    .eq('status', 'queued').eq('connection_id', connection.id).order('due_at', { ascending: true });

  let pushed = 0, needsHuman = 0, failed = 0;
  for (const sub of queued ?? []) {
    await supabase.rpc('idr_advance_submission', { p_submission_id: sub.id, p_to: 'in_flight' });
    const res = await adapter.push(ctx, sub);

    if (res.needsHuman) {
      needsHuman++; // stays in_flight until the operator confirms out-of-band
    } else if (res.ok) {
      await supabase.rpc('idr_advance_submission', {
        p_submission_id: sub.id, p_to: 'confirmed', p_receipt: res.receipt ?? {},
      });
      pushed++;
    } else {
      await supabase.rpc('idr_advance_submission', {
        p_submission_id: sub.id, p_to: 'failed', p_error: res.error ?? 'unknown',
      });
      failed++;
    }
  }
  ctx.log(`[sync] push: ${pushed} confirmed, ${needsHuman} awaiting operator, ${failed} failed`);
  return { pushed, needsHuman, failed };
}

/** Convenience: run both directions for a connection. */
export async function syncConnection(supabase, connection, opts = {}) {
  const pull = await pullOnce(supabase, connection, opts);
  const push = await pushQueued(supabase, connection, opts);
  return { pull, push };
}
