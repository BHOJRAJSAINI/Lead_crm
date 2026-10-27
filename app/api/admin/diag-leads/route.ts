import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Diagnostics: runs the same lead_current page query as the Lead page and reports count/error. */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sb = supabaseAdmin();
  const q = sb.from('lead_current').select('*', { count: 'exact' })
    .order('lead_date', { ascending: false, nullsFirst: false }).order('lead_id', { ascending: true }).range(0, 24);
  const { data, count, error } = await q;
  return NextResponse.json({ count, rows: data?.length, error: error ? { message: error.message, code: error.code, details: error.details, hint: error.hint } : null, first: data?.[0] });
}
