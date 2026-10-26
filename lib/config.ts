import { supabaseAdmin } from './supabase';
import { ENV } from './env';

/** Statuses / scope constants lifted verbatim from Code.gs. */
export const VALID_STATUSES = [
  'New', 'Not Responding', 'Not Converted', 'Share Quotation', 'Fulfilled',
  'Buyer', 'No requirement', 'WhatsApps', 'Vendor',
  'Low budget', 'Hot Lead', 'Potential Lead', 'Converted',
];

export const PENDING_STATUSES = ['New', 'Not Responding', 'WhatsApps', 'Share Quotation', 'Hot Lead', 'Potential Lead'];
export const ACTION_REQUIRED_STATUSES = ['Not Responding', 'WhatsApps', 'Share Quotation', 'Hot Lead'];
export const WASTE_STATUSES = ['Low budget', 'No requirement'];
export const HOT_STATUSES = ['Hot Lead'];
export const POTENTIAL_STATUSES = ['Potential Lead'];

export const REPORT_PENDING = PENDING_STATUSES;
export const REPORT_ACTION = ACTION_REQUIRED_STATUSES;
export const REPORT_CONVERTED = ['Converted'];
export const REPORT_FULFILLED = ['Fulfilled'];
export const REPORT_FAILED = ['Not Converted', 'No requirement', 'Low budget'];

/** Hard-coded special emails from Code.gs (kept in code; role stays source of truth). */
export const SPECIAL_EMAILS = {
  director: 'director@panacheevents.in',
  purchase: 'purchase@panacheevents.in',
  corporatesales: 'corporatesales@panacheevents.in',
};

export const SHARED_OWNER_GROUP: Record<string, string> = {
  'events@panacheevents.in': 'shilpi',
  'operations@panacheevents.in': 'shilpi',
};

/** Config rows in app_config override these defaults (env/config-table driven). */
const DEFAULTS: Record<string, any> = {
  quotation_allowed_assignee: 'indu hada',
  share_quotation_allowed_assignee: 'indu hada',
};

export async function getConfig(key: string): Promise<any> {
  try {
    const { data } = await supabaseAdmin().from('app_config').select('value').eq('key', key).single();
    if (data && data.value !== null && data.value !== undefined) return data.value;
  } catch (_) { /* fall through to default */ }
  return DEFAULTS[key];
}

export async function audit(entry: {
  actorEmail?: string | null; action: string; entity?: string;
  entityId?: string; detail?: any; ip?: string;
}) {
  try {
    await supabaseAdmin().from('audit_log').insert({
      actor_email: entry.actorEmail || null,
      action: entry.action,
      entity: entry.entity || null,
      entity_id: entry.entityId || null,
      detail: entry.detail || null,
      ip: entry.ip || null,
    });
  } catch (_) { /* audit must never break the request */ }
}
