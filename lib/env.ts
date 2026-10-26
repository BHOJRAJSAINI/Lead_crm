import { createHash } from 'crypto';

export const ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '',
  CRON_SECRET: process.env.CRON_SECRET || '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-only-pepper',
  APP_TIMEZONE: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  QUOTATIONS_BUCKET: process.env.QUOTATIONS_BUCKET || 'quotations',
  SHEET_WEBHOOK_SECRET: process.env.SHEET_WEBHOOK_SECRET || '',
  QUOTATION_HEADER_URL: process.env.QUOTATION_HEADER_URL || '',
  LOGO_URL: process.env.LOGO_URL || '',
};

export function requireEnv(): void {
  const missing: string[] = [];
  if (!ENV.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!ENV.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error('Missing env vars: ' + missing.join(', ') + ' — set them in the Vercel dashboard.');
  }
}

/** sha256(token + pepper) — raw tokens are never stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token + ENV.SESSION_SECRET).digest('hex');
}

/** DEV DEMO CREDENTIALS ONLY — replace with real users via Admin > New User. */
export const DEV_SEED_USERS = [
  { email: 'admin@panacheevents.in', password: 'admin@123', role: 'Admin', name: 'Admin' },
  { email: 'sales@panacheevents.in', password: 'sales@123', role: 'Sales Executive', name: 'Demo Sales' },
];
