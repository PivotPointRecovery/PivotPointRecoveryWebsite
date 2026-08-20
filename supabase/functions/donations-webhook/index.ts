// Stripe webhook receiver.
//
// This is the only place a donation becomes `succeeded`. The browser never gets
// to assert that a payment worked -- a donor closing the tab on the Stripe page
// must not leave a gift unrecorded, and a donor replaying the success URL must
// not create one.
//
// verify_jwt is off because Stripe cannot present a Supabase JWT. Two things
// authenticate this endpoint instead:
//
//  1. The HMAC signature check, when STRIPE_WEBHOOK_SECRET is configured.
//  2. An authoritative re-fetch. Nothing from the request body is ever written
//     to the database. The body is read only for an object id; every field we
//     store comes back from a direct authenticated GET against Stripe. So the
//     worst a forged request can achieve is making us re-read a real object and
//     converge on the state Stripe already holds.
//
// That second layer is what lets the endpoint stay correct before the signing
// secret is in place. A webhook that rejected everything until then would lose
// the notification for real, already-charged donations -- a worse failure than
// re-reading an object an attacker named.

import { serviceClient } from '../_shared/db.ts';
import { env, hasEnv, healthReport } from '../_shared/env.ts';
import { stripeRequest, verifySignature } from '../_shared/stripe.ts';
import { recipientCount, sendDonorReceipt, sendNotification } from '../_shared/notify.ts';
import { money } from '../_shared/validate.ts';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const OPTIONAL_SECRETS = [
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'NOTIFICATION_EMAILS',
  'RESEND_FROM',
];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Obj = any;

/** A Stripe id we are willing to look up, by object kind. */
const ID_PREFIX: Record<string, string> = {
  session: 'cs_',
  invoice: 'in_',
  subscription: 'sub_',
};

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return reply({
        service: 'donations-webhook',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
        // How this request would be authenticated right now. `refetch_only`
        // still writes nothing it did not read back from Stripe, but signature
        // verification is the intended posture -- set STRIPE_WEBHOOK_SECRET.
        verification: hasEnv('STRIPE_WEBHOOK_SECRET') ? 'signature' : 'refetch_only',
        // Count only, never the addresses.
        recipients: await recipientCount('donations'),
      });
    }
    return reply({ error: 'Method not allowed' }, 405);
  }

  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  if (!hasEnv('STRIPE_SECRET_KEY')) {
    console.error('missing_stripe_secret_key');
    return reply({ error: 'Webhook not configured' }, 503);
  }

  // --- Authenticate ---------------------------------------------------------
  // Raw text, not req.json(): the signature covers the exact bytes sent.

  const rawBody = await req.text();
  const secret = env('STRIPE_WEBHOOK_SECRET');

  if (secret) {
    const signature = req.headers.get('stripe-signature') ?? '';
    if (!(await verifySignature(rawBody, signature, secret))) {
      console.warn('webhook_signature_invalid');
      return reply({ error: 'Invalid signature' }, 400);
    }
  } else {
    console.warn('webhook_unverified_refetch_only');
  }

  let event: Obj;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return reply({ error: 'Invalid payload' }, 400);
  }

  const type = typeof event?.type === 'string' ? event.type : '';
  const objectId = typeof event?.data?.object?.id === 'string' ? event.data.object.id : '';
  if (!type || !objectId) return reply({ error: 'Invalid payload' }, 400);

  // Route by object kind, not by the specific event name. The re-fetched object
  // says what actually happened; the event name is only a hint about where to
  // look, and in the unsigned case it is not even trustworthy as that.
  let kind: keyof typeof ID_PREFIX | null = null;
  if (type.startsWith('checkout.session.')) kind = 'session';
  else if (type.startsWith('invoice.')) kind = 'invoice';
  else if (type.startsWith('customer.subscription.')) kind = 'subscription';

  if (!kind) {
    console.log('webhook_ignored', type);
    return reply({ received: true, ignored: type });
  }
  if (!objectId.startsWith(ID_PREFIX[kind])) {
    console.warn('webhook_id_kind_mismatch', type, objectId.slice(0, 12));
    return reply({ error: 'Invalid payload' }, 400);
  }

  // --- Re-fetch the object --------------------------------------------------
  // Everything written below comes from this response, never from the request.

  const fetched = await refetch(kind, objectId);
  if (!fetched.ok) {
    // A 404 means the id does not exist on this account: forged, or from
    // another account's endpoint pointed here by mistake. Either way, nothing
    // is written -- which also keeps junk out of the idempotency ledger.
    const status = fetched.status === 404 ? 400 : 502;
    console.warn('webhook_refetch_failed', type, fetched.status, fetched.error);
    return reply({ error: 'Could not verify event against Stripe' }, status);
  }
  const object = fetched.data;

  const db = serviceClient();

  // --- Idempotency ----------------------------------------------------------
  // Stripe delivers at least once. The primary key conflict is the guard. This
  // runs after the re-fetch so only events tied to a real object get recorded.

  const eventId = typeof event.id === 'string' && event.id ? event.id : `${type}:${objectId}`;
  const { error: ledgerError } = await db
    .from('stripe_events')
    .insert({ id: eventId, type });

  if (ledgerError) {
    if (ledgerError.code === '23505') {
      console.log('webhook_duplicate', eventId, type);
      return reply({ received: true, duplicate: true });
    }
    // Ledger unavailable: 500 so Stripe retries rather than risk double-applying.
    console.error('webhook_ledger_failed', ledgerError);
    return reply({ error: 'Could not record event' }, 500);
  }

  try {
    if (kind === 'session') await handleSession(db, object);
    else if (kind === 'invoice') await handleInvoice(db, object);
    else await handleSubscription(db, object);
  } catch (error) {
    // Roll the ledger entry back so Stripe's retry is actually reprocessed.
    console.error('webhook_handler_threw', type, error);
    await db.from('stripe_events').delete().eq('id', eventId);
    return reply({ error: 'Handler failed' }, 500);
  }

  return reply({ received: true });
});

