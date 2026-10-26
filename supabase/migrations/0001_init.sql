-- ============================================================
-- Phase 1 migrations — idempotent, additive only.
-- NEVER drops or recreates existing tables: leads, follow_ups,
-- profiles, checklist, delegation.
-- ============================================================

-- ---------- updated_at triggers on every synced table ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['leads','follow_ups','profiles','checklist','delegation'] loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------- leads.dedupe key ----------
create unique index if not exists leads_lead_id_source_key_key
  on public.leads (coalesce(source_key,''), lead_id);

-- ---------- indexes ----------
create index if not exists idx_leads_lead_date_desc on public.leads (lead_date desc);
create index if not exists idx_leads_assigned_name_lower on public.leads (lower(assigned_name));
create index if not exists idx_leads_lead_source on public.leads (lead_source);
create index if not exists idx_fu_lead_date_time_desc
  on public.follow_ups (lead_id, follow_date desc, follow_time desc);
create index if not exists idx_fu_next_follow_date on public.follow_ups (next_follow_date);
-- trigram search on customer_name / contact
create extension if not exists pg_trgm;
create index if not exists idx_leads_customer_name_trgm on public.leads using gin (customer_name gin_trgm_ops);
create index if not exists idx_leads_contact_trgm on public.leads using gin (contact gin_trgm_ops);

-- ---------- sessions ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,          -- sha256(token + SESSION_SECRET)
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null,          -- idle timeout
  absolute_expires_at timestamptz not null, -- max lifetime
  active boolean not null default true,
  user_agent text, ip text
);
create index if not exists idx_sessions_user on public.sessions (user_id);
create index if not exists idx_sessions_expires on public.sessions (expires_at);

-- ---------- quotations ----------
create table if not exists public.quotations (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  customer_name text, contact_person text, mobile text, location text,
  event_date text, days text,
  sales_person text, sales_person_mobile text,
  items jsonb not null default '[]',
  total numeric not null default 0,
  gst_percent numeric not null default 18,
  gst_amount numeric not null default 0,
  grand_total numeric not null default 0,
  generated_by text,
  storage_path text,
  pdf_url text,
  status text not null default 'Hot Lead',
  created_at timestamptz not null default now()
);
create index if not exists idx_quotations_lead on public.quotations (lead_id);

-- ---------- location tracking ----------
create table if not exists public.location_pings (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  user_name text,
  role text,
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision,
  position_ts timestamptz not null default now(),
  received_at timestamptz not null default now(),
  sharing_status text not null default 'Active',
  session_ref text,
  source text default 'web_geolocation',
  device_info text
);
create index if not exists idx_pings_email_time on public.location_pings (user_email, received_at desc);
create index if not exists idx_pings_received on public.location_pings (received_at);
create index if not exists idx_pings_cleanup on public.location_pings (received_at)
  where received_at < now() - interval '30 days';

-- ---------- sync outbox / log / state ----------
create table if not exists public.sheet_outbox (
  id bigserial primary key,
  op text not null check (op in ('upsert','delete')),
  table_name text not null,
  row_id text not null,
  payload jsonb,
  attempts int not null default 0,
  status text not null default 'pending' check (status in ('pending','done','dead')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text
);
create index if not exists idx_outbox_pending on public.sheet_outbox (status, id) where status = 'pending';

create table if not exists public.sheet_sync_log (
  id bigserial primary key,
  direction text not null,           -- 'db->sheet' | 'sheet->db'
  table_name text,
  detail jsonb,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.sheet_sync_state (
  key text primary key,              -- e.g. 'ingest:Leads:last_row'
  last_row bigint not null default 1,
  last_run timestamptz,
  extra jsonb
);

-- ---------- app config (Indu Hada rule etc.) ----------
create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_config (key, value) values
  ('quotation_allowed_assignee', '"indu hada"'),
  ('share_quotation_allowed_assignee', '"indu hada"')
on conflict (key) do nothing;

-- ---------- audit log ----------
create table if not exists public.audit_log (
  id bigserial primary key,
  actor_email text,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_log (created_at desc);

-- ---------- ensure updated_at columns exist on synced tables ----------
alter table public.leads     add column if not exists updated_at timestamptz;
alter table public.follow_ups add column if not exists updated_at timestamptz;
alter table public.profiles  add column if not exists updated_at timestamptz;
alter table public.checklist add column if not exists updated_at timestamptz;
alter table public.delegation add column if not exists updated_at timestamptz;

-- ---------- users extra columns (forced password reset, login throttle) ----------
alter table public.profiles add column if not exists password_hash text;
alter table public.profiles add column if not exists must_reset_password boolean not null default false;
alter table public.profiles add column if not exists failed_attempts int not null default 0;
alter table public.profiles add column if not exists locked_until timestamptz;

-- ============================================================
-- lead_current view: latest follow-up per lead (DISTINCT ON)
-- ============================================================
create or replace view public.lead_current as
with ranked as (
  select
    f.lead_id,
    f.remark,
    f.follow_date,
    f.follow_time,
    f.lead_status,
    f.next_follow_date,
    f.next_follow_time,
    row_number() over (
      partition by f.lead_id
      order by f.follow_date desc nulls last, f.follow_time desc nulls last, f.created_at desc
    ) rn
  from public.follow_ups f
)
select
  l.id,
  l.row_key,
  l.lead_id,
  l.source_key,
  l.lead_date,
  l.customer_name,
  l.contact,
  l.city,
  l.client_requirement,
  l.detail_requirements,
  l.lead_source,
  l.assigned_name,
  coalesce(rk.lead_status,
    case when l.base_status in ('','null','undefined') then null else l.base_status end,
    'New')::text as lead_status,
  coalesce(rk.remark, '') as last_follow_up_decision,
  coalesce(rk.follow_date::text, '') as follow_date,
  coalesce(rk.follow_time::text, '') as follow_time,
  coalesce(rk.next_follow_date::text, '') as next_follow_up_date,
  coalesce(rk.next_follow_time::text, '') as next_follow_up_time,
  l.created_at,
  l.updated_at
from public.leads l
left join ranked rk on rk.lead_id = l.lead_id and rk.rn = 1;

-- ============================================================
-- RLS: enabled everywhere, deny-all for anon (no policies).
-- Server uses the service-role key which bypasses RLS.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['sessions','quotations','location_pings','sheet_outbox',
    'sheet_sync_log','sheet_sync_state','app_config','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
