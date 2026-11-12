#!/bin/sh
set -eu

state_dir=${YOUEYE_FIRST_DEPLOY_STATE_DIR:-/var/lib/youeye-state/first-deploy}
journal="$state_dir/progress.json"
complete="$state_dir/complete"
lock="$state_dir/lock"
# These run from Spine (`youeye boot …`), so they change with a Spine release.
setup_gate=${YOUEYE_SETUP_GATE:-/usr/local/bin/youeye boot setup-gate}
bootstrap_network=${YOUEYE_BOOTSTRAP_NETWORK:-/usr/local/bin/youeye boot network}
release_policy=${YOUEYE_RELEASE_POLICY:-/var/lib/youeye-state/bootstrap/release-policy.json}
sealed_release=${YOUEYE_FIRST_DEPLOY_SEALED_RELEASE:-/usr/lib/youeye/appliance-release}
youeye=${YOUEYE_BIN:-/usr/local/bin/youeye}
incus=${INCUS_BIN:-incus}
curl_bin=${CURL_BIN:-curl}
control_secret=${YOUEYE_CONTROL_SECRET:-/var/lib/youeye/control/.deploy_secret}
core_required=${YOUEYE_CORE_SELECTION_REQUIRED:-/usr/share/youeye/core-selection-required}
max_attempts=${YOUEYE_FIRST_DEPLOY_MAX_ATTEMPTS:-8}

install -d -m 0700 "$state_dir"
# A re-run from the adopted Spine (see below) is the child of the run that
# exec'd into that Spine and still holds the lock on fd 9, so it must not
# take the lock again (flock -n would fail and end first deployment silently).
if [ -z "${YOUEYE_FIRST_DEPLOY_ADOPTED:-}" ]; then
    exec 9>"$lock"
    flock -n 9 || exit 0
fi

if [ -e "$complete" ]; then
    exit 0
fi

attempt=1
previous_stage=
if [ -s "$journal" ]; then
    attempt="$(jq -r '.attempt // 0' "$journal" 2>/dev/null || printf '0')"
    previous_stage="$(jq -r '.stage // ""' "$journal" 2>/dev/null || true)"
    attempt=$((attempt + 1))
    # A re-run from the adopted Spine (below) continues the same attempt.
    if [ -n "${YOUEYE_FIRST_DEPLOY_ADOPTED:-}" ] && [ "$attempt" -gt 1 ]; then
        attempt=$((attempt - 1))
    fi
fi

if [ "$previous_stage" = needs_attention ] && [ "$attempt" -gt "$max_attempts" ]; then
    exit 0
fi

write_progress() {
    stage=$1
    detail=$2
    percent=$3
    state=${4:-running}
    previous_percent=0
    if [ -s "$journal" ]; then
        previous_percent=$(jq -r '.percent // 0' "$journal" 2>/dev/null || printf '0')
    fi
    [ "$percent" -ge "$previous_percent" ] || percent=$previous_percent
    tmp="${journal}.tmp"
    jq -n \
        --arg schema youeye.installer.progress.v1 \
        --arg stage "$stage" \
        --arg detail "$detail" \
        --arg state "$state" \
        --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson attempt "$attempt" \
        --argjson percent "$percent" \
        '{schema:$schema,operation:"first-deploy",state:$state,stage:$stage,detail:$detail,percent:$percent,attempt:$attempt,updated_at:$updated_at}' > "$tmp"
    chmod 0600 "$tmp"
    mv -f "$tmp" "$journal"
    sync -f "$state_dir"
}

current_stage=preparing
on_exit() {
    status=$?
    trap - EXIT
    if [ "$status" -ne 0 ]; then
        if [ "$attempt" -ge "$max_attempts" ]; then
            write_progress needs_attention "First deployment stopped after $attempt attempts during $current_stage; inspect the journal and retry from Recovery" 99 needs_attention
            exit 0
        fi
        write_progress retrying "Attempt $attempt failed during $current_stage; the appliance will retry" 0 retrying
    fi
    exit "$status"
}
trap on_exit EXIT

write_progress network "Checking the saved wired network profile" 5
current_stage=network
$bootstrap_network

core_policy=false
core_initialized=false
if [ -e "$core_required" ] && ! jq -e '.core_manifest_sha256 | type == "string" and length == 64' "$release_policy" >/dev/null 2>&1; then
    current_stage=core_selection
    printf '%s\n' 'This appliance requires its complete System selection; recover the original v5 installer answer before retrying.' >&2
    exit 1
fi

# Run the installed release's Spine on this slot (a trial that commits when
# healthy); the image's seed may be older. When it changed, continue first
# deployment from that Spine, so its boot orchestration is the one that runs.
if [ -z "${YOUEYE_FIRST_DEPLOY_ADOPTED:-}" ]; then
    current_stage=adopting_spine
    adopted="$("$youeye" spine adopt)"
    printf '%s\n' "$adopted"
    case "$adopted" in
        *"is now current"*)
            trap - EXIT
            YOUEYE_FIRST_DEPLOY_ADOPTED=1 exec "$youeye" boot first-deploy ;;
    esac
