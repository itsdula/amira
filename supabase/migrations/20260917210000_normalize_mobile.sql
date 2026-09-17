-- AF webhooks deliver senderIdentifier WITHOUT the leading '+' (e.g. 966555841684),
-- while leads.mobile_e164 enforces strict E.164. Normalize at every RPC boundary so
-- no caller format can violate the constraint or miss a lookup.

create or replace function public.normalize_mobile(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p is null or p = '' then p
    when left(p, 1) = '+' then p
    else '+' || p
  end
$$;

revoke all on function public.normalize_mobile(text) from public, anon, authenticated;
grant execute on function public.normalize_mobile(text) to service_role;

-- record_inbound: normalize before match-or-create
create or replace function public.record_inbound(
  p_mobile text,
  p_text text,
  p_channel text default 'whatsapp',
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_message_id uuid;
  v_lang text;
  v_opt_out boolean := false;
begin
  p_mobile := public.normalize_mobile(p_mobile);

  if p_text ~* '(stop messaging|unsubscribe|\mstop\M|لا تتصلون|وقف الرسائل|لا تراسلون)' then
    v_opt_out := true;
  end if;

  v_lang := case when p_text ~ U&'[\0600-\06FF]' then 'ar' else null end;

  select * into v_lead from public.leads where mobile_e164 = p_mobile;

  if not found then
    insert into public.leads (
      mobile_e164, language, opened_by, current_step, current_channel, status,
      last_inbound_at, window_expires_at, consent_whatsapp, opted_out
    ) values (
      p_mobile,
      coalesce(v_lang, 'ar'),
      'inbound',
      'channel',
      'unset',
      'open',
      timezone('utc', now()),
      timezone('utc', now()) + interval '24 hours',
      not v_opt_out,
      v_opt_out
    )
    returning * into v_lead;
  else
    update public.leads set
      opted_out = opted_out or v_opt_out,
      last_inbound_at = timezone('utc', now()),
      window_expires_at = timezone('utc', now()) + interval '24 hours',
      status = case
        when opted_out or v_opt_out then status
        when status = 'awaiting_reply' then 'open'
        else status
      end,
      consent_whatsapp = case
        when v_opt_out then consent_whatsapp
        else true
      end
    where id = v_lead.id
    returning * into v_lead;
  end if;

  insert into public.messages (lead_id, channel, direction, text, lang, step, handler, meta)
  values (
    v_lead.id,
    p_channel,
    'in',
    p_text,
    coalesce(v_lang, v_lead.language),
    v_lead.current_step,
    'inbound',
    coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_message_id;

  return public.lead_pack_for(v_lead.id, 12) || jsonb_build_object(
    'message_id', v_message_id,
    'opt_out_detected', v_opt_out
  );
end;
$$;

-- get_lead_pack: normalize the lookup
create or replace function public.get_lead_pack(p_mobile text, p_limit integer default 12)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_id uuid;
begin
  p_mobile := public.normalize_mobile(p_mobile);
  select id into v_id from public.leads where mobile_e164 = p_mobile;
  if v_id is null then
    return jsonb_build_object('found', false, 'mobile_e164', p_mobile);
  end if;
  return public.lead_pack_for(v_id, p_limit);
end;
$$;

-- record_outbound: normalize the lookup
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
  p_mobile := public.normalize_mobile(p_mobile);
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

-- set_channel_choice: normalize the lookup
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
