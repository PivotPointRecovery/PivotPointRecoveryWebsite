-- Stripe lookup keys and the webhook's idempotency ledger.

-- The webhook matches an incoming session against the row checkout created, so
-- the session id has to be unique. Partial, because the row exists for a moment
-- before Stripe has issued a session id at all.
create unique index if not exists donations_stripe_session_id_key
  on public.donations (stripe_session_id)
  where stripe_session_id is not null;

create index if not exists donations_stripe_subscription_id_idx
  on public.donations (stripe_subscription_id)
  where stripe_subscription_id is not null;

create index if not exists donations_stripe_payment_intent_id_idx
  on public.donations (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- Stripe delivers each event at least once, and retries on any non-2xx. Writing
-- the event id first makes the primary key itself the replay guard: a duplicate
-- delivery collides here and never reaches a handler.
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'Processed Stripe webhook event IDs. Insert conflict = already handled.';

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;
