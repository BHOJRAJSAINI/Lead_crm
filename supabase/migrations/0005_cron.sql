-- Scheduled sync (pg_cron + pg_net). Store the secret first:
--   select vault.create_secret('<CRON_SECRET>', 'crm_cron_secret');
-- Replace the URL below with your Vercel production URL.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.crm_hit(path text) returns void
language plpgsql security definer set search_path to 'public','extensions','vault','net' as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'crm_cron_secret';
  perform net.http_get(
    url := 'https://YOUR-APP.vercel.app' || path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || s),
    timeout_milliseconds := 55000);
end $$;

select cron.schedule('crm-ingest-sheets', '*/2 * * * *', $$select public.crm_hit('/api/cron/ingest-sheets')$$);
select cron.schedule('crm-sync-sheets',   '*/5 * * * *', $$select public.crm_hit('/api/cron/sync-sheets')$$);
select cron.schedule('crm-reconcile',     '30 21 * * *', $$select public.crm_hit('/api/cron/reconcile-sheets')$$);
-- App -> Sheet pushes happen instantly after each write; these crons are the safety net + Sheet -> App pull.
