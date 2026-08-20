-- Donor receipts, and an exactly-once key for monthly renewals.

-- Renewal invoices are the one donation event with no checkout session behind
-- them, so they had no unique key and a redelivered `invoice.paid` could book
-- the same monthly gift twice. The invoice id is the natural business key: one
-- invoice, one row, however many times Stripe delivers it.
alter table public.donations
  add column if not exists stripe_invoice_id text;

create unique index if not exists donations_stripe_invoice_id_key
  on public.donations (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- Tracked separately from `notified` (which means "staff were told") so that a
-- run where the donor's receipt sends but the staff notification fails retries
-- only the half that failed, instead of emailing the donor twice.
alter table public.donations
  add column if not exists receipt_sent_at timestamptz;

comment on column public.donations.receipt_sent_at is
  'When the donor was emailed their 501(c)(3) acknowledgement. Null = not yet sent.';
comment on column public.donations.notified is
  'Whether staff were emailed about this gift.';
