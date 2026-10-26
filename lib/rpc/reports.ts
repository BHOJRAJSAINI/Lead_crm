import { NextRequest } from 'next/server';
import { supabaseAdmin, fetchAll } from '../supabase';
import { requireSession, AUTH_EXPIRED, isManagementSession, visibleOwnerNames } from '../auth';
import { REPORT_PENDING, REPORT_ACTION, REPORT_CONVERTED, REPORT_FULFILLED, REPORT_FAILED, VALID_STATUSES } from '../config';
import { resolveDateRange, todayKey, shiftDateKey, Range } from '../ist';
import { toCsv } from '../csv';
import { audit } from '../config';

type Enriched = {
  leadId: string; customerName: string; contact: string; city: string;
  clientRequirement: string; detailRequirements: string;
  leadSource: string; assignedName: string; date: string;
  leadStatus: string; followDate: string; followTime: string;
  nextFollowUpDate: string; nextFollowUpTime: string; lastFollowUpDecision: string; _rowKey: string;
};

async function loadEnriched(s: any): Promise<Enriched[]> {
  const sb = supabaseAdmin();
  const { data } = await fetchAll(() => sb.from('lead_current').select('*').order('lead_date', { ascending: false }));
  return (data || []).map((l: any) => ({
    leadId: l.lead_id, customerName: l.customer_name || '', contact: l.contact || '',
    city: l.city || '', clientRequirement: l.client_requirement || '',
    detailRequirements: l.detail_requirements || '', leadSource: l.lead_source || '',
    assignedName: l.assigned_name || '', date: l.lead_date || '',
    leadStatus: l.lead_status || 'New', followDate: l.follow_date || '', followTime: l.follow_time || '',
    nextFollowUpDate: l.next_follow_up_date || '', nextFollowUpTime: l.next_follow_up_time || '',
    lastFollowUpDecision: l.last_follow_up_decision || '',
    _rowKey: (l.source_key || 'DB') + '-' + l.lead_id,
  }));
}

function applyReportFilters(leads: Enriched[], filters: any, session: any): { leads: Enriched[]; range: Range } {
  const range = resolveDateRange(filters);
  let out = leads.slice();
  if (!isManagementSession(session)) {
    const owners = visibleOwnerNames(session).map((o) => o.toLowerCase());
    const ownerSet = new Set(owners);
    out = out.filter((l) => ownerSet.has((l.assignedName || '').toLowerCase().trim()));
  }
  if (range.from) out = out.filter((l) => l.date && l.date >= range.from!);
  if (range.to) out = out.filter((l) => l.date && l.date <= range.to!);
  if (filters.doerName) out = out.filter((l) => (l.assignedName || '').toLowerCase() === String(filters.doerName).trim().toLowerCase());
  if (filters.leadSource) out = out.filter((l) => (l.leadSource || '') === filters.leadSource);
  if (filters.leadStatus) out = out.filter((l) => (l.leadStatus || 'New') === filters.leadStatus);
  if (filters.assignment === 'assigned') out = out.filter((l) => !!(l.assignedName && l.assignedName.trim()));
  if (filters.assignment === 'unassigned') out = out.filter((l) => !(l.assignedName && l.assignedName.trim()));
  if (filters.followStatus) {
    const today = todayKey();
    out = out.filter((l) => {
      const nd = l.nextFollowUpDate || '';
      if (filters.followStatus === 'overdue') return nd && nd < today;
      if (filters.followStatus === 'today') return nd === today;
      if (filters.followStatus === 'upcoming') return nd && nd > today;
      if (filters.followStatus === 'none') return !nd;
      return true;
    });
  }
  return { leads: out, range };
}

