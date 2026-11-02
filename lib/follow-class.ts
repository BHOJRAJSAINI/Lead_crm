/** Single source of truth for how a lead counts in follow-up buckets.
 *  - Status still "New"                      -> 'none'     (No Follow-up)
 *  - Status changed + next date scheduled    -> 'overdue' | 'today' | 'upcoming'
 *  - Status changed, no next date, last follow-up >= STALE_DAYS ago -> 'overdue' (pending again)
 *  - Status changed, no next date, followed recently / no date      -> 'followed' */
export type FollowClass = 'none' | 'overdue' | 'today' | 'upcoming' | 'followed';
export const STALE_DAYS = 10;
const NEW_STATUSES = new Set(['', 'new', 'new lead', 'old lead', 'old new lead', 'null', 'undefined']);

function dayNum(k: string): number | null {
  const m = String(k || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
}

export function classifyFollow(status: any, nextDate: any, lastFollowDate: any, today: string): FollowClass {
  const st = String(status ?? '').trim().toLowerCase();
  if (NEW_STATUSES.has(st)) return 'none';
  const nd = String(nextDate || '').trim();
  if (nd) return nd < today ? 'overdue' : (nd === today ? 'today' : 'upcoming');
  const last = dayNum(String(lastFollowDate || ''));
  const t = dayNum(today);
  if (last !== null && t !== null && t - last >= STALE_DAYS) return 'overdue';
  return 'followed';
}
