-- Lead store: one page per phone, submissions are history, pack is one round-trip.
-- Data API is closed (RLS on, no anon/authenticated grants). service_role only.
-- request_calls stays as a leftover from init; new writes go through ingest_form_submission.

create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  mobile_e164 text not null unique
    check (mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  full_name text,
  language text not null default 'ar' check (language in ('en', 'ar')),
  gender_form text not null default 'unknown' check (gender_form in ('m', 'f', 'unknown')),
  consent_whatsapp boolean not null default false,
  opted_out boolean not null default false,
  opened_by text not null default 'form'
    check (opened_by in ('form', 'reschedule', 'inbound')),
  current_step text not null default 'channel'
    check (current_step in (
      'channel', 'vehicle', 'payment', 'colours',
      'order_gate', 'accessories', 'timing', 'close', 'done'
    )),
  current_channel text not null default 'unset'
    check (current_channel in ('whatsapp', 'voice', 'unset')),
  status text not null default 'awaiting_reply'
    check (status in (
      'awaiting_reply', 'open', 'scheduled', 'in_call', 'hot', 'cold'
    )),
  preferred_call_at timestamptz,
  outbound_attempts integer not null default 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  window_expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index leads_status_idx on public.leads (status);
create index leads_window_expires_at_idx on public.leads (window_expires_at);
create index leads_preferred_call_at_idx on public.leads (preferred_call_at);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

comment on table public.leads is
  'One row per phone. Pointer only — latest form seed lives on submissions.';

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  full_name text not null,
  mobile_e164 text not null,
  vehicle text not null,
  language text not null check (language in ('en', 'ar')),
  consent_whatsapp boolean not null,
  submitted_at timestamptz not null default timezone('utc', now()),
  source text not null default 'form' check (source in ('form'))
);

create index submissions_lead_submitted_at_idx
  on public.submissions (lead_id, submitted_at desc);

comment on table public.submissions is
  'Append-only form posts. Always read latest by lead_id, submitted_at desc.';

create table public.facts (
  lead_id uuid not null references public.leads (id) on delete cascade,
  key text not null,
  value jsonb,
  declined boolean not null default false,
  step text not null,
  channel text check (channel in ('whatsapp', 'voice', 'form')),
  at timestamptz not null default timezone('utc', now()),
  message_id uuid,
  primary key (lead_id, key)
);

create index facts_lead_idx on public.facts (lead_id);

comment on table public.facts is
  'Coverage. Overwrite in place. declined=true is still coverage — do not re-ask.';

create table public.step_contexts (
  lead_id uuid not null references public.leads (id) on delete cascade,
  step text not null,
  status text not null default 'empty'
    check (status in ('empty', 'in_progress', 'answered', 'declined', 'skipped')),
  facts_owned text[] not null default '{}',
  narrative text,
  open_threads text[] not null default '{}',
  message_ids uuid[] not null default '{}',
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (lead_id, step)
);

create trigger step_contexts_set_updated_at
  before update on public.step_contexts
  for each row execute function public.set_updated_at();

comment on table public.step_contexts is
  'Micro-context per lead × step: narrative + open threads, not only slots.';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'voice', 'form')),
  direction text not null check (direction in ('in', 'out', 'system')),
  text text not null,
  lang text check (lang in ('en', 'ar')),
  step text,
  handler text check (handler in ('form', 'reschedule', 'inbound')),
  at timestamptz not null default timezone('utc', now()),
  meta jsonb not null default '{}'::jsonb
);

create index messages_lead_at_idx on public.messages (lead_id, at desc);
create index messages_lead_step_idx on public.messages (lead_id, step);
create index messages_text_trgm_idx on public.messages using gin (text gin_trgm_ops);

comment on table public.messages is
  'Append-only chat log. Index inbound before the model replies.';

alter table public.facts
  add constraint facts_message_id_fkey
  foreign key (message_id) references public.messages (id) on delete set null;

create or replace view public.lead_latest_submission
  with (security_invoker = true)
as
select distinct on (s.lead_id)
  s.lead_id,
  s.id as submission_id,
  s.full_name,
  s.mobile_e164,
  s.vehicle,
  s.language,
  s.consent_whatsapp,
  s.submitted_at,
  s.source
from public.submissions s
order by s.lead_id, s.submitted_at desc;

comment on view public.lead_latest_submission is
  'Latest form seed per lead. Prefer this over scanning submissions.';

