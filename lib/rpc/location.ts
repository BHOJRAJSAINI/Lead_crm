import { NextRequest } from 'next/server';
import { supabaseAdmin } from '../supabase';
import { requireSession, isAdminSession, AUTH_EXPIRED } from '../auth';

const STALE_SECONDS = 5 * 60;              // CONFIG.LOCATION_STALE_SECONDS
const MIN_INTERVAL_MS = 15 * 1000;         // CONFIG.LOCATION_MIN_INTERVAL_MS
const MAX_ACCURACY = 5000;                 // CONFIG.LOCATION_MAX_ACCURACY_METERS

function mapsLink(lat: any, lng: any): string {
  const a = Number(lat), b = Number(lng);
  if (isNaN(a) || isNaN(b)) return '';
  return 'https://www.google.com/maps?q=' + encodeURIComponent(String(a)) + ',' + encodeURIComponent(String(b));
}

export async function handleInitializeLocationTracking(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  return {
    success: true,
    user: { email: s.email, name: s.name, role: s.role },
    isAdmin: isAdminSession(s),
    serverTime: new Date().toISOString(),
    staleSeconds: STALE_SECONDS,
  };
}

export async function handleUpdateMyLocation(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const p = args[0] || {};
  const lat = Number(p.latitude), lng = Number(p.longitude);
  let acc = Number(p.accuracy);
  if (isNaN(lat) || lat < -90 || lat > 90) return { success: false, code: 'VALIDATION_ERROR', message: 'Invalid latitude.' };
  if (isNaN(lng) || lng < -180 || lng > 180) return { success: false, code: 'VALIDATION_ERROR', message: 'Invalid longitude.' };
  if (!isFinite(acc) || acc < 0) acc = 0;

  const sb = supabaseAdmin();
  const now = new Date();
  // throttle: one write per 15s per user (dedupe identical positions)
  const { data: prev } = await sb.from('location_pings')
    .select('latitude, longitude, received_at')
    .eq('user_email', s.email)
    .order('received_at', { ascending: false })
    .limit(1).maybeSingle();
  if (prev) {
    const ageMs = now.getTime() - new Date(prev.received_at).getTime();
    const samePos = Math.abs(Number(prev.latitude) - lat) < 1e-6 && Math.abs(Number(prev.longitude) - lng) < 1e-6;
    if (prev && samePos && ageMs < MIN_INTERVAL_MS) {
      return { success: true, deduped: true, message: 'Duplicate position within throttle window.' };
    }
  }
  let positionTs = p.positionTimestamp ? new Date(p.positionTimestamp) : now;
  if (isNaN(positionTs.getTime()) || positionTs.getTime() > now.getTime() + 5 * 60 * 1000) positionTs = now;

  const { data: inserted, error } = await sb.from('location_pings').insert({
    user_email: s.email, user_name: s.name || '', role: s.role || '',
    latitude: lat, longitude: lng, accuracy: acc,
    position_ts: positionTs.toISOString(), received_at: now.toISOString(),
    sharing_status: 'Active',
    session_ref: String(p.sessionRef || '').substring(0, 80),
    source: String(p.source || 'web_geolocation').substring(0, 40),
    device_info: String(p.deviceInfo || '').substring(0, 200),
  }).select('id').single();
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to save location update.' };
  return {
    success: true, locationId: inserted?.id || '', accuracyFlag: acc > MAX_ACCURACY ? 'poor' : 'ok',
    receivedAt: now.toISOString(), mapsLink: mapsLink(lat, lng),
  };
}

export async function handleGetMyLocationStatus(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  const { data: row } = await sb.from('location_pings')
    .select('*').eq('user_email', s.email)
    .order('received_at', { ascending: false }).limit(1).maybeSingle();
  if (!row) {
    return { success: true, user: { email: s.email, name: s.name, role: s.role }, latest: null, status: 'No data yet' };
  }
  const ageSec = (Date.now() - new Date(row.received_at).getTime()) / 1000;
  return {
    success: true,
    user: { email: s.email, name: s.name, role: s.role },
    latest: {
      latitude: Number(row.latitude), longitude: Number(row.longitude), accuracy: Number(row.accuracy),
      positionTimestamp: row.position_ts, receivedAt: row.received_at,
      sharingStatus: row.sharing_status || 'Active', mapsLink: mapsLink(row.latitude, row.longitude),
    },
    status: ageSec > STALE_SECONDS ? 'Stale' : 'Active',
    ageSeconds: ageSec,
  };
}

export async function handleGetLiveLocations(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  if (!isAdminSession(s)) return { success: false, code: 'ACCESS_DENIED', message: 'Only admins can view all live locations.' };
  const o = args[0] || {};
  const sb = supabaseAdmin();
  const { data, error } = await sb.from('location_pings')
    .select('*').order('received_at', { ascending: false }).limit(500);
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to load live locations.' };
  // dedupe: latest per user
  const byUser = new Map<string, any>();
  (data || []).forEach((r: any) => { if (!byUser.has(r.user_email)) byUser.set(r.user_email, r); });
  let records = Array.from(byUser.values()).map((r: any) => {
    const ageSec = (Date.now() - new Date(r.received_at).getTime()) / 1000;
    return {
      userEmail: r.user_email, userName: r.user_name || '—', role: r.role || '—',
      latitude: Number(r.latitude), longitude: Number(r.longitude), accuracy: Number(r.accuracy),
      positionTimestamp: r.position_ts, receivedAt: r.received_at,
      sharingStatus: r.sharing_status || 'Active', mapsLink: mapsLink(r.latitude, r.longitude),
      status: ageSec > STALE_SECONDS ? 'Stale' : 'Active', ageSeconds: ageSec,
    };
  });
  const q = String(o.search || '').trim().toLowerCase();
  if (q) records = records.filter((r) => (r.userName + ' ' + r.userEmail).toLowerCase().includes(q));
  if (o.role) records = records.filter((r) => r.role === o.role);
  if (o.status) records = records.filter((r) => r.status === o.status);
  const sortKey = o.sortKey || 'receivedAt';
  const sortDir = o.sortDir === 'asc' ? 1 : -1;
  records.sort((a: any, b: any) => {
    const av = a[sortKey] || '', bv = b[sortKey] || '';
    return av < bv ? -1 * sortDir : av > bv ? 1 * sortDir : 0;
  });
  const totals = {
    totalUsers: records.length,
    activeUsers: records.filter((r) => r.status === 'Active').length,
    staleUsers: records.filter((r) => r.status === 'Stale').length,
    noDataUsers: records.filter((r) => r.status === 'No data').length,
  };
  const page = Number(o.page) || 1;
  const pageSize = Number(o.pageSize) || 50;
  return {
    success: true, records: records.slice((page - 1) * pageSize, page * pageSize),
    total: records.length, page, pageSize, totals, staleSeconds: STALE_SECONDS,
  };
}

export async function handleMarkLocationSessionEnded(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  const { data: row } = await sb.from('location_pings')
    .select('id').eq('user_email', s.email).eq('sharing_status', 'Active')
    .order('received_at', { ascending: false }).limit(1).maybeSingle();
  if (row) await sb.from('location_pings').update({ sharing_status: 'Stopped' }).eq('id', row.id);
  return { success: true };
}
