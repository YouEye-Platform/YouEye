#!/bin/sh
set -eu

nft_bin=${YOUEYE_NFT_BIN:-/usr/sbin/nft}
complete=${YOUEYE_FIRST_DEPLOY_COMPLETE:-/var/lib/youeye-state/first-deploy/complete}
table=youeye_setup_gate

table_exists() {
    "$nft_bin" list table inet "$table" >/dev/null 2>&1
}

case "${1:-}" in
    close)
        if [ -e "$complete" ]; then
            exit 0
        fi
        if table_exists; then
            "$nft_bin" delete table inet "$table"
        fi
        "$nft_bin" -f - <<'EOF'
table inet youeye_setup_gate {
    chain input {
        type filter hook input priority -210; policy accept;
        iifname "lo" accept
        tcp dport { 80, 443 } drop
    }
}
EOF
        ;;
    open)
        if table_exists; then
            "$nft_bin" delete table inet "$table"
        fi
        ;;
    *)
        printf 'usage: %s close|open\n' "$0" >&2
        exit 2
        ;;
esac
