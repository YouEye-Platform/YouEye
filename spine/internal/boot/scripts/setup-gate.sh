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
        # Until first deployment opens setup, ports 80 and 443 go to the
        # Preparing page (youeye boot setup-page on 47080/47443; Incus's API
        # owns 8443). Only traffic addressed to the host itself: containers'
        # internet traffic is forwarded through prerouting too. The nat
        # redirect runs before the socket lookup, so it wins over Incus's
        # proxy listeners on 0.0.0.0:80/443. The output chain does the same
        # for the box's own requests to its LAN address; loopback still
        # reaches Caddy (health checks and the final HTTPS probe).
        "$nft_bin" -f - <<'EOF'
table inet youeye_setup_gate {
    chain pre {
        type nat hook prerouting priority -100; policy accept;
        fib daddr type local tcp dport 80 redirect to :47080
        fib daddr type local tcp dport 443 redirect to :47443
    }
    chain out {
        type nat hook output priority -100; policy accept;
        ip daddr != 127.0.0.0/8 fib daddr type local tcp dport 80 redirect to :47080
        ip daddr != 127.0.0.0/8 fib daddr type local tcp dport 443 redirect to :47443
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
