-- Public website schema: contact, volunteer, donations.
--
-- This runs against a LIVE database that already contains real submissions in
-- contact_submissions and volunteer_interests. Every statement is therefore
-- idempotent and additive -- IF NOT EXISTS throughout, no DROP, no column type
-- changes. Running it twice is a no-op; running it against the existing project
-- backfills only what is missing.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- contact ---

create table if not exists public.contact_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.contact_submissions
  add column if not exists name       text,
  add column if not exists email      text,
  add column if not exists phone      text,
  add column if not exists interest   text,
  add column if not exists message    text,
  add column if not exists source     text default 'website',
  add column if not exists status     text default 'new',
  add column if not exists notified   boolean default false,
  add column if not exists user_agent text;

create index if not exists contact_submissions_created_at_idx
  on public.contact_submissions (created_at desc);

-- -------------------------------------------------------------- volunteer ---

create table if not exists public.volunteer_interests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.volunteer_interests
  add column if not exists first_name   text,
  add column if not exists last_name    text,
  add column if not exists email        text,
  add column if not exists phone        text,
  add column if not exists city         text,
  add column if not exists interests    text[],
  add column if not exists availability text,
  add column if not exists experience   text,
  add column if not exists source       text default 'website',
  add column if not exists status       text default 'new',
  add column if not exists notified     boolean default false,
  add column if not exists user_agent   text;

create index if not exists volunteer_interests_created_at_idx
  on public.volunteer_interests (created_at desc);

-- -------------------------------------------------------------- donations ---

-- One row per checkout attempt. Inserted as 'pending' when the donor is sent to
-- Stripe, promoted to 'succeeded' by the webhook. Abandoned checkouts stay
-- pending on purpose: a donor who got as far as the payment page is worth
-- knowing about.
create table if not exists public.donations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.donations
  add column if not exists updated_at               timestamptz default now(),
  add column if not exists stripe_session_id        text,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_subscription_id   text,
  add column if not exists stripe_customer_id       text,
  add column if not exists donor_name               text,
  add column if not exists donor_email              text,
  add column if not exists amount_cents             integer,
  add column if not exists currency                 text default 'usd',
  add column if not exists is_recurring             boolean default false,
  add column if not exists frequency                text,
  add column if not exists fund_designation         text,
  add column if not exists employer_match           boolean default false,
  add column if not exists status                   text default 'pending',
  add column if not exists receipt_url              text,
  add column if not exists notified                 boolean default false,
  add column if not exists source                   text default 'website',
  add column if not exists metadata                 jsonb default '{}'::jsonb;

create index if not exists donations_created_at_idx
  on public.donations (created_at desc);

create index if not exists donations_status_idx
  on public.donations (status);

create index if not exists donations_donor_email_idx
  on public.donations (lower(donor_email));

-- -------------------------------------------------------------------- RLS ---

-- Enabled with no policies: PostgREST/anon clients get nothing. The edge
-- functions write with the service role, which bypasses RLS. These tables hold
-- donor contact details and volunteer PII -- they must never be reachable with
-- the publishable key.

alter table public.contact_submissions enable row level security;
alter table public.volunteer_interests enable row level security;
alter table public.donations           enable row level security;

revoke all on public.contact_submissions from anon, authenticated;
revoke all on public.volunteer_interests from anon, authenticated;
revoke all on public.donations           from anon, authenticated;

-- ------------------------------------------------------------- updated_at ---

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists donations_touch_updated_at on public.donations;
create trigger donations_touch_updated_at
  before update on public.donations
  for each row execute function public.touch_updated_at();
