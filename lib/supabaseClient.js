"use client";
import { createBrowserClient } from "@supabase/ssr";

// Single browser client for the app. RLS enforces that a signed-in user
// only sees rows for their org (app_users.org_id).
// Public (publishable) fallbacks — safe to embed; RLS enforces org isolation.
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ssjougrsaecdwfuxeasd.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_XcM-JO1GQ92RbgDQ4eKKqQ_a970au8Z"
);
