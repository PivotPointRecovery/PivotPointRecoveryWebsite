// deno-fmt-ignore-file
//
// Outbound email via Resend. Two kinds, with two different rules.
//
// Staff notifications: a notification failure must never fail the request. The
// submission or the gift is already recorded by the time we get here, and a
// volunteer should not see an error because our mail provider had a bad minute.
// Failures are logged and reported back as `notified: false`.
//
// Donor receipts: same rule, stronger reason. The card is already charged. An
// email problem cannot be allowed to turn a completed donation into an error.

import { env, envDisabled } from './env.ts';
import { escapeHtml, money } from './validate.ts';

export interface NotifyResult {
  notified: boolean;
  reason?: string;
}

// The organisation's own details, used in the donor's tax acknowledgement.
const ORG_NAME = 'Pivot Point Recovery, Inc.';
const ORG_EIN = '41-4331928';
const SITE = 'pivotpointrecovery.org';

const BRAND_BLUE = '#005191';
const NAVY = '#1a2b4a';

function recipients(): string[] {
  return env('NOTIFICATION_EMAILS')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
}

/** Presence check used by the ?health=1 endpoints. */
export function notifyConfigured(): boolean {
  return Boolean(env('RESEND_API_KEY')) && recipients().length > 0;
}

function sender(): string {
  return env('RESEND_FROM', 'Pivot Point Recovery <onboarding@resend.dev>');
}

/** One shared shell so staff mail and donor mail look like the same org. */
function wrap(heading: string, inner: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:${BRAND_BLUE};padding:20px 24px">
        <h1 style="margin:0;color:#fff;font-size:18px;letter-spacing:.02em">${escapeHtml(heading)}</h1>
      </div>
      <div style="padding:24px">${inner}</div>
      <div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#718096;font-size:12px">
        ${footer}
      </div>
    </div>
  </body></html>`;
}

function rowsToTable(rows: Array<[string, string]>): string {
  const body = rows
    .filter(([, value]) => value)
    .map(([label, value]) =>
      `<tr>
         <td style="padding:8px 16px 8px 0;vertical-align:top;color:${NAVY};font-weight:600;white-space:nowrap">${escapeHtml(label)}</td>
         <td style="padding:8px 0;vertical-align:top;color:#333">${escapeHtml(value).replace(/\n/g, '<br>')}</td>
       </tr>`
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${body}</table>`;
}

/** POST to Resend. Never throws -- every failure comes back as a NotifyResult. */
async function send(payload: Record<string, unknown>, label: string): Promise<NotifyResult> {
  const apiKey = env('RESEND_API_KEY');
  if (!apiKey) return { notified: false, reason: 'RESEND_API_KEY not set' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      // The body carries Resend's actual reason -- an unverified sending domain
      // being the one that has bitten this project before. Log it in full;
      // "Resend returned 403" on its own sends you looking in the wrong place.
      const detail = await res.text();
      console.error(`${label}_failed`, res.status, detail);
      return { notified: false, reason: `Resend returned ${res.status}` };
    }
    return { notified: true };
  } catch (error) {
    console.error(`${label}_threw`, error);
    return { notified: false, reason: 'Resend request failed' };
  }
}

/** Staff notification: a form submission or an incoming gift. */
export async function sendNotification(
  subject: string,
  rows: Array<[string, string]>,
  opts: { replyTo?: string; intro?: string } = {},
): Promise<NotifyResult> {
  const to = recipients();
  if (to.length === 0) return { notified: false, reason: 'NOTIFICATION_EMAILS not set' };

  const prefix = env('NOTIFICATION_PREFIX', 'PPR');
  const inner = `${
    opts.intro ? `<p style="margin:0 0 16px;color:#4a5568">${escapeHtml(opts.intro)}</p>` : ''
  }${rowsToTable(rows)}`;

  const payload: Record<string, unknown> = {
    from: sender(),
    to,
    subject: `[${prefix}] ${subject}`,
    html: wrap(subject, inner, `Sent automatically from ${SITE}`),
  };
  // Lets staff hit reply and reach the person who submitted the form.
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  return await send(payload, 'resend');
}

export interface DonorReceipt {
  donorName: string;
  donorEmail: string;
  amountCents: number | null;
  isRecurring: boolean;
  fundLabel: string;
  receiptUrl?: string | null;
  /** ISO date the gift was received. Defaults to today. */
  date?: string;
}

/**
 * Donor acknowledgement -- and, for a 501(c)(3), the donor's written
 * substantiation. The IRS wants the amount, the date, the organisation, and a
 * statement that nothing was given in return; a $250+ gift is not deductible
 * without it. Stripe's own card receipt does not say any of that, which is why
 * this exists rather than leaning on Stripe's email.
 *
 * Set DONOR_RECEIPTS=0 to suppress these without touching code.
 */
export async function sendDonorReceipt(gift: DonorReceipt): Promise<NotifyResult> {
  if (envDisabled('DONOR_RECEIPTS')) return { notified: false, reason: 'DONOR_RECEIPTS disabled' };
  if (!gift.donorEmail) return { notified: false, reason: 'no donor email' };

  const amount = money(gift.amountCents);
  const when = gift.date ?? new Date().toISOString().slice(0, 10);
  const recurring = gift.isRecurring;

  const rows: Array<[string, string]> = [
    ['Amount', recurring ? `${amount} per month` : amount],
    ['Date', when],
    ['Designation', gift.fundLabel || 'Where it is needed most'],
    ['Type', recurring ? 'Recurring monthly gift' : 'One-time gift'],
  ];

  const greeting = gift.donorName ? `Dear ${gift.donorName},` : 'Dear friend,';

  const inner = `
    <p style="margin:0 0 16px;color:#4a5568">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;color:#4a5568">
      Thank you for your gift to ${escapeHtml(ORG_NAME)}. Our services are free to the people
      who need them, and gifts like yours are what makes that possible.
    </p>
    ${rowsToTable(rows)}
    ${
    recurring
      ? `<p style="margin:16px 0 0;color:#4a5568;font-size:14px">
           This gift will repeat monthly until you tell us to stop. Reply to this email any
           time to change or cancel it.
         </p>`
      : ''
  }
    ${
    gift.receiptUrl
      ? `<p style="margin:16px 0 0;font-size:14px">
           <a href="${escapeHtml(gift.receiptUrl)}" style="color:${BRAND_BLUE}">View your payment receipt</a>
         </p>`
      : ''
  }
    <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;color:#4a5568;font-size:13px">
      ${escapeHtml(ORG_NAME)} is a registered 501(c)(3) nonprofit organization, EIN ${ORG_EIN}.
      No goods or services were provided in exchange for this contribution, which is
      tax-deductible to the extent allowed by law. Please keep this email as your receipt.
    </p>`;

  const payload: Record<string, unknown> = {
    from: sender(),
    to: [gift.donorEmail],
    subject: recurring
      ? `Thank you for your monthly gift to Pivot Point Recovery`
      : `Thank you for your gift to Pivot Point Recovery`,
    html: wrap('Thank you for your gift', inner, `${ORG_NAME} &middot; EIN ${ORG_EIN} &middot; ${SITE}`),
  };
  // A donor replying to their receipt should reach a human, not the void.
  const staff = recipients();
  if (staff.length > 0) payload.reply_to = staff[0];

  return await send(payload, 'resend_receipt');
}
