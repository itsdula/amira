-- Calling hours used a double timezone conversion, so 11:00 Riyadh looked like 05:00
-- and call_now was stored as scheduled instead of dialing.

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

  v_riyadh := now() at time zone 'Asia/Riyadh';
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
