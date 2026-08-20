#!/usr/bin/env bash
#
# Shared Cloudflare API auth for the GitHub Actions workflows.
#
# Repositories name their Cloudflare secrets inconsistently, and Cloudflare
# supports two different auth schemes that need different headers:
#
#   * API token  ->  Authorization: Bearer <token>          (modern, scoped)
#   * Global key ->  X-Auth-Email + X-Auth-Key              (legacy, account-wide)
#
# Rather than hardcode one secret name and one scheme, cf_resolve_auth probes
# every candidate it was given and keeps the first that Cloudflare actually
# accepts. Downstream steps then just call cf_api and do not care which won.
#
# Usage in a workflow step:
#   source scripts/cf-api.sh
#   cf_resolve_auth            # first step only; persists choice to GITHUB_ENV
#   cf_api "https://api.cloudflare.com/client/v4/zones"

# Candidate secret names, most specific first. Add to this list rather than
# renaming secrets in the Cloudflare/GitHub UI.
CF_TOKEN_CANDIDATES=(
  CLOUDFLARE_ACCESS_TOKEN
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_TOKEN
  CF_API_TOKEN
  CF_TOKEN
  CLOUDFLARE_API_KEY
)

# Issue an authenticated Cloudflare API request using whichever scheme
# cf_resolve_auth settled on. All arguments are passed through to curl.
cf_api() {
  if [ -n "${CF_BEARER:-}" ]; then
    curl -sS -H "Authorization: Bearer $CF_BEARER" -H 'Content-Type: application/json' "$@"
  elif [ -n "${CF_EMAIL:-}" ] && [ -n "${CF_KEY:-}" ]; then
    curl -sS -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY" -H 'Content-Type: application/json' "$@"
  else
    echo "cf_api called before cf_resolve_auth succeeded" >&2
    return 1
  fi
}

# Probe each candidate secret and keep the first Cloudflare accepts.
# Exports CF_BEARER (or CF_EMAIL/CF_KEY) and CF_ACCOUNT_ID via GITHUB_ENV.
cf_resolve_auth() {
  local name val code winner="" scheme=""

  echo "Probing Cloudflare credentials (values are masked; only names are printed)..."

  # --- Scheme 1: API token via Bearer -------------------------------------
  for name in "${CF_TOKEN_CANDIDATES[@]}"; do
    val="${!name:-}"
    [ -n "$val" ] || continue
    echo "::add-mask::$val"
    code=$(curl -sS -o /tmp/cf_verify.json -w '%{http_code}' \
      -H "Authorization: Bearer $val" \
      "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null || echo 000)
    if [ "$code" = "200" ] && [ "$(jq -r '.success' /tmp/cf_verify.json 2>/dev/null)" = "true" ]; then
      echo "  $name: valid API token"
      winner="$val"; scheme="bearer"
      echo "  using secret: $name (Bearer)"
      break
    fi
    echo "  $name: rejected as an API token (HTTP $code)"
  done

  # --- Scheme 2: legacy global key, needs an account email ----------------
  if [ -z "$winner" ]; then
    local email="${CLOUDFLARE_EMAIL:-${CF_EMAIL_SECRET:-}}"
    for name in CLOUDFLARE_API_KEY CLOUDFLARE_GLOBAL_API_KEY CF_API_KEY; do
      val="${!name:-}"
      [ -n "$val" ] || continue
      [ -n "$email" ] || continue
      echo "::add-mask::$val"
      code=$(curl -sS -o /tmp/cf_verify.json -w '%{http_code}' \
        -H "X-Auth-Email: $email" -H "X-Auth-Key: $val" \
        "https://api.cloudflare.com/client/v4/user" 2>/dev/null || echo 000)
      if [ "$code" = "200" ]; then
        echo "  $name: valid global API key"
        winner="$val"; scheme="globalkey"
        break
      fi
      echo "  $name: rejected as a global key (HTTP $code)"
    done
  fi

  if [ -z "$winner" ]; then
    echo "::error::None of the Cloudflare secrets in this repository were accepted by the Cloudflare API."
    echo "Checked these names: ${CF_TOKEN_CANDIDATES[*]}"
    echo ""
    echo "Most likely causes, in order:"
    echo "  1. The value is a Global API Key, not an API token. Global keys also need"
    echo "     an email — add a CLOUDFLARE_EMAIL secret with the Cloudflare account"
    echo "     login address, and this workflow will use it automatically."
    echo "  2. The token was created but has expired or was rolled."
    echo "  3. The token is scoped to the wrong account."
    echo ""
    echo "Recommended fix: create an API token at"
    echo "  https://dash.cloudflare.com/profile/api-tokens"
    echo "with permissions  Account > Cloudflare Pages > Edit  and  Zone > DNS > Edit"
    echo "(zone: pivotpointrecovery.org), then save it as CLOUDFLARE_API_TOKEN."
    return 1
  fi

  if [ "$scheme" = "bearer" ]; then
    echo "CF_BEARER=$winner" >> "$GITHUB_ENV"
    CF_BEARER="$winner"
  else
    echo "CF_EMAIL=${CLOUDFLARE_EMAIL:-}" >> "$GITHUB_ENV"
    echo "CF_KEY=$winner" >> "$GITHUB_ENV"
    CF_EMAIL="${CLOUDFLARE_EMAIL:-}"; CF_KEY="$winner"
  fi

  # --- Account id: prefer an explicit secret, else derive it --------------
  local acct="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
  if [ -n "$acct" ]; then
    echo "::add-mask::$acct"
  else
    local a n
    a=$(cf_api "https://api.cloudflare.com/client/v4/accounts?per_page=50")
    n=$(echo "$a" | jq -r '.result | length')
    if [ "$n" != "1" ]; then
      echo "::error::Token can see $n accounts; set CLOUDFLARE_ACCOUNT_ID to pick one."
      return 1
    fi
    acct=$(echo "$a" | jq -r '.result[0].id')
    echo "::add-mask::$acct"
  fi
  echo "CF_ACCOUNT_ID=$acct" >> "$GITHUB_ENV"
  CF_ACCOUNT_ID="$acct"
  echo "  account resolved"
}
