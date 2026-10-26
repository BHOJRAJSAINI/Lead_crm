-- Base tables (idempotent). In the legacy project these already existed; a fresh Supabase project needs them.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  role text,
  created_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  row_key text,
  lead_id text not null,
  source_key text,
  lead_date date,
  customer_name text,
  contact text,
  city text,
  client_requirement text,
  detail_requirements text,
  lead_source text,
  assigned_name text,
  base_status text,
  created_at timestamptz not null default now()
);

-- follow_date/time are text on purpose: the app stores '' for empty values.
create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  follow_date text,
  follow_time text,
  remark text,
  lead_status text,
  next_follow_date text,
  next_follow_time text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.checklist (
  id uuid primary key default gen_random_uuid(),
  user_email text,
  task_id text, task text, planned_time text, frequency text, department text, updation_link text,
  created_at timestamptz not null default now()
);

create table if not exists public.delegation (
  id uuid primary key default gen_random_uuid(),
  user_email text,
  task_code text, assigned_by text, work text, deadline text, updation_link text,
  created_at timestamptz not null default now()
);
