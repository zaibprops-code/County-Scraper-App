// ============================================================
// Supabase client instances
// - supabase      → anon key, safe for browser / frontend
// - supabaseAdmin → service role key, server-side ONLY
// ============================================================

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable."
  );
}

// Public client — safe to use in React components
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin client — server-side only (API routes, cron jobs)
// Never expose SUPABASE_SERVICE_ROLE_KEY to the browser
export function getSupabaseAdmin() {
  if (!supabaseServiceKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
