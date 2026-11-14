#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-console-status"
tmp=$(mktemp -d)
pid=
trap '[ -z "$pid" ] || kill "$pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT INT TERM

mkdir -p "$tmp/first" "$tmp/update" "$tmp/root/.ssh"
cat > "$tmp/release" <<'EOF'
{"image_version":"0.5.23.0.0.12"}
EOF
cat > "$tmp/state" <<'EOF'
{"slots":{"current":"A"}}
EOF
printf '%s\n' 'root=PARTLABEL=YE-SYSTEM-B ro quiet' > "$tmp/cmdline"
cat > "$tmp/first/progress.json" <<'EOF'
{"stage":"complete","detail":"Exact platform release is healthy"}
EOF
: > "$tmp/first/complete"
cat > "$tmp/config" <<'EOF'
domain: test.ui.bingo
setup_completed: true
EOF
printf 'ssh-ed25519 AAAATEST operator\n' > "$tmp/root/.ssh/authorized_keys"
printf '%s\n' '{"phase":"trial"}' > "$tmp/update/journal.json"
printf '%s\n' '{"schema":"youeye.console-access.v1","root_password_hash":"$y$j9T$saltsaltsalt$hashhashhashhashhashhashhashhashhashhashhas","password_ssh":true,"accounts":[]}' > "$tmp/console-access.json"
printf 'ABCDE-FGHJK\n' > "$tmp/owner-reset-code"
: > "$tmp/tty"

YOUEYE_CONSOLE_RELEASE="$tmp/release" \
YOUEYE_CONSOLE_STATE="$tmp/state" \
YOUEYE_CONSOLE_FIRST_DEPLOY="$tmp/first/progress.json" \
YOUEYE_CONSOLE_FIRST_COMPLETE="$tmp/first/complete" \
YOUEYE_CONSOLE_UPDATE="$tmp/update/journal.json" \
YOUEYE_CONSOLE_ACCESS="$tmp/console-access.json" \
YOUEYE_CONSOLE_RESET_CODE="$tmp/owner-reset-code" \
YOUEYE_CONSOLE_CONFIG="$tmp/config" \
YOUEYE_CONSOLE_AUTHORIZED_KEYS="$tmp/root/.ssh/authorized_keys" \
YOUEYE_CONSOLE_CMDLINE="$tmp/cmdline" \
YOUEYE_CONSOLE_TTYS="$tmp/tty" \
YOUEYE_CONSOLE_RUNTIME_DIR="$tmp" \
YOUEYE_CONSOLE_REFRESH_SECONDS=1 \
"$script" &
pid=$!
sleep 1.2
kill "$pid"
wait "$pid" 2>/dev/null || true
pid=

grep -Fq 'YouEye local appliance status console' "$root/appliance/systemd/youeye-console-status.service"
grep -Fq 'test.ui.bingo' "$tmp/tty"
grep -Fq 'System update: trial' "$tmp/tty"
grep -Fq 'slot B' "$tmp/tty"
grep -Fq '0.5.23.0.0.12' "$tmp/tty"
grep -Fq 'public key' "$tmp/tty"
grep -Fq 'admins sign in on Ctrl+Alt+F2' "$tmp/tty"
grep -Fq 'password SSH on (local network)' "$tmp/tty"
grep -Fq 'Owner password reset code: ABCDE-FGHJK' "$tmp/tty"
grep -Eq 'Open https://[^ ]+/settings/reset-owner' "$tmp/tty"
if grep -Fq 'https://test.ui.bingo/settings/reset-owner' "$tmp/tty"; then
    printf 'the reset page answers only on the IP address, not the name\n' >&2
    exit 1
fi
if grep -Eiq '\$y\$|hash|secret|token' "$tmp/tty"; then
    printf 'console status exposed a forbidden credential term\n' >&2
    exit 1
fi

echo 'youeye-console-status tests passed'
