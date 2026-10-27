import { ENV } from './env';

/**
 * Google Sheets API v4 via service account (JWT -> access token).
 * Used by the cron jobs (DB -> Sheets mirror + Sheets -> DB ingest).
 */
type TokenCache = { token: string; exp: number };
let cached: TokenCache | null = null;

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getServiceAccountJson(): any {
  let raw = (ENV.GOOGLE_SERVICE_ACCOUNT_JSON || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  // Strip wrapping quotes added by some dashboards / shells.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1).trim();

  const candidates: string[] = [];
  if (raw.startsWith('{')) candidates.push(raw);
  if (raw.startsWith('{\\"')) candidates.push(raw.replace(/\\"/g, '"')); // escaped JSON string
  const b64 = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  try { candidates.push(Buffer.from(b64, 'base64').toString('utf8')); } catch (_) { /* ignore */ }

  for (const text of candidates) {
    try {
      const sa = JSON.parse(text);
      if (sa && sa.client_email && sa.private_key) {
        sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
        return sa;
      }
    } catch (_) { /* try next */ }
  }
  throw new Error(
    'GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed (length=' + raw.length + ', starts="' + raw.slice(0, 4) +
    '"). Expected the service-account JSON (starts with {) or its base64 (starts with ey).'
  );
}

export async function getAccessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = getServiceAccountJson();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = header + '.' + claims;
  const { createSign } = await import('crypto');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    }),
  });
  if (!res.ok) throw new Error('Google token exchange failed: ' + (await res.text()));
  const json = await res.json();
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return cached.token;
}

async function sheetsCall(path: string, init?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + ENV.GOOGLE_SHEET_ID + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error('Sheets API ' + path + ' failed: ' + (await res.text()));
  if (res.status === 204) return {};
  return res.json();
}

/** Upsert one row by matching hidden `_db_id` in a chosen key column. */
export async function upsertRow(sheetName: string, headers: string[], keyCol: string, dbId: string, row: any[]) {
  // 1) find existing row with _db_id
  const meta = await sheetsCall(
    '?ranges=' + encodeURIComponent(sheetName) + '&fields=' + encodeURIComponent('sheets(properties(title,data(rowCount)))'),
    {}
  );
  const sheet = meta.sheets && meta.sheets.find((s: any) => s.properties.title === sheetName);
  const rowCount = sheet ? sheet.data?.[0]?.rowCount || 1 : 1;
  let targetRow = -1;
  if (rowCount > 1) {
    const keyIdx = headers.indexOf(keyCol);
    const search = await sheetsCall(
      '/values/' + encodeURIComponent(sheetName) + '!A2:' + colLetter(headers.length) + (rowCount) +
      '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE',
      {}
    );
    const values = search.values || [];
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][keyIdx] || '') === dbId) { targetRow = i + 2; break; }
    }
  }
  const range = targetRow === -1
    ? '/' + encodeURIComponent(sheetName) + '!A1'
    : '/' + encodeURIComponent(sheetName) + '!A' + targetRow;
  const body = targetRow === -1
    ? { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', includeValuesInResponse: false,
        data: [{ range: sheetName + '!A1', values: [headers, row] }] }
    : { valueInputOption: 'USER_ENTERED', includeValuesInResponse: false,
        data: [{ range: sheetName + '!A' + targetRow, values: [row] }] };
  return sheetsCall('/values:batchUpdate' + range, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function readRange(sheetName: string, a1: string, raw = false): Promise<any[][]> {
  // raw=true returns dates/times as serial numbers (locale-independent) instead of formatted strings.
  const render = raw ? '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER' : '';
  const res = await sheetsCall('/values/' + encodeURIComponent(sheetName + '!' + a1) + '?majorDimension=ROWS' + render, {});
  return res.values || [];
}

export function colLetter(idx: number): string {
  let s = '';
  let n = idx;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

/** Tab titles of the spreadsheet (diagnostics). */
export async function listTabs(): Promise<string[]> {
  const meta = await sheetsCall('?fields=' + encodeURIComponent('sheets(properties(title))'), {});
  return (meta.sheets || []).map((x: any) => x.properties.title);
}
