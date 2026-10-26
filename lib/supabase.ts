import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ENV } from './env';

/**
 * Service-role client — SERVER ONLY. Bypasses RLS (all tables are RLS-on, deny-all
 * for anon). Never import this from client components.
 */
let admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    const missing: string[] = [];
    if (!ENV.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!ENV.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (missing.length) {
      throw new Error('Missing env vars: ' + missing.join(', ') + ' — set them in the Vercel dashboard.');
    }
    admin = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Next.js caches fetch() GETs in its Data Cache by default; that served stale rows (and a stale
      // sync cursor). Every Supabase call must hit the database.
      global: { fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }) },
    });
  }
  return admin;
}

/** Supabase/PostgREST caps every response at 1000 rows (project "max rows"); page through ALL rows.
 *  `build` must return a fresh query each call. A stable `id` tiebreaker keeps pages consistent. */
export async function fetchAll(build: () => any, pageSize = 1000): Promise<{ data: any[]; error: any }> {
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + pageSize - 1);
    if (error) return { data: out, error };
    if (data && data.length) out.push(...data);
    if (!data || data.length < pageSize) break;
  }
  return { data: out, error: null };
}
