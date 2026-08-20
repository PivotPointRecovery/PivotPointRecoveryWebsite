# Migration runbook

Moving the public website to its own GitHub organisation and its own Supabase
project, fully separated from the `nonprofitportal` application.

Two independent moves. Do them in the order below — the repo move is cheap and
reversible, the database move is neither.

| | From | To |
| --- | --- | --- |
| Repo | `erica-83/PivotPointRecoveryWebsite` | `PivotPointRecovery/Website` |
| Supabase | `ydynhwrlpwvlhhohzfwl` (shared with the portal) | `ihgwhglatsbhngbsezuj` (own account, `us-west-2`) |

## Why the database is splitting

The portal holds 42 CFR Part 2 and HIPAA records. The public site's edge
function runs with a service-role key on an anonymous, internet-facing surface.
While both live in one Supabase project, a compromise of the public surface
reaches clinical data. A separate project holding only pre-intake enquiries
keeps that blast radius small.

The cost is real and worth stating: enquiries stop landing in the same database
the portal reads, so staff work them from email until a one-way sync exists.

---

## Step 0 — Merge PR #2 first

Do this **before** either move. [PR #2](https://github.com/erica-83/PivotPointRecoveryWebsite/pull/2)
brings the backend into this repo (`supabase/migrations/`,
`supabase/functions/`) and is what gets deployed to the new project. Migrating
first means migrating a repo that cannot yet stand up its own backend.

It also fixes two live regressions from moving to standalone Cloudflare Pages:

- `POST /api/donations/checkout` → **405**. The donate page is broken; that
  route used to reach the portal and no longer resolves.
- `/portal` serves the marketing homepage, so the footer "PPR Login" link
  loops back to the front page. PR #2's `_redirects` sends it to the portal's
  own hostname.

It needs a rebase onto current `main` — it fixes the same `/employment-resources`
dead link that has since been fixed and merged, so expect a conflict in
`services.html` and `resources.html`.

---

## Step 1 — Export the existing submissions

**Do this before touching anything.** The current database holds real contact
and volunteer enquiries from real people. They do not move themselves, and the
old project is shared with the portal, so it will not simply be handed over.

In the Supabase dashboard for `ydynhwrlpwvlhhohzfwl`, SQL editor:

```sql
select * from public.contact_submissions order by created_at;
select * from public.volunteer_interests order by created_at;
```

Download each result as CSV and keep it somewhere durable.

Expect a backlog nobody has seen: notification email has never been configured,
so every submission since launch saved silently without alerting staff.

---

## Step 2 — Move the repository

Use GitHub's **Transfer**, not a fresh push. Transfer preserves commit history,
issues, pull requests (including PR #2), and leaves redirects from the old URL
so existing clones and links keep working. Pushing a mirror to an empty repo
loses issues and PRs.

1. Create the `PivotPointRecovery` organisation if it does not exist.
2. In `erica-83/PivotPointRecoveryWebsite`: **Settings → General → Danger Zone
   → Transfer ownership** → new owner `PivotPointRecovery`.
3. Rename it to `Website`: **Settings → General → Repository name**.

### What does NOT come across

Transfer moves the repository, not its configuration. After it lands:

- **Actions secrets are not transferred.** Re-add `CLOUDFLARE_API_TOKEN` (and
  `CLOUDFLARE_ACCOUNT_ID`) under **Settings → Secrets and variables → Actions**,
  or `.github/workflows/cloudflare-deploy.yml` fails at the credential step.
- **Actions may be disabled by default** under the new organisation's policy —
  check **Settings → Actions → General**. This is also where to relax the
  approval requirement that has been gating every run.
- **Cloudflare Pages**: if the `pivotpointrecovery` Pages project is Git-connected
  to the old repository, reconnect it to the new one. If it is a direct-upload
  project driven by the workflow, nothing to do.
- **Claude Code's access** is scoped per repository. The new location has to be
  added to the session before it can be read or pushed to.

---

## Step 3 — Create the new Supabase project

1. Sign up / sign in under the new account, create an organisation.
2. **New project**. Region `us-east-1` (closest to Northern Virginia — this is
   the latency every form submission pays).
3. Save the database password somewhere durable; it is shown once.
4. Copy the **project ref** from **Settings → General** (the subdomain in
   `https://<ref>.supabase.co`).

Free tier allows two active projects per organisation, which is enough — but
note free projects **pause after a week of inactivity**. A public contact form
that only sees occasional traffic can be paused exactly when someone tries to
reach you. If that matters, budget for the paid tier.

---

## Step 4 — Stand up the backend in the new project

Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) with the **new** ref substituted
throughout:

```sh
supabase login
supabase link --project-ref <NEW_REF>
supabase db push                          # applies 0001_public_site_schema.sql
supabase functions deploy public-forms
supabase functions deploy donate-checkout
supabase functions deploy donate-webhook
```

Then the secrets. The name must match exactly — `RESEND_API_KEY2` is not
`RESEND_API_KEY`, and a mismatch is silent: the function saves the row and skips
the email, returning `notified: false`.

```sh
supabase secrets set \
  RESEND_API_KEY="re_..." \
  NOTIFICATION_EMAILS="steve@pivotpointrecovery.org,info@pivotpointrecovery.org" \
  RESEND_FROM="Pivot Point Recovery <info@pivotpointrecovery.org>" \
  NOTIFICATION_PREFIX="PPR" \
  SITE_URL="https://pivotpointrecovery.org"
```

`pivotpointrecovery.org` must be **verified in Resend** (SPF + DKIM records in
Cloudflare DNS). Sending from an unverified domain is the most common cause of
`notified: false` despite a valid key.

Stripe keys and the webhook are only needed once the donate page is live —
`DEPLOYMENT.md` step 4 covers them.

---

## Step 5 — Point the site at the new project

**Done.** The old ref was hardcoded in three places on `main`; all three now
point at `ihgwhglatsbhngbsezuj`:

```
contact.html      FORMS_ENDPOINT
volunteer.html    FORMS_ENDPOINT
README.md         endpoint + verification references
```

PR #2 adds `donate.html` to that list, so re-check after it merges. Residual
references (this runbook aside, where the old ref names the source project):

```sh
grep -rln ydynhwrlpwvlhhohzfwl . --include=*.html --include=*.md
```

`_headers` needed no change — its CSP allows `connect-src https://*.supabase.co`,
which covers any project ref.

**Still outstanding:** import the CSVs from step 1 into the new project's
tables, so the history of who has contacted you moves with the site.

---

## Step 6 — Verify before trusting it

```sh
# Every function reports configuration presence (booleans only, never values)
for fn in public-forms donate-checkout donate-webhook; do
  curl -s "https://<NEW_REF>.supabase.co/functions/v1/$fn?health=1"; echo
done

# A real submission. "notified" must come back true.
curl -s -X POST "https://<NEW_REF>.supabase.co/functions/v1/public-forms" \
  -H 'Content-Type: application/json' -H 'Origin: https://pivotpointrecovery.org' \
  -d '{"form_type":"contact","name":"Migration test","email":"you@example.com","message":"test"}'
```

`{"ok":true,"notified":true}` is the finish line. `notified:false` means the row
saved but nobody was emailed — the exact failure this migration exists to end.

**Status 2026-08-20.** Against `ihgwhglatsbhngbsezuj`: schema applied
(`contact_submissions`, `volunteer_interests`, `donations`), `public-forms`
deployed and `ACTIVE` with `verify_jwt` off, CORS returning the production
origin, and live `contact` + `volunteer` POSTs both saving rows. `?health=1`
reports `RESEND_API_KEY: true` and `NOTIFICATION_EMAILS: true`.

Submissions still return `notified:false`, and the function logs give the
reason — it is Resend, not the secrets:

```
resend_failed 403 validation_error
You can only send testing emails to your own email address
(erica@pivotpointrecovery.org). To send emails to other recipients, please
verify a domain at resend.com/domains, and change the `from` address to an
email using this domain.
```

So the warning in step 4 is the live blocker: `pivotpointrecovery.org` is not
yet verified in Resend, and with `RESEND_FROM` unset the sender falls back to
the shared `onboarding@resend.dev`, which Resend restricts to the account
owner's own address. Verify the domain, then set `RESEND_FROM` to an address on
it. `erica@pivotpointrecovery.org` is the only recipient that works until then.

`donate-checkout` and `donate-webhook` are not deployed yet; they arrive with
PR #2.

Then submit through the live site in a browser and confirm the mail arrives at
Steve's inbox, not just that the API says it did.

---

## Decommissioning the old project

Leave the old tables in place until the new setup has been receiving real mail
for a couple of weeks. They are shared with the portal, so **do not drop them** —
the portal may read them. Stopping the website from writing there is the
separation; deleting data is not required and is not reversible.
