import { NextRequest } from 'next/server';
import { supabaseAdmin, fetchAll } from '../supabase';
import { requireSession, Session, AUTH_EXPIRED, visibleOwnerNames } from '../auth';
import { SPECIAL_EMAILS, VALID_STATUSES, audit } from '../config';
import { todayKey } from '../ist';
import { toClientLead, normalizeLeadKey, safeStatus } from './leads';
import { enqueueSheetSync } from '../outbox';

function scopeOr(s: Session): string | null {
  const email = s.email.toLowerCase();
  const role = (s.role || '').toLowerCase();
  if (role === 'admin' || email === SPECIAL_EMAILS.director || email === SPECIAL_EMAILS.purchase) return null;
  if (email === SPECIAL_EMAILS.corporatesales) return 'assigned_name.eq.Indu Hada';
  const owners = visibleOwnerNames(s).map((o) => o.toLowerCase());
  if (!owners.length) return 'assigned_name.eq.__NONE__';
  return owners.map((o) => `assigned_name.ilike.${o}`).join(',');
}

export async function handleGetLeadsWithFollowUpData(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const o = args[0] || {};
  const sb = supabaseAdmin();
  const PAGE_MAX = 200;
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(PAGE_MAX, Math.max(1, Number(o.pageSize) || 25));

  let q = sb.from('lead_current').select('*', { count: 'exact' });
  const scoped = scopeOr(s);
  if (scoped) q = q.or(scoped);
  if (o.fromDate) q = q.gte('lead_date', o.fromDate);
  if (o.toDate) q = q.lte('lead_date', o.toDate);
  const search = String(o.search || '').trim().toLowerCase();
  if (search) q = q.or(`lead_id.ilike.%${search}%,customer_name.ilike.%${search}%,contact.ilike.%${search}%`);
  if (o.city) q = q.eq('city', o.city);
  if (o.leadSource) q = q.eq('lead_source', o.leadSource);
  if (o.assignedName) q = q.eq('assigned_name', o.assignedName);
  if (o.leadStatus) q = q.eq('lead_status', o.leadStatus);

  const sortKeyMap: Record<string, string> = {
    date: 'lead_date', customerName: 'customer_name', leadId: 'lead_id',
    leadStatus: 'lead_status', assignedName: 'assigned_name', city: 'city', leadSource: 'lead_source',
  };
  const dbSort = sortKeyMap[o.sortKey || 'date'] || 'lead_date';
  q = q.order(dbSort, { ascending: o.sortDir === 'asc', nullsFirst: false }).order('lead_id', { ascending: true });
  q = q.range((page - 1) * pageSize, page * pageSize - 1);

  const { data, count, error } = await q;
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to load leads.' };

  // filterOptions computed from the FULL scoped set (like GAS), not just the page.
  const scoped2 = scopeOr(s);
  const { data: fdata } = await fetchAll(() => {
    let fq = sb.from('lead_current').select('city,lead_source,assigned_name,lead_status');
    if (scoped2) fq = fq.or(scoped2);
    return fq;
  });
  const cities: Record<string, boolean> = {}, sources: Record<string, boolean> = {}, assignees: Record<string, boolean> = {}, statuses: Record<string, boolean> = {};
  (fdata || []).forEach((l: any) => {
    if (l.city) cities[l.city] = true;
    if (l.lead_source) sources[l.lead_source] = true;
    if (l.assigned_name && l.assigned_name.trim() !== '') assignees[l.assigned_name] = true;
    statuses[l.lead_status || 'New'] = true;
  });

  // Latest quotation per lead on this page -> stable link (/api/quotation/<id>) that redirects to a fresh signed PDF URL.
  const quoteByLead: Record<string, string> = {};
  const pageLeadIds = Array.from(new Set((data || []).map((l: any) => l.lead_id).filter(Boolean)));
  if (pageLeadIds.length) {
    const { data: qrows } = await sb.from('quotations').select('id, lead_id, created_at').in('lead_id', pageLeadIds).order('created_at', { ascending: false });
    for (const q of qrows || []) if (!quoteByLead[q.lead_id]) quoteByLead[q.lead_id] = '/api/quotation/' + q.id;
  }

  return {
    success: true, total: count || 0, page, pageSize,
    leads: (data || []).map((l: any) => ({ ...toClientLead(l), quotationUrl: quoteByLead[l.lead_id] || '' })),
    filterOptions: {
      cities: Object.keys(cities).sort(), sources: Object.keys(sources).sort(),
      assignees: Object.keys(assignees).sort(), statuses: Object.keys(statuses).sort(),
    },
    userRole: s.role, userEmail: s.email, userName: s.name,
  };
}