// --- Re-fetch ---------------------------------------------------------------

function refetch(kind: keyof typeof ID_PREFIX, id: string) {
  if (kind === 'session') {
    // latest_charge rides along so the donor's receipt link costs no extra call.
    return stripeRequest('GET', `/checkout/sessions/${id}`, {
      expand: ['payment_intent.latest_charge'],
    });
  }
  if (kind === 'invoice') return stripeRequest('GET', `/invoices/${id}`);
  return stripeRequest('GET', `/subscriptions/${id}`);
}

// --- Field extraction -------------------------------------------------------
//
// Stripe moves fields between API versions -- an invoice's subscription and
// payment intent both moved out from under `invoice` in later versions. Reads
// here are pinned by _shared/stripe.ts, so the flat form is what arrives; the
// nested fallbacks mean bumping that pin does not silently stop recording
// monthly renewals.

function id(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as Obj).id === 'string') {
    return (value as Obj).id;
  }
  return null;
}

function invoiceSubscriptionId(invoice: Obj): string | null {
  return id(invoice.subscription) ??
    id(invoice.parent?.subscription_details?.subscription) ??
    id(invoice.lines?.data?.[0]?.subscription) ??
    null;
}

function invoicePaymentIntentId(invoice: Obj): string | null {
  return id(invoice.payment_intent) ??
    id(invoice.payments?.data?.[0]?.payment?.payment_intent) ??
    null;
}

/** What Stripe says the money actually did. */
function sessionOutcome(session: Obj): 'succeeded' | 'processing' | 'failed' | 'expired' | 'open' {
  if (session.status === 'expired') return 'expired';

  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (paid) return 'succeeded';

  if (session.status !== 'complete') return 'open';

  // Completed but unpaid: a delayed method (ACH debit) is still clearing, or it
  // already bounced. The payment intent is the only thing that knows which.
  const intentStatus = typeof session.payment_intent === 'object'
    ? session.payment_intent?.status
    : null;
  if (intentStatus === 'succeeded') return 'succeeded';
  if (intentStatus === 'canceled' || intentStatus === 'requires_payment_method') return 'failed';
  return 'processing';
}

