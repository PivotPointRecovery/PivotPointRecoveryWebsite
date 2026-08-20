-- Who gets notified, as data rather than as a secret.
--
-- Recipients used to live only in the NOTIFICATION_EMAILS secret. That made
-- adding a person a privileged dashboard operation followed by a redeploy, and
-- it is the reason nobody noticed for months that the list did not include the
-- one person asking where the emails were. A table can be read, audited, and
-- changed with a single insert.
--
-- The secret is not retired: notify.ts unions this table with it, so an empty
-- table changes nothing and there is no window where notifications stop.

create table if not exists public.notification_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  label      text,
  active     boolean not null default true,
  -- Separated because the audiences differ in practice: whoever works
  -- enquiries is not necessarily whoever reconciles gifts.
  receives_forms     boolean not null default true,
  receives_donations boolean not null default true,
  created_at timestamptz not null default now()
);

-- Case-insensitive, so Steve@ and steve@ cannot both be on the list and send
-- every notification twice.
create unique index if not exists notification_recipients_email_key
  on public.notification_recipients (lower(email));

create index if not exists notification_recipients_active_idx
  on public.notification_recipients (active)
  where active;

alter table public.notification_recipients enable row level security;
revoke all on public.notification_recipients from anon, authenticated;

comment on table public.notification_recipients is
  'Staff who receive form and donation notifications. Unioned with the NOTIFICATION_EMAILS secret, never replacing it.';
comment on column public.notification_recipients.active is
  'Set false to stop mailing someone without losing the record that they were on the list.';
