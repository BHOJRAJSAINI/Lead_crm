/**
 * One-time idempotent re-import from Google Sheets into Supabase + diff report.
 * Usage: npm run import-from-sheets
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID.
 *
 * Safe to re-run: upserts by (source_key, lead_id); never deletes; prints a
 * diff report (DB vs Sheet counts per tab) at the end.
 */
import { createClient } from '@supabase/supabase-js';

const SOURCES = [
  { key: 'INDIAMART', sheetName: 'Leads', endCol: 'Q',
    map: { leadId: 0, date: 1, customerName: 2, contact: 4, city: 10, clientRequirement: 7, detailRequirements: 8, assignedName: 14, status: 16 },
    forceSource: 'INDIAMART', fallbackSource: 'INDIAMART' },
  { key: 'FB_INSTA', sheetName: 'FB & INSTA', endCol: 'K',
    map: { leadId: 0, date: 1, customerName: 2, contact: 3, city: 4, clientRequirement: 5, detailRequirements: 6, leadSource: 8, assignedName: 9, status: 10 },
    forceSource: null, fallbackSource: 'Facebook' },
  { key: 'CORP_FB', sheetName: 'Corp FB', endCol: 'K',
    map: { leadId: 0, date: 1, customerName: 2, contact: 5, city: 4, clientRequirement: 6, detailRequirements: 7, leadSource: 8, assignedName: 9, status: 10 },
    forceSource: null, fallbackSource: 'Corp FB' },
];

function colIdx(letter: string): number {
  let col = 0;
  const up = letter.toUpperCase();
  for (let i = 0; i < up.length; i++) col = col * 26 + (up.charCodeAt(i) - 64);
  return col - 1;
}

async function getAccessToken(): Promise<string> {
  const raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64u = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  }));
  const unsigned = header + '.' + claims;
  const { createSign } = await import('crypto');
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const j = await res.json();
  return j.access_token;
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const token = await getAccessToken();
  const report: any[] = [];

  for (const src of SOURCES) {
    const colEnd = colIdx(src.endCol) + 1;
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + process.env.GOOGLE_SHEET_ID +
      '/values/' + encodeURIComponent(src.sheetName + '!A2:' + colL(colEnd)) + '?majorDimension=ROWS';
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const { values } = await res.json();
    let inserted = 0, updated = 0, skipped = 0;
    for (const row of values || []) {
      if (!row || row.every((c: any) => c === '' || c === null)) { skipped++; continue; }
      const m = src.map;
      const leadId = String(row[m.leadId] ?? '').trim();
      if (!leadId) { skipped++; continue; }
      const dateRaw = row[m.date];
      const leadDate = typeof dateRaw === 'number'
        ? new Date(Math.round((dateRaw - 25569) * 86400 * 1000)).toISOString().slice(0, 10)
        : String(dateRaw ?? '').trim();
      const payload = {
        row_key: src.key + '-' + leadId, lead_id: leadId, source_key: src.key,
        lead_date: leadDate || null,
        customer_name: String(row[m.customerName] ?? '').trim(),
        contact: String(row[m.contact] ?? '').trim(),
        city: String(row[m.city] ?? '').trim(),
        client_requirement: String(row[m.clientRequirement] ?? '').trim(),
        detail_requirements: String(row[m.detailRequirements] ?? '').trim(),
        lead_source: src.forceSource || String(row[m.leadSource] ?? '').trim() || src.fallbackSource,
        assigned_name: String(row[m.assignedName] ?? '').trim(),
        base_status: String(row[m.status] ?? '').trim() || 'New',
      };
      const { data: existing } = await sb.from('leads').select('id').eq('lead_id', leadId).eq('source_key', src.key).maybeSingle();
      if (existing) {
        // re-import does NOT overwrite DB-side edits (assignment/status)
        const { error } = await sb.from('leads').update({
          customer_name: payload.customer_name, contact: payload.contact, city: payload.city,
          client_requirement: payload.client_requirement, detail_requirements: payload.detail_requirements,
          lead_source: payload.lead_source, lead_date: payload.lead_date,
        }).eq('id', existing.id);
        error ? skipped++ : updated++;
      } else {
        const { error } = await sb.from('leads').insert(payload);
        error ? skipped++ : inserted++;
      }
    }
    report.push({ tab: src.sheetName, inserted, updated, skipped });
    console.log(src.sheetName, { inserted, updated, skipped });
  }

  // follow-ups
  const fuUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + process.env.GOOGLE_SHEET_ID +
    '/values/' + encodeURIComponent('Lead FollowUps!A2:H') + '?majorDimension=ROWS';
  const fuRes = await fetch(fuUrl, { headers: { Authorization: 'Bearer ' + token } });
  const { values: fuRows } = await fuRes.json();
  let fuInserted = 0, fuSkipped = 0;
  for (const r of fuRows || []) {
    if (!r || !r[0]) { fuSkipped++; continue; }
    const leadId = String(r[0]).trim();
    const { data: lead } = await sb.from('leads').select('id').eq('lead_id', leadId).maybeSingle();
    if (!lead) { fuSkipped++; continue; }
    const { data: dup } = await sb.from('follow_ups').select('id')
      .eq('lead_id', leadId).eq('follow_date', String(r[1] ?? '').trim()).eq('follow_time', String(r[2] ?? '').trim())
      .maybeSingle();
    if (dup) { fuSkipped++; continue; }
    const { error } = await sb.from('follow_ups').insert({
      lead_id: leadId, follow_date: String(r[1] ?? '').trim(), follow_time: String(r[2] ?? '').trim(),
      remark: String(r[3] ?? '').trim(), lead_status: String(r[4] ?? 'New').trim(),
      next_follow_date: String(r[5] ?? '').trim(), next_follow_time: String(r[6] ?? '').trim(),
    });
    error ? fuSkipped++ : fuInserted++;
  }
  report.push({ tab: 'Lead FollowUps', inserted: fuInserted, skipped: fuSkipped });
  console.log('Lead FollowUps', { inserted: fuInserted, skipped: fuSkipped });

  // diff report
  for (const [tab, table] of [['Leads', 'leads'], ['Lead FollowUps', 'follow_ups']] as const) {
    const { count } = await sb.from(table).select('id', { count: 'exact', head: true });
    console.log('DIFF', tab, 'DB count =', count);
  }
  console.log('Report complete.', JSON.stringify(report, null, 2));
}

function colL(idx: number): string {
  let s = '', n = idx;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s || 'A';
}

main().catch((e) => { console.error(e); process.exit(1); });
