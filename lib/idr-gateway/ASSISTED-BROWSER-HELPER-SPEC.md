# Assisted browser-helper — implementation spec

The `assisted_browser` adapter's runtime half: a small browser helper that runs
inside the operator's **own, US-verified** CMS Federal IDR Gateway session. It
reads the page the operator is already looking at (to emit sync events) and
pre-fills submission forms the operator reviews and submits themselves. Avertyn
never holds portal credentials and never clicks "Submit" — the human does.

This is the compliant answer to the Gateway's US-only + identity-verification
controls: the verified person is genuinely present.

---

## 1. Delivery options

| Option | Fit | Notes |
|---|---|---|
| **Chrome/Edge MV3 extension** | Recommended | Content script on `nsa-idr.cms.gov`; full DOM read + fill; survives SPA nav. Ships via the operator's browser. |
| **Claude-in-Chrome / agent driver** | Fastest to pilot | Reuses an existing in-browser agent to read/fill on command; good for a demo, weaker for always-on capture. |
| **Bookmarklet** | Throwaway only | One-shot page scrape; no background capture. Prototyping only. |

The rest of this spec assumes the **MV3 extension**; the message protocol is
identical for the agent driver.

---

## 2. Components

```
┌ Operator's browser ───────────────────────────────┐
│  nsa-idr.cms.gov  (verified session, operator)     │
│        ▲ read DOM            ▼ fill form            │
│  ┌ content script ───────────────────────────┐     │
│  │  observers: dashboard rows, case detail    │     │
│  │  filler:    maps payload → form fields      │     │
│  └───────────▲───────────────────▼────────────┘     │
│              │ chrome.runtime      │                 │
│  ┌ background service worker ─────────────────┐     │
│  │  holds Avertyn session (Supabase JWT)       │     │
│  │  calls RPCs; polls queued submissions       │     │
│  └───────────▲───────────────────▼────────────┘     │
└──────────────┼───────────────────┼──────────────────┘
               │ Supabase REST/RPC  │
        idr_ingest_event     idr_submissions (poll queued)
        idr_reconcile_event  idr_advance_submission
```

The background worker authenticates to Avertyn (same Supabase project) so every
call is RLS-scoped to the operator's org — no service-role key in the browser.

---

## 3. Inbound: page-read → events

The content script runs observers on the two Gateway surfaces:

- **Dashboard / dispute list** → one `raw` row per dispute:
  `{ disputeNumber, phase, due, outcome, initiatingParty, disputedAmount, serviceCode, isNew }`
- **Case detail** → phase, published deadlines, posted offers, determination.

For each observed change the content script posts to the background worker, which
normalizes via the connector's `mapping.js` and calls:

```
supabase.rpc('idr_ingest_event', {
  p_connection_id, p_kind, p_dedupe_key,   // dedupeKey(disputeNumber, kind, discriminator)
  p_gateway_ref: disputeNumber, p_raw, p_normalized,
})
```

then `idr_reconcile_event` for each new event id. Idempotency on `dedupe_key`
means re-observing the same row is a no-op — safe to run the observer on every
DOM mutation or a short interval.

**Selectors** live in one map so a portal change is a one-file edit:

```js
const SEL = {
  dashboardRow: '[data-idr="dispute-row"], table.dispute-list tbody tr',
  cell: { number: '.col-dispute-id', phase: '.col-phase', due: '.col-due', outcome: '.col-outcome' },
  detail: { phase: '#case-phase', determination: '#determination-outcome' },
};
```
(Confirm against the live Gateway DOM; these are placeholders.)

---

## 4. Outbound: queued submission → pre-fill → operator submits → receipt

1. **Poll.** Background worker subscribes to (or polls, per `poll_interval_sec`)
   `idr_submissions` where `status = 'queued'` and `connection_id` is this org's
   assisted connection.
2. **Navigate + fill.** For each, it opens the matching Gateway form and asks the
   content script to fill fields from `submission.payload` via a per-kind map:

   | kind | payload → form fields |
   |---|---|
   | `submit_offer` / `respond_to_dispute` | `amount` → offer input; attach `documentIds` |
   | `open_negotiation_notice` | `recipient`, `claimRefs`, `noticeDate` |
   | `eligibility_objection` | `objectionText`, cited `ruleCodes` |
   | `upload_document` | file picker ← `documentIds` (resolved to blobs) |
   | `select_idre` | `idreId` → IDRE dropdown |

3. **Hand off.** The helper **stops at a filled, unsubmitted form** and surfaces a
   non-blocking banner: *"Avertyn pre-filled this — review and submit."* It never
   auto-clicks submit. (Set `status → in_flight` when the form is presented, so
   the UI reflects "awaiting operator".)
4. **Confirm.** On the portal's confirmation screen the content script scrapes the
   confirmation number and calls:

```
supabase.rpc('idr_advance_submission', {
  p_submission_id, p_to: 'confirmed',
  p_receipt: { confirmationNumber, at, docRef },
})
```
which writes the ledger entry and (for offer kinds) runs the `submit_response`
kernel action. Failures → `p_to:'failed'` with the message.

> Never trigger native `alert()/confirm()` dialogs from the helper — they block
> the page and the extension messaging. Use in-page banners + `console` only.

---

## 5. Message protocol (content ⇄ background)

```ts
// content -> background
{ type: 'IDR_OBSERVED', surface: 'dashboard'|'detail', rows: RawRow[] }
{ type: 'IDR_RECEIPT', submissionId: string, receipt: {confirmationNumber,at,docRef} }
{ type: 'IDR_FILL_RESULT', submissionId: string, ok: boolean, error?: string }
// background -> content
{ type: 'IDR_FILL', submissionId: string, kind: string, fields: Record<string,any> }
{ type: 'IDR_HIGHLIGHT', selector: string }   // draw attention to the submit button
```

All messages carry a nonce; the background worker rejects any message whose
`sender.tab.url` origin isn't the Gateway host.

---

## 6. Security model

- **No credentials stored by Avertyn.** The operator authenticates to CMS
  normally; the helper only reads/fills the DOM of that live session.
- **Least privilege.** `host_permissions` limited to `https://nsa-idr.cms.gov/*`
  and the Avertyn app origin. No `<all_urls>`.
- **Avertyn auth in the worker only.** Supabase JWT lives in the background
  service worker (not the content script); RLS scopes every call to the org.
- **Human gate preserved.** The helper never submits. Approval already happened
  in-app (`queued`, ledgered); the operator's in-portal click is the second gate.
- **Audit.** Presentation (`in_flight`) and receipt (`confirmed`) both hit the
  tamper-evident ledger via the RPCs — the full path is reconstructable.
- **PII/PHI.** The helper transmits only what the payload needs; raw page scrapes
  stay client-side except the normalized fields sent to `idr_ingest_event`.

---

## 7. Build order

1. MV3 skeleton: manifest, background worker with Supabase auth, Gateway host perms.
2. Content-script dashboard observer → `idr_ingest_event` (read-only path first — ship this alone for value).
3. Case-detail observer → deadlines/determinations.
4. Queued-submission poller + per-kind form filler + hand-off banner.
5. Confirmation scraper → `idr_advance_submission('confirmed', receipt)`.
6. Selector/field maps hardened against the live Gateway; error + retry UX.

Ship after step 2 for immediate inbound sync; steps 4–5 complete the outbound loop.
