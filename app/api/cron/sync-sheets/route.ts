import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drains sheet_outbox -> Google Sheets (DB → Sheets, near-real-time mirror).
 *  Protected by CRON_SECRET. Batches writes, retries with backoff, dead-letters
 *  after 5 attempts, logs to sheet_sync_log. */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sheets = await import('@/lib/sheets');
  const sb = supabaseAdmin();

  // Source tabs: where each lead lives and which columns hold Assigned Name / Status (same maps as ingest).
  const SRC_TABS: Record<string, { tab: string; assigned: string; status: string }> = {
    INDIAMART: { tab: 'Leads', assigned: 'O', status: 'Q' },
    FB_INSTA: { tab: 'FB & INSTA', assigned: 'J', status: 'K' },
    CORP_FB: { tab: 'Corp FB', assigned: 'J', status: 'K' },
  };
  const istStamp = () => new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const { data: batch } = await sb.from('sheet_outbox')
    .select('*').eq('status', 'pending').order('id').limit(50);

  const results: any[] = [];
  for (const job of batch || []) {
    try {
      const p = job.payload || {};
      if (job.table_name === 'follow_ups') {
        // Append below the last follow-up (A:H = LEAD NO, Follow Date, Follow Time, Remark, Status, Next Date, Next Time, Timestamp)
        await sheets.appendValues('Lead FollowUps', 'A:H', [[p.leadId, p.followDate, p.followTime, p.remark, p.leadStatus, p.nextFollowDate, p.nextFollowTime, istStamp()]]);
      } else if (job.table_name === 'leads') {
        // Update only the Assigned Name / Status cells of that lead's row in its own source tab (never rewrites the row).
        const { data: lead } = await sb.from('leads').select('source_key').eq('lead_id', p.leadId).limit(1).maybeSingle();
        const src = lead && SRC_TABS[lead.source_key];
        if (!src) throw new Error('No source tab for lead ' + p.leadId);
        const rowNo = await sheets.findRowByColA(src.tab, p.leadId);
        if (!rowNo) throw new Error('Lead ' + p.leadId + ' not found in sheet tab ' + src.tab);
        const upd: { range: string; values: any[][] }[] = [];
        if (p.assignedName !== undefined) upd.push({ range: sheets.a1Cell(src.tab, src.assigned, rowNo), values: [[p.assignedName ?? '']] });
        if (p.status !== undefined) upd.push({ range: sheets.a1Cell(src.tab, src.status, rowNo), values: [[p.status ?? '']] });
        await sheets.batchUpdateValues(upd);
      } else {
        // users / quotations / checklist / delegation: not mirrored back to the sheet (sheet is their source).
        await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: job.table_name, ok: true, detail: { skipped: true } });
      }
      await sb.from('sheet_outbox').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', job.id);
      results.push({ id: job.id, ok: true });
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const status = attempts >= 5 ? 'dead' : 'pending';
      await sb.from('sheet_outbox').update({
        attempts, status, last_error: String(e?.message || e).substring(0, 500),
      }).eq('id', job.id);
      await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: job.table_name, ok: false, error: String(e?.message || e).substring(0, 500) });
      results.push({ id: job.id, ok: false, error: String(e?.message || e) });
    }
  }
  await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: 'outbox_drain', ok: true, detail: { count: results.length } });
  return NextResponse.json({ ok: true, processed: results.length, results });
}
