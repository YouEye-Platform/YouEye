#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/appliance/initramfs/youeye-network-state"

temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM

cat > "$temp/dhcp.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=yes
IPv6AcceptRA=yes
EOF
migrate_youeye_network_state "$temp/dhcp.network"
grep -Fqx 'DHCP=ipv4' "$temp/dhcp.network"
grep -Fqx 'IPv6AcceptRA=no' "$temp/dhcp.network"
grep -Fqx 'LinkLocalAddressing=ipv4' "$temp/dhcp.network"
! grep -Eq '^(DHCP=yes|IPv6AcceptRA=yes)$' "$temp/dhcp.network"

cat > "$temp/static.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
Address=192.0.2.10/24
Gateway=192.0.2.1
DNS=192.0.2.53
IPv6AcceptRA=yes
EOF
migrate_youeye_network_state "$temp/static.network"
grep -Fqx 'Address=192.0.2.10/24' "$temp/static.network"
grep -Fqx 'IPv6AcceptRA=no' "$temp/static.network"
grep -Fqx 'LinkLocalAddressing=no' "$temp/static.network"

cat > "$temp/current.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=ipv4
IPv6AcceptRA=no
LinkLocalAddressing=ipv4
EOF
before=$(sha256sum "$temp/current.network" | awk '{print $1}')
migrate_youeye_network_state "$temp/current.network"
after=$(sha256sum "$temp/current.network" | awk '{print $1}')
[ "$before" = "$after" ]

cat > "$temp/current-static.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
Address=192.0.2.10/24
Gateway=192.0.2.1
DNS=192.0.2.53
IPv6AcceptRA=no
LinkLocalAddressing=no
EOF
before=$(sha256sum "$temp/current-static.network" | awk '{print $1}')
migrate_youeye_network_state "$temp/current-static.network"
after=$(sha256sum "$temp/current-static.network" | awk '{print $1}')
[ "$before" = "$after" ]

printf '%s\n' 'PASS: legacy DHCP/static network state migrates idempotently to IPv4-only policy'
