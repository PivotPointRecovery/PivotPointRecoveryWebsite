# Pivot Point Recovery — Public Website

The public marketing site for [pivotpointrecovery.org](https://pivotpointrecovery.org).

Plain static HTML + CSS + a little vanilla JS. No build step, no framework, no
dependencies. Open a file in a browser and it works.

This repo is **only** the public website. The staff portal, CRM, accounting,
and donation processing live in the separate `nonprofitportal` application.

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
| `/contact` | `contact.html` | Contact form |

Shared assets: `styles.css`, `main.js`, `logo-color.svg`, `logo-white.svg`,
`favicon.svg`, `veteran.jpeg`.

## Design system

Defined as CSS custom properties at the top of `styles.css`.

- **Blue** `#005191` · **Navy** `#1a2b4a` · **Gold** `#ffb81c` (CTA accent)
- **Display font** Antonio (uppercase headings) · **Body font** Palanquin
- 1200px container, 12px radius

Reuse the existing classes rather than adding new ones where possible:
`page-hero`, `content-section`, `section-title`, `section-label`,
`involve-card`, `service-detail`, `split-section`, `check-list`, `cta-banner`,
`contact-form`, `form-group`, `btn btn-primary|btn-blue|btn-outline|btn-ghost`.

## Forms

Both public forms POST to the same Supabase edge function, which validates the
payload, writes it to the database with the service role, and emails staff via
Resend. The function answers preflight with an explicit origin allowlist —
`pivotpointrecovery.org`, `www.pivotpointrecovery.org`, any `*.pages.dev`
preview, and localhost — overridable with the `ALLOWED_ORIGINS` secret:

```
https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms
```

| Form | `form_type` | Table |
| --- | --- | --- |
| Contact | `contact` | `contact_submissions` |
| Volunteer | `volunteer` | `volunteer_interests` |

Both include an off-screen honeypot field (`_honeypot`); the function silently
accepts and drops any submission that fills it.

### Who receives the notification emails

Recipients are **not** configured in this repo. The edge function reads a
comma-separated `NOTIFICATION_EMAILS` secret, and sends through Resend:

```sh
supabase secrets set RESEND_API_KEY="re_..." \
  NOTIFICATION_EMAILS="steve@pivotpointrecovery.org,info@pivotpointrecovery.org" \
  RESEND_FROM="Pivot Point Recovery <info@pivotpointrecovery.org>" \
  NOTIFICATION_PREFIX="PPR"
```

If either `RESEND_API_KEY` or `NOTIFICATION_EMAILS` is unset, the submission is
still saved to the database but **no email goes out**. The function returns
`{ ok: true, notified: false }` and logs the reason.

> **Open issue — no verified Resend domain (verified 2026-08-20).** Live test
> submissions against project `ihgwhglatsbhngbsezuj` return
> `{"ok":true,"notified":false}`. Rows save correctly, CORS is fine, and
> `?health=1` now reports both `RESEND_API_KEY: true` and
> `NOTIFICATION_EMAILS: true` — the secrets are not the problem. Resend is
> rejecting the send outright:
>
> ```
> resend_failed 403 validation_error
> You can only send testing emails to your own email address
> (erica@pivotpointrecovery.org). To send emails to other recipients, please
> verify a domain at resend.com/domains, and change the `from` address to an
> email using this domain.
> ```
>
> `RESEND_FROM` is unset, so the sender falls back to Resend's shared
> `onboarding@resend.dev`. On that sandbox sender Resend delivers **only** to
> the account owner's own address, so mail to any other recipient —
> `steve@pivotpointrecovery.org` included — is refused with the 403 above.
>
> Two steps close it, neither of which lives in this repo:
>
> 1. Verify `pivotpointrecovery.org` at [resend.com/domains](https://resend.com/domains)
>    — add the SPF and DKIM records it gives you to Cloudflare DNS and wait for
>    it to report Verified.
> 2. Set `RESEND_FROM` to an address on that domain, e.g.
>    `Pivot Point Recovery <info@pivotpointrecovery.org>`. Leaving it unset
>    keeps the sandbox sender and the 403.
>
> Until then, the only recipient Resend will accept is
> `erica@pivotpointrecovery.org`. Setting `NOTIFICATION_EMAILS` to that address
> is a usable stopgap: staff get mail immediately, and it can be widened to
> Steve and `info@` once the domain verifies.

Verify with:

```sh
# Config presence (booleans only, never values)
curl -s "https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms?health=1"

# A real submission
curl -s -X POST https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms \
  -H 'Content-Type: application/json' -H 'Origin: https://pivotpointrecovery.org' \
  -d '{"form_type":"volunteer","first_name":"Test","last_name":"Test","email":"you@example.com","phone":"5555550100"}'
```

`notified` must come back `true`.

## Donations

`donate.html` collects the amount and donor details, then POSTs to the portal's
checkout API on the same origin:

```
POST /api/donations/checkout  →  { url }  →  redirect to Stripe Checkout
```

The API resolves the tenant from the request host server-side and never trusts
a tenant field in the body. Card data never touches this site.

**Deployment requirement:** `/api/*` and `/portal/*` must continue to route to
the portal application. If this static site is served as a Cloudflare Pages
project in front of the portal Worker, keep those prefixes falling through —
otherwise the donate form has no checkout endpoint.

## Local development

No build step. Serve the directory over HTTP so root-relative paths resolve:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Note that `/donate` submissions will fail locally — there's no `/api` backend
on the dev server. Test giving against a deployed preview.

## Deployment

Cloudflare Pages, served from the repository root. `_headers` sets the security
and CSP policy; extend the CSP there if you add a new external asset host.

> **Site is currently down — Cloudflare Error 1000 (verified 2026-08-20).**
> Every path on `pivotpointrecovery.org` returns HTTP 403 with Cloudflare's
> *"DNS points to prohibited IP"* interstitial. The zone is live on Cloudflare
> (`owen`/`carrera.ns.cloudflare.com`), but the root `A`/`AAAA` records in the
> Cloudflare DNS tab hold Cloudflare's own anycast addresses
> (`104.21.20.223`, `172.67.194.181`, `2606:4700:30xx::…`), which makes the
> proxy resolve to itself. No `*.pages.dev` hostname for this project resolves
> either, so there is no origin behind the domain right now.
>
> This is a dashboard fix, not a code fix — nothing in this repo can change it:
>
> 1. Deploy this repository as a Cloudflare Pages project (root directory, no
>    build command, no build output directory).
> 2. In **Pages → the project → Custom domains**, add `pivotpointrecovery.org`
>    and `www.pivotpointrecovery.org`. Let Pages create the records itself.
> 3. In **DNS → Records**, delete the leftover `A`/`AAAA` rows for `@` and
>    `www` that point at the Cloudflare IPs above. Those rows are what triggers
>    Error 1000; the Pages custom-domain record replaces them.
> 4. Re-check with `curl -I https://pivotpointrecovery.org/` — expect `200`.
>
> Keep `/api/*` and `/portal/*` routing to the portal application as described
> under [Donations](#donations), or the donate page loses its checkout endpoint.
