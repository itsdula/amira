create table public.request_calls (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  mobile_e164 text not null,
  vehicle text not null,
  language text not null check (language in ('en', 'ar')),
  consent_whatsapp boolean not null,
  submitted_at timestamptz not null default timezone('utc', now()),
  constraint request_calls_mobile_e164_key unique (mobile_e164)
);

create index request_calls_submitted_at_idx on public.request_calls (submitted_at desc);

alter table public.request_calls enable row level security;

revoke all on public.request_calls from anon, authenticated;

comment on table public.request_calls is
  'Form-trigger leads. Written only by the request-call Edge Function (service role).';
