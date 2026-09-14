-- Channel choice + outbound logging.
-- set_channel_choice: deterministic fork after ask_channel (whatsapp | call_now | schedule),
--   with 09:00-21:00 Asia/Riyadh clamping for calls.
-- record_outbound: append an outbound message to the chat log (AF flows call this after every send).

create or replace function public.record_outbound(
  p_mobile text,
  p_text text,
  p_channel text default 'whatsapp',
  p_step text default null,
  p_handler text default 'inbound',
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_id uuid;
begin
  select * into v_lead from public.leads where mobile_e164 = p_mobile;
  if not found then
    return jsonb_build_object('found', false, 'mobile_e164', p_mobile);
  end if;

  insert into public.messages (lead_id, channel, direction, text, lang, step, handler, meta)
  values (
    v_lead.id, p_channel, 'out', p_text, v_lead.language,
    coalesce(p_step, v_lead.current_step), p_handler, coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_id;

  update public.leads
  set last_outbound_at = timezone('utc', now())
  where id = v_lead.id;

  return jsonb_build_object('found', true, 'message_id', v_id);
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
    current_step = 'vehicle',
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

  perform public.upsert_fact(
    v_lead.id, 'preferred_channel', to_jsonb(p_choice), false, 'channel', 'whatsapp', v_msg_id
  );

  insert into public.step_contexts (lead_id, step, status, facts_owned, narrative, open_threads, message_ids)
  values (
    v_lead.id, 'channel', 'answered', array['preferred_channel']::text[],
    'Chose ' || p_choice || ' on WhatsApp.',
    case when p_choice = 'schedule' and p_preferred_call_at is null
         then array['call time pending']::text[] else '{}'::text[] end,
    array[v_msg_id]
  )
  on conflict (lead_id, step) do update set
    status = 'answered',
    narrative = excluded.narrative,
    open_threads = excluded.open_threads,
    message_ids = array_append(public.step_contexts.message_ids, v_msg_id);

  return public.lead_pack_for(v_lead.id, 12) || jsonb_build_object(
    'call_window', case when v_in_hours then 'open' else 'closed' end,
    'dial_now', p_choice = 'call_now' and v_in_hours,
    'next_window_at', v_next_start
  );
end;
$$;

revoke all on function public.record_outbound(text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_channel_choice(text, text, timestamptz) from public, anon, authenticated;

grant execute on function public.record_outbound(text, text, text, text, text, jsonb) to service_role;
grant execute on function public.set_channel_choice(text, text, timestamptz) to service_role;
