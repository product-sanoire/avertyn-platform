# Avertyn — web app (scaffold)

Next.js (App Router) + Supabase starter for the TPA/plan-side IDR defense platform.
Reads live from the **Avertyn** Supabase project and renders the command-center queue
from real `disputes` rows (org-isolated by RLS).

## Stack
- Next.js 14 (App Router, JS)
- Supabase (`@supabase/ssr` + `@supabase/supabase-js`) — Postgres, Auth (email OTP), RLS

## Run locally
```bash
cd avertyn-app
cp .env.local.example .env.local     # values already point at the live Avertyn project
npm install
npm run dev                          # http://localhost:3000
```

## First-time auth setup (see the seeded demo data)
The database has a demo org (**Meridian Plan Administrators**) with 8 disputes.
RLS hides every row unless your signed-in user is attached to that org.

1. Start the app, go to `/login`, enter your email, click the magic link.
2. After you exist in `auth.users`, attach yourself to the demo org. In the Supabase
   SQL editor (or via the MCP), run:
   ```sql
   insert into public.app_users (id, org_id, email, full_name, role)
   select u.id,
          'a0000000-0000-0000-0000-000000000001',   -- demo org: Meridian Plan Administrators
          u.email, 'Demo Analyst', 'admin'
   from auth.users u
   where u.email = 'YOU@EXAMPLE.COM'
   on conflict (id) do update set org_id = excluded.org_id;
   ```
3. Reload `/dashboard` — the action queue and KPIs now render from live data.

> For local email testing you can enable "Confirm email = off" and use the Supabase
> Auth "magic link" logs, or configure an SMTP provider in project Auth settings.

## What's implemented
- `/` landing → `/dashboard`
- `/login` — email OTP (magic link)
- `/dashboard` — session guard, live `disputes` query (embeds plan + initiator names),
  KPI strip (open, likely-ineligible, windows < 48h, $ defended, awards), action queue
  with the "Avertyn read" recommendation per case (`lib/format.js`).

## Next build steps
- **Case workspace** (`/dispute/[id]`): eligibility findings, QPA record, offers, docs, audit.
- **Eligibility scoring**: Edge Function that runs `eligibility_rules` → writes
  `eligibility_findings` and sets `disputes.eligibility_score`.
- **Server-side auth** with `@supabase/ssr` cookies + middleware for protected routes.
- **Signup trigger**: auto-create an `app_users` row bound to an org on first sign-in.
- **Deadline engine**: business-day countdown + reminder notifications.
- Point the React Native app at the same project (shared API client + tokens).

## Project
- Supabase ref: `ssjougrsaecdwfuxeasd` · URL `https://ssjougrsaecdwfuxeasd.supabase.co`
- Schema & rule engine: see `../Avertyn-product-foundation.md`
- Design tokens/components: see `../Avertyn-design-system.html`
