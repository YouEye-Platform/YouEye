#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/appliance/scripts/youeye-appliance-bless"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/empty-efivars"
printf 'test-boot-id\n' > "$tmp/boot-id"
: > "$tmp/first-deploy-complete"

cat > "$tmp/bin/youeye" <<'EOF'
#!/bin/sh
set -eu
if [ "$*" = "appliance commit-healthy-slot" ]; then
    printf 'commit\n' >> "$CALL_LOG"
    if [ "${FAIL_COMMIT:-0}" = 1 ]; then
        exit 1
    fi
    exit 0
fi
if [ "$*" = "update system reconcile --json" ]; then
    printf 'reconcile\n' >> "$CALL_LOG"
    if [ "${UPDATE_TRIAL:-0}" = 1 ]; then
        printf '{"status":{"state":"trial"},"reboot_required":false}\n'
    else
        printf '{"status":{"state":"healthy"},"reboot_required":false}\n'
    fi
    exit 0
fi
if [ "$*" = "update system reconcile --health-failed --json" ]; then
    printf 'reconcile-failed\n' >> "$CALL_LOG"
    if [ "${UPDATE_TRIAL:-0}" = 1 ]; then
        printf '{"reboot_required":true}\n'
    else
        printf '{"reboot_required":false}\n'
    fi
    exit 0
fi
if [ "$*" = "update system mark-healthy --json" ]; then
    printf 'mark-healthy\n' >> "$CALL_LOG"
    printf '{"state":"healthy"}\n'
    exit 0
fi
printf 'health\n' >> "$CALL_LOG"
if [ "${FAIL_HEALTH:-0}" = 1 ]; then
    exit 1
fi
printf '{"status":"healthy"}\n'
EOF
cat > "$tmp/bin/systemctl" <<'EOF'
#!/bin/sh
set -eu
[ "$*" = "--no-block reboot" ]
printf 'reboot\n' >> "$CALL_LOG"
EOF
cat > "$tmp/bin/systemd-bless-boot" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = good ]
printf 'bless\n' >> "$CALL_LOG"
if [ "${FAIL_BLESS:-0}" = 1 ]; then
    exit 1
fi
EOF
chmod 0755 "$tmp/bin/youeye" "$tmp/bin/systemd-bless-boot" "$tmp/bin/systemctl"

run_bless() {
    YOUEYE_EFIVARS_DIR="$1" \
    YOUEYE_STATE_DIR="$2" \
    YOUEYE_BIN="$tmp/bin/youeye" \
    YOUEYE_BLESS_BOOT_BIN="$tmp/bin/systemd-bless-boot" \
	YOUEYE_BOOT_ID_FILE="$tmp/boot-id" \
	YOUEYE_FIRST_DEPLOY_COMPLETE="${9:-$tmp/first-deploy-complete}" \
	YOUEYE_REBOOT_BIN="$tmp/bin/systemctl" \
    CALL_LOG="$3" \
    FAIL_HEALTH="${4:-0}" \
    FAIL_BLESS="${5:-0}" \
	FAIL_COMMIT="${6:-0}" \
	UPDATE_TRIAL="${7:-0}" \
	YOUEYE_UPDATE_HEALTH_GRACE_ATTEMPTS="${8:-24}" \
		"$script"
}

if run_bless "$tmp/empty-efivars" "$tmp/incomplete-state" "$tmp/incomplete-calls" 0 0 0 0 24 "$tmp/missing-first-deploy"; then
	printf 'FAIL: incomplete first deployment was blessed\n' >&2
	exit 1
fi
test ! -s "$tmp/incomplete-calls"

run_bless "$tmp/empty-efivars" "$tmp/uncounted-state" "$tmp/uncounted-calls"
test "$(cat "$tmp/uncounted-calls")" = "$(printf 'reconcile\nhealth\ncommit\nmark-healthy\nhealth')"
jq -e '.status == "healthy" and .boot_id == "test-boot-id"' \
    "$tmp/uncounted-state/last-bless.json" >/dev/null
test ! -e "$tmp/uncounted-state/pending-bless.json"

if run_bless "$tmp/empty-efivars" "$tmp/uncounted-health-failed-state" \
    "$tmp/uncounted-health-failed-calls" 1; then
    printf 'FAIL: uncounted boot health failure was accepted\n' >&2
    exit 1
fi
test "$(cat "$tmp/uncounted-health-failed-calls")" = "$(printf 'reconcile\nhealth\nreconcile-failed')"
test ! -e "$tmp/uncounted-health-failed-state/last-bless.json"

if run_bless "$tmp/empty-efivars" "$tmp/uncounted-commit-retry-state" \
    "$tmp/uncounted-commit-retry-calls" 0 0 1; then
    printf 'FAIL: uncounted slot commit failure was accepted\n' >&2
    exit 1
fi
test "$(cat "$tmp/uncounted-commit-retry-calls")" = "$(printf 'reconcile\nhealth\ncommit')"
test ! -e "$tmp/uncounted-commit-retry-state/last-bless.json"
run_bless "$tmp/empty-efivars" "$tmp/uncounted-commit-retry-state" \
    "$tmp/uncounted-commit-retry-calls"
