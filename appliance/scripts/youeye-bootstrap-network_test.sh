#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-bootstrap-network"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM
mkdir -p "$temp/bin" "$temp/state" "$temp/network" "$temp/sys"
printf '1\n' > "$temp/sys/carrier"

cat > "$temp/bin/ip" <<'EOF'
#!/bin/sh
case "$*" in
  "-j link show") printf '[{"ifname":"lo","link_type":"loopback"},{"ifname":"incusbr0","link_type":"bridge"},{"ifname":"ens19","link_type":"ether","address":"02:00:00:00:00:19"},{"ifname":"ens18","link_type":"ether","address":"02:00:00:00:00:18"}]\n' ;;
  "-4 -j addr show dev ens18") printf '[{"addr_info":[{"scope":"global","local":"192.0.2.10"}]}]\n' ;;
  "-4 route show default dev ens18") printf 'default via 192.0.2.1 dev ens18\n' ;;
  "-4 -j addr show dev ens19") printf '[{"addr_info":[{"scope":"global","local":"192.0.2.11"}]}]\n' ;;
  "-4 route show default dev ens19") printf 'default via 192.0.2.1 dev ens19\n' ;;
  *) exit 1 ;;
esac
EOF
cat > "$temp/bin/networkctl" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$temp/bin/getent" <<'EOF'
#!/bin/sh
[ "${FAKE_DNS_FAIL:-0}" != 1 ]
EOF
cat > "$temp/bin/curl" <<'EOF'
#!/bin/sh
[ "${FAKE_SOURCE_FAIL:-0}" != 1 ] || exit 22
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; printf '[]\n' > "$1"; exit 0; fi
  shift
done
exit 1
EOF
chmod +x "$temp/bin/"*

cat > "$temp/state/network-profile.json" <<'EOF'
{"schema":"youeye.network-profile.v1","id":"primary","kind":"ethernet","ipv4":{"mode":"dhcp"}}
EOF
cat > "$temp/state/release-policy.json" <<'EOF'
{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","freshness":"require-current"}
EOF

run_network() {
    env \
        YOUEYE_NETWORK_PROFILE="$temp/state/network-profile.json" \
        YOUEYE_RELEASE_POLICY="$temp/state/release-policy.json" \
        YOUEYE_NETWORK_FILE="$temp/network/20-youeye.network" \
        YOUEYE_NETWORK_STATUS="$temp/state/network-status.json" \
        YOUEYE_NETWORK_LAST_GOOD="$temp/state/network-last-good.network" \
        YOUEYE_NETWORK_LAST_GOOD_PROFILE="$temp/state/network-last-good-profile.json" \
        YOUEYE_NETWORK_CARRIER="$temp/sys/carrier" \
        YOUEYE_NETWORK_MAX_ATTEMPTS=1 YOUEYE_NETWORK_RETRY_SECONDS=0 \
        IP_BIN="$temp/bin/ip" NETWORKCTL_BIN="$temp/bin/networkctl" \
        GETENT_BIN="$temp/bin/getent" CURL_BIN="$temp/bin/curl" \
        "$@" "$script"
}

run_network
grep -Fqx 'Name=ens18' "$temp/network/20-youeye.network"
grep -Fqx 'DHCP=ipv4' "$temp/network/20-youeye.network"
jq -e '.phase == "ready" and .interface == "ens18" and .ipv4_mode == "dhcp"' "$temp/state/network-status.json" >/dev/null
test "$(stat -c %a "$temp/state/network-last-good-profile.json")" = 600

cat > "$temp/state/network-profile.json" <<'EOF'
{"schema":"youeye.network-profile.v1","id":"primary","kind":"ethernet","adapter_mac":"02:00:00:00:00:19","ipv4":{"mode":"dhcp"}}
EOF
run_network
grep -Fqx 'MACAddress=02:00:00:00:00:19' "$temp/network/20-youeye.network"
jq -e '.phase == "ready" and .interface == "ens19"' "$temp/state/network-status.json" >/dev/null

cp "$temp/network/20-youeye.network" "$temp/network/before"
cat > "$temp/state/network-profile.json" <<'EOF'
{"schema":"youeye.network-profile.v1","id":"primary","kind":"ethernet","ipv4":{"mode":"static","address":"192.0.2.10/24","gateway":"192.0.2.1","dns":["192.0.2.53"]}}
EOF
if run_network FAKE_DNS_FAIL=1; then
    echo 'DNS failure unexpectedly passed' >&2
    exit 1
fi
cmp -s "$temp/network/before" "$temp/network/20-youeye.network"
jq -e '.ipv4.mode == "dhcp"' "$temp/state/network-profile.json" >/dev/null || {
    echo 'failed candidate profile was not rolled back' >&2
    cat "$temp/state/network-profile.json" >&2
    exit 1
}
jq -e '.phase == "needs_attention" and .error_code == "dns_unavailable"' "$temp/state/network-status.json" >/dev/null

cat > "$temp/state/network-profile.json" <<'EOF'
{"schema":"youeye.network-profile.v1","id":"primary","kind":"ethernet","adapter_mac":"01:00:5e:00:00:01","ipv4":{"mode":"dhcp"}}
EOF
if run_network; then
    echo 'multicast adapter selector unexpectedly passed' >&2
    exit 1
fi
jq -e '.error_code == "invalid_profile"' "$temp/state/network-status.json" >/dev/null

cat > "$temp/state/network-profile.json" <<'EOF'
{"schema":"youeye.network-profile.v1","id":"primary","kind":"wifi","ipv4":{"mode":"dhcp"}}
EOF
if run_network; then
    echo 'unsupported Wi-Fi profile unexpectedly passed' >&2
    exit 1
fi
jq -e '.error_code == "invalid_profile"' "$temp/state/network-status.json" >/dev/null

echo 'youeye-bootstrap-network tests passed'
