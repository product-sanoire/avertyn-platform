# Avertyn — session context for Claude (read this first)

This file is the durable memory across sessions. A fresh Cloud/Cowork session has
no recollection of prior work; everything an agent needs to deploy correctly lives here.

## Which repo is the deploy target — IMPORTANT

- **`product-sanoire/avertyn-platform`  ← THIS REPO. Deploy target. Canonical.**
  Vercel is git-linked to it and auto-deploys `main` to **https://platform.avertyn.com**.
  All application work must land here.
- `product-sanoire/avertyn-app` — the user's local development mirror
  (`C:\Users\jenni\Documents\Avertyn\app`). It is **not** what Vercel deploys.
  Do not push app changes here expecting them to go live. The two repos have diverged;
  never push one's `main` onto the other (histories are unrelated → rejected).

When in doubt, the live product = whatever is on `avertyn-platform` `main`.

## Deploy workflow

Normal path: commit to `main`, push, Vercel auto-deploys (~1–2 min). Verify with
`curl https://platform.avertyn.com` and grep the served
`/_next/static/chunks/app/page-*.js` chunk for new strings. The command center
lives at the site root (`/`); its implementation is `app/dashboard/Dashboard.js`,
re-exported by `app/page.js`. Sibling screens (`ops.js`, `workspace.js`, `admin.js`,
etc.) still live under `app/dashboard/` as modules.

**Known caveat — the git proxy:** the Cloud/Cowork sandbox routes all GitHub traffic
through a proxy that only injects credentials for repos in *that session's* authorized
set. That set is fixed at session start. If a session was not started with
`avertyn-platform` connected, every push is refused ("not in this session's authorized
repository set") and it cannot be fixed mid-session. Two workarounds:
1. Start a fresh Cowork session with `avertyn-platform` connected → push works normally.
2. Deliver a `git bundle`/patch to the user; they pull + push from their own machine.

## Backend — Supabase

- Project ref: `ssjougrsaecdwfuxeasd` · URL `https://ssjougrsaecdwfuxeasd.supabase.co`
- Anon (publishable) key and URL have public fallbacks hardcoded in
  `lib/supabaseClient.js` — the build works without env vars.
- Migrations live in `supabase/migrations/`; Edge Functions in `supabase/functions/`.
  Both are applied/deployed live via the Supabase MCP tools, and mirrored here as
  source-of-truth. Keep them in sync when you change the DB.
- Multi-tenant, org-scoped by RLS. Auth helpers: `auth_org_id()`, `auth_role()`,
  `can_action()`. Action ledger is hash-chained (`action_log`).

## Product

Plan-side / TPA **No Surprises Act IDR defense** platform. Core surfaces (dashboard tabs):
Overview (KPIs + cross-case predictions), **Cases** (the dispute queue — the work object;
"dispute"/"IDR dispute" stays the precise domain term inside a case), Intelligence
(initiators / exposure), Workspace (inbox / tasks / calendar), Filing (batch → IDRE →
file), Admin (access / reports / alerts / integrations).

IA notes: deadlines are integrated into Cases (per-row countdown chip + "Due soon"
filter), not a separate tab; the alert scan/dispatch machinery lives under Admin → Alerts.
Filing is also reachable from the Cases queue via multi-select → "Batch & file".
Explainability is a glass-box "Explain" modal on any case (`explain_dispute` + `qpa_explain`).

## Stubs waiting on the user's credentials (flip to live when provided)

- SSO login handshake (SAML/OIDC) — needs the user's IdP metadata (Okta/Azure).
- Real outbound email on the notification rail — needs a Resend API key.
  The SCIM 2.0 endpoint (`/functions/v1/scim`) and the scheduled-report pg_cron runner
  are already fully live.

## Security note

A broad, non-expiring GitHub write PAT was used during setup. It should be rotated
once proper auth is wired. Never commit tokens/keys to this repo.
