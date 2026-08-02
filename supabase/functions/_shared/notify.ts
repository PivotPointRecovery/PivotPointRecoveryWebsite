// Staff notification email via Resend.
//
// Design rule: a notification failure must never fail the request. The
// submission is already saved by the time we get here, and a donor or volunteer
// should not see an error because our mail provider had a bad minute. Failures
// are logged and reported back as `notified: false` -- which is exactly the
// signal that surfaced the original silent-forms problem.

import { env } from './env.ts';
import { escapeHtml } from './validate.ts';

export interface NotifyResult {
  notified: boolean;
  reason?: string;
}

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

export async function sendNotification(
  subject: string,
  rows: Array<[string, string]>,
  opts: { replyTo?: string; intro?: string } = {},
): Promise<NotifyResult> {
  const apiKey = env('RESEND_API_KEY');
  const to = recipients();

  if (!apiKey) return { notified: false, reason: 'RESEND_API_KEY not set' };
  if (to.length === 0) return { notified: false, reason: 'NOTIFICATION_EMAILS not set' };

  const from = env('RESEND_FROM', 'Pivot Point Recovery <onboarding@resend.dev>');
  const prefix = env('NOTIFICATION_PREFIX', 'PPR');

  const body = rows
    .filter(([, value]) => value)
    .map(([label, value]) =>
      `<tr>
         <td style="padding:8px 16px 8px 0;vertical-align:top;color:#1a2b4a;font-weight:600;white-space:nowrap">${escapeHtml(label)}</td>
         <td style="padding:8px 0;vertical-align:top;color:#333">${escapeHtml(value).replace(/\n/g, '<br>')}</td>
       </tr>`
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#005191;padding:20px 24px">
        <h1 style="margin:0;color:#fff;font-size:18px;letter-spacing:.02em">${escapeHtml(subject)}</h1>
      </div>
      <div style="padding:24px">
        ${opts.intro ? `<p style="margin:0 0 16px;color:#4a5568">${escapeHtml(opts.intro)}</p>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:14px">${body}</table>
      </div>
      <div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#718096;font-size:12px">
        Sent automatically from pivotpointrecovery.org
      </div>
    </div>
  </body></html>`;

  const payload: Record<string, unknown> = {
    from,
    to,
    subject: `[${prefix}] ${subject}`,
    html,
  };
  // Lets staff hit reply and reach the person who submitted the form.
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('resend_failed', res.status, detail);
      return { notified: false, reason: `Resend returned ${res.status}` };
    }
    return { notified: true };
  } catch (error) {
    console.error('resend_threw', error);
    return { notified: false, reason: 'Resend request failed' };
  }
}