export async function handleGetFollowUpsData(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const o = args[0] || {};
  const sb = supabaseAdmin();
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(o.pageSize) || 25));

  // latest follow-up per lead via DISTINCT ON view
  const { data: allFu } = await fetchAll(() =>
    sb.from('follow_ups').select('lead_id, follow_date, follow_time, remark, lead_status, next_follow_date, next_follow_time, created_at')
      .order('lead_id').order('follow_date', { ascending: false }).order('follow_time', { ascending: false }).order('created_at', { ascending: false }));
  const latestByLead = new Map<string, any>();
  (allFu || []).forEach((r: any) => {
    const k = normalizeLeadKey(r.lead_id);
    if (!latestByLead.has(k)) latestByLead.set(k, r);
  });
  const latestRows = Array.from(latestByLead.values());

  // map lead rows for scope + enrichment
  const scopedLeadFilter = scopeOr(s);
  const { data: leadRows } = await fetchAll(() => {
    let leadQ = sb.from('lead_current').select('*');
    if (scopedLeadFilter) leadQ = leadQ.or(scopedLeadFilter);
    return leadQ;
  });
  const leadByKey = new Map<string, any>();
  (leadRows || []).forEach((l: any) => {
    leadByKey.set(normalizeLeadKey(l.lead_id), l);
    leadByKey.set(String(l.lead_id || '').trim(), l);
  });
  const privileged = ['admin', 'manager'].includes((s.role || '').toLowerCase()) ||
    [SPECIAL_EMAILS.director, SPECIAL_EMAILS.purchase, SPECIAL_EMAILS.corporatesales].includes(s.email.toLowerCase());
  const scopedLeadKeys = new Set((leadRows || []).map((l: any) => normalizeLeadKey(l.lead_id)));

  let records = latestRows
    .filter((r: any) => privileged || scopedLeadKeys.has(normalizeLeadKey(r.lead_id)))
    .filter((r: any) => (!o.fromDate || r.follow_date >= o.fromDate) && (!o.toDate || r.follow_date <= o.toDate))
    .filter((r: any) => (!o.leadStatus || (r.lead_status || 'New') === o.leadStatus))
    .filter((r: any) => {
      if (!o.followStatus) return true;
      const nextDate = r.next_follow_date || '';
      const today = todayKey();
      if (o.followStatus === 'overdue') return nextDate && nextDate < today;
      if (o.followStatus === 'today') return nextDate === today;
      if (o.followStatus === 'upcoming') return nextDate && nextDate > today;
      if (o.followStatus === 'none') return !nextDate;
      return true;
    });

  const search = String(o.search || '').trim().toLowerCase();
  if (search) {
    records = records.filter((r: any) => {
      const lead = leadByKey.get(normalizeLeadKey(r.lead_id)) || {};
      return ((r.lead_id || '') + ' ' + (r.remark || '') + ' ' + (r.lead_status || 'New') + ' ' + (lead.customer_name || '')).toLowerCase().includes(search);
    });
  }
  if (o.assignedName) records = records.filter((r: any) => (leadByKey.get(normalizeLeadKey(r.lead_id)) || {}).assigned_name === o.assignedName);
  if (o.leadSource) records = records.filter((r: any) => (leadByKey.get(normalizeLeadKey(r.lead_id)) || {}).lead_source === o.leadSource);

  const sortKey = o.sortKey || 'followDate';
  const sortDir = o.sortDir === 'asc' ? 1 : -1;
  const dbField: Record<string, string> = { followDate: 'follow_date', followTime: 'follow_time', leadStatus: 'lead_status', leadNo: 'lead_id' };
  const field = dbField[sortKey] || 'follow_date';
  records.sort((a: any, b: any) => {
    const av = a[field] || '', bv = b[field] || '';
    return av < bv ? -1 * sortDir : av > bv ? 1 * sortDir : 0;
  });

  const total = records.length;
  const start = (page - 1) * pageSize;
  const pageRecords = records.slice(start, start + pageSize).map((r: any) => {
    const lead = leadByKey.get(normalizeLeadKey(r.lead_id));
    return {
      leadNo: r.lead_id, followDate: r.follow_date || '', followTime: r.follow_time || '',
      remark: r.remark || '', leadStatus: r.lead_status || 'New',
      nextFollowDate: r.next_follow_date || '', nextFollowTime: r.next_follow_time || '',
      timestamp: r.created_at || '',
      _rowKey: 'fu-' + r.lead_id,
      lead: lead ? {
        _rowKey: (lead.source_key || 'DB') + '-' + lead.lead_id, leadId: lead.lead_id, date: lead.lead_date,
        customerName: lead.customer_name, contact: lead.contact, city: lead.city,
        clientRequirement: lead.client_requirement, detailRequirements: lead.detail_requirements,
        leadSource: lead.lead_source, assignedName: lead.assigned_name, leadStatus: lead.lead_status,
      } : null,
      customerName: lead ? (lead.customer_name || '') : '',
      contact: lead ? (lead.contact || '') : '',
      city: lead ? (lead.city || '') : '',
      date: lead ? (lead.lead_date || '') : '',
      clientRequirement: lead ? (lead.client_requirement || '') : '',
      detailRequirements: lead ? (lead.detail_requirements || '') : '',
      leadSource: lead ? (lead.lead_source || '') : '',
      assignedName: lead ? (lead.assigned_name || '') : '',
    };
  });

  const statuses: Record<string, boolean> = {}, assignees: Record<string, boolean> = {}, sources: Record<string, boolean> = {};
  (leadRows || []).forEach((l: any) => {
    if (l.assigned_name && l.assigned_name.trim() !== '') assignees[l.assigned_name] = true;
    if (l.lead_source) sources[l.lead_source] = true;
    statuses[l.lead_status || 'New'] = true;
  });
  return {
    success: true, total, page, pageSize, records: pageRecords,
    filterOptions: {
      statuses: Object.keys(statuses).sort(),
      assignees: Object.keys(assignees).sort(),
      sources: Object.keys(sources).sort(),
    },
  };
}

