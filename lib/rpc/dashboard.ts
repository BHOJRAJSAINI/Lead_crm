import { NextRequest } from 'next/server';
import { supabaseAdmin } from '../supabase';
import { requireSession, Session, AUTH_EXPIRED, visibleOwnerNames, isAdminSession } from '../auth';
import { SPECIAL_EMAILS, PENDING_STATUSES, ACTION_REQUIRED_STATUSES, WASTE_STATUSES, HOT_STATUSES, POTENTIAL_STATUSES, VALID_STATUSES } from '../config';
import { todayKey, shiftDateKey } from '../ist';
import { toClientLead, normalizeLeadKey } from './leads';

/** Dashboard payload — identical key set to Code.gs getDashboardData. */
export async function handleGetDashboardData(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const sb = supabaseAdmin();
  let q = sb.from('lead_current').select('*');
  const scoped = scopeFilter(s);
  if (scoped) q = q.or(scoped);
  const { data: leads, error } = await q;
  if (error) return { success: false, code: 'SERVER_ERROR', message: 'Failed to load dashboard data.' };

  const today = todayKey();
  const yesterday = shiftDateKey(1);
  const weekAgoKey = shiftDateKey(6);
  const pendingThreshold = today; // hard-coded '2026-08-01' cut-off REPLACED per fix list

  const bySource: Record<string, number> = {};
  const bySourceToday: Record<string, number> = {};
  const bySourceYesterday: Record<string, number> = {};
  const byAssignee: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  const statusDist: Record<string, number> = {};
  const statusBySource: Record<string, any> = {};
  let todayCount = 0, yesterdayCount = 0, weekCount = 0;
  const todayLeads: any[] = [], yesterdayLeads: any[] = [], weekLeads: any[] = [];
  const actionRequiredMap: Record<string, { status: string; count: number; leads: any[] }> = {};
  ACTION_REQUIRED_STATUSES.forEach((st) => { actionRequiredMap[st] = { status: st, count: 0, leads: [] }; });
  let wasteLeads = 0, hotLeads = 0, sharedQuotationLeads = 0, potentialLeads = 0, convertedLeads = 0, pendingLeads = 0;
  let overdueFollowups = 0, todayFollowups = 0, upcomingFollowups = 0, noFollowupScheduled = 0;
  const wasteBySource: Record<string, number> = { INDIAMART: 0, META_CORP: 0, FACEBOOK: 0, INSTAGRAM: 0, UNKNOWN: 0 };
  const employeeData: Record<string, any> = {};
  const sourcePerformance: Record<string, any> = {};

  for (const raw of leads || []) {
    const l: any = toClientLead(raw);
    const src = l.leadSource || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    if (l.assignedName && l.assignedName.trim() !== '') byAssignee[l.assignedName] = (byAssignee[l.assignedName] || 0) + 1;
    if (l.date) byDate[l.date] = (byDate[l.date] || 0) + 1;
    if (l.date === today) { todayCount++; bySourceToday[src] = (bySourceToday[src] || 0) + 1; todayLeads.push(l); }
    if (l.date === yesterday) { yesterdayCount++; bySourceYesterday[src] = (bySourceYesterday[src] || 0) + 1; yesterdayLeads.push(l); }
    if (l.date && l.date >= weekAgoKey && l.date <= today) { weekCount++; weekLeads.push(l); }

    const status = l.leadStatus || 'New';
    if (status && !['', 'null', 'undefined'].includes(status)) statusDist[status] = (statusDist[status] || 0) + 1;
    if (!statusBySource[src]) statusBySource[src] = {};
    if (status && !['', 'null', 'undefined'].includes(status)) {
      let displayStatus = status;
      if (status === 'New') displayStatus = l.date && l.date < '2026-09-01' ? 'Old Lead' : 'New Lead';
      statusBySource[src][displayStatus] = (statusBySource[src][displayStatus] || 0) + 1;
    }
    if (HOT_STATUSES.includes(status)) hotLeads++;
    if (status === 'Shared Quotation') sharedQuotationLeads++;
    if (POTENTIAL_STATUSES.includes(status)) potentialLeads++;
    if (status === 'Converted') convertedLeads++;
    if (l.date && l.date <= pendingThreshold && PENDING_STATUSES.includes(status)) pendingLeads++;
    if (WASTE_STATUSES.includes(status)) {
      wasteLeads++;
      const wc = getWasteSource(l.leadSource);
      wasteBySource[wc] = (wasteBySource[wc] || 0) + 1;
    }
    if (actionRequiredMap[status]) {
      actionRequiredMap[status].count++;
      if (actionRequiredMap[status].leads.length < 5) actionRequiredMap[status].leads.push(l);
    }
    const nextDate = l.nextFollowUpDate || '';
    if (nextDate) {
      if (nextDate < today) overdueFollowups++;
      else if (nextDate === today) todayFollowups++;
      else upcomingFollowups++;
    } else noFollowupScheduled++;

    const empName = l.assignedName || 'Unassigned';
    if (!employeeData[empName]) employeeData[empName] = { total: 0, pending: 0, pendingFollowups: 0, converted: 0, fulfilled: 0 };
    employeeData[empName].total++;
    if (PENDING_STATUSES.includes(status)) employeeData[empName].pending++;
    if (status === 'Converted') employeeData[empName].converted++;
    if (status === 'Fulfilled') employeeData[empName].fulfilled++;
    if (nextDate && nextDate <= today) employeeData[empName].pendingFollowups++;

    if (!sourcePerformance[src]) sourcePerformance[src] = { total: 0, converted: 0 };
    sourcePerformance[src].total++;
    if (status === 'Converted') sourcePerformance[src].converted++;
  }

  const statusDistribution = Object.keys(statusDist).map((k) => ({ status: k, count: statusDist[k] })).sort((a, b) => b.count - a.count);
  const actionOrder = ACTION_REQUIRED_STATUSES;
  const actionRequired = actionOrder.map((st) => actionRequiredMap[st]).filter(Boolean);
  const trend: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) { const k = shiftDateKey(i); trend.push({ date: k, count: byDate[k] || 0 }); }
  const topSources = Object.keys(bySource).map((k) => ({ source: k, count: bySource[k] })).sort((a, b) => b.count - a.count);
  const sourceTodayVsYesterday = topSources.map((x) => ({ source: x.source, today: bySourceToday[x.source] || 0, yesterday: bySourceYesterday[x.source] || 0 }));
  const pipelineMap: Record<string, number> = {};
  VALID_STATUSES.forEach((st) => { pipelineMap[st] = 0; });
  (leads || []).forEach((raw: any) => {
    const st = raw.lead_status || 'New';
    if (pipelineMap[st] !== undefined) pipelineMap[st]++;
  });
  const pipelineDistribution = VALID_STATUSES.map((st) => ({ stage: st, count: pipelineMap[st] || 0 }));
  const totalLeads = (leads || []).length;
  const conversionRate = totalLeads > 0 ? (convertedLeads / totalLeads) * 100 : 0;

  // Compatibility: allLeads kept, but capped at 5000 rows (payload hardening).
  const allLeads = totalLeads > 5000 ? (leads || []).slice(0, 5000).map((l: any) => toClientLead(l)) : (leads || []).map((l: any) => toClientLead(l));

  return {
    success: true,
    totals: {
      totalLeads,
      indiamart: (leads || []).filter((l: any) => l.lead_source === 'INDIAMART').length,
      fbInsta: bySource['FB & INSTA'] || 0,
      corpFb: bySource['Corp FB'] || 0,
      todayCount, yesterdayCount, weekCount,
      hotLeads, sharedQuotationLeads, potentialLeads, convertedLeads,
      pendingLeads, wasteLeads, conversionRate,
    },
    sourceDistribution: topSources,
    sourceTodayVsYesterday,
    assigneeDistribution: Object.keys(byAssignee).filter((k) => k && k.trim() !== '').map((k) => ({ name: k, count: byAssignee[k] })).sort((a, b) => b.count - a.count),
    trend, statusDistribution, statusBySource, actionRequired,
    wasteLeads, wasteBySource, overdueFollowups, todayFollowups, upcomingFollowups, noFollowupScheduled,
    pipelineDistribution, statusWidgetsAvailable: true,
    todayLeads, yesterdayLeads, weekLeads,
    todayDate: today, yesterdayDate: yesterday, weekStartDate: weekAgoKey,
    allLeads, allLeadsCapped: totalLeads > 5000,
    hotLeads, sharedQuotationLeads, potentialLeads, convertedLeads,
    pendingLeads, conversionRate,
    employeeData, sourcePerformance,
  };
}