function computeDoerMetrics(leads: Enriched[]) {
  const today = todayKey();
  const total = leads.length;
  let converted = 0, fulfilled = 0, failed = 0, pending = 0, action = 0;
  let dueToday = 0, overdue = 0, upcoming = 0, noFollow = 0;
  const statusDist: Record<string, number> = {};
  const sourceDist: Record<string, number> = {};
  const sourceConverted: Record<string, number> = {};
  let lastFollowDate = '';
  leads.forEach((l) => {
    const st = l.leadStatus || 'New';
    statusDist[st] = (statusDist[st] || 0) + 1;
    if (REPORT_CONVERTED.includes(st)) converted++;
    else if (REPORT_FULFILLED.includes(st)) fulfilled++;
    else if (REPORT_FAILED.includes(st)) failed++;
    if (REPORT_PENDING.includes(st)) pending++;
    if (REPORT_ACTION.includes(st)) action++;
    const nd = l.nextFollowUpDate || '';
    if (nd) { if (nd < today) overdue++; else if (nd === today) dueToday++; else upcoming++; }
    else noFollow++;
    const src = l.leadSource || 'Unknown';
    sourceDist[src] = (sourceDist[src] || 0) + 1;
    if (REPORT_CONVERTED.includes(st)) sourceConverted[src] = (sourceConverted[src] || 0) + 1;
    if (l.followDate && l.followDate > lastFollowDate) lastFollowDate = l.followDate;
  });
  const convRate = total > 0 ? (converted / total) * 100 : 0;
  const fulRate = total > 0 ? (fulfilled / total) * 100 : 0;
  return {
    totalLeads: total, pendingLeads: pending, convertedLeads: converted,
    fulfilledLeads: fulfilled, failedLeads: failed, actionRequired: action,
    dueToday, overdue, upcoming, noFollowUp: noFollow,
    conversionRate: Math.round(convRate * 100) / 100,
    fulfillmentRate: Math.round(fulRate * 100) / 100,
    statusDistribution: statusDist,
    sourcePerformance: Object.keys(sourceDist).map((sc) => ({
      source: sc, total: sourceDist[sc], converted: sourceConverted[sc] || 0,
      rate: sourceDist[sc] > 0 ? Math.round(((sourceConverted[sc] || 0) / sourceDist[sc]) * 10000) / 100 : 0,
    })),
    lastFollowDate: lastFollowDate || '',
  };
}

function doerList(leads: Enriched[], session: any): string[] {
  const set = new Set<string>();
  leads.forEach((l) => { const n = (l.assignedName || '').trim(); if (n) set.add(n); });
  let list = Array.from(set).sort();
  if (!isManagementSession(session)) {
    const ownerSet = new Set(visibleOwnerNames(session).map((o) => o.toLowerCase()));
    list = list.filter((n) => ownerSet.has(n.toLowerCase().trim()));
  }
  return list;
}

export async function handleGetDoerReport(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const filters = args[0] || {};
  try {
    const enriched = await loadEnriched(s);
    const base = applyReportFilters(enriched, filters, s);
    let leads = base.leads;
    const targetDoer = String(filters.doerName || '').trim();
    if (targetDoer) {
      leads = leads.filter((l) => (l.assignedName || '').toLowerCase() === targetDoer.toLowerCase());
    } else if (!isManagementSession(s)) {
      const ownerSet = new Set(visibleOwnerNames(s).map((o) => o.toLowerCase()));
      leads = leads.filter((l) => ownerSet.has((l.assignedName || '').toLowerCase().trim()));
    }
    const metrics = computeDoerMetrics(leads);
    const trendMap: Record<string, number> = {};
    leads.forEach((l) => { if (l.date) trendMap[l.date] = (trendMap[l.date] || 0) + 1; });
    const trend: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) { const k = shiftDateKey(i); trend.push({ date: k, count: trendMap[k] || 0 }); }
    return { success: true, doer: targetDoer || (s.name || ''), range: base.range, metrics, trend, doers: doerList(enriched, s) };
  } catch (e: any) {
    return { success: false, code: 'SERVER_ERROR', message: 'Failed to load Doer report: ' + (e.message || 'unknown') };
  }
}

export async function handleGetAllDoersReport(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  if (!isManagementSession(s)) {
    return { success: false, code: 'ACCESS_DENIED', message: 'Only authorized management can view the combined Doer report.' };
  }
  const filters = args[0] || {};
  try {
    const enriched = await loadEnriched(s);
    const base = applyReportFilters(enriched, filters, s);
    const groups: Record<string, Enriched[]> = {};
    base.leads.forEach((l) => {
      const name = (l.assignedName || '').trim() || 'Unassigned';
      (groups[name] = groups[name] || []).push(l);
    });
    const rows = Object.keys(groups).map((name) => {
      const m = computeDoerMetrics(groups[name]);
      return {
        doerName: name, totalLeads: m.totalLeads, pendingLeads: m.pendingLeads,
        convertedLeads: m.convertedLeads, fulfilledLeads: m.fulfilledLeads,
        overdue: m.overdue, dueToday: m.dueToday, noFollowUp: m.noFollowUp,
        conversionRate: m.conversionRate, fulfillmentRate: m.fulfillmentRate,
        lastActivity: m.lastFollowDate || '',
      };
    }).sort((a, b) => b.totalLeads - a.totalLeads);
    const overall = computeDoerMetrics(base.leads);
    const sources = new Set<string>(); enriched.forEach((l) => { if (l.leadSource) sources.add(l.leadSource); });
    return { success: true, range: base.range, rows, overall, doers: doerList(enriched, s), sources: Array.from(sources).sort(), statuses: VALID_STATUSES.slice() };
  } catch (e: any) {
    return { success: false, code: 'SERVER_ERROR', message: 'Failed to load combined Doer report: ' + (e.message || 'unknown') };
  }
}

