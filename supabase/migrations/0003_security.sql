-- RLS on base tables (deny-all for anon/authenticated; server uses the service-role key which bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['profiles','leads','follow_ups','checklist','delegation'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- The view must respect RLS of the caller, otherwise anon could read all leads through PostgREST.
alter view public.lead_current set (security_invoker = true);
