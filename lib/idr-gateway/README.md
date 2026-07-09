# IDR Gateway connector (`lib/idr-gateway`)

Deep integration between Avertyn and the **CMS Federal IDR Gateway** — the
centralized No Surprises Act dispute-resolution platform CMS announced in 2026.

## The one idea

The connector is **mechanism-agnostic**. Everything except the adapter is shared:

```
disputes / deadlines / documents            ← existing Avertyn schema
        ▲
idr_reconcile_event                          ← fold events into operations
        ▲
idr_sync_events (inbound)  idr_submissions (outbound, edit-in-app)
        ▲                          │
     sync.js  ── orchestrator ─────┘         ← mechanism-independent
        ▲
   adapter (ONE of):
     assisted_browser · autonomous_rpa · report_ingest · email_event · api
```

Switching how an org reaches the Gateway is a single field change on
`idr_connections.adapter`. When CMS ships an official API, implement `adapters/futureApi.js`
and flip the field — nothing downstream changes.

## Adapters

| mode | direction | real-time | US-presence needed | notes |
|---|---|---|---|---|
| `assisted_browser` | pull + push | yes | yes | co-pilot in the operator's own verified session; most compliant |
| `autonomous_rpa` | pull + push | polled | yes (US infra + service identity) | lights-out; highest ToS/compliance surface |
| `report_ingest` | pull only | no (report cadence) | no | ingest Gateway report exports; read-only |
| `email_event` | pull only | yes | no | parse portal notification emails; the closest thing to a webhook today |
| `api` | reserved | — | no | official Gateway/FHIR API when CMS exposes one |

## Data flow

- **Inbound (real-time sync):** an adapter observes portal state → `emit()` →
  `idr_ingest_event` (idempotent on `dedupe_key`) → `idr_reconcile_event`
  updates `disputes` / `deadlines`.
- **Outbound (edit-in-app):** operator stages a submission
  (`idr_stage_submission`, status `draft`) → edits `payload` in the UI →
  approves (`idr_advance_submission` → `queued`) → `pushQueued()` runs the
  adapter → `confirmed` with the Gateway receipt. Approval + push route through
  the ontology kernel so they land on the tamper-evident ledger and honor the
  autonomy dial.

## What's a stub vs. wired

Real and complete: the adapter contract, the registry/orchestrator seams, the
field mapping, the Supabase tables + RLS + RPCs (migration
`20260709_idr_gateway_connector.sql`).

Stubbed pending live-portal specifics: the browser DOM reads (`pageSnapshot`),
the headless driver worker (`driverEndpoint`), the inbound-mail webhook, the
report parser at the upload boundary, and the `-- KERNEL:` call sites where the
RPCs should invoke `execute_action`. Every stub is marked in-file.

## Do not apply the migration to prod blindly

`supabase/migrations/20260709_idr_gateway_connector.sql` is **not** applied to
the live project. Review it, confirm the `authenticated` role name and the
`execute_action` signature, then apply via `supabase db push` or the SQL editor.
