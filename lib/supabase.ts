// Server-only Supabase client. SUPABASE_SERVICE_ROLE bypasses RLS, so this
// module must never be imported from a client component. `server-only` turns
// an accidental client import into a build error rather than a silent leak.
import 'server-only';
import { createClient } from '@supabase/supabase-js';

/** Target schema for every table this job writes. */
export const TARGET_SCHEMA = 'b2b_metrics';

function build(url: string, serviceRole: string) {
  return createClient(url, serviceRole, {
    db: { schema: TARGET_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client bound to the b2b_metrics schema, not the default `public`. */
export type MetricsClient = ReturnType<typeof build>;

let cached: MetricsClient | null = null;

export function getSupabaseClient(): MetricsClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRole) {
    // Names only -- never the value.
    const missing = [
      !url && 'SUPABASE_URL',
      !serviceRole && 'SUPABASE_SERVICE_ROLE',
    ].filter(Boolean);
    throw new Error(`Missing Supabase env vars: ${missing.join(', ')}`);
  }

  cached = build(url, serviceRole);
  return cached;
}
