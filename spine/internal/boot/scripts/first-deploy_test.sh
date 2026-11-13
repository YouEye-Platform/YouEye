#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$(cd -- "$(dirname -- "$0")" && pwd)/first-deploy.sh"
tmp=$(mktemp -d)
fixture_core=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
trap 'rm -rf "$tmp"' EXIT INT TERM

make_fixture() {
    fixture=$1
    mkdir -p "$fixture/bin" "$fixture/state" "$fixture/control"
    : > "$fixture/commands"
    printf '{"core_manifest_sha256":"%s"}\n' "$fixture_core" > "$fixture/release-policy.json"
    printf '%s\n' '{"release_set":{"control_panel":{"version":"0.5.29"}}}' > "$fixture/sealed-release.json"
    cat > "$fixture/bin/incus" <<'EOF'
#!/bin/sh
case "$1 $2" in
  "list youeye-control")
    if [ -e "$FAKE_INCUS_STATE_FILE" ]; then printf 'RUNNING\n'; else printf '%s\n' "${FAKE_CONTROL_STATE:-RUNNING}"; fi ;;
  "exec youeye-control")
    if [ "$3" = -- ] && [ "$4" = cat ]; then
      printf '{"version":"%s"}\n' "${FAKE_CONTROL_VERSION:-0.5.29}"
    else
      [ "${FAKE_CONTROL_COMPLETE:-0}" = 1 ]
    fi ;;
  "start youeye-control")
    if [ "${FAKE_START_RACE:-0}" = 1 ]; then touch "$FAKE_INCUS_STATE_FILE"; exit 1; fi
    exit 0 ;;
  *) exit 1 ;;
esac
EOF
    cat > "$fixture/bin/youeye" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  "update system converge "*)
    if [ "${FAKE_CONVERGE_REBOOT:-0}" = 1 ]; then
      printf '{"schema":"youeye.first-boot-convergence.v1","reboot_requested":true}\n'
    else
      printf '{"schema":"youeye.first-boot-convergence.v1","reboot_requested":false}\n'
    fi ;;
  "update core first-boot "*)
    [ "${FAKE_CORE_CONVERGE_FAIL:-0}" != 1 ] || exit 1
    case "$*" in
      *--resume-only) printf '{"initialized":%s,"converged":%s,"reboot_requested":false}\n' "${FAKE_CORE_INITIALIZED:-false}" "${FAKE_CORE_INITIALIZED:-false}" ;;
      *) printf '{"initialized":true,"converged":%s,"reboot_requested":%s}\n' "${FAKE_CORE_CONVERGED:-true}" "${FAKE_CORE_REBOOT:-false}" ;;
    esac ;;
  "update core initialize "*) [ "${FAKE_CORE_INIT_FAIL:-0}" != 1 ] ;;
  "appliance health --profile=operational --json") printf '{"healthy":true}\n' ;;
  "spine adopt")
    if [ "${FAKE_ADOPT:-0}" = 1 ]; then printf 'Spine 9.9.9-rc.1 is now current on slot A\n'; else printf 'Spine is already current\n'; fi ;;
  "boot first-deploy")
    # Like Spine: run the step as a child while this process keeps fd 9.
    /bin/sh "$FAKE_FIRST_DEPLOY_SCRIPT"; exit $? ;;
  *) [ "${FAKE_DEPLOY_FAIL:-0}" != 1 ] ;;
esac
EOF
    cat > "$fixture/bin/gate" <<'EOF'
#!/bin/sh
exit 0
EOF
    cat > "$fixture/bin/seed" <<'EOF'
#!/bin/sh
exit 0
EOF
    cat > "$fixture/bin/network" <<'EOF'
#!/bin/sh
exit 0
EOF
    cat > "$fixture/bin/curl" <<'EOF'
#!/bin/sh
[ "${FAKE_HTTPS_FAIL:-0}" != 1 ]
EOF
    chmod +x "$fixture/bin/"*
}

run_fixture() {
    fixture=$1
    shift
    env \
        FAKE_COMMAND_LOG="$fixture/commands" \
        FAKE_FIRST_DEPLOY_SCRIPT="$script" \
        FAKE_INCUS_STATE_FILE="$fixture/incus-running" \
        YOUEYE_FIRST_DEPLOY_STATE_DIR="$fixture/state" \
        YOUEYE_CONTROL_SECRET="$fixture/control/.deploy_secret" \
        YOUEYE_BIN="$fixture/bin/youeye" \
        INCUS_BIN="$fixture/bin/incus" \
        YOUEYE_SETUP_GATE="$fixture/bin/gate" \
        YOUEYE_SEED_MARKET="$fixture/bin/seed" \
        YOUEYE_BOOTSTRAP_NETWORK="$fixture/bin/network" \
        CURL_BIN="$fixture/bin/curl" \
        YOUEYE_RELEASE_POLICY="$fixture/release-policy.json" \
        YOUEYE_FIRST_DEPLOY_SEALED_RELEASE="$fixture/sealed-release.json" \
        "$@" \
        "$script"
}

partial="$tmp/partial"
make_fixture "$partial"
run_fixture "$partial" FAKE_CONTROL_COMPLETE=0
grep -Fxq deploy "$partial/commands"
grep -Fq '"stage": "complete"' "$partial/state/progress.json"
jq -e '.schema == "youeye.installer.progress.v1" and .percent == 100 and .state == "complete"' "$partial/state/progress.json" >/dev/null

