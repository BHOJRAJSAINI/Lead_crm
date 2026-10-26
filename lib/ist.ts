/** IST helpers — all "today/yesterday/week" boundaries use Asia/Kolkata. */
const IST_TZ = 'Asia/Kolkata';

function ymdInIST(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // yyyy-MM-dd
}

export function todayKey(): string { return ymdInIST(new Date()); }

export function shiftDateKey(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return ymdInIST(d);
}

export function yesterdayKey(): string { return shiftDateKey(1); }

/** Monday-start week window: [weekStart, today] — 7 calendar days back like GAS (today-6 … today). */
export function weekStartKey(): string { return shiftDateKey(6); }

export function monthStartKey(): string { return todayKey().substring(0, 8) + '01'; }

export function lastMonthRange(): { from: string; to: string } {
  const now = new Date();
  const firstThisMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lastPrevMs = firstThisMs - 86400000; // last day of previous month
  return {
    from: ymdInIST(new Date(lastPrevMs)).substring(0, 8) + '01',
    to: ymdInIST(new Date(lastPrevMs)),
  };
}

export type Range = { from: string | null; to: string | null; preset: string };

/** Mirrors Code.gs `_resolveDateRange_`. */
export function resolveDateRange(filters: any): Range {
  const preset = String((filters && filters.preset) || 'thisMonth');
  const today = todayKey();
  switch (preset) {
    case 'today': return { from: today, to: today, preset };
    case 'yesterday': { const y = yesterdayKey(); return { from: y, to: y, preset }; }
    case 'thisWeek': return { from: weekStartKey(), to: today, preset };
    case 'thisMonth': return { from: monthStartKey(), to: today, preset };
    case 'lastMonth': { const r = lastMonthRange(); return { from: r.from, to: r.to, preset }; }
    case 'custom': return { from: filters.fromDate || null, to: filters.toDate || null, preset };
    case 'all':
    default: return { from: null, to: null, preset };
  }
}
