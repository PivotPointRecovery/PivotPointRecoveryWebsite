# Verification

Run after deploying. Every step has an explicit pass condition — "the page
loaded" is not one of them.

Base URL: `https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1`

---

## 1. Configuration

```sh
for fn in public-forms donate-checkout donate-webhook; do
  echo "--- $fn"; curl -s "https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/$fn?health=1"; echo
done
```

**Pass:** each returns `"ok": true` and `"missing": []`.
**Fail:** anything in `missing` — set that secret and redeploy that function.

---

## 2. Contact form

```sh
curl -s -X POST https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/public-forms \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://pivotpointrecovery.org' \
  -d '{"form_type":"contact","name":"Deploy Test","email":"you@example.com","phone":"5555550100","interest":"general","message":"Verification test - please ignore."}'
```

**Pass:** `{"ok":true,"notified":true}` **and** the email actually arrives at
every address in `NOTIFICATION_EMAILS`.

`notified:false` means the row saved but no mail went out. Check, in order: is
`RESEND_API_KEY` set; is `NOTIFICATION_EMAILS` set; is the `RESEND_FROM` domain
verified in Resend. Then read the logs:

```sh
supabase functions logs public-forms
```

Look for `resend_failed` or `resend_threw`.

---

## 3. Volunteer form

```sh
curl -s -X POST https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/public-forms \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://pivotpointrecovery.org' \
  -d '{"form_type":"volunteer","first_name":"Deploy","last_name":"Test","email":"you@example.com","phone":"5555550100","city":"Fairfax","interests":["mentoring","events"],"availability":"weekends","experience":"Verification test - please ignore."}'
```

**Pass:** `{"ok":true,"notified":true}` and mail arrives.

---

## 4. Input handling

Each of these must be **rejected**, proving the server is not trusting the
browser.

```sh
POST() { curl -s -X POST "https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/$1" \
  -H 'Content-Type: application/json' -H 'Origin: https://pivotpointrecovery.org' -d "$2"; echo; }

# Amount below the $1 floor
POST donate-checkout '{"amount":0.5,"donor_name":"T","donor_email":"t@example.com"}'
# Negative amount
POST donate-checkout '{"amount":-100,"donor_name":"T","donor_email":"t@example.com"}'
# Above the $50,000 ceiling
POST donate-checkout '{"amount":99999,"donor_name":"T","donor_email":"t@example.com"}'
# Malformed email
POST donate-checkout '{"amount":25,"donor_name":"T","donor_email":"not-an-email"}'
# Unknown form type
POST public-forms '{"form_type":"nonsense","name":"T","email":"t@example.com"}'
```

**Pass:** every one returns `ok:false` with a readable message. None returns a
checkout URL.

Honeypot — must return `{"ok":true,"notified":false}` and write **no** row:

```sh
POST public-forms '{"form_type":"contact","name":"Bot","email":"bot@example.com","message":"x","_honeypot":"filled"}'
```

---

## 5. CORS

```sh
curl -s -i -X OPTIONS https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/public-forms \
  -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
```

**Pass:** no `access-control-allow-origin` header. Repeating with
`-H 'Origin: https://pivotpointrecovery.org'` **must** echo that origin back.

A response of `access-control-allow-origin: *` means an older build is still
deployed.

---

## 6. Donation, end to end

The only test that proves the money path works. Do it in **live mode** with a
real card, then refund — Stripe test cards do not exercise live keys, live
webhooks, or live payout config.

1. Open `https://pivotpointrecovery.org/donate`.
2. Choose **$1** (custom amount), fill in your name and a real email, pick a
   fund, submit.
3. **Pass:** you land on Stripe Checkout — not an error toast. An error here
   means `donate-checkout` is unreachable or misconfigured.
4. Complete the payment with a real card.
5. **Pass:** you land on `/thank-you` and Stripe emails you a receipt.
6. **Pass:** staff notification email arrives.
7. Check the database:

```sql
select stripe_session_id, donor_email, amount_cents, status, notified, created_at
  from donations order by created_at desc limit 5;
```

**Pass:** exactly **one** row for your gift, `status = 'completed'`,
`amount_cents = 100`, `notified = true`. Two rows means the upsert conflict
target is wrong; `status = 'pending'` means the webhook never fired or failed
signature verification — check Stripe Dashboard → Webhooks → the endpoint's
recent deliveries for the response code.

8. Refund the $1 in the Stripe Dashboard.

### Cancelled checkout

Start a donation, then hit back from Stripe.

**Pass:** you return to `/donate` and see "Checkout canceled — you have not been
charged." The row stays `pending`, which is intended: it records that someone
got as far as the payment page.

### Monthly gift

Repeat with **Monthly** selected. **Pass:** Stripe shows a recurring
subscription, and the row has `is_recurring = true` and a
`stripe_subscription_id`. Cancel the subscription afterwards.

---

## 7. The portal dependency is gone

```sh
grep -rn 'href="/api/\|/api/donations' *.html
```

**Pass:** no matches.

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://pivotpointrecovery.org/donate
```

**Pass:** `200`. The donate page must not need `/api/*` to route anywhere.

---

## 8. Site checks

```sh
curl -s -o /dev/null -w 'privacy   %{http_code}\n' https://pivotpointrecovery.org/privacy
curl -s -o /dev/null -w 'terms     %{http_code}\n' https://pivotpointrecovery.org/terms
curl -s -o /dev/null -w 'thanks    %{http_code}\n' https://pivotpointrecovery.org/thank-you
curl -s -o /dev/null -w 'robots    %{http_code}\n' https://pivotpointrecovery.org/robots.txt
curl -s -o /dev/null -w 'sitemap   %{http_code}\n' https://pivotpointrecovery.org/sitemap.xml
curl -s -o /dev/null -w 'og-image  %{http_code}\n' https://pivotpointrecovery.org/og-image.png
curl -s -o /dev/null -w '404 page  %{http_code}\n' https://pivotpointrecovery.org/definitely-not-a-page
```

**Pass:** `200` for everything except the last, which must be `404` and render
the branded page.

Deep link — `https://pivotpointrecovery.org/resources?tag=employment` must load
with the **Employment** tag active and a filtered list.

CSP — open any page with DevTools console open. **Pass:** no Content Security
Policy violations. If you added an external asset host, add it to `_headers`.

Social preview — paste `https://pivotpointrecovery.org` into Slack, iMessage, or
the LinkedIn Post Inspector. **Pass:** the branded card renders with a title and
description.

---

## Rollback triggers

Roll back if any of these hold after deploying:

- Donations reach Stripe but no `completed` row appears — money is moving
  unrecorded, which is the worst possible state. Fix the webhook before
  accepting further gifts.
- `public-forms` returns 5xx — submissions are being lost outright.
- CORS echoes an arbitrary origin.

`notified:false` alone is **not** a rollback trigger: submissions are still
being saved. It is a configuration fix, done without redeploying the site.