fi

if jq -e '.core_manifest_sha256 | type == "string" and length > 0' "$release_policy" >/dev/null 2>&1; then
    core_policy=true
    current_stage=core_convergence
    core_convergence="$state_dir/core-convergence.json"
    "$youeye" update core first-boot --policy "$release_policy" --resume-only > "${core_convergence}.tmp"
    chmod 0600 "${core_convergence}.tmp"
    mv -f "${core_convergence}.tmp" "$core_convergence"
    if jq -e '.reboot_requested == true' "$core_convergence" >/dev/null; then
        write_progress system_restart "Continuing the frozen System release after restart" 96
        trap - EXIT
        exit 0
    fi
    if jq -e '.initialized == true' "$core_convergence" >/dev/null; then
        jq -e '.converged == true' "$core_convergence" >/dev/null
        core_initialized=true
    fi
fi

if [ "$core_initialized" != true ]; then
current_stage=release_convergence
write_progress release_convergence "Verifying the installed System release" 18
convergence="$state_dir/convergence.json"
"$youeye" update system converge --policy "$release_policy" --reboot --json > "${convergence}.tmp"
chmod 0600 "${convergence}.tmp"
mv -f "${convergence}.tmp" "$convergence"
if jq -e '.reboot_requested == true' "$convergence" >/dev/null; then
    write_progress system_restart "A newer System was written to the inactive slot; restarting to continue" 28
    trap - EXIT
    exit 0
fi

write_progress preparing "Preparing the verified installation selection" 30
control_state="$($incus list youeye-control -c s --format csv 2>/dev/null || true)"
if [ -n "$control_state" ]; then
    if [ "$control_state" != RUNNING ]; then
        if ! "$incus" start youeye-control; then
            # incus-startup may win the race between the state read and the
            # explicit start. Accept that narrow race only after readback.
            control_state="$($incus list youeye-control -c s --format csv 2>/dev/null || true)"
            [ "$control_state" = RUNNING ] || exit 1
        fi
    fi
    if "$incus" exec youeye-control -- sh -c \
        'test -e /opt/app/server.js && test -e /etc/systemd/system/youeye-control.service && test -e /etc/systemd/system/youeye-id.service' \
        && [ -s "$control_secret" ]; then
        current_stage=resuming
        write_progress server_interface "Reconciling an interrupted complete platform deployment" 52
        YOUEYE_FIRST_DEPLOY_PROGRESS_PATH="$journal" YOUEYE_FIRST_DEPLOY_ATTEMPT="$attempt" "$youeye" deploy --resume
    else
        current_stage=continuing
        write_progress server_interface "Continuing an interrupted Server interface transaction" 52
        YOUEYE_FIRST_DEPLOY_PROGRESS_PATH="$journal" YOUEYE_FIRST_DEPLOY_ATTEMPT="$attempt" "$youeye" deploy
    fi
else
    current_stage=deploying
    write_progress storage "Starting persistent storage and platform deployment" 36
    YOUEYE_FIRST_DEPLOY_PROGRESS_PATH="$journal" YOUEYE_FIRST_DEPLOY_ATTEMPT="$attempt" "$youeye" deploy
fi

fi # the verified initialized core resumes without redeploying its media baseline

current_stage=verifying
write_progress verifying "Running durable appliance health checks" 94
"$youeye" appliance health --profile=operational --json > "$state_dir/health.json.tmp"
chmod 0600 "$state_dir/health.json.tmp"
mv -f "$state_dir/health.json.tmp" "$state_dir/health.json"

if [ "$core_policy" = true ] && [ "$core_initialized" != true ]; then
    "$youeye" update core initialize --policy "$release_policy"
    current_stage=core_convergence
    write_progress core_convergence "Accepting the frozen complete System release before opening setup" 96
    "$youeye" update core first-boot --policy "$release_policy" > "${core_convergence}.tmp"
    chmod 0600 "${core_convergence}.tmp"
    mv -f "${core_convergence}.tmp" "$core_convergence"
    if jq -e '.reboot_requested == true' "$core_convergence" >/dev/null; then
        write_progress system_restart "Restarting to accept the frozen System release" 96
        trap - EXIT
        exit 0
    fi
    jq -e '.initialized == true and .converged == true' "$core_convergence" >/dev/null
    "$youeye" appliance health --profile=operational --json > "$state_dir/health.json.tmp"
    chmod 0600 "$state_dir/health.json.tmp"
    mv -f "$state_dir/health.json.tmp" "$state_dir/health.json"
fi

write_progress setup "Opening first setup after all health gates passed" 98
if ! $setup_gate open; then
    exit 1
fi
current_stage=https
if ! "$curl_bin" --fail --silent --show-error --insecure --max-time 30 --output /dev/null https://127.0.0.1/; then
    $setup_gate close || true
    exit 1
fi
install -m 0600 /dev/null "$complete"
sync -f "$state_dir"
write_progress complete "Exact platform release is healthy and first setup is reachable over HTTPS" 100 complete
trap - EXIT
