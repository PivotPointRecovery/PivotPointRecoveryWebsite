# Build Plan — Website Independence

**Goal:** `pivotpointrecovery.org` runs as a complete, self-contained public
website. No runtime dependency on the `nonprofitportal` application. Donations
and both public forms work end to end, owned by this repository.

Status legend: ✅ done · 🔨 in progress · ⬜ not started · 🔑 needs a secret or
dashboard action only the account owner can take.

---

## 1. Where the site actually stood

Findings from probing the live site and the deployed backend on 2026-08-02.

| Check | Result |
| --- | --- |
| `GET https://pivotpointrecovery.org` | `200` — static pages serve fine |
| `OPTIONS .../functions/v1/public-forms` | `204` — function is deployed and live |
| `POST /api/donations/checkout` | **`307 → /login`** |
| Notification emails | README records a live test returning `{"ok":true,"notified":false}` |

### The donate form is broken in production

`donate.html` posts to `/api/donations/checkout`, expecting `{ url }` back. That
route answers `307 Location: /login` — it sits behind the portal's auth
middleware. The browser follows the redirect, gets the login **HTML** page,
`res.json()` throws, and the donor sees *"Something went wrong. Please try
again."* Every time. No donation can complete through this site today.

This is also the site's **only** hard runtime dependency on the portal, so
fixing it and removing the dependency are the same task.

### The forms save but stay silent

Submissions reach `public-forms` and land in the database, but `notified:false`
means no email goes to staff. A volunteer signup that nobody is told about is
functionally a lost volunteer. The function source lives in the portal repo, so
this repo cannot fix, review, or redeploy the thing its own forms depend on.

### What "independent" has to mean

Not just "stop calling `/api`". The backend the public site relies on must be
**owned, versioned, and deployable from this repository**. Otherwise the site is
still coupled — just implicitly, which is worse, because the coupling is
invisible until it breaks.

---

## 2. What gets built

### Phase 1 — Own the backend ✅

Vendor the public-facing backend into this repo as source.

- ✅ `supabase/migrations/0001_public_site_schema.sql` — idempotent schema for
  `contact_submissions`, `volunteer_interests`, `donations`. Written with
  `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` throughout so it is
  safe to run against the existing project, which already has the first two
  tables populated. RLS on, no public policies — only the service role writes.
- ✅ `supabase/functions/_shared/` — CORS allowlist, env resolution, Resend
  notification helper, shared validation.
- ✅ `supabase/functions/public-forms/` — contact + volunteer. Wire-compatible
  with the payloads the current pages already send, so nothing regresses.
- ✅ `supabase/functions/donate-checkout/` — creates a Stripe Checkout Session
  and returns `{ url }`. **This replaces `/api/donations/checkout`.**
- ✅ `supabase/functions/donate-webhook/` — verifies the Stripe signature and
  records the completed gift. The webhook is the source of truth for money;
  the browser redirect is only a UI cue.
- ✅ `supabase/config.toml` — pins `verify_jwt = false` for all three public
  functions. Without this Supabase rejects anonymous browser calls with 401.

### Phase 2 — Cut the portal dependency ✅

- ✅ `donate.html` posts to `donate-checkout` instead of `/api/...`.
- ✅ Donation intent is captured server-side before redirect, so an abandoned
  checkout is still a known prospect rather than nothing.
- ✅ Footer "PPR Login" points at the portal's own URL (`PORTAL_URL`) rather
  than assuming a same-origin `/portal` mount. A link out is fine; a shared
  origin requirement is not.
- ✅ `_headers` CSP extended for Stripe.

### Phase 3 — Finish the site ✅

Gaps that keep it from being a complete site, independent of the portal work.

- ✅ `thank-you.html` — donation success landing. Nothing existed at the far
  side of a successful checkout.
- ✅ `404.html` — Cloudflare's default 404 is unbranded.
- ✅ `privacy.html` + `terms.html` — a 501(c)(3) taking online donations and
  collecting contact details needs both. Also expected by payment processors.
- ✅ `robots.txt`, `sitemap.xml`.
- ✅ Canonical URLs and Open Graph / Twitter card tags on every page. Shared
  links currently render with no title, image, or description.
- ✅ `_redirects` — `.html` → clean-URL canonicalization.

### Phase 4 — Verify 🔑

Requires secrets and dashboard access on the live project.

- 🔑 Set the secrets in §3 on Supabase project `ydynhwrlpwvlhhohzfwl`.
- 🔑 Deploy the three functions and apply the migration.
- 🔑 Register the Stripe webhook endpoint, capture its signing secret.
- ⬜ Run `docs/VERIFICATION.md` end to end — a real $1 test gift in live mode,
  refunded after, plus one contact and one volunteer submission that must
  return `notified:true`.

---

## 3. Secrets

Set on the Supabase project, not in this repo. Nothing here is committed.

| Secret | Needed by | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | donate-checkout, donate-webhook | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | donate-webhook | `whsec_…`, from the webhook endpoint |
| `RESEND_API_KEY` | public-forms, donate-webhook | `re_…` |
| `NOTIFICATION_EMAILS` | public-forms, donate-webhook | comma-separated |
| `RESEND_FROM` | public-forms, donate-webhook | must be a verified domain |
| `SITE_URL` | donate-checkout | `https://pivotpointrecovery.org` |
| `ALLOWED_ORIGINS` | all | optional; defaults to the production hosts |
| `NOTIFICATION_PREFIX` | public-forms, donate-webhook | optional subject tag |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do
not set them by hand.

Because the exact names already present on the project could not be inspected
from here, every function resolves each secret through a **short alias list**
(`STRIPE_SECRET_KEY`, `PPR_STRIPE_SECRET_KEY`, `STRIPE_API_KEY`, …). Whichever
name is set will be found. Each function also answers `GET ?health=1` with a
presence-only report — booleans, never values — so setup can be confirmed
without guessing:

```sh
curl -s 'https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/donate-checkout?health=1'
```

---

## 4. Deliberate design decisions

**The webhook is the source of truth, not the redirect.** A donor who closes the
tab after paying still gets recorded. A donor who hand-crafts a request to
`/thank-you` records nothing. Trusting the browser for payment state is how
charities end up with books that do not reconcile.

**Amounts are validated and clamped server-side** (min $1, max $50,000, integer
cents). The client sends an amount; the server decides what is chargeable.
Client-side validation is a courtesy to honest users, never a control.

**CORS is an explicit allowlist**, not `*`. The live function currently answers
`access-control-allow-origin: *`, which lets any site post to it.

**The schema migration is idempotent** because it must run against a live
database that already holds real submissions. It adds and never drops.

**No build step, still.** The site remains plain HTML/CSS/JS that opens in a
browser. That is a real asset for a small nonprofit and worth preserving —
nobody should need a toolchain to fix a typo.

---

## 5. Explicitly out of scope

- The portal keeps its own donation handling for staff-entered gifts. This plan
  does not touch it.
- No CRM sync. Submissions land in Supabase; whether the portal reads them is
  the portal's business and does not couple this site to it.
- No analytics vendor added — that is a privacy decision for the org, not a
  technical gap.

---

## 6. Rollback

Each phase is independently revertible. The riskiest change is the donate
endpoint swap; to undo it, restore the `CHECKOUT_ENDPOINT` constant in
`donate.html`. Nothing in this plan modifies portal code or drops data.
