create or replace function public.empty_selection()
returns jsonb
language sql
immutable
set search_path = public
as $$
  select '{"vehicle":null,"payment":null,"color":null,"order_now":null,"accessories":null,"purchase":null,"rep_time":null,"timing":null}'::jsonb
$$;

create or replace function public.selection_next_ask(p jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p is null or p->'vehicle' is null or p->'vehicle' = 'null'::jsonb then 'vehicle'
    when p->'payment' is null or p->'payment' = 'null'::jsonb then 'payment'
    when p->'color' is null or p->'color' = 'null'::jsonb then 'color'
    when p->'order_now' is null or p->'order_now' = 'null'::jsonb then 'order_now'
    when p->>'order_now' = 'true'
         and (p->'accessories' is null or p->'accessories' = 'null'::jsonb) then 'accessories'
    when p->>'order_now' = 'true'
         and (p->'purchase' is null or p->'purchase' = 'null'::jsonb) then 'purchase'
    when p->>'purchase' = 'telesales'
         and (p->'rep_time' is null or p->'rep_time' = 'null'::jsonb) then 'rep_time'
    when (p->'timing' is null or p->'timing' = 'null'::jsonb)
         and not (p->>'order_now' = 'true' and p->>'purchase' in ('online', 'telesales'))
      then 'timing'
    else 'close'
  end
$$;

alter table public.leads drop constraint if exists leads_current_step_check;
alter table public.leads add constraint leads_current_step_check
  check (current_step in (
    'channel', 'vehicle', 'payment', 'color', 'order_now',
    'accessories', 'purchase', 'rep_time', 'timing', 'close', 'done'
  ));
