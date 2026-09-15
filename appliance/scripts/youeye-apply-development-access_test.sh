#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
script=$root/appliance/scripts/youeye-apply-development-access
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
state=$work/state
system=$work/system
fakebin=$work/fakebin
install -d -m 0700 "$state/bootstrap"
install -d -m 0755 "$state/etc" "$system/etc/ssh/sshd_config.d" "$fakebin"
cat > "$system/etc/passwd" <<'EOF'
root:x:0:0:root:/root:/bin/bash
EOF
cat > "$system/etc/shadow" <<'EOF'
root:!:20000:0:99999:7:::
EOF
chmod 0640 "$system/etc/shadow"

hash='$y$j9T$AAt9R641xPvCI9nXw1HHW/$cuQRBMN3N/f8IcmVN.4YrZ1bHMOiLOoz9/XQMKV/v0A'

cat > "$fakebin/systemctl" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${SYSTEMCTL_CALLS:?}"
state=${SYSTEMCTL_STATE:?}
command=$1
shift
case "$command" in
  enable)
    [ "${SYSTEMCTL_FAIL_ENABLE:-0}" != 1 ] || exit 1
    : > "$state/enabled"
    ;;
  disable)
    [ "${SYSTEMCTL_FAIL_DISABLE:-0}" != 1 ] || exit 1
    rm -f "$state/enabled"
    ;;
  start)
    [ "$1" = --no-block ] && [ "$2" = getty@tty2.service ] || exit 64
    [ "${SYSTEMCTL_FAIL_START:-0}" != 1 ] || exit 1
    : > "$state/start-requested"
    ;;
  stop)
    [ "$1" = --no-block ] && [ "$2" = getty@tty2.service ] || exit 64
    [ ! -e "$state/fail-stop" ] || exit 1
    : > "$state/stop-requested"
    ;;
  is-enabled)
    [ "$1" = --quiet ] && [ "$2" = getty@tty2.service ] || exit 64
    [ -e "$state/enabled" ]
    ;;
  is-active)
    [ "$1" = --quiet ] || exit 64
    if [ "$2" = ssh.service ]; then
      exit 0
    fi
    [ "$2" = getty@tty2.service ] || exit 64
    if [ -e "$state/start-requested" ]; then
      count=0
      [ ! -f "$state/start-polls" ] || count=$(cat "$state/start-polls")
      count=$((count + 1))
      printf '%s\n' "$count" > "$state/start-polls"
      if [ "$count" -ge "${SYSTEMCTL_START_AFTER:-1}" ]; then : > "$state/active"; fi
    fi
    if [ -e "$state/stop-requested" ]; then
      count=0
      [ ! -f "$state/stop-polls" ] || count=$(cat "$state/stop-polls")
      count=$((count + 1))
      printf '%s\n' "$count" > "$state/stop-polls"
      if [ "$count" -ge "${SYSTEMCTL_STOP_AFTER:-1}" ]; then rm -f "$state/active"; fi
    fi
    [ -e "$state/active" ]
    ;;
  try-reload-or-restart)
    [ "$1" = ssh.service ] || exit 64
    [ "${SYSTEMCTL_FAIL_SSH:-0}" != 1 ] || exit 1
    if [ -f "${SSH_DROPIN:?}" ]; then
      : > "$state/ssh-password-active"
    else
      rm -f "$state/ssh-password-active"
    fi
    ;;
  --no-block)
    [ "$1" = try-reload-or-restart ] && [ "$2" = ssh.service ] || exit 64
    [ "${SYSTEMCTL_FAIL_SSH:-0}" != 1 ] || exit 1
    if [ -f "${SSH_DROPIN:?}" ]; then
      : > "$state/ssh-password-active"
    else
      rm -f "$state/ssh-password-active"
    fi
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "$fakebin/systemctl"
cat > "$fakebin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$fakebin/sleep"

write_policy() {
    console=$1 ssh=$2
    if [ "$console" = true ] || [ "$ssh" = true ]; then
        jq -n --arg hash "$hash" --argjson console "$console" --argjson ssh "$ssh" \
            '{schema:"youeye.development-access.v1",local_root_console:$console,root_password_ssh:$ssh,password_hash:$hash,ssh_network_scope:(if $ssh then "local-subnet" else null end)} | del(.ssh_network_scope | select(. == null))' \
            > "$state/bootstrap/development-access.json"
    else
        printf '%s\n' '{"schema":"youeye.development-access.v1","local_root_console":false,"root_password_ssh":false}' > "$state/bootstrap/development-access.json"
    fi
    chmod 0600 "$state/bootstrap/development-access.json"
}