export async function handleSaveFollowUp(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const p = args[0] || {};
  if (!p.leadId || !p.followDate) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'Lead ID and Follow Date are required.' };
  }
  const status = safeStatus(p.leadStatus);

  // Configurable rule: 'Share Quotation' status allowed only for leads assigned to
  // the configured assignee (app_config.share_quotation_allowed_assignee, default 'indu hada').
  if (status === 'Share Quotation') {
    const allowed = String(await (await import('../config')).getConfig('share_quotation_allowed_assignee') || 'indu hada');
    const sb0 = supabaseAdmin();
    const { data: lead } = await sb0.from('leads').select('assigned_name').eq('lead_id', p.leadId).maybeSingle();
    if (!lead || (lead.assigned_name || '').toString().trim().toLowerCase() !== allowed) {
      return { success: false, code: 'ACCESS_DENIED', message: 'Share Quotation status is allowed only for leads assigned to Indu Hada.' };
    }
  }

  const sb = supabaseAdmin();
  const { error } = await sb.from('follow_ups').insert({
    lead_id: p.leadId,
    follow_date: p.followDate,
    follow_time: p.followTime || '',
    remark: p.remark || '',
    lead_status: status,
    next_follow_date: p.nextFollowDate || '',
    next_follow_time: p.nextFollowTime || '',
    created_by: s.email,
  });
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Could not save follow-up.' };
  await sb.from('leads').update({ updated_at: new Date().toISOString() }).eq('lead_id', p.leadId);
  await enqueueSheetSync('follow_ups', p.leadId + ':' + p.followDate + ':' + (p.followTime || ''), {
    leadId: p.leadId, followDate: p.followDate, followTime: p.followTime || '', remark: p.remark || '',
    leadStatus: status, nextFollowDate: p.nextFollowDate || '', nextFollowTime: p.nextFollowTime || '',
    createdBy: s.email,
  });
  await audit({ actorEmail: s.email, action: 'save_follow_up', entity: 'follow_ups', entityId: p.leadId, detail: { status } });
  return { success: true, message: 'Follow-up saved successfully.' };
}

export async function handleGetFollowHistory(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const leadId = args[0];
  if (!leadId) return { success: false, code: 'VALIDATION_ERROR', message: 'Lead ID is required.' };
  const sb = supabaseAdmin();
  const { data, error } = await sb.from('follow_ups')
    .select('lead_id, follow_date, follow_time, remark, lead_status, next_follow_date, next_follow_time, created_at')
    .eq('lead_id', leadId)
    .order('follow_date', { ascending: false })
    .order('follow_time', { ascending: false });
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to load follow history.' };
  return {
    success: true,
    history: (data || []).map((r: any) => ({
      leadNo: r.lead_id, followDate: r.follow_date || '', followTime: r.follow_time || '',
      remark: r.remark || '', leadStatus: r.lead_status || 'New',
      nextFollowDate: r.next_follow_date || '', nextFollowTime: r.next_follow_time || '',
      timestamp: r.created_at || '', _rowKey: 'fu-' + r.lead_id + '-' + Math.random().toString(36).slice(2, 7),
    })),
  };
}

