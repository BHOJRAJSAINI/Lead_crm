import { supabaseAdmin } from '../supabase';
import { Session, isAdminSession, visibleOwnerNames } from '../auth';
import { SPECIAL_EMAILS, VALID_STATUSES } from '../config';

/**
 * Server-side scope enforcement (mirrors Code.gs _filterLeadsByUserRole):
 *  - Admin / director@ / purchase@ -> all leads
 *  - corporatesales@ -> only leads assigned to 'indu hada'
 *  - everyone else -> only leads whose lower(assigned_name) is in visibleOwnerNames()
 * Enforced in SQL, never in the client.
 */
export function applyLeadScopeToQuery(q: any, session: Session): any {
  const email = session.email.toLowerCase();
  const role = (session.role || '').toLowerCase();
  if (role === 'admin' || email === SPECIAL_EMAILS.director || email === SPECIAL_EMAILS.purchase) return q;
  if (email === SPECIAL_EMAILS.corporatesales) {
    return q.eq('assigned_name', 'Indu Hada'); // exact, like GAS trim/lower compare on canonical value
  }
  const owners = visibleOwnerNames(session);
  if (!owners.length) return q.eq('id', '00000000-0000-0000-0000-000000000000'); // deny all
  const lowered = owners.map((o) => o.toLowerCase());
  // lower(assigned_name) in owners
  return q.filter('assigned_name', 'ilike', lowered.length === 1 ? exactLike(lowered[0]) : null)
    .or(lowered.map((o) => `assigned_name.ilike.${exactLike(o)}`).join(','));
}

function exactLike(v: string): string {
  return v.replace(/\*/g, '').replace(/,/g, '');
}

export type ScopedLeads = Awaited<ReturnType<typeof fetchScopedLeads>>;

export async function fetchScopedLeads(session: Session): Promise<Map<string, any>> {
  const sb = supabaseAdmin();
  let q = sb.from('lead_current').select('*');
  const email = session.email.toLowerCase();
  const role = (session.role || '').toLowerCase();
  if (!(role === 'admin' || email === SPECIAL_EMAILS.director || email === SPECIAL_EMAILS.purchase)) {
    if (email === SPECIAL_EMAILS.corporatesales) {
      q = q.eq('assigned_name', 'Indu Hada');
    } else {
      const owners = visibleOwnerNames(session).map((o) => o.toLowerCase());
      if (!owners.length) return new Map();
      q = q.or(owners.map((o) => `assigned_name.ilike.${o}`).join(','));
    }
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const map = new Map<string, any>();
  (data || []).forEach((l: any) => {
    map.set(normalizeLeadKey(l.lead_id), l);
    map.set(String(l.lead_id || '').trim(), l);
  });
  return map;
}

export function normalizeLeadKey(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Maps a lead_current row to the exact JSON shape the client reads. */
export function toClientLead(l: any, sourceKey?: string): any {
  return {
    _rowKey: (sourceKey || l.source_key || 'DB') + '-' + l.lead_id,
    leadId: l.lead_id,
    date: l.lead_date || '',
    customerName: l.customer_name || '',
    contact: l.contact || '',
    city: l.city || '',
    clientRequirement: l.client_requirement || '',
    detailRequirements: l.detail_requirements || '',
    leadSource: l.lead_source || '',
    assignedName: l.assigned_name || '',
    lastFollowUpDecision: l.last_follow_up_decision || '',
    nextFollowUpDate: l.next_follow_up_date || '',
    nextFollowUpTime: l.next_follow_up_time || '',
    leadStatus: l.lead_status || 'New',
    followDate: l.follow_date || '',
    followTime: l.follow_time || '',
    _sourceKey: l.source_key || sourceKey || '',
  };
}

export function safeStatus(s: any): string {
  const v = (s || '').toString().trim();
  return VALID_STATUSES.indexOf(v) !== -1 ? v : 'New';
}
