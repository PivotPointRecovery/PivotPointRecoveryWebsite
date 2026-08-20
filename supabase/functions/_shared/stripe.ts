// Stripe REST client.
//
// Hand-rolled rather than pulling the SDK: the surface used here is four
// endpoints and a signature check, and a form-encoder is far cheaper than an
// SDK import on every cold start.
//
// API_VERSION is pinned deliberately, and it does more than freeze our request
// shape. Webhook payloads arrive in whatever version the *endpoint* is set to
// in the Stripe dashboard, which nobody in this repo controls -- and the fields
// that move between versions (an invoice's subscription and payment intent,
// most of all) are exactly the ones the webhook depends on. Because the webhook
// re-fetches every object through this client, it always reads the pinned
// shape, whatever version Stripe used to deliver the notification.

import { env } from './env.ts';

const API = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';

/**
 * Flattens a nested object into Stripe's bracket notation, e.g.
 * `line_items[0][price_data][unit_amount]=2500`. Empty and nullish values are
 * dropped so callers can pass `undefined` for conditional fields.
 */
export function formEncode(data: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    const path = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (item !== null && typeof item === 'object') {
          parts.push(...formEncode(item as Record<string, unknown>, itemPath));
        } else {
          parts.push(`${encodeURIComponent(itemPath)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === 'object') {
      parts.push(...formEncode(value as Record<string, unknown>, path));
    } else {
      parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts;
}

export interface StripeResult {
  ok: boolean;
  status: number;
  // deno-lint-ignore no-explicit-any
  data: any;
  error?: string;
}

export async function stripeRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<StripeResult> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey) {
    return { ok: false, status: 0, data: null, error: 'STRIPE_SECRET_KEY not set' };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': API_VERSION,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let url = `${API}${path}`;
  let encodedBody: string | undefined;

  if (body && method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    encodedBody = formEncode(body).join('&');
  } else if (body) {
    const qs = formEncode(body).join('&');
    if (qs) url += `?${qs}`;
  }

  try {
    const res = await fetch(url, { method, headers, body: encodedBody });
    const data = await res.json();

    if (!res.ok) {
      const message = data?.error?.message ?? `Stripe returned ${res.status}`;
      console.error('stripe_error', res.status, data?.error?.type ?? '', message);
      return { ok: false, status: res.status, data, error: message };
    }
    return { ok: true, status: res.status, data };
  } catch (error) {
    console.error('stripe_threw', error);
    return { ok: false, status: 0, data: null, error: 'Stripe request failed' };
  }
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * Rejects on a missing header, a missing v1 signature, a timestamp outside the
 * tolerance window (replay defence), or a mismatched HMAC.
 */
export async function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!rawBody || !header || !secret) return false;

  let timestamp = '';
  const signatures: string[] = [];

  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index < 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

/** Comparison whose duration does not depend on where the first mismatch is. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
