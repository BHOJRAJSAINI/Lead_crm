import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sheets → DB ingest: reads rows newer than sheet_sync_state.last_row per source
 *  tab, normalizes, and upserts into `leads` by (source_key, lead_id). Never
 *  overwrites DB-side edits (assignment/status) — sheet is source of truth only
 *  for NEW rows. Source-tab column maps lifted from Code.gs LEAD_SOURCES. */
const SOURCES = [
  { key: 'INDIAMART', sheetName: 'Leads', endCol: 'Q',
    map: { leadId: 0, date: 1, customerName: 2, contact: 4, city: 10, clientRequirement: 7, detailRequirements: 8, assignedName: 14, status: 16 },
    forceSource: 'INDIAMART', fallbackSource: 'INDIAMART' },
  { key: 'FB_INSTA', sheetName: 'FB & INSTA', endCol: 'K',
    map: { leadId: 0, date: 1, customerName: 2, contact: 3, city: 4, clientRequirement: 5, detailRequirements: 6, leadSource: 8, assignedName: 9, status: 10 },
    forceSource: null, fallbackSource: 'Facebook' },
  { key: 'CORP_FB', sheetName: 'Corp FB', endCol: 'K',
    map: { leadId: 0, date: 1, customerName: 2, contact: 5, city: 4, clientRequirement: 6, detailRequirements: 7, leadSource: 8, assignedName: 9, status: 10 },
    forceSource: null, fallbackSource: 'Corp FB' },
];

function colIdx(letter: string): number {
  let col = 0;
  const up = letter.toUpperCase();
  for (let i = 0; i < up.length; i++) col = col * 26 + (up.charCodeAt(i) - 64);
  return col - 1;
}

function fmtDate(val: any): string {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number' && val > 20000 && val < 60000) { // Sheets serial date
    return new Date(Date.UTC(1899, 11, 30) as any).toISOString().slice(0, 0) || ''; // handled below
  }
  const s = String(val).trim();
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}


// ---------- Lead FollowUps (Sheet -> DB) ----------
const FU_SHEET = 'Lead FollowUps';
const FU_MAX_PER_RUN = 1500;   // catch-up in chunks so a run never times out
const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

function serialToUtc(n: number): Date { return new Date(Math.round((n - 25569) * 86400 * 1000)); }

function normDate(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return serialToUtc(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/); // dd/mm/yyyy (India)
  if (m) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
  return s;
}

function normTime(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    const total = Math.round((v - Math.floor(v)) * 1440);
    return pad2(Math.floor(total / 60) % 24) + ':' + pad2(total % 60);
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return s;
  let h = +m[1];
  if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return pad2(h) + ':' + m[2];
}

function normTimestamp(v: any): string | null {
  if (typeof v === 'number') return new Date(serialToUtc(v).getTime() - 330 * 60000).toISOString(); // sheet time is IST
  if (typeof v === 'string' && v.trim()) { const d = new Date(v.trim()); return isNaN(d.getTime()) ? null : d.toISOString(); }
  return null;
}

async function ingestFollowUps(sb: any, sheets: any) {
  const stateKey = 'ingest:' + FU_SHEET + ':last_row';
  const { data: state } = await sb.from('sheet_sync_state').select('*').eq('key', stateKey).maybeSingle();
  const lastRow = state ? Number(state.last_row) : 1;
  const rows: any[][] = await sheets.readRange(FU_SHEET, 'A' + (lastRow + 1) + ':H' + (lastRow + FU_MAX_PER_RUN), true);
  const batch: any[] = [];
  let skipped = 0;
  for (const r of rows) {
    const leadId = String((r && r[0]) ?? '').trim();
    if (!leadId) { skipped++; continue; }
    const rec: any = {
      lead_id: leadId,
      follow_date: normDate(r[1]),
      follow_time: normTime(r[2]),
      remark: String(r[3] ?? '').trim(),
      lead_status: String(r[4] ?? '').trim() || 'New',
      next_follow_date: normDate(r[5]),
      next_follow_time: normTime(r[6]),
      created_by: 'sheet-import',
    };
    const ts = normTimestamp(r[7]);
    if (ts) rec.created_at = ts;
    batch.push(rec);
  }
  for (let i = 0; i < batch.length; i += 300) {
    const { error } = await sb.from('follow_ups').insert(batch.slice(i, i + 300));
    if (error) throw new Error('follow_ups insert failed: ' + error.message); // cursor not advanced -> retried next run
  }
  const newLast = lastRow + rows.length;
  const { error: stErr } = await sb.from('sheet_sync_state').upsert({ key: stateKey, last_row: newLast, last_run: new Date().toISOString() }, { onConflict: 'key' });
  if (stErr) throw new Error('cursor update failed: ' + stErr.message);
  await sb.from('sheet_sync_log').insert({ direction: 'sheet->db', table_name: FU_SHEET, ok: true, detail: { inserted: batch.length, skipped, newLast } });
  return { source: FU_SHEET, inserted: batch.length, skipped, hasMore: rows.length >= FU_MAX_PER_RUN };
}

