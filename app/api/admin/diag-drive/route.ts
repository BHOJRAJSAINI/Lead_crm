import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Diagnostics: can the service account read each imported quotation's Drive file? (metadata only) */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabaseAdmin } = await import('@/lib/supabase');
  const { getAccessToken } = await import('@/lib/sheets');
  const sb = supabaseAdmin();
  const { data } = await sb.from('quotations').select('lead_id, pdf_url').eq('generated_by', 'sheet-import');
  const token = await getAccessToken();
  let ok = 0; const failed: any[] = [];
  for (const q of data || []) {
    const m = String(q.pdf_url || '').match(/\/d\/([\w-]+)/);
    if (!m) { failed.push({ lead: q.lead_id, why: 'no file id' }); continue; }
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + m[1] + '?fields=id,mimeType&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (r.ok) ok++; else failed.push({ lead: q.lead_id, status: r.status });
  }
  return NextResponse.json({ total: (data || []).length, ok, failedCount: failed.length, failed: failed.slice(0, 5) });
}
