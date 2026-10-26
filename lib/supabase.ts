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
    });
  }
  return admin;
}
