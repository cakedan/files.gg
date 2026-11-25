#!/usr/bin/env bash
# Writes Cloudflare's published IP ranges as nftables sets (docs/redesign/contracts/milestone-7.md §1, decision 7): the
# only addresses ops/nftables.conf.example lets reach 443. Weekly from root's crontab, with --reload:
#
#   17 4 * * 1  /home/deploy/files.gg/ops/cloudflare-ips.sh --reload
#
#   ops/cloudflare-ips.sh [--reload] [<file>]   <file> defaults to /etc/nftables.d/cloudflare.nft
#
# The file holds `set cloudflare_v4` and `set cloudflare_v6`, included inside the `inet filesgg` table. It's only
# replaced when the lists parsed, look complete and differ from what's there; --reload then checks the whole ruleset
# (NFT_CONF, default /etc/nftables.conf) with `nft -c` and loads it, putting the old file back if the check fails.
# A failed fetch keeps the previous ranges: Cloudflare adds ranges rarely and announces them in advance.
set -euo pipefail

reload=
out=/etc/nftables.d/cloudflare.nft
while [ $# -gt 0 ]; do
  case $1 in
    --reload) reload=1 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) out=$1 ;;
  esac
  shift
done
NFT_CONF=${NFT_CONF:-/etc/nftables.conf}

log() { echo "[cloudflare-ips] $*"; }

# one CIDR per line, each checked; fewer than `minimum` means the list is cut short, not that Cloudflare shrank
fetch() {
  local url=$1 pattern=$2 minimum=$3 body line count=0
  body=$(curl -fsS --max-time 30 --retry 3 "$url" | tr -d '\r') || { log "can't fetch $url"; return 1; }
  for line in $body; do
    if [[ ! $line =~ $pattern ]]; then
      log "$url has a line that isn't a range, refusing it"
      return 1
    fi
    count=$((count + 1))
  done
  if [ "$count" -lt "$minimum" ]; then
    log "$url lists only $count ranges, refusing it"
    return 1
  fi
  printf '%s\n' "$body" | grep . | sort -u | paste -sd ',' - | sed 's/,/, /g'
}

v4=$(fetch https://www.cloudflare.com/ips-v4 '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' 10)
v6=$(fetch https://www.cloudflare.com/ips-v6 '^[0-9a-f]{1,4}(:[0-9a-f]{0,4}){1,7}/[0-9]{1,3}$' 5)

new=$(mktemp)
trap 'rm -f "$new"' EXIT
cat > "$new" <<EOF
# Cloudflare's IP ranges, written by ops/cloudflare-ips.sh from https://www.cloudflare.com/ips-v4 and /ips-v6.
# Don't edit: the next run replaces it. Included inside \`table inet filesgg\` (ops/nftables.conf.example).
set cloudflare_v4 {
    type ipv4_addr
    flags interval
    elements = { $v4 }
}
set cloudflare_v6 {
    type ipv6_addr
    flags interval
    elements = { $v6 }
}
EOF

# the header line changes nothing, compare the sets only
if [ -f "$out" ] && diff -q <(grep -v '^#' "$out") <(grep -v '^#' "$new") >/dev/null; then
  log "$out is up to date"
  exit 0
fi

mkdir -p "$(dirname "$out")"
backup=
if [ -f "$out" ]; then
  backup=$out.previous
  cp -p "$out" "$backup"
fi
install -m 0644 "$new" "$out"
log "wrote $out ($(tr ',' '\n' <<< "$v4" | grep -c .) IPv4 and $(tr ',' '\n' <<< "$v6" | grep -c .) IPv6 ranges)"

if [ -n "$reload" ]; then
  if ! nft -c -f "$NFT_CONF"; then
    log "$NFT_CONF doesn't load with the new ranges, putting the previous file back"
    if [ -n "$backup" ]; then mv "$backup" "$out"; else rm -f "$out"; fi
    exit 1
  fi
  nft -f "$NFT_CONF"
  log "reloaded $NFT_CONF"
fi
