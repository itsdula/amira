-- One JSON selection on the lead. Drops facts + step_contexts.
-- The bot fills empty keys; code derives what to ask next.

create or replace function public.empty_selection()
returns jsonb
language sql
immutable
set search_path = public
as $$
  select '{"vehicle":null,"payment":null,"color":null,"order_now":null,"accessories":null,"timing":null}'::jsonb
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
    when p->'timing' is null or p->'timing' = 'null'::jsonb then 'timing'
    else 'close'
  end
$$;

alter table public.leads
  add column if not exists selection jsonb not null default public.empty_selection();

comment on column public.leads.selection is
  'Qualification blob: vehicle, payment, color, order_now, accessories, timing. Null key = not asked. accessories is an array or "none".';

-- Backfill from the old facts table if it still exists.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'facts') then
    update public.leads l set selection = jsonb_build_object(
      'vehicle', coalesce((select f.value from public.facts f where f.lead_id = l.id and f.key = 'vehicle' and not f.declined), 'null'::jsonb),
      'payment', coalesce((select f.value from public.facts f where f.lead_id = l.id and f.key = 'payment' and not f.declined), 'null'::jsonb),
      'color', coalesce((
        select case
          when jsonb_typeof(f.value) = 'array' then f.value->0
          else f.value
        end
        from public.facts f
        where f.lead_id = l.id and f.key = 'colours' and not f.declined
      ), 'null'::jsonb),
      'order_now', coalesce((select f.value from public.facts f where f.lead_id = l.id and f.key = 'order_now' and not f.declined), 'null'::jsonb),
      'accessories', coalesce((
        select case
          when f.declined then '"none"'::jsonb
          when jsonb_typeof(f.value) = 'array' and jsonb_array_length(f.value) = 0 then '"none"'::jsonb
          else f.value
        end
        from public.facts f
        where f.lead_id = l.id and f.key = 'accessories'
      ), 'null'::jsonb),
      'timing', coalesce((select f.value from public.facts f where f.lead_id = l.id and f.key = 'timing' and not f.declined), 'null'::jsonb)
    );
    update public.leads
      set selection = jsonb_set(selection, '{accessories}', '"none"')
      where selection->>'order_now' = 'false';
  end if;
end $$;

update public.leads set current_step = 'color' where current_step = 'colours';
update public.leads set current_step = 'order_now' where current_step = 'order_gate';

alter table public.leads drop constraint if exists leads_current_step_check;
alter table public.leads add constraint leads_current_step_check
  check (current_step in (
    'channel', 'vehicle', 'payment', 'color', 'order_now',
    'accessories', 'timing', 'close', 'done'
  ));

update public.leads set current_step = case
  when current_channel = 'unset' then 'channel'
  else public.selection_next_ask(selection)
end;

create or replace function public.lead_pack_for(p_lead_id uuid, p_limit integer default 12)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_submission jsonb;
  v_messages jsonb;
  v_sel jsonb;
begin
  select * into v_lead from public.leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_sel := coalesce(v_lead.selection, public.empty_selection());

  select to_jsonb(s)
  into v_submission
  from public.lead_latest_submission s
  where s.lead_id = p_lead_id;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.at desc), '[]'::jsonb)
  into v_messages
  from (
    select *
    from public.messages
    where lead_id = p_lead_id
    order by at desc
    limit greatest(coalesce(p_limit, 12), 0)
  ) m;

  return jsonb_build_object(
    'found', true,
    'next_action', public.lead_next_action(v_lead),
    'lead', to_jsonb(v_lead),
    'latest_submission', v_submission,
    'selection', v_sel,
    'next_ask', case
      when v_lead.current_channel = 'unset' then 'channel'
      else public.selection_next_ask(v_sel)
    end,
    'recent_messages', v_messages
  );
end;
$$;