-- --- pack + writes (one round-trip) ---------------------------------------

create or replace function public.lead_next_action(p_lead public.leads)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_lead.opted_out then 'stop_opted_out'
    when p_lead.status in ('hot', 'cold') then 'already_closed'
    when p_lead.current_channel = 'unset' then 'ask_channel'
    else 'gather'
  end
$$;

create or replace function public.lead_pack_for(p_lead_id uuid, p_limit integer default 12)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_facts jsonb;
  v_submission jsonb;
  v_context jsonb;
  v_messages jsonb;
  v_uncovered text[];
begin
  select * into v_lead from public.leads where id = p_lead_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(jsonb_object_agg(f.key, jsonb_build_object(
    'value', f.value,
    'declined', f.declined,
    'step', f.step,
    'channel', f.channel,
    'at', f.at
  )), '{}'::jsonb)
  into v_facts
  from public.facts f
  where f.lead_id = p_lead_id;

  select to_jsonb(s)
  into v_submission
  from public.lead_latest_submission s
  where s.lead_id = p_lead_id;

  select to_jsonb(sc)
  into v_context
  from public.step_contexts sc
  where sc.lead_id = p_lead_id
    and sc.step = v_lead.current_step;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.at desc), '[]'::jsonb)
  into v_messages
  from (
    select *
    from public.messages
    where lead_id = p_lead_id
    order by at desc
    limit greatest(coalesce(p_limit, 12), 0)
  ) m;

  v_uncovered := array(
    select k from unnest(array[
      'vehicle', 'grade', 'payment', 'colours', 'order_now',
      'accessories', 'timing', 'preferred_channel'
    ]) as k
    where not exists (
      select 1 from public.facts f
      where f.lead_id = p_lead_id and f.key = k
    )
  );

  return jsonb_build_object(
    'found', true,
    'next_action', public.lead_next_action(v_lead),
    'lead', to_jsonb(v_lead),
    'latest_submission', v_submission,
    'facts', v_facts,
    'uncovered', to_jsonb(v_uncovered),
    'step_context', v_context,
    'recent_messages', v_messages
  );
end;
$$;

create or replace function public.get_lead_pack(p_mobile text, p_limit integer default 12)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.leads where mobile_e164 = p_mobile;
  if v_id is null then
    return jsonb_build_object('found', false, 'mobile_e164', p_mobile);
  end if;
  return public.lead_pack_for(v_id, p_limit);
end;
$$;

create or replace function public.upsert_fact(
  p_lead_id uuid,
  p_key text,
  p_value jsonb,
  p_declined boolean,
  p_step text,
  p_channel text default null,
  p_message_id uuid default null
) returns void
language sql
set search_path = public
as $$
  insert into public.facts (lead_id, key, value, declined, step, channel, message_id)
  values (p_lead_id, p_key, p_value, coalesce(p_declined, false), p_step, p_channel, p_message_id)
  on conflict (lead_id, key) do update set
    value = excluded.value,
    declined = excluded.declined,
    step = excluded.step,
    channel = excluded.channel,
    at = timezone('utc', now()),
    message_id = coalesce(excluded.message_id, public.facts.message_id);
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
begin
  select * into v_lead from public.leads where mobile_e164 = p_mobile;

  if not found then
    v_is_new := true;
    insert into public.leads (
      mobile_e164, full_name, language, consent_whatsapp, opened_by,
      current_step, current_channel, status, outbound_attempts
    ) values (
      p_mobile, p_full_name, p_language, p_consent, 'form',
      'channel', 'unset', 'awaiting_reply',
      case when p_consent then 1 else 0 end
    )
    returning * into v_lead;
  else
    update public.leads set
      full_name = p_full_name,
      language = p_language,
      consent_whatsapp = p_consent,
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

  perform public.upsert_fact(v_lead.id, 'full_name', to_jsonb(p_full_name), false, 'channel', 'form', v_message_id);
  perform public.upsert_fact(v_lead.id, 'mobile_e164', to_jsonb(p_mobile), false, 'channel', 'form', v_message_id);
  perform public.upsert_fact(v_lead.id, 'vehicle', to_jsonb(p_vehicle), false, 'channel', 'form', v_message_id);
  perform public.upsert_fact(v_lead.id, 'language', to_jsonb(p_language), false, 'channel', 'form', v_message_id);
  perform public.upsert_fact(v_lead.id, 'consent_whatsapp', to_jsonb(p_consent), false, 'channel', 'form', v_message_id);

  insert into public.step_contexts (lead_id, step, status, facts_owned, narrative)
  values (
    v_lead.id,
    'channel',
    'in_progress',
    array['preferred_channel']::text[],
    'Submitted the request-a-call form for ' || p_vehicle
      || '. Language ' || p_language || '.'
  )
  on conflict (lead_id, step) do update set
    narrative = excluded.narrative,
    status = case
      when public.step_contexts.status = 'answered' then public.step_contexts.status
      else 'in_progress'
    end;

  v_send_template := p_consent and not v_lead.opted_out;

  return public.lead_pack_for(v_lead.id, 12) || jsonb_build_object(
    'is_new', v_is_new,
    'send_template', v_send_template,
    'submission_id', v_submission_id
  );
