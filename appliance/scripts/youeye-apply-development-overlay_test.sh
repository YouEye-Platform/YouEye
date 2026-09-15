#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script=$root/appliance/scripts/youeye-apply-development-overlay
work=$(mktemp -d)
cleanup() {
	code=$?
	trap - EXIT INT TERM
	rm -rf "$work"
	exit "$code"
}
trap cleanup EXIT INT TERM
state=$work/state
runtime=$work/run
systemd=$work/systemd
id=devart-b-1787209999-001
commit=0123456789abcdef0123456789abcdef01234567
artifact=$state/artifacts/$id
mkdir -p "$artifact/payload/bin" "$artifact/payload/libexec" "$state/active"
printf '#!/bin/sh\nexit 0\n' > "$artifact/payload/bin/youeye-installer"
printf '#!/bin/sh\nexit 0\n' > "$artifact/payload/libexec/youeye-apply-development-access"
chmod 0755 "$artifact/payload/bin/youeye-installer" "$artifact/payload/libexec/youeye-apply-development-access"
tar -C "$artifact/payload" -cf "$artifact/installer-runtime-overlay.tar" .
rm -rf "$artifact/payload"
chmod 0700 "$artifact"
chmod 0600 "$artifact/installer-runtime-overlay.tar"
digest=$(sha256sum "$artifact/installer-runtime-overlay.tar" | awk '{print $1}')
jq -n -S --arg id "$id" --arg commit "$commit" --arg digest "$digest" \
	'{schema:"youeye.development-overlay.v1",component:"installer",artifact_id:$id,source_commit:$commit,sha256:$digest}' > "$state/active/installer.json"
chmod 0600 "$state/active/installer.json"

run_overlay() {
	YOUEYE_DEVELOPMENT_OVERLAY_STATE_ROOT=$state \
	YOUEYE_DEVELOPMENT_OVERLAY_RUNTIME_ROOT=$runtime \
	YOUEYE_DEVELOPMENT_OVERLAY_SYSTEMD_ROOT=$systemd \
	YOUEYE_DEVELOPMENT_OVERLAY_NO_SYSTEMCTL=true \
	YOUEYE_DEVELOPMENT_OVERLAY_REQUIRED_UID=$(id -u) \
	"$script" "$@"
}

run_overlay activate
jq -e --arg id "$id" '.state == "active" and .unsigned == true and .artifact_id == $id' "$runtime/installer.json" >/dev/null
jq -e '.state == "active" and .reason == "verified-and-activated"' "$state/status/installer.json" >/dev/null
grep -Fq "$artifact/runtime/bin/youeye-installer console --console-kind physical" "$systemd/youeye-console-status.service.d/90-youeye-development-overlay.conf"
grep -Fq "$artifact/runtime/bin/youeye-installer console --console-kind serial" "$systemd/youeye-console-serial.service.d/90-youeye-development-overlay.conf"
grep -Fq "$artifact/runtime/libexec/youeye-apply-development-access" "$systemd/youeye-development-access.service.d/90-youeye-development-overlay.conf"

run_overlay deactivate "$id"
test ! -e "$state/active/installer.json"
test ! -e "$runtime/installer.json"
test ! -e "$artifact/runtime"
test ! -e "$systemd/youeye-console-status.service.d/90-youeye-development-overlay.conf"
jq -e '.state == "inactive" and .reason == "operator-deactivated"' "$state/status/installer.json" >/dev/null

# A corrupt retained payload is disabled at boot and the signed service files
# remain authoritative; boot itself still succeeds.
mkdir -p "$state/active"
jq -n -S --arg id "$id" --arg commit "$commit" --arg digest "$digest" \
	'{schema:"youeye.development-overlay.v1",component:"installer",artifact_id:$id,source_commit:$commit,sha256:$digest}' > "$state/active/installer.json"
chmod 0600 "$state/active/installer.json"
printf x >> "$artifact/installer-runtime-overlay.tar"
run_overlay boot
test ! -e "$state/active/installer.json"
test -e "$state/failed/installer.json"
jq -e '.state == "fallback" and .reason == "artifact-verification-failed"' "$state/status/installer.json" >/dev/null

# Explicit activation reports the same invalid marker as a failure rather than
# allowing Infra to mistake signed-baseline fallback for overlay acceptance.
cp "$state/failed/installer.json" "$state/active/installer.json"
chmod 0600 "$state/active/installer.json"
if run_overlay activate; then
	printf '%s\n' 'explicit activation accepted a corrupt artifact' >&2
	exit 1
fi

printf '%s\n' 'youeye development overlay lifecycle tests passed'
