# Pivot Point Recovery — Public Website

The public website for [pivotpointrecovery.org](https://pivotpointrecovery.org).

Plain static HTML + CSS + vanilla JS for the pages, with a small set of Supabase
edge functions for the two things a static site cannot do by itself: accept form
submissions and take donations.

**This repo is self-contained.** It does not require the `nonprofitportal`
application to be running, deployed, or mounted on the same origin. The staff
portal, CRM, and accounting remain a separate product; the website no longer
depends on any of it at runtime.

## Pages

| Path | File | Notes |
| --- | --- | --- |
| `/` | `index.html` | Home |
| `/about` | `about.html` | Our Story — founder bio, board |
| `/services` | `services.html` | Programs and continuum of care |
| `/resources` | `resources.html` | Searchable local resource directory |
| `/get-involved` | `get-involved.html` | Ways to help |
| `/volunteer` | `volunteer.html` | Volunteer interest form |
| `/donate` | `donate.html` | Giving page → Stripe Checkout |
| `/thank-you` | `thank-you.html` | Post-donation landing (`noindex`) |
| `/contact` | `contact.html` | Contact form |
| `/privacy` | `privacy.html` | Privacy policy |
| `/terms` | `terms.html` | Terms of use, incl. donation + refund terms |
| — | `404.html` | Branded not-found page |

Shared assets: `styles.css`, `main.js`, `logo-color.svg`, `logo-white.svg`,
`favicon.svg`, `og-image.png`, `veteran.jpeg`.

The resource directory supports deep links to a category:
`/resources?tag=employment`. Tag names are the `data-tag` values in
`resources.html`.

## Design system

Defined as CSS custom properties at the top of `styles.css`.

- **Blue** `#005191` · **Navy** `#1a2b4a` · **Gold** `#ffb81c` (CTA accent)
- **Display font** Antonio (uppercase headings) · **Body font** Palanquin
- 1200px container, 12px radius

Reuse the existing classes rather than adding new ones where possible:
`page-hero`, `content-section`, `content-narrow`, `section-title`,
`section-label`, `involve-card`, `service-detail`, `split-section`,
`check-list`, `cta-banner`, `contact-form`, `form-group`,
`btn btn-primary|btn-blue|btn-outline|btn-ghost`.

There is no build step and no templating. Shared markup — nav, footer, meta
tags — is duplicated across pages by design; when you change it, change it
everywhere. `docs/DEPLOYMENT.md` describes the checks that catch a page you
missed.

## Backend

Three Supabase edge functions, with source in this repo under
`supabase/functions/`. Project ref `ydynhwrlpwvlhhohzfwl`.

| Function | Called by | Purpose |
| --- | --- | --- |
| `public-forms` | contact.html, volunteer.html | Validate, save, notify staff |
| `donate-checkout` | donate.html | Create a Stripe Checkout Session |
| `donate-webhook` | Stripe | Record the completed gift |

Schema lives in `supabase/migrations/`. The tables — `contact_submissions`,
`volunteer_interests`, `donations` — have RLS enabled with **no** public
policies; only the service role used by the edge functions can read or write
them. The migration is idempotent and safe to re-run against the live database.

### Forms

Both public forms POST to `public-forms` with a `form_type` discriminator:

```
https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/public-forms
```

| Form | `form_type` | Table |
| --- | --- | --- |
| Contact | `contact` | `contact_submissions` |
| Volunteer | `volunteer` | `volunteer_interests` |

Both include an off-screen honeypot (`_honeypot`); the function silently accepts
and drops any submission that fills it.

The save and the notification are independent. A submission is never lost
because email failed — the response reports `notified` so a silent mail failure
is visible instead of invisible. **`notified: false` means the row was saved but
nobody was told**, which is a configuration problem, not a code problem: see
Secrets below.

### Donations

`donate.html` collects the amount and donor details and POSTs to
`donate-checkout`, which returns `{ url }` for a redirect to Stripe Checkout.
Card data never touches this site.

The **webhook is the source of truth** for money. `donate-checkout` writes a
`pending` row before redirecting; `donate-webhook` verifies the Stripe signature
and promotes it to `completed`. Loading `/thank-you` records nothing — a donor
who closes the tab is still recorded, and anyone can navigate to that URL
without paying.

Amounts are validated server-side (min $1, max $50,000). The client's number is
a suggestion.

> **Previously:** the donate form posted to `/api/donations/checkout` on the
> portal. That route sits behind the portal's auth middleware and answers
> `307 → /login` for anonymous visitors, so every donation attempt failed with a
> generic error. Removing that dependency is why this backend exists.

## Secrets

Set on the Supabase project — never committed here.

| Secret | Used by | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | donate-checkout, donate-webhook | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | donate-webhook | `whsec_…` |
| `RESEND_API_KEY` | public-forms, donate-webhook | `re_…` |
| `NOTIFICATION_EMAILS` | public-forms, donate-webhook | comma-separated |
| `RESEND_FROM` | public-forms, donate-webhook | verified domain |
| `SITE_URL` | donate-checkout | defaults to the production URL |
| `ALLOWED_ORIGINS` | all | optional; defaults to production hosts |
| `NOTIFICATION_PREFIX` | public-forms, donate-webhook | optional subject tag |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

Each secret resolves through a small alias list (`STRIPE_SECRET_KEY`,
`PPR_STRIPE_SECRET_KEY`, `STRIPE_API_KEY`, …) so an existing name already set on
the project is picked up — see `supabase/functions/_shared/env.ts`.

Check what is actually configured without revealing any values:

```sh
curl -s 'https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/donate-checkout?health=1'
curl -s 'https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/public-forms?health=1'
curl -s 'https://ydynhwrlpwvlhhohzfwl.supabase.co/functions/v1/donate-webhook?health=1'
```

Each returns presence booleans and a `missing` list — never secret values.

## Local development

No build step. Serve the directory over HTTP so root-relative paths resolve:

```sh
python3 -m http.server 8080
```

Local pages are served as `/donate.html` rather than `/donate`; Cloudflare Pages
adds the clean URLs in production.

Forms and donations call the deployed Supabase functions, which allow
`localhost` as a CORS origin — so they work locally, against **live** data and
**live** Stripe keys. Use Stripe test mode if you are exercising checkout.

Run the backend tests (requires [Deno](https://deno.com)):

```sh
deno task test    # validation, amount clamping, CORS allowlist
deno task check   # typecheck all three functions
```

## Deployment

- **Site:** Cloudflare Pages, served from the repository root. `_headers` sets
  security and CSP; `_redirects` handles clean-URL canonicalisation. Extend the
  CSP in `_headers` if you add a new external asset host.
- **Backend:** `supabase functions deploy` — see `docs/DEPLOYMENT.md`.

Full runbook: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Post-deploy checks: [`docs/VERIFICATION.md`](docs/VERIFICATION.md).
What was built and why: [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).