end;
$$;

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

-- --- privileges -------------------------------------------------------------

alter table public.leads enable row level security;
alter table public.submissions enable row level security;
alter table public.facts enable row level security;
alter table public.step_contexts enable row level security;
alter table public.messages enable row level security;

revoke all on public.leads from anon, authenticated;
revoke all on public.submissions from anon, authenticated;
revoke all on public.facts from anon, authenticated;
revoke all on public.step_contexts from anon, authenticated;
revoke all on public.messages from anon, authenticated;
revoke all on public.lead_latest_submission from anon, authenticated;

grant all on public.leads to service_role;
grant all on public.submissions to service_role;
grant all on public.facts to service_role;
grant all on public.step_contexts to service_role;
grant all on public.messages to service_role;
grant select on public.lead_latest_submission to service_role;

revoke all on function public.lead_pack_for(uuid, integer) from public, anon, authenticated;
revoke all on function public.get_lead_pack(text, integer) from public, anon, authenticated;
revoke all on function public.ingest_form_submission(text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.record_inbound(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.upsert_fact(uuid, text, jsonb, boolean, text, text, uuid) from public, anon, authenticated;
revoke all on function public.lead_next_action(public.leads) from public, anon, authenticated;

grant execute on function public.lead_pack_for(uuid, integer) to service_role;
grant execute on function public.get_lead_pack(text, integer) to service_role;
grant execute on function public.ingest_form_submission(text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.record_inbound(text, text, text, jsonb) to service_role;
grant execute on function public.upsert_fact(uuid, text, jsonb, boolean, text, text, uuid) to service_role;
grant execute on function public.lead_next_action(public.leads) to service_role;

-- --- copy the one existing form row ---------------------------------------

insert into public.leads (
  mobile_e164, full_name, language, consent_whatsapp, opened_by,
  current_step, current_channel, status, created_at, updated_at
)
select
  mobile_e164, full_name, language, consent_whatsapp, 'form',
  'channel', 'unset', 'awaiting_reply', submitted_at, submitted_at
from public.request_calls
on conflict (mobile_e164) do nothing;

insert into public.submissions (
  lead_id, full_name, mobile_e164, vehicle, language, consent_whatsapp, submitted_at
)
select
  l.id, r.full_name, r.mobile_e164, r.vehicle, r.language, r.consent_whatsapp, r.submitted_at
from public.request_calls r
join public.leads l on l.mobile_e164 = r.mobile_e164
where not exists (
  select 1 from public.submissions s where s.lead_id = l.id
);

insert into public.facts (lead_id, key, value, declined, step, channel, at)
select l.id, x.key, x.value, false, 'channel', 'form', r.submitted_at
from public.request_calls r
join public.leads l on l.mobile_e164 = r.mobile_e164
cross join lateral (values
  ('full_name', to_jsonb(r.full_name)),
  ('mobile_e164', to_jsonb(r.mobile_e164)),
  ('vehicle', to_jsonb(r.vehicle)),
  ('language', to_jsonb(r.language)),
  ('consent_whatsapp', to_jsonb(r.consent_whatsapp))
) as x(key, value)
on conflict (lead_id, key) do nothing;

insert into public.step_contexts (lead_id, step, status, facts_owned, narrative)
select l.id, 'channel', 'in_progress', array['preferred_channel']::text[],
  'Submitted the request-a-call form for ' || r.vehicle || '. Language ' || r.language || '.'
from public.request_calls r
join public.leads l on l.mobile_e164 = r.mobile_e164
on conflict (lead_id, step) do nothing;
