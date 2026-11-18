#!/bin/bash
# Tests the live installer's choice between the silent, graphical and text installers.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/appliance/live/youeye-live-installer"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    [ -f "${T:-}/log" ] && sed 's/^/  log: /' "$T/log" >&2
    exit 1
}

# setup <name>: a fresh sandbox with stub commands. Files steer the stubs:
#   cog-modes   one mode per cog start: fail (exit at once), late (exit after 1.5 s), run (paints, until stopped),
#               blank (runs but the page never paints)
#   serve-exit  serve exits with this status as soon as the file exists
#   ready       curl reports serve ready
setup() {
    T="$work/$1"
    mkdir -p "$T/bin" "$T/dri" "$T/run" "$T/medium"
    : > "$T/log"
    : > "$T/serial"
    : > "$T/tty"
    printf 'boot=live components quiet\n' > "$T/cmdline"
    : > "$T/dri/card0"
    : > "$T/ready"
    printf 'run\n' > "$T/cog-modes"
    for command in chvt sync; do
        printf '#!/bin/sh\nexit 0\n' > "$T/bin/$command"
    done
    cat > "$T/bin/systemctl" <<'STUB'
#!/bin/sh
echo "systemctl $*" >> "$T/log"
STUB
    cat > "$T/bin/curl" <<'STUB'
#!/bin/sh
[ -e "$T/ready" ]
STUB
    cat > "$T/bin/findfs" <<'STUB'
#!/bin/sh
[ -e "$T/answer-device" ] && cat "$T/answer-device"
STUB
    cat > "$T/bin/mount" <<'STUB'
#!/bin/sh
for target; do :; done
echo '{}' > "$target/appliance-answer.json"
echo "mount $*" >> "$T/log"
STUB
    cat > "$T/bin/youeye-installer" <<'STUB'
#!/bin/bash
echo "installer $*" >> "$T/log"
if [ "$1" = serve ]; then
    trap 'echo "serve stopped" >> "$T/log"; exit 143' TERM
    echo "YouEye installer: [ 10%] Verify appliance release"
    while [ ! -e "$T/serve-exit" ]; do sleep 0.1; done
    echo "serve exited" >> "$T/log"
    exit "$(cat "$T/serve-exit")"
fi
exit 0
STUB
    cat > "$T/bin/cage" <<'STUB'
#!/bin/bash
echo "cage $* WLR_RENDERER=$WLR_RENDERER" >> "$T/log"
while [ "$1" != "--" ]; do shift; done
shift
# Like the real cage: cog runs as its child, and on SIGTERM cage still waits for cog to end.
"$@" &
child=$!
trap 'echo "cage got TERM" >> "$T/log"' TERM
while :; do
    wait "$child"; status=$?
    kill -0 "$child" 2>/dev/null || break
done
exit "$status"
STUB
    cat > "$T/bin/cog" <<'STUB'
#!/bin/bash
echo "cog $* XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$T/log"
mode="$(head -n 1 "$T/cog-modes")"
[ "$(wc -l < "$T/cog-modes")" -gt 1 ] && sed -i 1d "$T/cog-modes"
trap 'echo "cog stopped" >> "$T/log"; exit 143' TERM
case "$mode" in
    fail) exit 1 ;;
    late) sleep 1.5; exit 0 ;;
    run) : > "$T/run/kiosk/ui-ready"; while :; do sleep 0.1; done ;;
    blank) while :; do sleep 0.1; done ;;