run_apply() {
    PATH="$fakebin:$PATH" SYSTEMCTL_CALLS="$work/systemctl-calls" SYSTEMCTL_STATE="$work/systemctl-state" \
        SSH_DROPIN="$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf" \
        SYSTEMCTL_FAIL_ENABLE="${SYSTEMCTL_FAIL_ENABLE:-0}" SYSTEMCTL_FAIL_DISABLE="${SYSTEMCTL_FAIL_DISABLE:-0}" \
        SYSTEMCTL_FAIL_START="${SYSTEMCTL_FAIL_START:-0}" SYSTEMCTL_FAIL_STOP="${SYSTEMCTL_FAIL_STOP:-0}" \
        SYSTEMCTL_FAIL_SSH="${SYSTEMCTL_FAIL_SSH:-0}" SYSTEMCTL_START_AFTER="${SYSTEMCTL_START_AFTER:-1}" \
        SYSTEMCTL_STOP_AFTER="${SYSTEMCTL_STOP_AFTER:-1}" YOUEYE_STATE_ROOT="$state" YOUEYE_SYSTEM_ROOT="$system" \
        YOUEYE_DEV_ACCESS_NETWORK_SCOPE=192.0.2.0/24 "$@" "$script"
}

assert_stock_console_calls() {
    ! grep -E 'tty1|ttyS|serial|--now' "$work/systemctl-calls"
    grep -Fxq 'enable --runtime getty@tty2.service' "$work/systemctl-calls"
    grep -Fxq 'is-enabled --quiet getty@tty2.service' "$work/systemctl-calls"
    grep -Fxq 'start --no-block getty@tty2.service' "$work/systemctl-calls"
}

# Enable requests all stock getty lifecycle steps, polls through an asynchronous
# start, and publishes the complete v2 state without credential material.
install -d "$work/systemctl-state"
: > "$work/systemctl-calls"
write_policy true true
SYSTEMCTL_START_AFTER=2 run_apply
assert_stock_console_calls
grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
grep -Fq "root:$hash:" "$system/etc/shadow"
grep -Fq 'Match User root Address 192.0.2.0/24' "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
jq -e '.schema == "youeye.development-access-status.v2" and
       .local_root_console_requested and .local_root_console_persisted and
       .local_root_console_active and .local_root_console_effective and
       .root_password_ssh_requested and .root_password_ssh_effective and
       .network_scope == "192.0.2.0/24" and (has("password_hash") | not)' \
    "$state/bootstrap/development-access-status.json" >/dev/null

# Reapplying an already converged request is idempotent and remains effective.
: > "$work/systemctl-calls"
SYSTEMCTL_START_AFTER=1 run_apply
assert_stock_console_calls
! grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
jq -e '.local_root_console_requested and .local_root_console_persisted and .local_root_console_active and .local_root_console_effective' "$state/bootstrap/development-access-status.json" >/dev/null

# Disable is its own lifecycle: disable, verify absent, stop asynchronously,
# then poll inactive. SSH is removed independently.
: > "$work/systemctl-calls"
write_policy false false
SYSTEMCTL_STOP_AFTER=2 run_apply
grep -Fxq 'disable --runtime getty@tty2.service' "$work/systemctl-calls"
grep -Fxq 'is-enabled --quiet getty@tty2.service' "$work/systemctl-calls"
grep -Fxq 'stop --no-block getty@tty2.service' "$work/systemctl-calls"
! grep -E 'tty1|ttyS|serial|--now' "$work/systemctl-calls"
test ! -e "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
grep -Eq '^root:!:' "$system/etc/shadow"
jq -e '(.local_root_console_requested | not) and (.local_root_console_persisted | not) and
       (.local_root_console_active | not) and (.local_root_console_effective | not) and
       (.root_password_ssh_requested | not) and (.root_password_ssh_effective | not)' \
    "$state/bootstrap/development-access-status.json" >/dev/null

# A console failure records the observed state and returns failure, but SSH
# still completes its independently requested lifecycle.
rm -rf "$work/systemctl-state"
install -d "$work/systemctl-state"
: > "$work/systemctl-calls"
write_policy true true
if SYSTEMCTL_FAIL_START=1 run_apply; then
    printf '%s\n' 'console start failure returned success' >&2
    exit 1
fi
grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
test -f "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
jq -e '.local_root_console_requested and .local_root_console_persisted and
       (.local_root_console_active | not) and (.local_root_console_effective | not) and
       .root_password_ssh_effective and (.detail | length > 0)' \
    "$state/bootstrap/development-access-status.json" >/dev/null

