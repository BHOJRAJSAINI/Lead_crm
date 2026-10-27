import { ENV } from '../env';
import { LOGO_DATA_URL } from '../logo-data';

/** Returns the app logo as a data URL (client expects `data:...;base64,...` or '').
 *  Source: LOGO_URL env (public URL of the Panache logo). Drive file IDs cannot be
 *  read server-side without OAuth — upload the logo to Supabase Storage / any CDN
 *  and set LOGO_URL. Falls back to '' exactly like Code.gs catch-block. */
export async function getLogoDataUrl(): Promise<string> {
  const url = process.env.LOGO_URL || '';
  if (!url) return LOGO_DATA_URL;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (_) {
    return '';
  }
}
