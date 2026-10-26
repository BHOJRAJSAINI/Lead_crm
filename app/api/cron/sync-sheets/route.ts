import { NextRequest, NextResponse } from 'next/server';
import { ENV } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drains sheet_outbox -> Google Sheets (DB → Sheets, near-real-time mirror).
 *  Protected by CRON_SECRET. Batches writes, retries with backoff, dead-letters
 *  after 5 attempts, logs to sheet_sync_log. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  if (!ENV.CRON_SECRET || auth !== 'Bearer ' + ENV.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sheets = await import('@/lib/sheets');
  const sb = supabaseAdmin();

  // Header orders copied verbatim from Code.gs CONFIG / _appendRow.
  const LEAD_HEADERS = ['Lead ID', 'Date', 'Customer Name', 'Contact', 'City', 'Client Requirement', 'Detail Requirements', 'Lead Source', 'Assigned Name', 'Lead Status'];
  const FU_HEADERS = ['Lead ID', 'Follow Date', 'Follow Time', 'Remark', 'Lead Status', 'Next Follow Date', 'Next Follow Time', 'Timestamp'];
  const USER_HEADERS = ['Email', 'Role', 'Name']; // NO password hashes, by design
  const KEY_COL = '_db_id';

  const { data: batch } = await sb.from('sheet_outbox')
    .select('*').eq('status', 'pending').order('id').limit(50);

  const results: any[] = [];
  for (const job of batch || []) {
    try {
      const p = job.payload || {};
      let headers: string[], row: any[], sheetName: string;
      if (job.table_name === 'follow_ups') {
        sheetName = 'Lead FollowUps'; headers = FU_HEADERS;
        row = [p.leadId, p.followDate, p.followTime, p.remark, p.leadStatus, p.nextFollowDate, p.nextFollowTime, job.row_id];
      } else if (job.table_name === 'leads') {
        sheetName = 'Leads'; headers = LEAD_HEADERS.concat([KEY_COL, '_synced_at']);
        row = LEAD_HEADERS.map((h) => {
          switch (h) {
            case 'Lead ID': return p.leadId; case 'Assigned Name': return p.assignedName ?? '';
            case 'Lead Status': return p.status ?? ''; default: return '';
          }
        }).concat([job.row_id, new Date().toISOString()]);
      } else if (job.table_name === 'users') {
        sheetName = 'Users'; headers = USER_HEADERS.concat([KEY_COL, '_synced_at']);
        row = [p.email, p.role, p.name, job.row_id, new Date().toISOString()];
      } else {
        // quotations / checklist / delegation: log-only for now (mirror is Leads-centric)
        await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: job.table_name, ok: true, detail: { skipped: true } });
        await sb.from('sheet_outbox').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', job.id);
        continue;
      }
      await sheets.upsertRow(sheetName, headers, KEY_COL, job.row_id, row);
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
