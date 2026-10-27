import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEMP_PASSWORD = 'Panache@2026';

/** One-time import of users (email, role, name) from the "Users" tab. Sheet passwords are NEVER read.
 *  New users get a shared temporary password + must_reset_password. Existing users keep their password. */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sheets = await import('@/lib/sheets');
  const sb = supabaseAdmin();
  const dry = req.nextUrl.searchParams.get('run') !== '1';
  const rows = await sheets.readRange('Users', 'A2:D200');
  const hash = await bcrypt.hash(TEMP_PASSWORD, 10);
  const report: any[] = [];
  for (const r of rows) {
    const email = String(r[0] ?? '').trim().toLowerCase();
    const role = String(r[2] ?? '').trim();
    const name = String(r[3] ?? '').trim();
    if (!email.includes('@')) continue;
    const { data: ex } = await sb.from('profiles').select('id').eq('email', email).maybeSingle();
    if (!dry) {
      const { error } = ex
        ? await sb.from('profiles').update({ name, role: role || 'Sales Executive' }).eq('id', ex.id)
        : await sb.from('profiles').insert({ email, name, role: role || 'Sales Executive', password_hash: hash, must_reset_password: true });
      report.push({ email, name, role, action: ex ? 'updated' : 'created', error: error?.message });
    } else report.push({ email, name, role, action: ex ? 'would update' : 'would create' });
  }
  return NextResponse.json({ ok: true, dry, users: report });
}
