#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-recovery-apply"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/request" "$tmp/first" "$tmp/bin"

cat > "$tmp/bin/youeye" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${TEST_CALLS:?}"
if [ "${TEST_FAIL:-0}" = 1 ]; then exit 1; fi
EOF
chmod 0755 "$tmp/bin/youeye"
cat > "$tmp/bin/apply-development-access" <<'EOF'
#!/bin/sh
printf '%s\n' apply-development-access >> "${TEST_CALLS:?}"
EOF
chmod 0755 "$tmp/bin/apply-development-access"

write_request() {
    operation=$1
    jq -n --arg operation "$operation" \
        '{schema:"youeye.appliance.recovery.v1",transaction_id:"0123456789abcdef0123456789abcdef",operation:$operation,stage:"queued",requested_at:"2026-08-09T00:00:00Z"}' \
        > "$tmp/request/request.json"
}

: > "$tmp/calls"
write_request reset-platform
TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_APPLY="$tmp/bin/apply-development-access" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_POLICY="$tmp/development-access.json" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS="$tmp/development-access-status.json" "$script"
grep -Fxq 'cleanup --yes --keep-data' "$tmp/calls"
test ! -e "$tmp/request/request.json"
test ! -e "$tmp/first"
jq -e '.schema == "youeye.appliance.recovery.v1" and .operation == "reset-platform" and .stage == "complete"' "$tmp/request/last-result.json" >/dev/null

mkdir -p "$tmp/first"
: > "$tmp/calls"
write_request factory-reset
TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_APPLY="$tmp/bin/apply-development-access" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_POLICY="$tmp/development-access.json" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS="$tmp/development-access-status.json" "$script"
grep -Fxq 'cleanup --yes' "$tmp/calls"
grep -Fxq 'apply-development-access' "$tmp/calls"
jq -e '.schema == "youeye.development-access.v1" and .local_root_console == false and .root_password_ssh == false and (has("password_hash") | not)' "$tmp/development-access.json" >/dev/null
test "$(stat -c %a "$tmp/development-access.json")" = 600
test ! -e "$tmp/development-access-status.json"
jq -e '.operation == "factory-reset" and .stage == "complete"' "$tmp/request/last-result.json" >/dev/null

# The appliance apply helper owns writing the v2 outcome record after reset.
cat > "$tmp/bin/apply-development-access" <<'EOF'
#!/bin/sh
printf '%s\n' apply-development-access >> "${TEST_CALLS:?}"
printf '%s\n' '{"schema":"youeye.development-access-status.v2","local_root_console_requested":false,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"Secure defaults active"}' > "${YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS:?}"
EOF
chmod 0755 "$tmp/bin/apply-development-access"
mkdir -p "$tmp/first"
write_request factory-reset
TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_APPLY="$tmp/bin/apply-development-access" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_POLICY="$tmp/development-access.json" \
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS="$tmp/development-access-status.json" "$script"
jq -e '.schema == "youeye.development-access-status.v2" and
       (.local_root_console_requested | not) and (.local_root_console_effective | not) and
       (.root_password_ssh_requested | not) and (.root_password_ssh_effective | not)' \
    "$tmp/development-access-status.json" >/dev/null

# Restore the ordinary fake helper for the failure assertion below.
cat > "$tmp/bin/apply-development-access" <<'EOF'
#!/bin/sh
printf '%s\n' apply-development-access >> "${TEST_CALLS:?}"
EOF
chmod 0755 "$tmp/bin/apply-development-access"

mkdir -p "$tmp/first"
write_request factory-reset
if TEST_FAIL=1 TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
    YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
    YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_APPLY="$tmp/bin/apply-development-access" \
    YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_POLICY="$tmp/development-access.json" \
    YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS="$tmp/development-access-status.json" "$script"; then
    printf 'failed recovery operation returned success\n' >&2
    exit 1
fi
jq -e '.stage == "failed" and .operation == "factory-reset"' "$tmp/request/request.json" >/dev/null
test -d "$tmp/first"

printf 'youeye-recovery-apply tests passed\n'
