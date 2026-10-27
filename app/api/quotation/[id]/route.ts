import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { ENV } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stable quotation link: checks the session cookie, then redirects to a fresh short-lived signed PDF URL. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const s = await requireSession(req);
  if (!s) return new NextResponse('Session expired. Please log in again.', { status: 401 });
  const sb = supabaseAdmin();
  const { data: q } = await sb.from('quotations').select('storage_path, pdf_url, lead_id').eq('id', params.id).maybeSingle();
  if (!q) return new NextResponse('Quotation not found.', { status: 404 });
  if (!q.storage_path) {
    // imported (legacy) quotation: link straight to its stored PDF URL
    return q.pdf_url && /^https?:\/\//i.test(q.pdf_url) ? NextResponse.redirect(q.pdf_url, 302) : new NextResponse('Quotation file not available.', { status: 404 });
  }
  const { data: signed, error } = await sb.storage.from(ENV.QUOTATIONS_BUCKET).createSignedUrl(q.storage_path, 300);
  if (error || !signed?.signedUrl) return new NextResponse('Could not open quotation.', { status: 500 });
  return NextResponse.redirect(signed.signedUrl, 302);
}
