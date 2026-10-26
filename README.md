# Panache Lead CRM — Next.js + Supabase + Google Sheets Auto-Sync

Migration of the Google Apps Script "LEAD CRM MANAGEMENT SYSTEM" to
**Vercel (Next.js App Router, TypeScript) + Supabase Postgres**, with two-way
Google Sheets sync. The UI (`Index.html`) is kept 1:1 — no redesign.

## Quick start

1. **Supabase migrations** — run `supabase/migrations/0001_init.sql` and
   `0002_storage.sql` in the SQL editor (idempotent; they never drop or
   recreate existing tables: `leads`, `follow_ups`, `profiles`, `checklist`, `delegation`).
2. **Vercel env vars** (copy from `.env.example`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
   `GOOGLE_SERVICE_ACCOUNT_JSON` (base64), `GOOGLE_SHEET_ID`,
   `CRON_SECRET`, `SESSION_SECRET`, `APP_TIMEZONE=Asia/Kolkata`,
   `QUOTATIONS_BUCKET=quotations`, `LOGO_URL` (public URL of the Panache logo),
   `QUOTATION_HEADER_URL` (public URL of the quotation header image).
3. **Google service account** — create one, enable the Sheets API, share the
   spreadsheet (`1gma1CsjqFUcPmn35uV5S0LHVK70N5Bco4vGNWk1Al_g`) with the
   service-account email as Editor.
4. **Deploy** — `vercel --prod` (region `bom1`); crons are declared in `vercel.json`.
5. **Users** — first login seeds two demo users (`admin@panacheevents.in` /
   `sales@panacheevents.in`, passwords in `lib/env.ts` — DEV ONLY, both are
   flagged `must_reset_password`). Change them immediately, then create the
   12 real users via Admin → New User (min password length is now 8).

## Architecture

```
Browser (original Index.html, untouched UI)
  └── public/gas-shim.js      — implements window.google.script.run, forwards to /api/rpc
        └── app/api/rpc/route.ts   — typed dispatcher (28 functions), auth + scope per call
              ├── lib/rpc/*        — users, leads, dashboard, quotation (pdf-lib), location, reports
              ├── lib/auth.ts      — bcrypt + sessions table + HttpOnly cookie + rate limit
              └── Supabase Postgres (service role server-side; RLS deny-all for anon)

Sync:
  writes → sheet_outbox → /api/cron/sync-sheets (2 min) → Sheets API v4 (upsert by _db_id)
  Sheets → /api/cron/ingest-sheets (2 min) → new rows into leads by (source_key, lead_id)
  nightly → /api/cron/reconcile-sheets — counts + drift log
  optional Apps Script onChange webhook → /api/webhooks/sheet-change (HMAC-SHA256)
```

## Business rules preserved from Code.gs (source of truth)

- Role scope: Admin/director@/purchase@ see all; corporatesales@ sees only
  leads assigned to `Indu Hada`; others only `visibleOwnerNames()` (incl. the
  Shilpi ↔ Palak Daryani shared-owner group). Enforced **in SQL**, not the client.
- Latest lead status = latest `follow_ups` row (follow_date, then follow_time,
  then created_at), else `base_status`, else `New` — via the `lead_current` view.
- Quotation: allowed only for leads assigned to **Indu Hada** (configurable via
  `app_config.quotation_allowed_assignee`); Size/Qty optional individually, Rate
  compulsory; Amount = Size×Qty×Rate | Size×Rate | Qty×Rate; GST default 18%;
  PDF stored in the private `quotations` bucket, returned as a signed URL; a
  `Hot Lead` follow-up is auto-saved.
- Location: 15 s throttle/dedupe, 300 s stale threshold, admin-only live map,
  pings older than 30 days purgeable by cron.
- Sessions: 6 h idle / 24 h absolute, sliding renewal 60 min before expiry —
  now backed by the `sessions` table + HttpOnly cookie instead of localStorage.

## Fixes applied (Section 6 of the migration prompt)

1. Hard-coded `'2026-08-31'` / `'2026-08-01'` pending-lead cut-off → **today (IST)**.
2. Session token: HttpOnly, Secure, SameSite=Lax cookie; shim reads no storage.
3. bcrypt password hashes; login rate-limit 5 / 15 min per IP+email + per-user lockout.
4. `verifyOldPasswordAndReset` requires the old password (plus rate limit + audit log).
5. Every RPC enforces role+scope; CSV cells escaped against formula injection (`=,+,-,@`).
6. Dashboard `allLeads` capped at 5,000 rows (`allLeadsCapped` flag), gzip via Vercel.
7. CSP, HSTS, X-Frame-Options, nosniff headers in `next.config.js`.
8. `audit_log` table records logins, password resets, user creation, assignment and exports.

## Conflicts between Code.gs and the migration prompt (Code.gs wins)

| Topic | Code.gs | Prompt | Resolution |
|---|---|---|---|
| Quotation toast text | "Indu Huda" | says client text is wrong, rule is "Indu Hada" | Rule uses `indu hada` (lowercased compare, as in Code.gs); toast says "Indu Hada" |
| Pending-lead cut-off | `2026-08-01` (dashboard), prompt says `2026-08-31` | — | Both replaced with **today (IST)** |
| `getUsers` returns passwords | returns plaintext | no hashes to Sheets | `getUsers` now returns masked passwords; Sheets `Users` tab never receives hashes |
| `getAllDoersReport` access | admin + director@ + purchase@ + manager role + corporatesales@ | "Admin only" | Kept Code.gs `_isManagementSession_` semantics |
| `updateLeadStatus` / `getLocationHistory` | exist in Code.gs, not in the prompt list | — | Implemented (dispatcher superset) |
| Password min length | 4 | raise to 8 | **8** for new passwords |
| Dashboard `statusBySource` "New" split | Old Lead `< 2026-09-01` else New Lead | not mentioned | Kept as-is (client relies on it) |

## Scripts

- `npm run import-from-sheets` — one-time idempotent re-import + diff report.
- `npm run build` / `npm run typecheck`.

## Rollback plan

Keep the old Apps Script web app live **read-only** for 14 days. If rollback is
needed, redeploy the previous Apps Script deployment; data written to Postgres
after cutover can be exported with `import-from-sheets` in reverse or via the
Sheets mirror.
