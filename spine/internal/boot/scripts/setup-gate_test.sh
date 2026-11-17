#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$(cd -- "$(dirname -- "$0")" && pwd)/setup-gate.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/nft" <<'EOF'
#!/bin/sh
set -eu
state=${FAKE_NFT_STATE:?}
rules=${FAKE_NFT_RULES:?}
case "$*" in
    "list table inet youeye_setup_gate")
        test -e "$state"
        ;;
    "delete table inet youeye_setup_gate")
        rm -f "$state"
        ;;
    "-f -")
        cat > "$rules"
        : > "$state"
        ;;
    *)
        exit 2
        ;;
esac
EOF
chmod 0700 "$tmp/nft"

export YOUEYE_NFT_BIN="$tmp/nft"
export YOUEYE_FIRST_DEPLOY_COMPLETE="$tmp/complete"
export FAKE_NFT_STATE="$tmp/table-present"
export FAKE_NFT_RULES="$tmp/rules"

"$script" close
test -e "$FAKE_NFT_STATE"
grep -Fq 'type nat hook prerouting priority -100; policy accept;' "$FAKE_NFT_RULES"
grep -Fq 'fib daddr type local tcp dport 80 redirect to :47080' "$FAKE_NFT_RULES"
grep -Fq 'fib daddr type local tcp dport 443 redirect to :47443' "$FAKE_NFT_RULES"
# Forwarded traffic (containers to the internet) must never be redirected.
! grep -Eq '^\s*tcp dport' "$FAKE_NFT_RULES"
grep -Fq 'type nat hook output priority -100; policy accept;' "$FAKE_NFT_RULES"
grep -Fq 'ip daddr != 127.0.0.0/8 fib daddr type local tcp dport 443 redirect to :47443' "$FAKE_NFT_RULES"
! grep -Fq ' drop' "$FAKE_NFT_RULES"

"$script" open
test ! -e "$FAKE_NFT_STATE"

: > "$YOUEYE_FIRST_DEPLOY_COMPLETE"
"$script" close
test ! -e "$FAKE_NFT_STATE"

printf '%s\n' 'youeye setup gate tests passed'
