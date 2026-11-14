#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-recovery-apply"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/request" "$tmp/first" "$tmp/bin"

cat > "$tmp/bin/youeye" <<'EOF2'
#!/bin/sh
printf '%s\n' "$*" >> "${TEST_CALLS:?}"
if [ "${TEST_FAIL:-0}" = 1 ]; then exit 1; fi
EOF2
chmod 0755 "$tmp/bin/youeye"

write_request() {
    jq -n --arg operation "$1" \
        '{schema:"youeye.appliance.recovery.v1",transaction_id:"0123456789abcdef0123456789abcdef",operation:$operation,stage:"queued",requested_at:"2026-08-09T00:00:00Z"}' \
        > "$tmp/request/request.json"
}

run() {
    TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
    YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
    YOUEYE_RECOVERY_CONSOLE_ACCESS="$tmp/console-access.json" YOUEYE_RECOVERY_CONSOLE_HOMES="$tmp/home" \
    YOUEYE_RECOVERY_CONSOLE_STATE="$tmp/console" "$script"
}

# A platform reset only cleans up: the next first deploy installs the accepted System selection.
: > "$tmp/calls"
write_request reset-platform
run
test "$(cat "$tmp/calls")" = 'cleanup --yes --keep-data'
test ! -e "$tmp/request/request.json"
test ! -e "$tmp/first"
jq -e '.stage == "complete" and .operation == "reset-platform"' "$tmp/request/last-result.json" >/dev/null

# A factory reset also removes every console account, the root password and password SSH.
: > "$tmp/calls"
mkdir -p "$tmp/first"
printf '%s\n' '{"schema":"youeye.console-access.v1","root_password_hash":"x","password_ssh":true,"accounts":[{"user_id":"u"}]}' > "$tmp/console-access.json"
mkdir -p "$tmp/home/anna/.ssh" "$tmp/console" && : > "$tmp/home/anna/.ssh/authorized_keys" && : > "$tmp/console/owner-reset.json"
write_request factory-reset
run
test "$(cat "$tmp/calls")" = "$(printf 'cleanup --yes\nconsole apply')"
test ! -e "$tmp/home" && test ! -e "$tmp/console"
jq -e '.accounts == [] and .password_ssh == false and (has("root_password_hash") | not)' "$tmp/console-access.json" >/dev/null
test "$(stat -c %a "$tmp/console-access.json")" = 600
test ! -e "$tmp/first"

# Reset owner password issues the console code and changes nothing else.
: > "$tmp/calls"
mkdir -p "$tmp/first"
write_request reset-owner-password
run
test "$(cat "$tmp/calls")" = 'console owner-reset'
test -e "$tmp/first"
test ! -e "$tmp/request/request.json"
jq -e '.stage == "complete" and .operation == "reset-owner-password"' "$tmp/request/last-result.json" >/dev/null

# A failed operation stays pending for a retry.
write_request factory-reset
if TEST_FAIL=1 run; then
    printf 'failed recovery operation returned success\n' >&2
    exit 1
fi
jq -e '.stage == "failed" and .operation == "factory-reset"' "$tmp/request/request.json" >/dev/null
test -d "$tmp/first"

# A kind this System doesn't implement is reported, not retried forever.
: > "$tmp/calls"
write_request some-later-kind
run
test ! -e "$tmp/request/request.json"
test -e "$tmp/first"
test ! -s "$tmp/calls"
jq -e '.stage == "unsupported" and .operation == "some-later-kind" and (.error | test("does not support"))' "$tmp/request/last-result.json" >/dev/null

printf 'youeye-recovery-apply tests passed\n'