export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabaseAdmin } = await import('@/lib/supabase');
  const sheets = await import('@/lib/sheets');
  const sb = supabaseAdmin();
  const summary: any = { sources: [] };

  for (const src of SOURCES) {
    try {
      const stateKey = 'ingest:' + src.sheetName + ':last_row';
      const { data: state } = await sb.from('sheet_sync_state').select('*').eq('key', stateKey).maybeSingle();
      const lastRow = state ? Number(state.last_row) : 1;

      const colEnd = colIdx(src.endCol) + 1;
      const a1 = 'A' + (lastRow + 1) + ':' + sheets.colLetter(colEnd) + '200000';
      const rows = await sheets.readRange(src.sheetName, a1);
      let inserted = 0, skipped = 0, newLast = lastRow;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        newLast = lastRow + i; // will advance even for blank rows
        if (!row || row.every((c) => c === '' || c === null || c === undefined)) { skipped++; continue; }
        const m = src.map;
        const leadId = String(row[m.leadId] ?? '').trim();
        if (!leadId) { skipped++; continue; }
        const dateRaw = row[m.date];
        const leadDate = typeof dateRaw === 'number'
          ? new Date(Math.round((dateRaw - 25569) * 86400 * 1000)).toISOString().slice(0, 10)
          : fmtDate(dateRaw);

        // upsert by (source_key, lead_id) — new rows only; DB edits win
        const { data: existing } = await sb.from('leads').select('id')
          .eq('lead_id', leadId).eq('source_key', src.key).maybeSingle();
        if (existing) { skipped++; continue; }
        const status = String(row[m.status] ?? '').trim() || 'New';
        let leadSource = src.forceSource || String(row[m.leadSource] ?? '').trim() || src.fallbackSource;
        const { error } = await sb.from('leads').insert({
          row_key: src.key + '-' + leadId,
          lead_id: leadId, source_key: src.key,
          lead_date: leadDate || null,
          customer_name: String(row[m.customerName] ?? '').trim(),
          contact: String(row[m.contact] ?? '').trim(),
          city: String(row[m.city] ?? '').trim(),
          client_requirement: String(row[m.clientRequirement] ?? '').trim(),
          detail_requirements: String(row[m.detailRequirements] ?? '').trim(),
          lead_source: leadSource,
          assigned_name: String(row[m.assignedName] ?? '').trim(),
          base_status: status,
        });
        if (error) { skipped++; continue; }
        inserted++;
      }
      await sb.from('sheet_sync_state').upsert({ key: stateKey, last_row: newLast, last_run: new Date().toISOString() }, { onConflict: 'key' });
      await sb.from('sheet_sync_log').insert({ direction: 'sheet->db', table_name: src.sheetName, ok: true, detail: { inserted, skipped, newLast } });
      summary.sources.push({ source: src.sheetName, inserted, skipped });
    } catch (e: any) {
      await sb.from('sheet_sync_log').insert({ direction: 'sheet->db', table_name: src.sheetName, ok: false, error: String(e?.message || e).substring(0, 500) });
      summary.sources.push({ source: src.sheetName, error: String(e?.message || e) });
    }
  }
  try {
    summary.sources.push(await ingestFollowUps(sb, sheets));
  } catch (e: any) {
    await sb.from('sheet_sync_log').insert({ direction: 'sheet->db', table_name: FU_SHEET, ok: false, error: String(e?.message || e).substring(0, 500) });
    summary.sources.push({ source: FU_SHEET, error: String(e?.message || e) });
  }
  return NextResponse.json({ ok: true, ...summary });
}
