#!/usr/bin/env bash
# Refuses a production configuration that isn't ready (docs/redesign/contracts/milestone-7.md §2.3). ops/deploy.sh runs
# it first; run it by hand after editing .env.
#
#   ops/check-env.sh                    checks .env (or ENV_FILE), as docker compose reads it
#
# Refused: a required variable missing, empty or still a placeholder (CHANGE_ME, example.com); a dev-only
# flag set (FILESGG_DEV_TOOLS, SESSION_COOKIE_INSECURE, FILESGG_ALLOW_LEGAL_PLACEHOLDERS, the stand-ins, DEBUG);
# CSAM_MATCHER anything but photodna; a generated secret that's too short; a public URL that isn't https; nginx's
# client_max_body_size not matching PROXY_BODY_LIMIT_BYTES; ADULT_BLOCKED_COUNTRIES not comma-separated two-letter
# country codes; the origin certificate missing, not matching its key, or
# expiring within 30 days (NGINX_CERT_DIR, default nginx/certificates). Values are never printed.
#
# Exit 0 when everything passed, 1 otherwise (every problem is listed).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=ops/env.sh
. ops/env.sh

CERT_DIR=${NGINX_CERT_DIR:-nginx/certificates}
MIB=1048576

# Required in production although compose lets them be empty (§2.3): the matcher's key, Web Risk, custom domains, the backup healthcheck, and the web build's Turnstile site key (ops/deploy.sh). Every `${NAME:?...}`
# in docker-compose.yml is required too, read from the file below so the two never drift apart.
# Discord sign-in is optional: all three DISCORD_* empty turns it off (checked below).
PRODUCTION_REQUIRED='PHOTODNA_SUBSCRIPTION_KEY WEB_RISK_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ZONE_ID DB_BACKUP_HEALTHCHECK_URL VITE_TURNSTILE_SITE_KEY'
# openssl rand -hex 32 (64 characters); 32 is the floor
GENERATED_SECRETS='SECRET_KEY RPC_KEY ORIGIN_SHARED_SECRET VIEW_HASH_SECRET CDN_SIGNING_SECRET ABUSE_HASH_SECRET
REDIS_PASSWORD POSTGRES_PASSWORD DB_BACKUP_RESTIC_PASSWORD GRAFANA_ADMIN_PASSWORD'
# development and test switches that must never reach production (milestones 4-6)
DEV_ONLY='FILESGG_DEV_TOOLS SESSION_COOKIE_INSECURE FILESGG_ALLOW_LEGAL_PLACEHOLDERS STANDIN_MODE WEB_RISK_STANDIN_FILE
DOMAIN_DNS_STUB DEBUG VITE_API_URL'

problems=0
problem() {
  echo "check-env: $*" >&2
  problems=$((problems + 1))
}

is_placeholder() {
  local lower
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case $lower in
    *change_me* | *changeme* | *change-me* | *placeholder* | *example.com* | *example.org*) return 0 ;;
  esac
  return 1
}

