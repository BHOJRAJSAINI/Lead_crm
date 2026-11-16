import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Drains sheet_outbox -> Google Sheets (DB → Sheets, near-real-time mirror).
 *  Protected by CRON_SECRET. Batches writes, retries with backoff, dead-letters
 *  after 5 attempts, logs to sheet_sync_log. */
export async function GET(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { drainOutbox } = await import('@/lib/outbox-drain');
  const results = await drainOutbox(50);
  return NextResponse.json({ ok: true, processed: results.length, results });
}