export async function handleGetDoerReportDetails(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const filters = args[0] || {};
  try {
    const enriched = await loadEnriched(s);
    const base = applyReportFilters(enriched, filters, s);
    let leads = base.leads;
    if (filters.statusOnly) leads = leads.filter((l) => (l.leadStatus || 'New') === filters.statusOnly);
    if (filters.convertedOnly) leads = leads.filter((l) => REPORT_CONVERTED.includes(l.leadStatus));
    if (filters.pendingOnly) leads = leads.filter((l) => REPORT_PENDING.includes(l.leadStatus));
    if (filters.overdueOnly) {
      const today = todayKey();
      leads = leads.filter((l) => l.nextFollowUpDate && l.nextFollowUpDate < today);
    }
    const records = leads.map((l) => ({
      leadId: l.leadId, customerName: l.customerName, contact: l.contact,
      leadSource: l.leadSource, assignedName: l.assignedName || 'Unassigned',
      date: l.date, leadStatus: l.leadStatus || 'New',
      lastFollowUp: l.followDate || '', nextFollowUpDate: l.nextFollowUpDate || '',
      lastRemark: l.lastFollowUpDecision || '', _rowKey: l._rowKey,
    }));
    return { success: true, total: records.length, records };
  } catch (e: any) {
    return { success: false, code: 'SERVER_ERROR', message: 'Failed to load report details: ' + (e.message || 'unknown') };
  }
}

export async function handleExportDoerReportCsv(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const filters = args[0] || {};
  try {
    const enriched = await loadEnriched(s);
    const base = applyReportFilters(enriched, filters, s);
    const leads = base.leads;
    const mode = filters.exportMode || 'leads';
    let rows: any[][];
    if (mode === 'summary' && isManagementSession(s)) {
      const groups: Record<string, Enriched[]> = {};
      leads.forEach((l) => {
        const n = (l.assignedName || '').trim() || 'Unassigned';
        (groups[n] = groups[n] || []).push(l);
      });
      rows = [['Doer Name', 'Total Leads', 'Pending', 'Converted', 'Fulfilled', 'Overdue', 'Due Today', 'No Follow-up', 'Conversion Rate %', 'Fulfillment Rate %', 'Last Activity']];
      Object.keys(groups).forEach((name) => {
        const m = computeDoerMetrics(groups[name]);
        rows.push([name, m.totalLeads, m.pendingLeads, m.convertedLeads, m.fulfilledLeads, m.overdue, m.dueToday, m.noFollowUp, m.conversionRate, m.fulfillmentRate, m.lastFollowDate || '']);
      });
    } else {
      rows = [['Lead ID', 'Customer', 'Contact', 'Source', 'Assigned Doer', 'Lead Date', 'Status', 'Last Follow-up', 'Next Follow-up', 'Remark']];
      leads.forEach((l) => rows.push([l.leadId, l.customerName, l.contact, l.leadSource, l.assignedName || 'Unassigned', l.date, l.leadStatus || 'New', l.followDate || '', l.nextFollowUpDate || '', l.lastFollowUpDecision || '']));
    }
    await audit({ actorEmail: s.email, action: 'export_doer_csv', detail: { mode } });
    return { success: true, csv: toCsv(rows), fileName: 'report-doer-' + todayKey() + '.csv' };
  } catch (e: any) {
    return { success: false, code: 'SERVER_ERROR', message: 'Failed to export report: ' + (e.message || 'unknown') };
  }
}

/** getChecklist / getDelegation — same column mapping as Code.gs sections 14-15. */
export async function handleGetChecklist(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  const { data } = await sb.from('checklist').select('*').eq('user_email', s.email);
  const out = (data || []).map((r: any) => ({
    taskId: r.task_id || '', task: r.task || '', plannedTime: r.planned_time || '',
    frequency: r.frequency || '', department: r.department || '', updationLink: r.updation_link || '',
  }));
  return { success: true, items: out };
}

export async function handleGetDelegation(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  const { data } = await sb.from('delegation').select('*').eq('user_email', s.email);
  const out = (data || []).map((r: any) => ({
    taskCode: r.task_code || '', assignedBy: r.assigned_by || '', work: r.work || '',
    deadline: r.deadline || '', updationLink: r.updation_link || '',
  }));
  return { success: true, items: out };
}