create or replace function public.patch_selection(p_lead_id uuid, p_fields jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_sel jsonb;
begin
  select * into v_lead from public.leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_sel := coalesce(v_lead.selection, public.empty_selection()) || coalesce(p_fields, '{}'::jsonb);
  if v_sel->>'order_now' = 'false' then
    v_sel := jsonb_set(v_sel, '{accessories}', '"none"');
  end if;

  update public.leads set
    selection = v_sel,
    current_step = case
      when current_channel = 'unset' then 'channel'
      else public.selection_next_ask(v_sel)
    end
  where id = p_lead_id
  returning * into v_lead;

  return public.lead_pack_for(v_lead.id, 12);
end;
$$;

create or replace function public.ingest_form_submission(
  p_full_name text,
  p_mobile text,
  p_vehicle text,
  p_language text,
  p_consent boolean,
  p_submitted_at timestamptz default timezone('utc', now())
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_is_new boolean := false;
  v_submission_id uuid;
  v_message_id uuid;
  v_send_template boolean;
  v_sel jsonb;
begin
  p_mobile := public.normalize_mobile(p_mobile);
  select * into v_lead from public.leads where mobile_e164 = p_mobile;

  if not found then
    v_sel := public.empty_selection();
    if p_vehicle is not null and p_vehicle <> '' then
      v_sel := jsonb_set(v_sel, '{vehicle}', to_jsonb(p_vehicle));
    end if;
    v_is_new := true;
    insert into public.leads (
      mobile_e164, full_name, language, consent_whatsapp, opened_by,
      current_step, current_channel, status, outbound_attempts, selection
    ) values (
      p_mobile, p_full_name, p_language, p_consent, 'form',
      'channel', 'unset', 'awaiting_reply',
      case when p_consent then 1 else 0 end,
      v_sel
    )
    returning * into v_lead;
  else
    v_sel := coalesce(v_lead.selection, public.empty_selection());
    if v_sel->>'vehicle' is null and p_vehicle is not null and p_vehicle <> '' then
      v_sel := jsonb_set(v_sel, '{vehicle}', to_jsonb(p_vehicle));
    end if;
    update public.leads set
      full_name = p_full_name,
      language = p_language,
      consent_whatsapp = p_consent,
      selection = v_sel,
      current_step = case
        when v_lead.status in ('hot', 'cold', 'awaiting_reply') then 'channel'
        else v_lead.current_step
      end,
      current_channel = case
        when v_lead.status in ('hot', 'cold', 'awaiting_reply') then 'unset'
        else v_lead.current_channel
      end,
      status = case
        when v_lead.opted_out then v_lead.status
        when v_lead.status in ('hot', 'cold', 'awaiting_reply') then 'awaiting_reply'
        else v_lead.status
      end,
      outbound_attempts = case
        when p_consent and not v_lead.opted_out
          and v_lead.status in ('hot', 'cold', 'awaiting_reply')
        then v_lead.outbound_attempts + 1
        else v_lead.outbound_attempts
      end
    where id = v_lead.id
    returning * into v_lead;
  end if;

  insert into public.submissions (
    lead_id, full_name, mobile_e164, vehicle, language, consent_whatsapp, submitted_at
  ) values (
    v_lead.id, p_full_name, p_mobile, p_vehicle, p_language, p_consent, p_submitted_at
  )
  returning id into v_submission_id;

  insert into public.messages (lead_id, channel, direction, text, lang, step, handler, meta)
  values (
    v_lead.id, 'form', 'system',
    'Form submitted for ' || p_vehicle,
    p_language, 'channel', 'form',
    jsonb_build_object('submission_id', v_submission_id, 'consent_whatsapp', p_consent)
  )
  returning id into v_message_id;

  v_send_template := p_consent and not v_lead.opted_out;

  return public.lead_pack_for(v_lead.id, 12) || jsonb_build_object(
    'is_new', v_is_new,
    'send_template', v_send_template,
    'submission_id', v_submission_id
  );
end;
$$;

create or replace function public.set_channel_choice(
  p_mobile text,
  p_choice text,
  p_preferred_call_at timestamptz default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_riyadh timestamp;
  v_in_hours boolean;
  v_next_start timestamptz;
  v_status text;
  v_pref timestamptz;
  v_msg_id uuid;
begin
  if p_choice not in ('whatsapp', 'call_now', 'schedule') then
    raise exception 'choice must be whatsapp | call_now | schedule';
  end if;

  p_mobile := public.normalize_mobile(p_mobile);
  select * into v_lead from public.leads where mobile_e164 = p_mobile;
  if not found then
    return jsonb_build_object('found', false, 'mobile_e164', p_mobile);
  end if;
  if v_lead.opted_out then
    return public.lead_pack_for(v_lead.id, 12);
  end if;

  v_riyadh := timezone('Asia/Riyadh', timezone('utc', now()));
  v_in_hours := extract(hour from v_riyadh) >= 9 and extract(hour from v_riyadh) < 21;
  v_next_start := case
    when extract(hour from v_riyadh) < 9
      then ((date_trunc('day', v_riyadh) + interval '9 hours') at time zone 'Asia/Riyadh')
    else ((date_trunc('day', v_riyadh) + interval '1 day' + interval '9 hours') at time zone 'Asia/Riyadh')
  end;

  v_status := case
    when p_choice = 'whatsapp' then 'open'
    when p_choice = 'call_now' and v_in_hours then 'open'
    else 'scheduled'
  end;

  v_pref := case
    when p_choice = 'call_now' and v_in_hours then timezone('utc', now())
    when p_choice = 'call_now' then v_next_start
    when p_choice = 'schedule' then p_preferred_call_at
    else null
  end;

  update public.leads set
    current_channel = case when p_choice = 'whatsapp' then 'whatsapp' else 'voice' end,
    current_step = public.selection_next_ask(coalesce(selection, public.empty_selection())),
    status = v_status,
    preferred_call_at = v_pref
  where id = v_lead.id
  returning * into v_lead;

  insert into public.messages (lead_id, channel, direction, text, lang, step, handler, meta)
  values (
    v_lead.id, 'whatsapp', 'system', 'channel choice: ' || p_choice, v_lead.language,
    'channel', 'inbound', jsonb_build_object('choice', p_choice, 'in_hours', v_in_hours)
  )
  returning id into v_msg_id;

  return public.lead_pack_for(v_lead.id, 12) || jsonb_build_object(
    'call_window', case when v_in_hours then 'open' else 'closed' end,
    'dial_now', p_choice = 'call_now' and v_in_hours,
    'next_window_at', v_next_start
  );
end;
$$;

revoke all on function public.empty_selection() from public, anon, authenticated;
revoke all on function public.selection_next_ask(jsonb) from public, anon, authenticated;
revoke all on function public.patch_selection(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.empty_selection() to service_role;
grant execute on function public.selection_next_ask(jsonb) to service_role;
grant execute on function public.patch_selection(uuid, jsonb) to service_role;
grant execute on function public.ingest_form_submission(text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.set_channel_choice(text, text, timestamptz) to service_role;
grant execute on function public.lead_pack_for(uuid, integer) to service_role;

drop function if exists public.upsert_fact(uuid, text, jsonb, boolean, text, text, uuid);
drop table if exists public.facts;
drop table if exists public.step_contexts;
