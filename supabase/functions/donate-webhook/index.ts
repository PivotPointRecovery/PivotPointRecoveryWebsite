// Stripe webhook -- the source of truth for completed donations.
//
// Why this exists rather than recording the gift on the /thank-you redirect:
// a donor who pays and immediately closes the tab never loads the success page,
// and anyone can navigate to /thank-you without paying a cent. Browser
// redirects are a UI cue. Only a signature-verified webhook is evidence that
// money moved.
//
// This function must NOT have CORS or JWT verification -- Stripe is not a
// browser and does not send an Origin header or a Supabase token.

import { serviceClient } from '../_shared/db.ts';
import { env, healthReport } from '../_shared/env.ts';
import { sendNotification } from '../_shared/notify.ts';

import Stripe from 'npm:stripe@18';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const OPTIONAL_SECRETS = ['RESEND_API_KEY', 'NOTIFICATION_EMAILS', 'RESEND_FROM'];

function money(cents: number | null | undefined): string {
  if (typeof cents !== 'number') return '';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return Response.json({
        service: 'donate-webhook',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
      });
    }
    return new Response('Method not allowed', { status: 405 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secretKey = env('STRIPE_SECRET_KEY');
  const webhookSecret = env('STRIPE_WEBHOOK_SECRET');
  if (!secretKey || !webhookSecret) {
    console.error('missing_stripe_secrets');
    return new Response('Webhook not configured', { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing stripe-signature', { status: 400 });

  const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' });
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    // constructEventAsync, not constructEvent: Deno's WebCrypto is async, and
    // the sync variant throws in this runtime.
    event = await stripe.webhooks.constructEventAsync(raw, signature, webhookSecret);
  } catch (error) {
    console.error('signature_verification_failed', error);
    return new Response('Invalid signature', { status: 400 });
  }

  const db = serviceClient();

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata ?? {};

      const amountCents = session.amount_total ?? null;
      const donorName = metadata.donor_name ?? session.customer_details?.name ?? '';
      const donorEmail = metadata.donor_email ?? session.customer_details?.email ?? '';
      const isRecurring = session.mode === 'subscription';

      const record = {
        stripe_session_id: session.id,
        stripe_payment_intent_id: typeof session.payment_intent === 'string'
          ? session.payment_intent
          : null,
        stripe_subscription_id: typeof session.subscription === 'string'
          ? session.subscription
          : null,
        stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
        donor_name: donorName,
        donor_email: donorEmail,
        amount_cents: amountCents,
        currency: session.currency ?? 'usd',
        is_recurring: isRecurring,
        frequency: isRecurring ? 'monthly' : 'one-time',
        fund_designation: metadata.fund_designation || null,
        employer_match: metadata.employer_match === 'true',
        status: 'completed',
        source: 'website',
      };

      // Upsert on the session id: donate-checkout already inserted a 'pending'
      // row, and Stripe retries webhooks. Either way we converge on one row.
      const { error } = await db
        .from('donations')
        .upsert(record, { onConflict: 'stripe_session_id' });

      if (error) {
        // Non-2xx makes Stripe retry, which is what we want if the write failed.
        console.error('donation_upsert_failed', error);
        return new Response('Database write failed', { status: 500 });
      }

      const result = await sendNotification(
        `New donation - ${money(amountCents)}${isRecurring ? ' / month' : ''}`,
        [
          ['Amount', `${money(amountCents)}${isRecurring ? ' per month' : ''}`],
          ['Donor', donorName],
          ['Email', donorEmail],
          ['Fund', metadata.fund_label || 'Where it is needed most'],
          ['Employer match', metadata.employer_match === 'true' ? 'Yes' : 'No'],
          ['Type', isRecurring ? 'Recurring (monthly)' : 'One-time'],
          ['Stripe session', session.id],
        ],
        { intro: `${donorName || 'A donor'} gave through the website.` },
      );

      if (result.notified) {
        await db.from('donations').update({ notified: true }).eq('stripe_session_id', session.id);
      } else {
        console.warn('donation_not_notified', result.reason);
      }
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object as Stripe.Checkout.Session;
      await db.from('donations')
        .update({ status: 'abandoned' })
        .eq('stripe_session_id', session.id)
        .eq('status', 'pending');
    } else if (event.type === 'invoice.paid') {
      // Renewal of a monthly gift. The first invoice arrives alongside
      // checkout.session.completed, which already recorded that one, so only
      // subsequent cycles are inserted here.
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.billing_reason === 'subscription_cycle') {
        // As of the 2025-08-27 API version the subscription reference moved off
        // Invoice and under parent.subscription_details.
        const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? null;
        const subscriptionId = typeof subscriptionRef === 'string'
          ? subscriptionRef
          : subscriptionRef?.id ?? null;
        await db.from('donations').insert({
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: typeof invoice.customer === 'string' ? invoice.customer : null,
          donor_name: invoice.customer_name ?? '',
          donor_email: invoice.customer_email ?? '',
          amount_cents: invoice.amount_paid,
          currency: invoice.currency ?? 'usd',
          is_recurring: true,
          frequency: 'monthly',
          status: 'completed',
          source: 'website',
          receipt_url: invoice.hosted_invoice_url ?? null,
          metadata: { billing_reason: invoice.billing_reason, invoice_id: invoice.id },
        });
      }
    } else {
      console.log('ignored_event', event.type);
    }
  } catch (error) {
    console.error('webhook_handler_failed', event.type, error);
    return new Response('Handler failed', { status: 500 });
  }

  return Response.json({ received: true });
});
