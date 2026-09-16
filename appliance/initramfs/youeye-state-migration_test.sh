#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/appliance/initramfs/youeye-state-migration"

temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM

mkdir -p "$temp/state/etc" "$temp/image/etc"
printf '%s\n' 'root:locked:first-image' > "$temp/image/etc/shadow"
chmod 0600 "$temp/image/etc/shadow"

migrate_youeye_state_file \
    "$temp/state/etc/shadow" "$temp/image/etc/shadow" 0640
grep -Fqx 'root:locked:first-image' "$temp/state/etc/shadow"
[ "$(stat -c %a "$temp/state/etc/shadow")" = 640 ]

printf '%s\n' 'root:locked:persistent-state' > "$temp/state/etc/shadow"
printf '%s\n' 'root:locked:new-image' > "$temp/image/etc/shadow"
migrate_youeye_state_file \
    "$temp/state/etc/shadow" "$temp/image/etc/shadow" 0640
grep -Fqx 'root:locked:persistent-state' "$temp/state/etc/shadow"
! grep -Fq 'new-image' "$temp/state/etc/shadow"

rm -f "$temp/state/etc/shadow"
ln -s "$temp/image/etc/shadow" "$temp/state/etc/shadow"
if migrate_youeye_state_file \
    "$temp/state/etc/shadow" "$temp/image/etc/shadow" 0640; then
    printf '%s\n' 'state migration accepted a symbolic-link destination' >&2
    exit 1
fi

rm -f "$temp/state/etc/shadow" "$temp/image/etc/shadow"
if migrate_youeye_state_file \
    "$temp/state/etc/shadow" "$temp/image/etc/shadow" 0640; then
    printf '%s\n' 'state migration accepted a missing image source' >&2
    exit 1
fi

printf '%s\n' 'PASS: initramfs state migration safely seeds and preserves persistent files'
