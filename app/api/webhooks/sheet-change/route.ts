import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { ENV } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Optional Apps Script onChange webhook for instant ingest.
 *  HMAC-SHA256 (hex of raw body) via SHEET_WEBHOOK_SECRET in `x-signature` header. */
export async function POST(req: NextRequest) {
  if (!ENV.SHEET_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 501 });
  }
  const raw = await req.text();
  const sig = req.headers.get('x-signature') || '';
  const expected = createHmac('sha256', ENV.SHEET_WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  // Signature valid → trigger the ingest immediately (same logic as the cron).
  const { GET } = await import('../../cron/ingest-sheets/route');
  return GET(req);
}
