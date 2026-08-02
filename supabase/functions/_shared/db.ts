// Service-role Supabase client.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every edge
// function by the platform -- they are not secrets you set by hand. The service
// role bypasses RLS, which is why these tables carry no public policies.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { env } from './env.ts';

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    env('SUPABASE_URL'),
    env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return cached;
}