export async function handleGetLeadById(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const leadId = args[0];
  if (!leadId) return { success: false, code: 'VALIDATION_ERROR', message: 'Lead ID is required.' };
  const sb = supabaseAdmin();
  const { data: found } = await sb.from('lead_current').select('*').eq('lead_id', String(leadId).trim()).maybeSingle();
  if (!found) return { success: false, code: 'NOT_FOUND', message: 'Lead not found for ID: ' + leadId };
  const scoped = scopeOr(s);
  if (scoped) {
    // verify visibility
    let vq = sb.from('lead_current').select('lead_id').eq('lead_id', String(leadId).trim());
    vq = vq.or(scoped);
    const { data: visible } = await vq.maybeSingle();
    if (!visible) return { success: false, code: 'ACCESS_DENIED', message: 'Access denied.' };
  }
  return { success: true, lead: toClientLead(found) };
}

export async function handleUpdateAssignedUser(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const p = args[0] || {};
  if (!p.leadId || !p.assignedName) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'Lead ID and Assigned Name are required.' };
  }
  const newName = String(p.assignedName).trim();
  const sb = supabaseAdmin();
  const { data: users } = await sb.from('profiles').select('name, email');
  const exists = (users || []).some((u: any) =>
    (u.name || '').toLowerCase() === newName.toLowerCase() || (u.email || '').toLowerCase() === newName.toLowerCase());
  if (!exists) return { success: false, code: 'VALIDATION_ERROR', message: 'Target user "' + newName + '" does not exist in the system.' };

  const { data: lead } = await sb.from('leads').select('id, assigned_name').eq('lead_id', String(p.leadId).trim()).maybeSingle();
  if (!lead) return { success: false, code: 'NOT_FOUND', message: 'Lead not found.' };
  if (lead.assigned_name && lead.assigned_name.toLowerCase() === newName.toLowerCase()) {
    return { success: false, code: 'VALIDATION_ERROR', message: 'This lead is already assigned to ' + newName + '.' };
  }
  const { error } = await sb.from('leads').update({ assigned_name: newName, updated_at: new Date().toISOString() }).eq('id', lead.id);
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to assign lead.' };
  await enqueueSheetSync('leads', p.leadId, { leadId: p.leadId, assignedName: newName }, 'upsert');
  await audit({ actorEmail: s.email, action: 'assign_lead', entity: 'leads', entityId: String(p.leadId), detail: { from: lead.assigned_name, to: newName } });
  return { success: true, message: 'Lead assigned to ' + newName + ' successfully.' };
}

export async function handleUpdateLeadStatus(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const p = args[0] || {};
  if (!p.leadId || !p.status) return { success: false, code: 'VALIDATION_ERROR', message: 'Lead ID and Status are required.' };
  if (VALID_STATUSES.indexOf(p.status) === -1) return { success: false, code: 'VALIDATION_ERROR', message: 'Invalid status value.' };
  const sb = supabaseAdmin();
  const { data: lead } = await sb.from('leads').select('id').eq('lead_id', String(p.leadId).trim()).maybeSingle();
  if (!lead) return { success: false, code: 'NOT_FOUND', message: 'Lead not found.' };
  const { error } = await sb.from('leads').update({ base_status: p.status, updated_at: new Date().toISOString() }).eq('id', lead.id);
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to update lead status.' };
  await enqueueSheetSync('leads', p.leadId, { leadId: p.leadId, status: p.status }, 'upsert');
  return { success: true, message: 'Lead status updated successfully.' };
}

export async function handleExportLeadsCsv(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  const scopedExport = scopeOr(s);
  const { data, error } = await fetchAll(() => {
    let q = sb.from('lead_current').select('*');
    if (scopedExport) q = q.or(scopedExport);
    return q;
  });
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to export leads.' };
  const { toCsv } = await import('../csv');
  const headers = ['Lead ID', 'Date', 'Customer Name', 'Contact', 'City', 'Client Requirement', 'Detail Requirements', 'Lead Source', 'Assigned Name', 'Lead Status'];
  const rows = [headers].concat((data || []).map((l: any) => [
    l.lead_id, l.lead_date, l.customer_name, l.contact, l.city,
    l.client_requirement, l.detail_requirements, l.lead_source, l.assigned_name, l.lead_status,
  ]));
  await audit({ actorEmail: s.email, action: 'export_leads_csv' });
  return { success: true, csv: toCsv(rows) };
}