# Failed SSH reloads persist a retry marker until the running daemon converges.
rm -rf "$work/systemctl-state"
install -d "$work/systemctl-state"
: > "$work/systemctl-calls"
write_policy true true
rm -f "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
if SYSTEMCTL_FAIL_SSH=1 run_apply; then
    printf '%s\n' 'SSH reload failure returned success' >&2
    exit 1
fi
test -f "$state/etc/development-access-ssh-reload.pending"
test ! -e "$work/systemctl-state/ssh-password-active"
jq -e '.root_password_ssh_requested and (.root_password_ssh_effective | not) and
       .network_scope == null and (.detail | length > 0)' \
    "$state/bootstrap/development-access-status.json" >/dev/null
: > "$work/systemctl-calls"
run_apply
grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
test ! -e "$state/etc/development-access-ssh-reload.pending"
test -f "$work/systemctl-state/ssh-password-active"
jq -e '.root_password_ssh_requested and .root_password_ssh_effective and
       .network_scope == "192.0.2.0/24"' "$state/bootstrap/development-access-status.json" >/dev/null

# Disabling also retries a failed reload after the drop-in is already absent.
write_policy false false
: > "$work/systemctl-calls"
if SYSTEMCTL_FAIL_SSH=1 run_apply; then
    printf '%s\n' 'SSH disable reload failure returned success' >&2
    exit 1
fi
test ! -e "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
test -f "$state/etc/development-access-ssh-reload.pending"
test -f "$work/systemctl-state/ssh-password-active"
: > "$work/systemctl-calls"
run_apply
grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
test ! -e "$state/etc/development-access-ssh-reload.pending"
test ! -e "$work/systemctl-state/ssh-password-active"

# A disable/stop failure preserves the active observation and writes status.
rm -rf "$work/systemctl-state"
install -d "$work/systemctl-state"
: > "$work/systemctl-state/enabled"
: > "$work/systemctl-state/active"
: > "$work/systemctl-calls"
write_policy false false
: > "$work/systemctl-state/fail-stop"
if run_apply; then
    printf '%s\n' 'console stop failure returned success' >&2
    exit 1
fi
jq -e '(.local_root_console_requested | not) and (.local_root_console_persisted | not) and
       .local_root_console_active and (.local_root_console_effective | not) and
       (.root_password_ssh_effective | not)' "$state/bootstrap/development-access-status.json" >/dev/null

# Invalid input revokes managed password SSH before a later shadow-lock failure.
rm -rf "$work/systemctl-state"
install -d "$work/systemctl-state"
: > "$work/systemctl-calls"
write_policy false true
run_apply
test -f "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
test -f "$work/systemctl-state/ssh-password-active"
grep -Fq "root:$hash:" "$system/etc/shadow"
printf '%s\n' '{"schema":"invalid"}' > "$state/bootstrap/development-access.json"
rm -f "$state/etc/shadow.lock"
mkdir "$state/etc/shadow.lock"
: > "$work/systemctl-calls"
if run_apply; then
    printf '%s\n' 'invalid policy with shadow-lock failure returned success' >&2
    exit 1
fi
test ! -e "$system/etc/ssh/sshd_config.d/90-youeye-development-access.conf"
test ! -e "$work/systemctl-state/ssh-password-active"
grep -Fxq 'try-reload-or-restart ssh.service' "$work/systemctl-calls"
grep -Fq "root:$hash:" "$system/etc/shadow"
jq -e '.schema == "youeye.development-access-status.v2" and
       (.local_root_console_requested | not) and (.root_password_ssh_requested | not) and
       (.root_password_ssh_effective | not) and
       .detail == "Development access policy is invalid; secure defaults were requested"' \
    "$state/bootstrap/development-access-status.json" >/dev/null
rm -rf "$state/etc/shadow.lock"

# Invalid input fails closed yet leaves a v2 status record.
printf '%s\n' '{"schema":"invalid"}' > "$state/bootstrap/development-access.json"
: > "$work/systemctl-calls"
if run_apply; then
    printf '%s\n' 'invalid policy returned success' >&2
    exit 1
fi
jq -e '.schema == "youeye.development-access-status.v2" and
       (.local_root_console_requested | not) and (.root_password_ssh_requested | not) and
       (.root_password_ssh_effective | not) and (.detail | length > 0)' \
    "$state/bootstrap/development-access-status.json" >/dev/null

# State staging remains outside sealed /etc.
test ! -e "$system/etc/shadow.tmp"
test -f "$state/etc/shadow.lock"
test "$(stat -c %a "$state/etc/shadow.lock")" = 600
! grep -Fq 'tmp=$shadow.tmp' "$script"
grep -Fq 'mktemp "$state_root/etc/.shadow.XXXXXX"' "$script"

printf '%s\n' 'youeye development access tests passed'