function sessionReceiptUrl(session: Obj): string | null {
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge = intent && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  return charge?.receipt_url ?? null;
}

// --- Handlers ---------------------------------------------------------------

async function handleSession(db: Db, session: Obj): Promise<void> {
  const outcome = sessionOutcome(session);
  if (outcome === 'open') {
    // Nothing has happened yet -- the donor is still on Stripe's page.
    console.log('session_still_open', session.id);
    return;
  }

  const status = outcome === 'succeeded' ? 'succeeded' : outcome;
  const donationId = session.client_reference_id ?? session.metadata?.donation_id ?? null;
  const paid = outcome === 'succeeded';

  const patch: Record<string, unknown> = {
    status,
    stripe_session_id: session.id,
    stripe_payment_intent_id: id(session.payment_intent),
    stripe_subscription_id: id(session.subscription),
    stripe_customer_id: id(session.customer),
    updated_at: new Date().toISOString(),
  };

  if (typeof session.amount_total === 'number' && session.amount_total > 0) {
    patch.amount_cents = session.amount_total;
  }
  if (session.customer_details?.email) patch.donor_email = session.customer_details.email;
  if (session.customer_details?.name) patch.donor_name = session.customer_details.name;
  if (paid) patch.receipt_url = sessionReceiptUrl(session);

  // Match the row the checkout function created. Falling back to the session id
  // covers a session created outside our flow (a payment link, say).
  const query = donationId
    ? db.from('donations').update(patch).eq('id', donationId)
    : db.from('donations').update(patch).eq('stripe_session_id', session.id);

  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;

  if (data) {
    if (paid) await acknowledge(db, data);
    return;
  }

  // Nothing matched -- record the gift rather than lose it. A gift Stripe took
  // that we have no row for is the one outcome with no acceptable excuse.
  const { data: inserted, error: insertError } = await db
    .from('donations')
    .insert({
      ...patch,
      donor_name: session.customer_details?.name ?? null,
      donor_email: session.customer_details?.email ?? null,
      amount_cents: session.amount_total ?? null,
      currency: session.currency ?? 'usd',
      is_recurring: Boolean(id(session.subscription)),
      frequency: id(session.subscription) ? 'monthly' : 'one-time',
      fund_designation: session.metadata?.fund_designation ?? 'general',
      employer_match: session.metadata?.employer_match === 'true',
      source: 'stripe',
      metadata: {
        reconstructed: true,
        fund_label: session.metadata?.fund_label ?? null,
      },
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  if (paid) await acknowledge(db, inserted);
}

async function handleInvoice(db: Db, invoice: Obj): Promise<void> {
  // The first invoice of a subscription is already covered by the checkout
  // session. Only later cycles create a new row.
  if (invoice.billing_reason !== 'subscription_cycle') {
    console.log('invoice_ignored', invoice.id, invoice.billing_reason);
    return;
  }
  if (invoice.status !== 'paid') {
    console.log('invoice_not_paid', invoice.id, invoice.status);
    return;
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.warn('invoice_without_subscription', invoice.id);
    return;
  }

  // Inherit donor details from the original gift in this subscription.
  const { data: original } = await db
    .from('donations')
    .select('donor_name, donor_email, fund_designation, employer_match, metadata')
    .eq('stripe_subscription_id', subscriptionId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: renewal, error } = await db
    .from('donations')
    .insert({
      donor_name: original?.donor_name ?? invoice.customer_name ?? null,
      donor_email: original?.donor_email ?? invoice.customer_email ?? null,
      amount_cents: invoice.amount_paid ?? null,
      currency: invoice.currency ?? 'usd',
      is_recurring: true,
      frequency: 'monthly',
      fund_designation: original?.fund_designation ?? 'general',
      employer_match: original?.employer_match ?? false,
      status: 'succeeded',
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: id(invoice.customer),
      stripe_payment_intent_id: invoicePaymentIntentId(invoice),
      receipt_url: invoice.hosted_invoice_url ?? null,
      source: 'website',
      metadata: { ...(original?.metadata ?? {}), renewal: true },
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) {
    // The unique index on stripe_invoice_id is the real exactly-once guard for
    // renewals: one invoice, one row, however many times Stripe delivers it.
    if (error.code === '23505') {
      console.log('renewal_already_recorded', invoice.id);
      return;
    }
    throw error;
  }

  await acknowledge(db, renewal, 'Monthly donation renewed');
}

/**
 * A cancelled subscription does not un-happen the gifts already given. Past rows
 * keep `status = 'succeeded'`; only the originating row is annotated, so a
 * lapsed monthly donor is visible without rewriting giving history.
 */
async function handleSubscription(db: Db, subscription: Obj): Promise<void> {
  if (subscription.status !== 'canceled') {
    console.log('subscription_ignored', subscription.id, subscription.status);
    return;
  }

  const { data: original, error: lookupError } = await db
    .from('donations')
    .select('id, metadata')
    .eq('stripe_subscription_id', subscription.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (!original) {
    console.log('subscription_cancelled_no_match', subscription.id);
    return;
  }

  const cancelledAt = subscription.canceled_at
    ? new Date(subscription.canceled_at * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await db
    .from('donations')
    .update({
      metadata: {
        ...(original.metadata ?? {}),
        subscription_status: 'cancelled',
        subscription_cancelled_at: cancelledAt,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', original.id);

  if (error) throw error;
}

/**
 * Tell the donor, then tell staff. Neither is ever allowed to fail the webhook:
 * the card is already charged, and a 500 here would only make Stripe redeliver
 * an event we have already applied.
 *
 * Each side has its own marker column, so a half-success retries only the half
 * that failed rather than double-sending the half that worked.
 */
async function acknowledge(db: Db, donation: Obj, subject?: string): Promise<void> {
  if (!donation) return;

  const label = donation.metadata?.fund_label ?? donation.fund_designation ?? 'General support';
  const amount = money(donation.amount_cents);

  if (!donation.receipt_sent_at && donation.donor_email) {
    const receipt = await sendDonorReceipt({
      donorName: donation.donor_name ?? '',
      donorEmail: donation.donor_email,
      amountCents: donation.amount_cents,
      isRecurring: Boolean(donation.is_recurring),
      fundLabel: label,
      receiptUrl: donation.receipt_url,
      date: (donation.created_at ?? new Date().toISOString()).slice(0, 10),
    });
    if (receipt.notified) {
      await db.from('donations')
        .update({ receipt_sent_at: new Date().toISOString() })
        .eq('id', donation.id);
    } else {
      console.warn('donor_receipt_not_sent', donation.id, receipt.reason);
    }
  }

  if (donation.notified) return;

  const heading = subject ??
    (donation.is_recurring ? 'New monthly donation' : 'New donation');

  const result = await sendNotification(
    `${heading} — ${amount}`,
    [
      ['Amount', donation.is_recurring ? `${amount} per month` : amount],
      ['Frequency', donation.is_recurring ? 'Monthly recurring' : 'One-time'],
      ['Donor', donation.donor_name ?? ''],
      ['Email', donation.donor_email ?? ''],
      ['Designation', label],
      ['Employer match', donation.employer_match ? 'Yes — donor will submit paperwork' : 'No'],
      ['Receipt', donation.receipt_url ?? ''],
    ],
    {
      replyTo: donation.donor_email ?? undefined,
      intro: `${donation.donor_name ?? 'A donor'} gave ${amount} through the website.`,
      // A gift, not an enquiry -- goes to whoever reconciles donations.
      audience: 'donations',
    },
  );

  if (result.notified) {
    await db.from('donations').update({ notified: true }).eq('id', donation.id);
  } else {
    console.warn('donation_not_notified', donation.id, result.reason);
  }
}
