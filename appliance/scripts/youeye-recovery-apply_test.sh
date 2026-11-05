#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-recovery-apply"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/request" "$tmp/first" "$tmp/bin"
printf '%s\n' '{"release_set":{"source":"https://example.test/YouEye","branch":"main","control_panel":{"tag":"cp-v0.5.29","artifact_sha256":"be902615e28df357e13c2f244397cade46709da4f3b3452f7a9d8f8d86057d92"},"ui":{"tag":"ui-v0.5.9","artifact_sha256":"4b0e866f3eac90a5ebfba14aac382e3a92415e02a2efaa2856a7426ec8816251"}}}' > "$tmp/sealed-release.json"

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
YOUEYE_RECOVERY_DEVELOPMENT_ACCESS_STATUS="$tmp/development-access-status.json" \
YOUEYE_RECOVERY_SEALED_RELEASE="$tmp/sealed-release.json" "$script"
grep -Fxq 'cleanup --yes --keep-data' "$tmp/calls"
grep -Fxq 'repo set https://example.test/YouEye' "$tmp/calls"
grep -Fxq 'channel set default --source https://example.test/YouEye --branch main --tag  --fallback none' "$tmp/calls"
grep -Fxq 'channel set spine --source https://example.test/YouEye --branch main --tag  --fallback none' "$tmp/calls"
grep -Fxq 'channel set control --source https://example.test/YouEye --branch main --tag cp-v0.5.29 --artifact-sha256 be902615e28df357e13c2f244397cade46709da4f3b3452f7a9d8f8d86057d92 --fallback none' "$tmp/calls"
grep -Fxq 'channel set ui --source https://example.test/YouEye --branch main --tag ui-v0.5.9 --artifact-sha256 4b0e866f3eac90a5ebfba14aac382e3a92415e02a2efaa2856a7426ec8816251 --fallback none' "$tmp/calls"
test ! -e "$tmp/request/request.json"
test ! -e "$tmp/first"
jq -e '.schema == "youeye.appliance.recovery.v1" and .operation == "reset-platform" and .stage == "complete"' "$tmp/request/last-result.json" >/dev/null

# A v2 image can bind Spine to a scoped branch and exact scoped release tag.
jq '.release_set.schema="youeye.release-set.v2" |
    .release_set.spine={"branch":"agent/sebastian/session","tag":"spine-agent/sebastian/session-v1.0.0","artifact_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} |
    .release_set.control_panel.branch="dev" | .release_set.ui.branch="dev"' \
    "$tmp/sealed-release.json" > "$tmp/sealed-v2.json"
mv "$tmp/sealed-v2.json" "$tmp/sealed-release.json"
: > "$tmp/calls"
mkdir -p "$tmp/first"
write_request reset-platform
TEST_CALLS="$tmp/calls" YOUEYE_RECOVERY_REQUEST_DIR="$tmp/request" \
YOUEYE_RECOVERY_FIRST_DEPLOY="$tmp/first" YOUEYE_RECOVERY_YOUEYE="$tmp/bin/youeye" \
YOUEYE_RECOVERY_SEALED_RELEASE="$tmp/sealed-release.json" "$script"
grep -Fxq 'channel set spine --source https://example.test/YouEye --branch agent/sebastian/session --tag spine-agent/sebastian/session-v1.0.0 --artifact-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --fallback none' "$tmp/calls"
grep -Fxq 'channel set control --source https://example.test/YouEye --branch dev --tag cp-v0.5.29 --artifact-sha256 be902615e28df357e13c2f244397cade46709da4f3b3452f7a9d8f8d86057d92 --fallback none' "$tmp/calls"
test ! -e "$tmp/first"

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
