// Public contact + volunteer form handler.
//
// Wire-compatible with the payloads contact.html and volunteer.html already
// send. Saves with the service role, then notifies staff via Resend.
//
// The save and the notification are deliberately independent: a submission is
// never lost because email failed. The response reports `notified` so a silent
// mail failure is visible rather than invisible.

import { fail, json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/db.ts';
import { recipientCount, sendNotification } from '../_shared/notify.ts';
import { healthReport } from '../_shared/env.ts';
import { email as parseEmail, str, strList } from '../_shared/validate.ts';

const REQUIRED_SECRETS = ['RESEND_API_KEY'];
// NOTIFICATION_EMAILS is no longer required: recipients can come from the
// notification_recipients table instead. `recipients` in the health output is
// the number that actually matters -- if it is 0, nobody gets told.
const OPTIONAL_SECRETS = [
  'NOTIFICATION_EMAILS',
  'RESEND_FROM',
  'NOTIFICATION_PREFIX',
  'ALLOWED_ORIGINS',
];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return json(req, {
        service: 'public-forms',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
        // Count only, never the addresses.
        recipients: await recipientCount('forms'),
      });
    }
    return fail(req, 'Method not allowed', 405);
  }

  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(req, 'Invalid request body');
  }

  // Honeypot. Bots fill the off-screen field; humans never see it. Report
  // success and drop the submission so the bot has no signal to adapt to.
  if (str(payload._honeypot, 200)) {
    console.log('honeypot_triggered');
    return json(req, { ok: true, notified: false });
  }

  const formType = str(payload.form_type, 40);
  const userAgent = str(req.headers.get('user-agent') ?? '', 500);
  const db = serviceClient();

  if (formType === 'contact') {
    const name = str(payload.name, 200);
    const email = parseEmail(payload.email);
    if (!name) return fail(req, 'Please enter your name.');
    if (!email) return fail(req, 'Please enter a valid email address.');

    const record = {
      name,
      email,
      phone: str(payload.phone, 40),
      interest: str(payload.interest, 200),
      message: str(payload.message, 5000),
      source: 'website',
      user_agent: userAgent,
    };

    const { data, error } = await db
      .from('contact_submissions')
      .insert(record)
      .select('id')
      .single();

    if (error) {
      console.error('contact_insert_failed', error);
      return fail(req, 'We could not save your message. Please try again.', 500);
    }

    const result = await sendNotification(
      'New contact message',
      [
        ['Name', record.name],
        ['Email', record.email],
        ['Phone', record.phone],
        ['Interest', record.interest],
        ['Message', record.message],
      ],
      { replyTo: record.email, intro: `${record.name} sent a message through the website.` },
    );

    if (result.notified) {
      await db.from('contact_submissions').update({ notified: true }).eq('id', data.id);
    } else {
      console.warn('contact_not_notified', result.reason);
    }

    return json(req, { ok: true, notified: result.notified });
  }

  if (formType === 'volunteer') {
    const firstName = str(payload.first_name, 100);
    const lastName = str(payload.last_name, 100);
    const email = parseEmail(payload.email);
    if (!firstName) return fail(req, 'Please enter your first name.');
    if (!lastName) return fail(req, 'Please enter your last name.');
    if (!email) return fail(req, 'Please enter a valid email address.');

    const record = {
      first_name: firstName,
      last_name: lastName,
      email,
      phone: str(payload.phone, 40),
      city: str(payload.city, 120),
      interests: strList(payload.interests),
      availability: str(payload.availability, 200),
      experience: str(payload.experience, 5000),
      source: 'website',
      user_agent: userAgent,
    };

    const { data, error } = await db
      .from('volunteer_interests')
      .insert(record)
      .select('id')
      .single();

    if (error) {
      console.error('volunteer_insert_failed', error);
      return fail(req, 'We could not save your interest. Please try again.', 500);
    }

    const result = await sendNotification(
      'New volunteer interest',
      [
        ['Name', `${record.first_name} ${record.last_name}`],
        ['Email', record.email],
        ['Phone', record.phone],
        ['City', record.city],
        ['Interests', record.interests.join(', ')],
        ['Availability', record.availability],
        ['Experience', record.experience],
      ],
      { replyTo: record.email, intro: `${record.first_name} ${record.last_name} wants to volunteer.` },
    );

    if (result.notified) {
      await db.from('volunteer_interests').update({ notified: true }).eq('id', data.id);
    } else {
      console.warn('volunteer_not_notified', result.reason);
    }

    return json(req, { ok: true, notified: result.notified });
  }

  return fail(req, 'Unknown form type.');
});