test "$(cat "$tmp/uncounted-commit-retry-calls")" = \
	"$(printf 'reconcile\nhealth\ncommit\nreconcile\nhealth\ncommit\nmark-healthy\nhealth')"
jq -e '.status == "healthy" and .boot_id == "test-boot-id"' \
    "$tmp/uncounted-commit-retry-state/last-bless.json" >/dev/null

mkdir -p "$tmp/counted-efivars"
: > "$tmp/counted-efivars/LoaderBootCountPath-test"
run_bless "$tmp/counted-efivars" "$tmp/healthy-state" "$tmp/healthy-calls"
test "$(cat "$tmp/healthy-calls")" = "$(printf 'reconcile\nhealth\nbless\ncommit\nmark-healthy\nhealth')"
jq -e '.status == "healthy"' "$tmp/healthy-state/last-bless-health.json" >/dev/null
jq -e '.schema == "youeye.appliance.boot-bless.v1" and .boot_id == "test-boot-id" and .status == "healthy"' \
    "$tmp/healthy-state/last-bless.json" >/dev/null

if run_bless "$tmp/counted-efivars" "$tmp/failed-state" "$tmp/failed-calls" 1; then
    printf 'FAIL: health failure was accepted\n' >&2
    exit 1
fi
test "$(cat "$tmp/failed-calls")" = "$(printf 'reconcile\nhealth\nreconcile-failed')"
test ! -e "$tmp/failed-state/last-bless.json"
test ! -e "$tmp/failed-state/pending-bless.json"

if run_bless "$tmp/counted-efivars" "$tmp/failed-bless-state" "$tmp/failed-bless-calls" 0 1; then
    printf 'FAIL: systemd blessing failure was accepted\n' >&2
    exit 1
fi
test "$(cat "$tmp/failed-bless-calls")" = "$(printf 'reconcile\nhealth\nbless')"
jq -e '.status == "healthy"' "$tmp/failed-bless-state/last-bless-health.json" >/dev/null
test ! -e "$tmp/failed-bless-state/last-bless.json"
jq -e '.status == "validated"' "$tmp/failed-bless-state/pending-bless.json" >/dev/null

if run_bless "$tmp/counted-efivars" "$tmp/retry-state" "$tmp/retry-calls" 0 0 1; then
    printf 'FAIL: slot commit failure was accepted\n' >&2
    exit 1
fi
test "$(cat "$tmp/retry-calls")" = "$(printf 'reconcile\nhealth\nbless\ncommit')"
jq -e '.status == "validated"' "$tmp/retry-state/pending-bless.json" >/dev/null
rm "$tmp/counted-efivars/LoaderBootCountPath-test"
run_bless "$tmp/counted-efivars" "$tmp/retry-state" "$tmp/retry-calls"
test "$(cat "$tmp/retry-calls")" = "$(printf 'reconcile\nhealth\nbless\ncommit\nreconcile\ncommit\nmark-healthy\nhealth')"
jq -e '.status == "healthy" and .boot_id == "test-boot-id"' "$tmp/retry-state/last-bless.json" >/dev/null
test ! -e "$tmp/retry-state/pending-bless.json"

: > "$tmp/counted-efivars/LoaderBootCountPath-test"
if run_bless "$tmp/counted-efivars" "$tmp/trial-recovered-state" "$tmp/trial-recovered-calls" 1 0 0 1 2; then
	printf 'FAIL: first transient trial health failure was accepted\n' >&2
	exit 1
fi
run_bless "$tmp/counted-efivars" "$tmp/trial-recovered-state" "$tmp/trial-recovered-calls" 0 0 0 1 2
test "$(cat "$tmp/trial-recovered-calls")" = \
	"$(printf 'reconcile\nhealth\nreconcile\nhealth\nbless\ncommit\nmark-healthy\nhealth')"
test ! -e "$tmp/trial-recovered-state/system-update-health-wait.json"
jq -e '.status == "healthy" and .boot_id == "test-boot-id"' \
	"$tmp/trial-recovered-state/last-bless.json" >/dev/null

if run_bless "$tmp/counted-efivars" "$tmp/trial-grace-state" "$tmp/trial-grace-calls" 1 0 0 1 2; then
	printf 'FAIL: transient trial health failure was accepted\n' >&2
	exit 1
fi
test "$(cat "$tmp/trial-grace-calls")" = "$(printf 'reconcile\nhealth')"
jq -e '.boot_id == "test-boot-id" and .attempts == 1' \
	"$tmp/trial-grace-state/system-update-health-wait.json" >/dev/null
run_bless "$tmp/counted-efivars" "$tmp/trial-grace-state" "$tmp/trial-grace-calls" 1 0 0 1 2
test "$(cat "$tmp/trial-grace-calls")" = \
	"$(printf 'reconcile\nhealth\nreconcile\nhealth\nreconcile-failed\nreboot')"
test ! -e "$tmp/trial-grace-state/system-update-health-wait.json"

run_bless "$tmp/counted-efivars" "$tmp/trial-failed-state" "$tmp/trial-failed-calls" 1 0 0 1 1
test "$(cat "$tmp/trial-failed-calls")" = "$(printf 'reconcile\nhealth\nreconcile-failed\nreboot')"
test ! -e "$tmp/trial-failed-state/last-bless.json"

printf 'PASS: health-gated appliance boot blessing and uncounted slot reconciliation\n'
