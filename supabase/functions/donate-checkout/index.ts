// Stripe Checkout session creator.
//
// This replaces the portal's /api/donations/checkout, which answers
// `307 -> /login` for anonymous visitors and so has never been able to process
// a public donation. With this function the website owns its own giving path
// and no longer needs the portal to be mounted on the same origin.
//
// Card data never touches our infrastructure -- we hand the donor to Stripe and
// they come back with a session id.

import { fail, json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/db.ts';
import { env, healthReport } from '../_shared/env.ts';
import {
  amountToCents,
  bool,
  email as parseEmail,
  MAX_DONATION_CENTS,
  MIN_DONATION_CENTS,
  str,
} from '../_shared/validate.ts';

import Stripe from 'npm:stripe@18';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const OPTIONAL_SECRETS = ['SITE_URL', 'ALLOWED_ORIGINS'];

const FUND_LABELS: Record<string, string> = {
  'peer-support': 'Peer Recovery Support',
  'reentry': 'Reentry & Reintegration',
  'veteran-mentorship': 'Veteran Mentorship',
  'family-community': 'Family & Community',
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return json(req, { service: 'donate-checkout', ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS) });
    }
    return fail(req, 'Method not allowed', 405);
  }

  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);

  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey) {
    console.error('missing_stripe_secret_key');
    return fail(req, 'Giving is temporarily unavailable. Please try again later.', 503);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(req, 'Invalid request body');
  }

  // Honeypot -- return a benign error rather than a checkout URL.
  if (str(payload._honeypot, 200)) {
    console.log('honeypot_triggered');
    return fail(req, 'Unable to process this request.');
  }

  // Server-side amount authority. The client's number is a suggestion.
  const amountCents = amountToCents(payload.amount);
  if (amountCents === null) {
    return fail(
      req,
      `Please enter an amount between $${MIN_DONATION_CENTS / 100} and $${(MAX_DONATION_CENTS / 100).toLocaleString('en-US')}.`,
    );
  }

  const donorName = str(payload.donor_name, 200);
  const donorEmail = parseEmail(payload.donor_email);
  if (!donorName) return fail(req, 'Please enter your name.');
  if (!donorEmail) return fail(req, 'Please enter a valid email address.');

  const isRecurring = bool(payload.is_recurring);
  const employerMatch = bool(payload.employer_match);
  const fundKey = str(payload.fund_designation, 60);
  const fundLabel = FUND_LABELS[fundKey] ?? '';

  const siteUrl = env('SITE_URL', 'https://pivotpointrecovery.org').replace(/\/$/, '');
  const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' });

  const productName = isRecurring ? 'Monthly Donation' : 'One-Time Donation';
  const description = fundLabel
    ? `Pivot Point Recovery - ${fundLabel}`
    : 'Pivot Point Recovery - Where it is needed most';

  // Carried through Stripe and read back by the webhook, so the recorded gift
  // keeps its designation even though Stripe has no concept of our funds.
  const metadata: Record<string, string> = {
    donor_name: donorName,
    donor_email: donorEmail,
    fund_designation: fundKey,
    fund_label: fundLabel,
    employer_match: String(employerMatch),
    is_recurring: String(isRecurring),
    source: 'website',
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: isRecurring ? 'subscription' : 'payment',
      customer_email: donorEmail,
      client_reference_id: crypto.randomUUID(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: productName, description },
          ...(isRecurring ? { recurring: { interval: 'month' as const } } : {}),
        },
      }],
      metadata,
      // Subscriptions carry metadata on the subscription, not the payment
      // intent, so it has to be attached in mode-specific fashion.
      ...(isRecurring
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata, description } }),
      success_url: `${siteUrl}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/donate?canceled=1`,
      billing_address_collection: 'auto',
      allow_promotion_codes: false,
      submit_type: 'donate',
    });

    if (!session.url) {
      console.error('stripe_session_missing_url', session.id);
      return fail(req, 'Could not start checkout. Please try again.', 502);
    }

    // Record the intent before redirecting. A donor who abandons checkout is
    // still a known prospect; the webhook promotes this row to 'completed'.
    // A failure here must not block the donation -- Stripe is already ready.
    const { error } = await serviceClient().from('donations').insert({
      stripe_session_id: session.id,
      donor_name: donorName,
      donor_email: donorEmail,
      amount_cents: amountCents,
      currency: 'usd',
      is_recurring: isRecurring,
      frequency: isRecurring ? 'monthly' : 'one-time',
      fund_designation: fundKey || null,
      employer_match: employerMatch,
      status: 'pending',
      source: 'website',
      metadata: { fund_label: fundLabel },
    });
    if (error) console.error('donation_intent_insert_failed', error);

    return json(req, { ok: true, url: session.url, id: session.id });
  } catch (error) {
    console.error('stripe_checkout_failed', error);
    return fail(req, 'Could not start checkout. Please try again.', 502);
  }
});
