import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../supabase';
import {
  Session, loginUser, logout, requireSession, isAdminSession, AUTH_EXPIRED,
} from '../auth';
import { audit } from '../config';
import { enqueueSheetSync } from '../outbox';

export async function handleLoginUser(req: NextRequest, args: any[]) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const res = await loginUser(args[0], args[1], ip);
  // Set the HttpOnly cookie; client still receives the same {success, token, role, name, email} shape.
  const out: any = { ...res };
  if (res.success) {
    out.setCookie = { name: 'crm_session', value: (res as any).sessionToken };
    delete out.sessionToken;
  }
  return out;
}

export async function handleLogoutUser(req: NextRequest, args: any[]) {
  return logout(req);
}

export async function handleValidateSession(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return { valid: false, code: 'SESSION_EXPIRED', message: 'Session expired. Please log in again.' };
  return { valid: true, role: s.role, name: s.name, email: s.email };
}

export async function handleGetUsers(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const { data, error } = await supabaseAdmin().from('profiles').select('email, role, name');
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to retrieve users.' };
  return { success: true, users: (data || []).map((u: any) => ({ email: u.email, password: '••••••••', role: u.role, name: u.name })) };
}

export async function handleCreateUser(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const emailLower = s.email.toLowerCase();
  if ((s.role || '').toLowerCase() !== 'admin' &&
      emailLower !== 'director@panacheevents.in' && emailLower !== 'purchase@panacheevents.in') {
    return { success: false, code: 'ACCESS_DENIED', message: 'Only Admin users can create new users.' };
  }
  const nu = args[0] || {};
  const email = (nu.email || '').toString().trim().toLowerCase();
  const password = (nu.password || '').toString();
  const role = (nu.role || '').toString().trim();
  const name = (nu.name || '').toString().trim();
  if (!email || !password || !role || !name) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'All fields (name, email, password, role) are required.' };
  }
  if (password.length < 8) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters long.' };
  }
  const sb = supabaseAdmin();
  const { data: existing } = await sb.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing) return { success: false, code: 'DUPLICATE_USER', message: 'A user with this email already exists.' };
  const { error } = await sb.from('profiles').insert({
    email, name, role,
    password_hash: await bcrypt.hash(password, 10),
    must_reset_password: false,
  });
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to create user.' };
  await audit({ actorEmail: s.email, action: 'user_create', entity: 'profiles', entityId: email });
  await enqueueSheetSync('users', email, { email, role, name });
  return { success: true };
}

export async function handleVerifyOldPasswordAndReset(req: NextRequest, args: any[]) {
  const [email, oldPassword, newPassword] = args;
  const em = (email || '').toString().trim().toLowerCase();
  if (!em || !oldPassword || !newPassword) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'Email, old password, and new password are required.' };
  }
  if (newPassword.length < 8) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'New password must be at least 8 characters long.' };
  }
  if (oldPassword === newPassword) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'New password must be different from current password.' };
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const sb = supabaseAdmin();
  const { data: user } = await sb.from('profiles')
    .select('id, email, name, password_hash').eq('email', em).maybeSingle();
  if (!user || !user.password_hash) return { success: false, code: 'NOT_FOUND', message: 'Email not found in our system.' };
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) return { success: false, code: 'INVALID_OLD_PASSWORD', message: 'Current password is incorrect.' };
  await sb.from('profiles').update({
    password_hash: await bcrypt.hash(newPassword, 10),
    must_reset_password: false,
  }).eq('id', user.id);
  await audit({ actorEmail: em, action: 'password_reset', ip });
  return { success: true, message: 'Password changed successfully. Please login with your new password.', name: user.name };
}