function getWasteSource(leadSource: string): string {
  if (!leadSource) return 'UNKNOWN';
  const n = String(leadSource).trim().toUpperCase();
  if (['INDIAMART', 'INDIA MART', 'INDIA-MART'].includes(n)) return 'INDIAMART';
  if (['META CORP', 'METACORP', 'CORP FB', 'CORP_FB', 'CORP', 'META'].includes(n)) return 'META_CORP';
  if (['FACEBOOK', 'FB', 'FB & INSTA', 'FB_INSTA'].includes(n)) return 'FACEBOOK';
  if (['INSTAGRAM', 'INSTA'].includes(n)) return 'INSTAGRAM';
  return 'UNKNOWN';
}

function scopeFilter(s: Session): string | null {
  const email = s.email.toLowerCase();
  const role = (s.role || '').toLowerCase();
  if (role === 'admin' || email === SPECIAL_EMAILS.director || email === SPECIAL_EMAILS.purchase) return null;
  if (email === SPECIAL_EMAILS.corporatesales) return 'assigned_name.eq.Indu Hada';
  const owners = visibleOwnerNames(s).map((o) => o.toLowerCase());
  if (!owners.length) return 'assigned_name.eq.__NONE__';
  return owners.map((o) => `assigned_name.ilike.${o}`).join(',');
}
