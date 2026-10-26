import { NextRequest } from 'next/server';
import { ENV } from './env';
import { requireSession, isAdminSession } from './auth';

/** Cron endpoints accept either the Vercel Cron bearer secret, or a logged-in Admin session
 *  (so an admin can open the URL in the browser to force a sync on plans without frequent crons). */
export async function isCronAuthorized(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (ENV.CRON_SECRET && auth === 'Bearer ' + ENV.CRON_SECRET) return true;
  try {
    return isAdminSession(await requireSession(req));
  } catch (_) {
    return false;
  }
}