https_origin() {
  [[ $1 =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]
}

if [ ! -f "$ENV_FILE" ]; then
  problem "$ENV_FILE doesn't exist (copy .env.example and fill it in)"
fi

required=" $(grep -oE '\$\{[A-Z_0-9]+:\?' docker-compose.yml | sed -E 's/^\$\{//; s/:\?$//' | sort -u | tr '\n' ' ')"
required="$required$(printf '%s' "$PRODUCTION_REQUIRED" | tr '\n' ' ') "
for name in $required; do
  value=$(env_value "$name")
  if [ -z "$value" ]; then
    problem "$name is required and is missing or empty"
  elif is_placeholder "$value"; then
    problem "$name is still a placeholder"
  fi
done

# a placeholder left in any other variable too
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC2013 # variable names, one word each
  for name in $(grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
      | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' | sort -u); do
    case $required in *" $name "*) continue ;; esac
    if is_placeholder "$(env_value "$name")"; then
      problem "$name is still a placeholder"
    fi
  done
fi

for name in $DEV_ONLY; do
  if [ -n "$(env_value "$name")" ]; then
    problem "$name is set: it's for development and tests only, remove it (from $ENV_FILE and the environment)"
  fi
done

matcher=$(env_value CSAM_MATCHER)
if [ -n "$matcher" ] && [ "$matcher" != photodna ]; then
  problem "CSAM_MATCHER must be photodna in production (the stand-in is for tests and local development)"
fi

for name in $GENERATED_SECRETS; do
  value=$(env_value "$name")
  if [ -n "$value" ] && ! is_placeholder "$value" && [ "${#value}" -lt 32 ]; then
    problem "$name is shorter than 32 characters (generate it with openssl rand -hex 32)"
  fi
done
# both end up inside URLs (REDIS_URL, DATABASE_URL) as they are
redis_password=$(env_value REDIS_PASSWORD)
if ! is_placeholder "$redis_password" && [[ ! $redis_password =~ ^[0-9a-f]*$ ]]; then
  problem "REDIS_PASSWORD must be hex (openssl rand -hex 32)"
fi
if [[ ! $(env_value POSTGRES_PASSWORD) =~ ^[A-Za-z0-9._~-]*$ ]]; then
  problem "POSTGRES_PASSWORD may only use letters, digits and ._~- (openssl rand -hex 32)"
fi

for name in PUBLIC_URL CDN_URL API_PUBLIC_URL; do
  value=$(env_value "$name")
  if [ -n "$value" ] && ! is_placeholder "$value" && ! https_origin "$value"; then
    problem "$name must be an https:// origin with no path"
  fi
done
for name in DISCORD_REDIRECT_URI DB_BACKUP_HEALTHCHECK_URL; do
  value=$(env_value "$name")
  if [ -n "$value" ] && ! is_placeholder "$value" && [[ ! $value =~ ^https:// ]]; then
    problem "$name must be an https:// URL"
  fi
done
# Discord sign-in: off with the id and secret both empty (the sign-in, link and re-auth buttons are hidden); on, it
# needs both (the API refuses to start with one) and the redirect registered in Discord's developer portal
if [ -n "$(env_value DISCORD_CLIENT_ID)" ] || [ -n "$(env_value DISCORD_CLIENT_SECRET)" ]; then
  for name in DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_REDIRECT_URI; do
    if [ -z "$(env_value "$name")" ]; then
      problem "$name is empty: Discord sign-in needs DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI (or none of them, to turn it off)"
    fi
  done
fi

webhook=$(env_value GRAFANA_ALERT_DISCORD_WEBHOOK)
if [ -n "$webhook" ] && ! is_placeholder "$webhook" && [[ ! $webhook =~ ^https://(discord|discordapp)\.com/api/webhooks/ ]]; then
  problem "GRAFANA_ALERT_DISCORD_WEBHOOK must be a Discord webhook URL (https://discord.com/api/webhooks/...)"
fi

# milestone-7 §11.1: the countries where adult content is unavailable, read by the API and the Worker; empty means GB.
# Spaces around the commas and lower case are fine (both read it that way). UK isn't a country code: Cloudflare says GB.
adult_blocked=$(env_value ADULT_BLOCKED_COUNTRIES)
if [ -n "$adult_blocked" ]; then
  if [[ ! $adult_blocked =~ ^[[:space:]]*[A-Za-z]{2}[[:space:]]*(,[[:space:]]*[A-Za-z]{2}[[:space:]]*)*$ ]]; then
    problem "ADULT_BLOCKED_COUNTRIES must be comma-separated two-letter country codes (e.g. GB or GB,US)"
  elif [[ ,$(printf '%s' "$adult_blocked" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]'), == *,UK,* ]]; then
    problem "ADULT_BLOCKED_COUNTRIES has UK: the United Kingdom's country code is GB"
  fi
fi

# nginx's extra API host names are for the staging run only (docs/redesign/LAUNCH.md §7), and end up in its config
extra_hosts=$(env_value NGINX_EXTRA_API_HOSTS)
if [ -n "$extra_hosts" ]; then
  if [[ ! $extra_hosts =~ ^[a-z0-9.-]+( [a-z0-9.-]+)*$ ]]; then
    problem "NGINX_EXTRA_API_HOSTS must be host names separated by spaces"
  fi
  public_url=$(env_value PUBLIC_URL)
  if [ "${public_url:-https://files.gg}" = https://files.gg ]; then
    problem "NGINX_EXTRA_API_HOSTS is for the staging run only, remove it from production"
  fi
fi

# §2.2: nginx's body limit is PROXY_BODY_LIMIT_BYTES plus 1 MiB of framing, rounded up to whole MiB
limit=$(env_value PROXY_BODY_LIMIT_BYTES)
limit=${limit:-104857600}
nginx_limit=$(sed -nE 's/^[[:space:]]*client_max_body_size[[:space:]]+([0-9]+)M;.*/\1/p' nginx/nginx.conf | head -n 1)
if [[ ! $limit =~ ^[0-9]+$ ]]; then
  problem "PROXY_BODY_LIMIT_BYTES must be a number of bytes"
elif [ -z "$nginx_limit" ]; then
  problem "nginx/nginx.conf has no client_max_body_size in MiB (NNNM)"
else
  expected=$(((limit + MIB + MIB - 1) / MIB))
  if [ "$nginx_limit" -ne "$expected" ]; then
    problem "nginx's client_max_body_size is ${nginx_limit}M, PROXY_BODY_LIMIT_BYTES ($limit) needs ${expected}M"
  fi
fi

# the origin certificate (§2.2): never committed, put on the server by hand
cert=$CERT_DIR/certificate.cert
key=$CERT_DIR/certificate.key
if ! command -v openssl >/dev/null; then
  problem "openssl isn't installed, can't check the origin certificate"
elif ! openssl x509 -in "$cert" -noout 2>/dev/null; then
  problem "$cert isn't a certificate (the Cloudflare origin certificate goes there)"
elif ! openssl pkey -in "$key" -noout 2>/dev/null; then
  problem "$key isn't a private key (the origin certificate's key goes there)"
else
  if [ "$(openssl x509 -in "$cert" -noout -pubkey)" != "$(openssl pkey -in "$key" -pubout)" ]; then
    problem "$key isn't the key of $cert"
  fi
  if ! openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null; then
    problem "$cert expires within 30 days"
  fi
fi
if ! openssl x509 -in nginx/certificates/cloudflare-origin-pull-ca.pem -noout 2>/dev/null; then
  problem "nginx/certificates/cloudflare-origin-pull-ca.pem (Cloudflare's origin-pull CA) is missing"
fi

if [ "$problems" -gt 0 ]; then
  echo "check-env: $problems problem(s) in the configuration, refusing" >&2
  exit 1
fi
echo "check-env: $ENV_FILE is ready for production"