complete="$tmp/complete"
make_fixture "$complete"
printf 'test-secret\n' > "$complete/control/.deploy_secret"
run_fixture "$complete" FAKE_CONTROL_COMPLETE=1
grep -Fxq 'deploy --resume' "$complete/commands"

outdated="$tmp/outdated"
make_fixture "$outdated"
printf 'test-secret\n' > "$outdated/control/.deploy_secret"
run_fixture "$outdated" FAKE_CONTROL_COMPLETE=1 FAKE_CONTROL_VERSION=0.5.23
grep -Fxq "spine adopt" "$outdated/commands"
! grep -Fq "update control" "$outdated/commands"
grep -Fxq 'deploy --resume' "$outdated/commands"

start_race="$tmp/start-race"
make_fixture "$start_race"
run_fixture "$start_race" FAKE_CONTROL_STATE=STOPPED FAKE_START_RACE=1 FAKE_CONTROL_COMPLETE=0
grep -Fxq deploy "$start_race/commands"
grep -Fq '"stage": "complete"' "$start_race/state/progress.json"

failing="$tmp/failing"
make_fixture "$failing"
attempt=1
while [ "$attempt" -le 8 ]; do
    if ! run_fixture "$failing" FAKE_CONTROL_COMPLETE=0 FAKE_DEPLOY_FAIL=1 YOUEYE_FIRST_DEPLOY_MAX_ATTEMPTS=8; then
        [ "$attempt" -lt 8 ]
    fi
    attempt=$((attempt + 1))
done
grep -Fq '"stage": "needs_attention"' "$failing/state/progress.json"
grep -Fq '"attempt": 8' "$failing/state/progress.json"

rebooting="$tmp/rebooting"
make_fixture "$rebooting"
run_fixture "$rebooting" FAKE_CONVERGE_REBOOT=1
! grep -Fxq deploy "$rebooting/commands"
jq -e '.stage == "system_restart" and .percent == 28' "$rebooting/state/progress.json" >/dev/null

https_failure="$tmp/https-failure"
make_fixture "$https_failure"
if run_fixture "$https_failure" FAKE_HTTPS_FAIL=1; then
    echo 'unreachable HTTPS setup surface unexpectedly completed first deployment' >&2
    exit 1
fi
test ! -e "$https_failure/state/complete"
jq -e '.state == "retrying" and .percent == 98' "$https_failure/state/progress.json" >/dev/null

core="$tmp/core"
make_fixture "$core"
run_fixture "$core"
grep -Fq 'update core initialize --policy' "$core/commands"
test -e "$core/state/complete"

core_failure="$tmp/core-failure"
make_fixture "$core_failure"
if run_fixture "$core_failure" FAKE_CORE_INIT_FAIL=1; then
    echo 'missing installed core receipt unexpectedly completed first deployment' >&2
    exit 1
fi
test ! -e "$core_failure/state/complete"

core_reboot="$tmp/core-reboot"
make_fixture "$core_reboot"
run_fixture "$core_reboot" FAKE_CORE_REBOOT=true FAKE_CORE_CONVERGED=false
[ ! -e "$core_reboot/state/complete" ]
jq -e '.stage == "system_restart" and .percent == 96' "$core_reboot/state/progress.json" >/dev/null

core_resumed="$tmp/core-resumed"
make_fixture "$core_resumed"
run_fixture "$core_resumed" FAKE_CORE_INITIALIZED=true FAKE_CONTROL_VERSION=0.5.23
[ -e "$core_resumed/state/complete" ]
! grep -Fq 'update system converge' "$core_resumed/commands"
! grep -Fq 'update control' "$core_resumed/commands"
! grep -Fq 'update core initialize' "$core_resumed/commands"
! grep -Fxq 'deploy' "$core_resumed/commands"

core_unaccepted="$tmp/core-unaccepted"
make_fixture "$core_unaccepted"
if run_fixture "$core_unaccepted" FAKE_CORE_CONVERGED=false; then
    echo 'unaccepted tracked core opened setup' >&2
    exit 1
fi
[ ! -e "$core_unaccepted/state/complete" ]

echo "youeye-first-deploy tests passed"

required="$tmp/core-required"
make_fixture "$required"
printf '{}\n' > "$required/release-policy.json"
if run_fixture "$required" 2>"$required/error"; then
    echo 'first deployment accepted a missing System selection' >&2
    exit 1
fi
grep -Fq 'original installer answer' "$required/error"
test ! -s "$required/commands"
test ! -e "$required/state/complete"

# Adopting a newer Spine re-runs first deployment from it while the first run
# still holds the lock; the re-run must finish the deployment, not exit early.
adopted="$tmp/adopted"
make_fixture "$adopted"
run_fixture "$adopted" FAKE_ADOPT=1 FAKE_CONTROL_COMPLETE=0
grep -Fxq "boot first-deploy" "$adopted/commands"
grep -Fxq deploy "$adopted/commands"
test -e "$adopted/state/complete"
jq -e '.attempt == 1 and .state == "complete"' "$adopted/state/progress.json" >/dev/null
