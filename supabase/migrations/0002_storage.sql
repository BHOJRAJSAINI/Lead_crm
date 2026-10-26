-- Phase 1b: create the private quotations storage bucket (idempotent).
insert into storage.buckets (id, name, public)
values ('quotations', 'quotations', false)
on conflict (id) do nothing;
