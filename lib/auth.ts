import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'crypto';
import { supabaseAdmin } from './supabase';
import { hashToken, ENV } from './env';
import { SPECIAL_EMAILS, SHARED_OWNER_GROUP, audit } from './config';

export const COOKIE_NAME = 'crm_session';
const IDLE_TIMEOUT_S = 6 * 60 * 60;        // matches CONFIG.SESSION_IDLE_TIMEOUT_SECONDS
const MAX_DURATION_S = 24 * 60 * 60;       // matches CONFIG.MAX_SESSION_DURATION_SECONDS
const RENEW_BEFORE_S = 60 * 60;            // matches CONFIG.RENEW_BEFORE_SECONDS

export type Session = {
  userId: string;
  email: string;
  role: string;
  name: string;
};

export const AUTH_EXPIRED = { success: false, code: 'SESSION_EXPIRED', message: 'Session expired. Please log in again.' } as const;

export function getSessionToken(req: NextRequest): string | null {
  return req.cookies.get(COOKIE_NAME)?.value || null;
}

/** Resolves the session from the HttpOnly cookie (token args from the client are ignored). */
export async function requireSession(req: NextRequest): Promise<Session | null> {
  const token = getSessionToken(req);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('sessions')
    .select('id, expires_at, absolute_expires_at, active, user_id, profiles:profiles(id, email, name, role)')
    .eq('token_hash', tokenHash)
    .eq('active', true)
    .maybeSingle();
  if (error || !data || !data.profiles) return null;
  const now = Date.now();
  if (new Date(data.expires_at).getTime() <= now) return null;
  if (new Date(data.absolute_expires_at).getTime() <= now) {
    await sb.from('sessions').update({ active: false }).eq('id', data.id);
    return null;
  }
  const profile = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;

  // Sliding renewal — same rule as Code.gs _updateSessionActivity.
  const remainingMs = new Date(data.expires_at).getTime() - now;
  if (remainingMs < RENEW_BEFORE_S * 1000) {
    await sb.from('sessions').update({
      expires_at: new Date(Math.min(now + IDLE_TIMEOUT_S * 1000, new Date(data.absolute_expires_at).getTime())),
      last_seen: new Date(),
    }).eq('id', data.id);
  } else {
    await sb.from('sessions').update({ last_seen: new Date() }).eq('id', data.id);
  }

  return { userId: profile.id, email: (profile.email || '').toLowerCase(), role: profile.role || '', name: profile.name || '' };
}

/** In-memory login rate limit (5 attempts / 15 min per IP+email) + per-user lockout in profiles. */
const loginAttempts = new Map<string, { count: number; firstAt: number }>();
function rateLimitLogin(key: string): boolean {
  const now = Date.now();
  const e = loginAttempts.get(key);
  if (!e || now - e.firstAt > 15 * 60 * 1000) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return true;
  }
  e.count++;
  return e.count <= 5;
}

export async function loginUser(email: string, password: string, ip: string) {
  email = (email || '').toString().trim().toLowerCase();
  password = (password || '').toString();
  if (!email || !password) {
    return { success: false, code: 'INVALID_CREDENTIALS', message: 'Email and password are required.' };
  }
  if (!rateLimitLogin(ip + ':' + email)) {
    return { success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' };
  }
  const sb = supabaseAdmin();
  const { data: user } = await sb.from('profiles')
    .select('id, email, name, role, password_hash, must_reset_password, failed_attempts, locked_until')
    .eq('email', email)
    .maybeSingle();

  // First-run convenience: if no users exist yet, seed demo users (must_reset_password = true).
  if (!user) {
    const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true });
    if (!count) await seedDemoUsers();
  }

  if (!user || !user.password_hash) {
    return { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' };
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { success: false, code: 'RATE_LIMITED', message: 'Account temporarily locked. Try again later.' };
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const attempts = (user.failed_attempts || 0) + 1;
    await sb.from('profiles').update({
      failed_attempts: attempts,
      locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
    }).eq('id', user.id);
    return { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' };
  }
  await sb.from('profiles').update({ failed_attempts: 0, locked_until: null }).eq('id', user.id);

  const rawToken = randomUUID() + '_' + Date.now().toString(36) + '_' + randomBytes(6).toString('hex');
  await sb.from('sessions').insert({
    token_hash: hashToken(rawToken),
    user_id: user.id,
    expires_at: new Date(Date.now() + IDLE_TIMEOUT_S * 1000),
    absolute_expires_at: new Date(Date.now() + MAX_DURATION_S * 1000),
    ip,
  });
  await audit({ actorEmail: email, action: 'login' });
  // The token handed to the client is a decoy (client stores it in localStorage for
  // compatibility); the real credential lives ONLY in the HttpOnly cookie.
  return {
    success: true as const,
    sessionToken: rawToken, // consumed server-side only (set as HttpOnly cookie, stripped before responding)
    token: 'cookie-backed-' + randomBytes(8).toString('hex'),
    role: user.role,
    name: user.name,
    email: user.email,
    mustResetPassword: !!user.must_reset_password,
  };
}

export async function logout(req: NextRequest) {
  const token = getSessionToken(req);
  if (token) {
    await supabaseAdmin().from('sessions').update({ active: false }).eq('token_hash', hashToken(token));
  }
  return { success: true };
}

async function seedDemoUsers() {
  const sb = supabaseAdmin();
  for (const u of (await import('./env')).DEV_SEED_USERS) {
    await sb.from('profiles').upsert({
      email: u.email,
      name: u.name,
      role: u.role,
      password_hash: await bcrypt.hash(u.password, 10),
      must_reset_password: true,
    }, { onConflict: 'email' });
  }
}

export function isAdminSession(s: Session | null): boolean {
  if (!s) return false;
  const role = (s.role || '').toLowerCase();
  const email = (s.email || '').toLowerCase();
  return role === 'admin' || email === SPECIAL_EMAILS.director || email === SPECIAL_EMAILS.purchase;
}

export function isManagementSession(s: Session | null): boolean {
  if (!s) return false;
  if (isAdminSession(s)) return true;
  const email = (s.email || '').toLowerCase();
  const role = (s.role || '').toLowerCase();
  return email === SPECIAL_EMAILS.corporatesales || role === 'manager';
}

/** Owner names the session can see — mirrors _visibleOwnerNamesForSession_. */
export function visibleOwnerNames(s: Session): string[] {
  const email = (s.email || '').toLowerCase().trim();
  if (SHARED_OWNER_GROUP[email]) return [SHARED_OWNER_GROUP[email]];
  const ownName = (s.name || '').toLowerCase().trim();
  return ownName ? [ownName] : [];
}

export function sessionCookie(token: string) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_DURATION_S,
  };
}

export function clearedCookie() {
  return { ...sessionCookie(''), maxAge: 0 };
}
