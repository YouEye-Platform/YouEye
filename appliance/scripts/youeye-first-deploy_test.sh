#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/appliance/scripts/youeye-first-deploy"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

make_fixture() {
    fixture=$1
    mkdir -p "$fixture/bin" "$fixture/state" "$fixture/control"
    : > "$fixture/commands"
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
jq -e '.schema == "youeye.appliance.progress.v2" and .percent == 100 and .state == "complete"' "$partial/state/progress.json" >/dev/null

complete="$tmp/complete"
make_fixture "$complete"
printf 'test-secret\n' > "$complete/control/.deploy_secret"
run_fixture "$complete" FAKE_CONTROL_COMPLETE=1
grep -Fxq 'deploy --resume' "$complete/commands"

outdated="$tmp/outdated"
make_fixture "$outdated"
printf 'test-secret\n' > "$outdated/control/.deploy_secret"
run_fixture "$outdated" FAKE_CONTROL_COMPLETE=1 FAKE_CONTROL_VERSION=0.5.23
grep -Fxq 'update control --yes' "$outdated/commands"
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
printf '%s\n' '{"core_manifest_sha256":"fixture-core"}' > "$core/release-policy.json"
run_fixture "$core"
grep -Fq 'update core initialize --policy' "$core/commands"
test -e "$core/state/complete"

core_failure="$tmp/core-failure"
make_fixture "$core_failure"
printf '%s\n' '{"core_manifest_sha256":"fixture-core"}' > "$core_failure/release-policy.json"
if run_fixture "$core_failure" FAKE_CORE_INIT_FAIL=1; then
    echo 'missing installed core receipt unexpectedly completed first deployment' >&2
    exit 1
fi
test ! -e "$core_failure/state/complete"

core_reboot="$tmp/core-reboot"
make_fixture "$core_reboot"
printf '%s\n' '{"core_manifest_sha256":"fixture-core"}' > "$core_reboot/release-policy.json"
run_fixture "$core_reboot" FAKE_CORE_REBOOT=true FAKE_CORE_CONVERGED=false
[ ! -e "$core_reboot/state/complete" ]
jq -e '.stage == "system_restart" and .percent == 96' "$core_reboot/state/progress.json" >/dev/null

core_resumed="$tmp/core-resumed"
make_fixture "$core_resumed"
printf '%s\n' '{"core_manifest_sha256":"fixture-core"}' > "$core_resumed/release-policy.json"
run_fixture "$core_resumed" FAKE_CORE_INITIALIZED=true FAKE_CONTROL_VERSION=0.5.23
[ -e "$core_resumed/state/complete" ]
! grep -Fq 'update system converge' "$core_resumed/commands"
! grep -Fq 'update control' "$core_resumed/commands"
! grep -Fq 'update core initialize' "$core_resumed/commands"
! grep -Fxq 'deploy' "$core_resumed/commands"

core_unaccepted="$tmp/core-unaccepted"
make_fixture "$core_unaccepted"
printf '%s\n' '{"core_manifest_sha256":"fixture-core"}' > "$core_unaccepted/release-policy.json"
if run_fixture "$core_unaccepted" FAKE_CORE_CONVERGED=false; then
    echo 'unaccepted tracked core opened setup' >&2
    exit 1
fi
[ ! -e "$core_unaccepted/state/complete" ]

echo "youeye-first-deploy tests passed"
