-- Email column (Leads tab column N) + view recreated with email as the last column.
alter table public.leads add column if not exists email text not null default '';

create or replace view public.lead_current as
 with ranked as (
   select f.lead_id, f.remark, f.follow_date, f.follow_time, f.lead_status, f.next_follow_date, f.next_follow_time,
          row_number() over (partition by f.lead_id order by f.follow_date desc nulls last, f.follow_time desc nulls last, f.created_at desc) as rn
   from follow_ups f)
 select l.id, l.row_key, l.lead_id, l.source_key, l.lead_date, l.customer_name, l.contact, l.city,
        l.client_requirement, l.detail_requirements, l.lead_source, l.assigned_name,
        coalesce(rk.lead_status, case when l.base_status = any (array['', 'null', 'undefined']) then null else l.base_status end, 'New') as lead_status,
        coalesce(rk.remark, '') as last_follow_up_decision,
        coalesce(rk.follow_date, '') as follow_date,
        coalesce(rk.follow_time, '') as follow_time,
        coalesce(rk.next_follow_date, '') as next_follow_up_date,
        coalesce(rk.next_follow_time, '') as next_follow_up_time,
        l.created_at, l.updated_at, l.email
 from leads l left join ranked rk on rk.lead_id = l.lead_id and rk.rn = 1;
alter view public.lead_current set (security_invoker = true);
