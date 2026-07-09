"use client";
import { createBrowserClient } from "@supabase/ssr";

// Single browser client for the app. RLS enforces that a signed-in user
// only sees rows for their org (app_users.org_id).
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
