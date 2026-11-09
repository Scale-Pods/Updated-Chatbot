import { createClient } from "@supabase/supabase-js"

/**
 * Server-only Supabase client using the service_role key.
 *
 * Import this only from server code (API routes, server components, actions).
 * The service_role key bypasses Row Level Security and must never reach the
 * browser.
 */
export function createServerSupabaseClient() {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable",
    )
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
