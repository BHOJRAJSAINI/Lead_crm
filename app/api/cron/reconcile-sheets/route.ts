import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Nightly full reconciliation: compares DB row counts vs Sheets and logs drift
 *  into sheet_sync_log (repair jobs can be added per-table later). */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sheets = await import('@/lib/sheets');
  const sb = supabaseAdmin();
  const report: any[] = [];
  for (const [sheetName, table] of [['Leads', 'leads'], ['Lead FollowUps', 'follow_ups']] as const) {
    try {
      const { count: dbCount } = await sb.from(table).select('id', { count: 'exact', head: true });
      const rows = await sheets.readRange(sheetName, 'A2:A200000');
      const sheetCount = rows.filter((r) => r[0] !== '' && r[0] !== null && r[0] !== undefined).length;
      const drift = Math.abs((dbCount || 0) - sheetCount);
      await sb.from('sheet_sync_log').insert({
        direction: 'db->sheet', table_name: sheetName, ok: drift === 0,
        detail: { dbCount, sheetCount, drift }, error: drift === 0 ? null : 'DRIFT detected',
      });
      report.push({ sheetName, dbCount, sheetCount, drift });
    } catch (e: any) {
      report.push({ sheetName, error: String(e?.message || e) });
    }
  }
  return NextResponse.json({ ok: true, report });
}
