import { NextRequest, NextResponse } from 'next/server';
import { requireSession, AUTH_EXPIRED } from '@/lib/auth';
import { getLogoDataUrl } from '@/lib/rpc/branding';
import * as users from '@/lib/rpc/users';
import * as leads from '@/lib/rpc/leads-rpc';
import * as dashboard from '@/lib/rpc/dashboard';
import * as quotation from '@/lib/rpc/quotation';
import * as location from '@/lib/rpc/location';
import * as reports from '@/lib/rpc/reports';

/**
 * Single typed RPC dispatcher. Every function returns the exact JSON shape the
 * client expects, with error codes SESSION_EXPIRED / SERVER_ERROR /
 * INVALID_CREDENTIALS / ACCESS_DENIED / VALIDATION_ERROR / NOT_FOUND / DUPLICATE_USER.
 * Authorization is enforced inside each handler (role + scope), server-side only.
 */
type Handler = (req: NextRequest, args: any[]) => Promise<any> | any;

const DISPATCHER: Record<string, Handler> = {
  // auth / users
  validateSession: users.handleValidateSession,
  loginUser: users.handleLoginUser,
  logoutUser: users.handleLogoutUser,
  getUsers: users.handleGetUsers,
  createUser: users.handleCreateUser,
  verifyOldPasswordAndReset: users.handleVerifyOldPasswordAndReset,
  // branding
  getLogoDataUrl: (req) => getLogoDataUrl(),
  // leads / follow-ups
  getLeadsWithFollowUpData: leads.handleGetLeadsWithFollowUpData,
  getFollowUpsData: leads.handleGetFollowUpsData,
  saveFollowUp: leads.handleSaveFollowUp,
  getFollowHistory: leads.handleGetFollowHistory,
  getLeadById: leads.handleGetLeadById,
  updateAssignedUser: leads.handleUpdateAssignedUser,
  updateLeadStatus: leads.handleUpdateLeadStatus,
  exportLeadsCsv: leads.handleExportLeadsCsv,
  // dashboard
  getDashboardData: dashboard.handleGetDashboardData,
  // quotation
  generateQuotation: quotation.handleGenerateQuotation,
  // location
  initializeLocationTracking: location.handleInitializeLocationTracking,
  updateMyLocation: location.handleUpdateMyLocation,
  getMyLocationStatus: location.handleGetMyLocationStatus,
  getLiveLocations: location.handleGetLiveLocations,
  markLocationSessionEnded: location.handleMarkLocationSessionEnded,
  // reports
  getDoerReport: reports.handleGetDoerReport,
  getAllDoersReport: reports.handleGetAllDoersReport,
  getDoerReportDetails: reports.handleGetDoerReportDetails,
  exportDoerReportCsv: reports.handleExportDoerReportCsv,
  // checklist / delegation
  getChecklist: reports.handleGetChecklist,
  getDelegation: reports.handleGetDelegation,
};

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return NextResponse.json({ success: false, code: 'VALIDATION_ERROR', message: 'Malformed request body.' }, { status: 400 });
  }
  const fn = String(body.fn || '');
  let args: any[] = Array.isArray(body.args) ? body.args : [];
  // The legacy client passes the (decoy) session token as the first argument of every authenticated call.
  // Auth rides on the HttpOnly cookie, so drop it so handlers see their real arguments.
  if (typeof args[0] === 'string' && args[0].startsWith('cookie-backed-')) args = args.slice(1);
  const handler = DISPATCHER[fn];
  if (!handler) {
    return NextResponse.json({ success: false, code: 'VALIDATION_ERROR', message: 'Unknown function: ' + fn }, { status: 400 });
  }

  // Fast session pre-check: SESSION_EXPIRED before running anything that needs auth.
  try {
    const s = await requireSession(req);
    if (!s && fn !== 'loginUser' && fn !== 'validateSession' && fn !== 'verifyOldPasswordAndReset' && fn !== 'getLogoDataUrl') {
      return NextResponse.json(AUTH_EXPIRED, { status: 401 });
    }
  } catch (e: any) {
    // Missing env vars etc. surface as SERVER_ERROR, never a crash.
    return NextResponse.json({ success: false, code: 'SERVER_ERROR', message: e?.message || 'Server misconfigured.' }, { status: 500 });
  }

  try {
    const result = await handler(req, args);
    // Strip the cookie instruction BEFORE serializing so the real session token never reaches the JSON body.
    let cookie: { name: string; value: string } | null = null;
    if (result && typeof result === 'object' && result.setCookie) {
      cookie = result.setCookie;
      delete result.setCookie;
    }
    const res = NextResponse.json(result);
    if (cookie) {
      res.cookies.set({ name: cookie.name, value: cookie.value, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 24 * 60 * 60 });
    }
    return res;
  } catch (e: any) {
    console.error('RPC ' + fn + ' failed:', e);
    return NextResponse.json({ success: false, code: 'SERVER_ERROR', message: 'Temporary server error. Please try again.' }, { status: 500 });
  }
}
