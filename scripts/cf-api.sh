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
# A third thing is easy to confuse with the first: a Cloudflare Access (Zero
# Trust) *service token*. Those authenticate to Access-protected applications
# and are useless against the Cloudflare API — they are rejected with HTTP 400
# because they are not even API-token shaped. A secret named
# CLOUDFLARE_ACCESS_TOKEN is very often one of these.
#
# cf_resolve_auth probes every candidate against the live API and keeps the
# first Cloudflare actually accepts, reporting each rejection with Cloudflare's
# own error code so a failure says what is wrong rather than just "denied".
#
# Usage in a workflow step:
#   source scripts/cf-api.sh
#   cf_resolve_auth            # first step only; persists choice to GITHUB_ENV
#   cf_api "https://api.cloudflare.com/client/v4/zones"

CF_TOKEN_CANDIDATES=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_TOKEN
  CF_API_TOKEN
  CF_TOKEN
  CLOUDFLARE_ACCESS_TOKEN
  CLOUDFLARE_API_KEY
)

CF_KEY_CANDIDATES=(
  CLOUDFLARE_API_KEY
  CLOUDFLARE_GLOBAL_API_KEY
  CF_API_KEY
  CLOUDFLARE_ACCESS_TOKEN
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

# Print Cloudflare's own error codes from a response body, indented.
_cf_explain() {
  jq -r '.errors[]? | "      cloudflare says: " + (.code|tostring) + " " + .message' "$1" 2>/dev/null \
    | head -4
}

cf_resolve_auth() {
  local name val code winner="" scheme="" email=""

  echo "Probing Cloudflare credentials (values masked; only names are printed)..."
  echo ""
  echo "-- Scheme 1: API token (Authorization: Bearer) --"
  for name in "${CF_TOKEN_CANDIDATES[@]}"; do
    val="${!name:-}"
    [ -n "$val" ] || continue
    echo "::add-mask::$val"
    code=$(curl -sS -o /tmp/cf_verify.json -w '%{http_code}' \
      -H "Authorization: Bearer $val" \
      "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null || echo 000)
    if [ "$code" = "200" ] && [ "$(jq -r '.success' /tmp/cf_verify.json 2>/dev/null)" = "true" ]; then
      echo "   $name: ACCEPTED as an API token"
      winner="$val"; scheme="bearer"
      break
    fi
    echo "   $name: rejected (HTTP $code)"
    _cf_explain /tmp/cf_verify.json
    if [ "$code" = "400" ]; then
      echo "      -> HTTP 400 means this value is not API-token shaped at all."
      echo "         Most likely a Cloudflare Access (Zero Trust) service token,"
      echo "         which cannot be used against the Cloudflare API."
    fi
  done

  # --- Scheme 2: legacy global key. Needs an account email to go with it. ---
  if [ -z "$winner" ]; then
    echo ""
    echo "-- Scheme 2: global API key (X-Auth-Email + X-Auth-Key) --"

    # Candidate emails, in order of trustworthiness. CF_EMAIL_CANDIDATES is
    # populated by the workflow from the CLOUDFLARE_EMAIL secret and from the
    # push event's author address, so no address is hardcoded here.
    local -a emails=()
    local e
    for e in ${CF_EMAIL_CANDIDATES:-}; do
      case " ${emails[*]:-} " in *" $e "*) ;; *) emails+=("$e");; esac
    done

    if [ ${#emails[@]} -eq 0 ]; then
      echo "   skipped: no candidate account email available."
      echo "   Add a CLOUDFLARE_EMAIL secret holding the Cloudflare login address."
    fi

    for name in "${CF_KEY_CANDIDATES[@]}"; do
      val="${!name:-}"
      [ -n "$val" ] || continue
      echo "::add-mask::$val"
      for e in "${emails[@]}"; do
        code=$(curl -sS -o /tmp/cf_verify.json -w '%{http_code}' \
          -H "X-Auth-Email: $e" -H "X-Auth-Key: $val" \
          "https://api.cloudflare.com/client/v4/user" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then
          echo "   $name + <$e>: ACCEPTED as a global API key"
          winner="$val"; scheme="globalkey"; email="$e"
          break 2
        fi
        echo "   $name + <$e>: rejected (HTTP $code)"
        _cf_explain /tmp/cf_verify.json
      done
    done
  fi

  if [ -z "$winner" ]; then
    echo ""
    echo "::error::No Cloudflare credential in this repository was accepted by the Cloudflare API."
    cat <<'EOF'

WHAT THIS MEANS
  The secrets exist, but Cloudflare rejects all of them. This is a credential
  problem, not a workflow problem — nothing in this repository can fix it.

HOW TO FIX IT (about two minutes)
  1. Go to  https://dash.cloudflare.com/profile/api-tokens
  2. "Create Token" -> "Create Custom Token"
  3. Give it these permissions:
        Account | Cloudflare Pages | Edit
        Zone    | DNS              | Edit
  4. Under "Zone Resources" select the pivotpointrecovery.org zone.
  5. Create it, copy the token (shown only once).
  6. In GitHub: Settings -> Secrets and variables -> Actions -> New secret
        Name:  CLOUDFLARE_API_TOKEN
        Value: the token you just copied
  7. Re-run this workflow. It will pick the new secret up automatically.

NOTE ON THE EXISTING SECRETS
  CLOUDFLARE_ACCESS_TOKEN is almost certainly a Cloudflare Access (Zero Trust)
  service token. Those are for authenticating to Access-protected apps, not the
  Cloudflare API, so no workflow can use it for Pages or DNS.
  CLOUDFLARE_API_KEY looks like a Global API Key, which additionally requires
  the account's login email — add CLOUDFLARE_EMAIL if you want to use it, though
  a scoped API token is the safer choice.
EOF
    return 1
  fi

  if [ "$scheme" = "bearer" ]; then
    echo "CF_BEARER=$winner" >> "$GITHUB_ENV"
    CF_BEARER="$winner"
  else
    echo "CF_EMAIL=$email" >> "$GITHUB_ENV"
    echo "CF_KEY=$winner" >> "$GITHUB_ENV"
    CF_EMAIL="$email"; CF_KEY="$winner"
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
      echo "::error::Credential can see $n accounts; set CLOUDFLARE_ACCOUNT_ID to pick one."
      return 1
    fi
    acct=$(echo "$a" | jq -r '.result[0].id')
    echo "::add-mask::$acct"
  fi
  echo "CF_ACCOUNT_ID=$acct" >> "$GITHUB_ENV"
  CF_ACCOUNT_ID="$acct"
  echo "   account resolved"
}
