#!/bin/sh
set -eu

script=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/check-public-release-hygiene.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

init_repo() {
    rm -rf "$work/repo"
    mkdir -p "$work/repo"
    git -C "$work/repo" init -q
    git -C "$work/repo" config user.name test
    git -C "$work/repo" config user.email test@example.test
}

init_repo
cat > "$work/repo/README.md" <<'EOF'
Public GitHub source: https://github.com/YouEye-Platform/YouEye
Generic Forgejo example: https://forge.example.test/example/YouEye
LAN example: 192.168.1.100
Checksum: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF
git -C "$work/repo" add README.md
"$script" "$work/repo" >/dev/null

for fixture in AGENTS.md private-url.txt worker-email.txt allocation.txt; do
    init_repo
    case "$fixture" in
        AGENTS.md) printf 'private journal\n' > "$work/repo/$fixture" ;;
        private-url.txt) printf 'https://github.com/example/repo\n' > "$work/repo/$fixture" ;;
        worker-email.txt) printf 'worker@workers.anyagent.local\n' > "$work/repo/$fixture" ;;
        allocation.txt) printf 'alloc-app-network-isolation-ipam-1234567890\n' > "$work/repo/$fixture" ;;
    esac
    git -C "$work/repo" add "$fixture"
    if "$script" "$work/repo" >/dev/null 2>&1; then
        printf 'hygiene scanner accepted forbidden fixture: %s\n' "$fixture" >&2
        exit 1
    fi
done

printf '%s\n' 'public release hygiene tests passed'
