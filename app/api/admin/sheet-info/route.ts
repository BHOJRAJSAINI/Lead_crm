import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Diagnostics for sheet mapping: tab names + header row of every tab. Sample rows only for
 *  checklist/delegation-like tabs. Never returns data from the Users tab beyond its header. */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sheets = await import('@/lib/sheets');
  const ss = req.nextUrl.searchParams.get('ss') || undefined;
  const tabs = await sheets.listTabs(ss);
  const out: any[] = [];
  for (const t of tabs) {
    try {
      const wantSample = !!ss || /check|deleg/i.test(t);
      const rows = await sheets.readRange(t, 'A1:Z' + (wantSample ? 4 : 1), true, ss);
      const rowCount = (await sheets.readRange(t, 'A1:A200000', false, ss)).length;
      out.push({ tab: t, rows: rowCount, header: rows[0] || [], sample: wantSample ? rows.slice(1) : undefined });
    } catch (e: any) {
      out.push({ tab: t, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return NextResponse.json({ ok: true, tabs: out });
}