esac
STUB
    chmod 0755 "$T"/bin/*
}

launch() {
    T="$T" PATH="$T/bin:$PATH" \
    YOUEYE_LIVE_INSTALLER="$T/bin/youeye-installer" \
    YOUEYE_LIVE_CMDLINE="$T/cmdline" \
    YOUEYE_LIVE_DRI_DIR="$T/dri" \
    YOUEYE_LIVE_SERIAL="$T/serial" \
    YOUEYE_LIVE_TTY="$T/tty" \
    YOUEYE_LIVE_RUN_DIR="$T/run" \
    YOUEYE_LIVE_MEDIUM="$T/medium" \
    YOUEYE_LIVE_KIOSK_GRACE_SECONDS=1 \
    YOUEYE_LIVE_SERVE_READY_SECONDS=1 \
    YOUEYE_LIVE_UI_READY_SECONDS=4 \
    timeout 30 "$script" 2>> "$T/stderr"
}

# serve_exits_after <seconds> <status>: the owner ends the graphical session.
serve_exits_after() {
    (sleep "$1"; printf '%s\n' "$2" > "$T/serve-exit") &
}

has() { grep -Fq -- "$1" "$T/log" || fail "$name: log is missing: $1"; }
lacks() { ! grep -Fq -- "$1" "$T/log" || fail "$name: log must not contain: $1"; }
count() { [ "$(grep -Fc -- "$1" "$T/log")" -eq "$2" ] || fail "$name: expected $2 x $1"; }
last_is_poweroff() { [ "$(tail -n 1 "$T/log")" = "systemctl poweroff" ] || fail "$name: the machine must turn off last"; }
before() {
    local first second
    first="$(grep -Fn -- "$1" "$T/log" | head -n 1 | cut -d: -f1)"
    second="$(grep -Fn -- "$2" "$T/log" | head -n 1 | cut -d: -f1)"
    [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] || fail "$name: $1 must come before $2"
}

name="text mode from GRUB"
setup text-mode
printf 'boot=live components youeye.text=1 quiet\n' > "$T/cmdline"
launch
has 'installer install'
lacks 'installer serve'
lacks 'cog '
last_is_poweroff

name="no DRM device"
setup no-drm
rm "$T/dri/card0"
launch
has 'installer install'
lacks 'installer serve'
last_is_poweroff

name="graphical session ends with turn off"
setup graphical
serve_exits_after 1 0
launch
has 'installer serve --listen 127.0.0.1:8090'
has "cog -P wl http://127.0.0.1:8090/ XDG_RUNTIME_DIR=$T/run/kiosk"
has "cage -s -- cog -P wl http://127.0.0.1:8090/ WLR_RENDERER=pixman"
has 'cog stopped'
lacks 'installer install'
last_is_poweroff
grep -Fq 'YouEye installer: [ 10%] Verify appliance release' "$T/serial" || fail "$name: serial console lacks plain progress text"
[ "$(stat -c %a "$T/run/kiosk")" = 700 ] || fail "$name: the kiosk runtime directory must be private"

name="cog fails at once: text installer"
setup cog-fails
printf 'fail\n' > "$T/cog-modes"
launch
has 'serve stopped'
before 'cog -P wl' 'installer install'
before 'serve stopped' 'installer install'
last_is_poweroff
grep -Fq 'using the text installer' "$T/stderr" || fail "$name: the fallback must be logged"

name="a GPU render node: wlroots picks its renderer"
setup render-node
: > "$T/dri/renderD128"
serve_exits_after 1 0
launch
has 'WLR_RENDERER=auto'

name="the page never paints (renderer crash): text installer"
setup cog-blank
printf 'blank\n' > "$T/cog-modes"
launch
has 'cog stopped'
has 'serve stopped'
before 'cog stopped' 'installer install'
last_is_poweroff
grep -Fq 'did not appear' "$T/stderr" || fail "$name: the fallback must be logged"

name="cog ends after the grace period: started again"
setup cog-late
printf 'late\nrun\n' > "$T/cog-modes"
serve_exits_after 3 0
launch
count 'cage -s --' 2
lacks 'installer install'
last_is_poweroff

name="cog fails during an installation: never a second installer"
setup cog-fails-installing
printf 'fail\nrun\n' > "$T/cog-modes"
: > "$T/run/interactive-answer.json"
serve_exits_after 2 1
launch
count 'cage -s --' 2
lacks 'installer install'
lacks 'serve stopped'
last_is_poweroff

name="serve never answers: text installer"
setup serve-not-ready
rm "$T/ready"
launch
has 'serve stopped'
lacks 'cog '
has 'installer install'
last_is_poweroff

name="serve fails before an installation: text installer"
setup serve-fails
serve_exits_after 1 1
launch
has 'cog stopped'
before 'serve exited' 'installer install'
last_is_poweroff

name="answer disk: silent install, unchanged"
setup answer-disk
printf '/dev/sdb\n' > "$T/answer-device"
launch
has "mount -o ro,nodev,nosuid,noexec /dev/sdb $T/run/answer"
has "installer install --silent --yes --answer $T/run/answer/appliance-answer.json"
lacks 'installer serve'
lacks 'cog '
last_is_poweroff
[ "$(readlink "$T/run/artifacts")" = "$T/medium" ] || fail "$name: artifacts link is missing"

grep -Fq 'YOUEYE_LIVE_KIOSK_GRACE_SECONDS:-20' "$script" || fail 'cog must get 20 seconds before the text fallback'
grep -Fq 'tee "$serial"' "$script" || fail 'silent installs must copy progress to the serial console'
grep -Fq 'serial=${YOUEYE_LIVE_SERIAL:-/dev/ttyS0}' "$script" || fail 'the serial console is ttyS0'

printf 'PASS: live installer chooses silent, graphical or text\n'
