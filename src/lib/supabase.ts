// ============================================================
// Supabase client instances — fully lazy, Vercel-safe.
// No env access at module load time. All validation deferred
// to first runtime call so build never crashes.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ---- Helpers ---------------------------------------------------

function getUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v) throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_URL");
  return v;
}

function getAnonKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v) throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return v;
}

function getServiceKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");
  return v;
}

// ---- Public client (lazy singleton, Proxy) ---------------------

let _public: SupabaseClient | null = null;

function publicClient(): SupabaseClient {
  if (!_public) _public = createClient(getUrl(), getAnonKey());
  return _public;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = publicClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// ---- Admin client (new instance per call, server-side only) ----

export function getSupabaseAdmin(): SupabaseClient {
  return createClient(getUrl(), getServiceKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
