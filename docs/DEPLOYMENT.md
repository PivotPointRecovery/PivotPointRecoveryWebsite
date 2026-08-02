# Deployment Runbook

Two independent deploy targets: the static site (Cloudflare Pages) and the
backend (Supabase edge functions). Neither requires the `nonprofitportal`
application.

Supabase project ref: **`ydynhwrlpwvlhhohzfwl`**

---

## Prerequisites

```sh
npm install -g supabase        # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref ydynhwrlpwvlhhohzfwl
```

---

## 1. Secrets

Set these before deploying, or the functions will deploy successfully and then
fail at request time.

```sh
supabase secrets set \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  RESEND_API_KEY="re_..." \
  NOTIFICATION_EMAILS="steve@pivotpointrecovery.org,info@pivotpointrecovery.org" \
  RESEND_FROM="Pivot Point Recovery <info@pivotpointrecovery.org>" \
  NOTIFICATION_PREFIX="PPR" \
  SITE_URL="https://pivotpointrecovery.org"
```

`STRIPE_WEBHOOK_SECRET` does not exist until you create the webhook endpoint in
step 4 — set the others now and come back for it.

Do **not** set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`; the platform
injects them and rejects the `SUPABASE_` prefix.

If a secret is already set under a different name, the functions will still find
it — `supabase/functions/_shared/env.ts` resolves each through an alias list.
Confirm with the health endpoints in step 5 rather than guessing.

### Resend sending domain

`RESEND_FROM` must use a domain verified in Resend. Sending from an unverified
domain is the most common cause of `notified: false` with a valid API key.
Verify `pivotpointrecovery.org` in the Resend dashboard (DNS records for SPF and
DKIM) before expecting mail to arrive.

---

## 2. Database schema

```sh
supabase db push
```

Or paste `supabase/migrations/0001_public_site_schema.sql` into the SQL editor.

The migration is idempotent and additive — `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, no `DROP`. It is safe to run against the live
database, which already holds real contact and volunteer submissions.

Verify afterwards:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('contact_submissions','volunteer_interests','donations');

-- All three must report rowsecurity = true.
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('contact_submissions','volunteer_interests','donations');
```

---

## 3. Edge functions

```sh
supabase functions deploy public-forms
supabase functions deploy donate-checkout
supabase functions deploy donate-webhook
```

`supabase/config.toml` sets `verify_jwt = false` for all three. This is
required — they are called by anonymous browsers and by Stripe, neither of which
carries a Supabase token. If a deploy ignores the config, pass the flag
explicitly:

```sh
supabase functions deploy donate-webhook --no-verify-jwt
```

A 401 on an otherwise correct request is almost always this setting.

---

## 4. Stripe webhook

In the Stripe Dashboard → Developers → Webhooks → **Add endpoint**:

- **URL:** `https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/donate-webhook`
- **Events:**
  - `checkout.session.completed` — records the gift
  - `checkout.session.expired` — marks an abandoned checkout
  - `invoice.paid` — records monthly renewals

Copy the signing secret (`whsec_…`) and set it:

```sh
supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
supabase functions deploy donate-webhook   # redeploy to pick it up
```

Make sure the endpoint is created in the same mode (live or test) as the
`STRIPE_SECRET_KEY` you configured. A test-mode webhook secret paired with a
live key fails signature verification on every event.

---

## 5. Confirm configuration

```sh
for fn in public-forms donate-checkout donate-webhook; do
  echo "--- $fn"
  curl -s "https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/$fn?health=1"
  echo
done
```

Every response must show `"ok": true` with an empty `missing` array. These
report presence booleans only and never echo a secret value.

---

## 6. Static site

Cloudflare Pages, served from the repository root. No build command, no output
directory — it is the repo.

| Setting | Value |
| --- | --- |
| Build command | *(empty)* |
| Output directory | `/` |
| Root directory | `/` |

`_headers` and `_redirects` are picked up automatically from the root.

### One thing to remove

If the Pages project still forwards `/api/*` or `/portal/*` to the portal
Worker, those rules are now dead weight — the site makes no same-origin `/api`
calls. `_redirects` sends `/portal` to `https://portal.pivotpointrecovery.org`.
Point that at wherever the portal actually lives, or drop the rule if there is
no public login URL.

---

## Pre-deploy checks

```sh
deno task check    # typecheck the three edge functions
deno task test     # validation, amount clamping, CORS allowlist
```

Because there is no templating, shared markup can drift between pages. Quick
sanity sweep before shipping a nav or footer change:

```sh
grep -L 'href="/privacy"' *.html     # pages missing the footer legal links
grep -L 'og:image' *.html            # pages missing social meta (404 + thank-you are intentional)
grep -rn 'href="/api/' *.html        # must return nothing
```

---

## Rollback

- **Site:** redeploy the previous deployment from the Cloudflare Pages
  dashboard.
- **Functions:** `git checkout <previous-sha> -- supabase/functions` and
  redeploy.
- **Donate page only:** restoring the `CHECKOUT_ENDPOINT` constant in
  `donate.html` reverts to the old portal route — though that route returns
  `307 → /login`, so this is a rollback to a broken state, not a working one.
- **Schema:** the migration only adds. There is nothing to roll back, and
  dropping columns would destroy submissions.
