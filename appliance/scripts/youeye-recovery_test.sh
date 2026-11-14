#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
recovery="$root/appliance/scripts/youeye-recovery"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

state="$tmp/state"
esp="$tmp/esp"
support="$tmp/support"
fake_bin="$tmp/bin"
mkdir -p "$state/boot" "$esp/EFI/Linux" "$esp/loader/entries" "$support" "$fake_bin"
printf 'stale\n' > "$esp/EFI/Linux/youeye-system-a.efi"
printf 'stale\n' > "$esp/EFI/Linux/youeye-system-b.efi"
printf 'stale\n' > "$esp/EFI/Linux/youeye-recovery.efi"
printf 'stale\n' > "$esp/loader/entries/youeye-system-a.conf"
printf 'stale\n' > "$esp/loader/entries/youeye-system-a+0-3.conf"
printf 'stale\n' > "$esp/loader/entries/youeye-system-b+0-3.conf"

printf 'system-a-trusted\n' > "$state/boot/system-a.efi"
printf 'system-b-trusted\n' > "$state/boot/system-b.efi"
printf 'recovery-trusted\n' > "$state/boot/recovery.efi"

write_manifest() {
    jq -nc \
        --arg a "$(sha256sum "$state/boot/system-a.efi" | cut -d ' ' -f 1)" \
        --arg b "$(sha256sum "$state/boot/system-b.efi" | cut -d ' ' -f 1)" \
        --arg r "$(sha256sum "$state/boot/recovery.efi" | cut -d ' ' -f 1)" \
		'{image_version:"0.6.0-dev.26",recovery_version:"1",artifacts:[
            {role:"system-a-uki",sha256:$a},
            {role:"system-b-uki",sha256:$b},
            {role:"recovery-uki",sha256:$r}
        ]}' > "$state/appliance-manifest.json"
    chmod 0600 "$state/appliance-manifest.json"
    jq -nc --arg sha "$(sha256sum "$state/appliance-manifest.json" | cut -d ' ' -f 1)" \
        '{schema:"youeye.core-release.v1",authority:"digest",members:[{role:"spine",artifact:{sha256:"x"}},{role:"appliance",artifact:{sha256:$sha}}]}' \
        > "$tmp/core-release.json"
    chmod 0600 "$tmp/core-release.json"
}

cat > "$fake_bin/findfs" <<EOF
#!/bin/sh
printf '%s\n' '$tmp/esp-device'
EOF
cat > "$fake_bin/mount" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${TEST_MOUNT_LOG:-/dev/null}"
exit 0
EOF
cat > "$fake_bin/umount" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${TEST_UMOUNT_LOG:-/dev/null}"
exit 0
EOF
cat > "$fake_bin/bootctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${TEST_BOOTCTL_LOG:-/dev/null}"
exit 0
EOF
cat > "$fake_bin/blkid" <<'EOF'
#!/bin/sh
if [ "${1:-}" = -o ] && [ "${2:-}" = device ] && [ "${3:-}" = -t ]; then
    label=${4#LABEL=}
    if [ "$label" = "${TEST_SUPPORT_LABEL:-YOUEYE-SUP}" ]; then
        printf '%s\n' "${TEST_SUPPORT_DEVICE:?}"
        if [ "${TEST_DUPLICATE_LABEL:-0}" = 1 ]; then
            printf '%s\n' "${TEST_SECOND_SUPPORT_DEVICE:?}"
        fi
    fi
    exit 0
fi
if [ "${1:-}" = -s ] && [ "${2:-}" = PARTLABEL ]; then
    printf '%s' "${TEST_PARTLABEL:-}"
    exit 0
fi
if [ "${1:-}" = -s ] && [ "${2:-}" = TYPE ]; then
    printf '%s\n' "${TEST_FSTYPE:-vfat}"
    exit 0
fi
exit 1
EOF
cat > "$fake_bin/findmnt" <<'EOF'
#!/bin/sh
if [ "${TEST_EXISTING_MOUNT:-0}" = 1 ]; then
    case " $* " in
        *' -o TARGET '*) printf '%s\n' "${TEST_SUPPORT_MOUNT:?}"; exit 0 ;;
        *' -o OPTIONS '*) printf '%s\n' "${TEST_EXISTING_OPTIONS:-rw}"; exit 0 ;;
    esac
fi
exit 1
EOF
cat > "$fake_bin/youeye" <<'EOF'
#!/bin/sh
printf '%s\n' 'Appliance health (recovery): healthy'
printf '%s\n' '  PASS  Recovery boot                isolated Recovery target is active'
EOF
cat > "$fake_bin/lsblk" <<'EOF'
#!/bin/sh
printf '%s\n' 'NAME PATH SIZE MODEL SERIAL RO RM FSTYPE LABEL PARTLABEL MOUNTPOINTS'
EOF
cat > "$fake_bin/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' '0 loaded units listed.'
EOF
chmod 0755 "$fake_bin"/*
touch "$tmp/esp-device" "$tmp/support-device" "$tmp/support-device-2"

run_repair() {
    YOUEYE_RECOVERY_PATH="$fake_bin:/usr/bin:/bin" \
    YOUEYE_RECOVERY_INSTALLER_STATE="$state" \
	YOUEYE_RECOVERY_CORE_RELEASE="$tmp/core-release.json" \
	YOUEYE_RECOVERY_APPLIANCE_STATE="$tmp/appliance-state.json" \
	YOUEYE_RECOVERY_UPDATE_BOOT="$tmp/update-boot" \
    YOUEYE_RECOVERY_ESP_DEVICE="$tmp/esp-device" \
    YOUEYE_RECOVERY_ESP_MOUNT="$esp" \
    TEST_MOUNT_LOG="$tmp/mount.log" \
    TEST_UMOUNT_LOG="$tmp/umount.log" \
    TEST_BOOTCTL_LOG="$tmp/bootctl.log" \
        "$recovery" --repair-boot
}

run_export() {
    TEST_SUPPORT_DEVICE="$tmp/support-device" \
    TEST_SECOND_SUPPORT_DEVICE="$tmp/support-device-2" \
    TEST_SUPPORT_LABEL="${TEST_SUPPORT_LABEL:-YOUEYE-SUP}" \
    TEST_DUPLICATE_LABEL="${TEST_DUPLICATE_LABEL:-0}" \
    TEST_PARTLABEL="${TEST_PARTLABEL:-}" \
    TEST_FSTYPE="${TEST_FSTYPE:-vfat}" \
    TEST_EXISTING_MOUNT="${TEST_EXISTING_MOUNT:-0}" \
    TEST_EXISTING_OPTIONS="${TEST_EXISTING_OPTIONS:-rw}" \
    TEST_SUPPORT_MOUNT="$support" \
    TEST_MOUNT_LOG="$tmp/mount.log" \
    TEST_UMOUNT_LOG="$tmp/umount.log" \
    YOUEYE_RECOVERY_PATH="$fake_bin:/usr/bin:/bin" \
    YOUEYE_RECOVERY_SUPPORT_MOUNT="$support" \
    YOUEYE_RECOVERY_YOUEYE="$fake_bin/youeye" \
        "$recovery" --export-support
}

esp_digest() {
    find "$esp" -type f -printf '%P\0' | sort -z |
        xargs -0 -r -I{} sha256sum "$esp/{}" |
        sha256sum | cut -d ' ' -f 1
}

write_manifest
: > "$tmp/mount.log"
: > "$tmp/bootctl.log"
run_repair
cmp -s "$state/boot/system-a.efi" "$esp/EFI/YouEye/youeye-system-a.efi"
cmp -s "$state/boot/system-b.efi" "$esp/EFI/YouEye/youeye-system-b.efi"
cmp -s "$state/boot/recovery.efi" "$esp/EFI/YouEye/youeye-recovery.efi"
test ! -e "$esp/EFI/Linux/youeye-system-a.efi"
test ! -e "$esp/EFI/Linux/youeye-system-b.efi"
test ! -e "$esp/EFI/Linux/youeye-recovery.efi"
test ! -e "$esp/loader/entries/youeye-system-a.conf"
test ! -e "$esp/loader/entries/youeye-system-a+0-3.conf"
test ! -e "$esp/loader/entries/youeye-system-b+0-3.conf"
if grep -Eq '^default[[:space:]]' "$esp/loader/loader.conf"; then
    printf '%s\n' 'Recovery repair installed a forcing boot default' >&2
    exit 1
fi
grep -Fxq 'efi /EFI/YouEye/youeye-system-a.efi' "$esp/loader/entries/youeye-system-a+3-0.conf"
grep -Fxq 'efi /EFI/YouEye/youeye-system-b.efi' "$esp/loader/entries/youeye-system-b+3-0.conf"
grep -Fxq -- "-t vfat -o rw,nodev,nosuid,noexec,umask=0077 $tmp/esp-device $esp" "$tmp/mount.log"
grep -Fxq -- "--esp-path=$esp --no-variables install" "$tmp/bootctl.log"
grep -Fxq -- "--esp-path=$esp set-default " "$tmp/bootctl.log"
grep -Fxq -- "--esp-path=$esp set-oneshot " "$tmp/bootctl.log"

for role in system-a system-b recovery; do
    before="$(esp_digest)"
    printf 'corrupt\n' >> "$state/boot/$role.efi"
    if run_repair >/dev/null 2>&1; then
        printf 'corrupt %s backup was accepted\n' "$role" >&2
        exit 1
    fi
    test "$(esp_digest)" = "$before"
    sed -i '$d' "$state/boot/$role.efi"
done

before="$(esp_digest)"
jq '.members[1].artifact.sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' "$tmp/core-release.json" > "$tmp/core-release.next"
mv "$tmp/core-release.next" "$tmp/core-release.json"
if run_repair >/dev/null 2>&1; then
    printf '%s\n' 'manifest outside the accepted core release was accepted' >&2
    exit 1
fi
test "$(esp_digest)" = "$before"
write_manifest
chmod 0666 "$state/appliance-manifest.json"
if run_repair >/dev/null 2>&1; then
    printf '%s\n' 'unprotected installed manifest was accepted' >&2
    exit 1
fi
test "$(esp_digest)" = "$before"

write_manifest
mkdir -p "$tmp/update-boot/b/0.6.0-dev.27"
printf 'system-b-version-0.6.0-dev.27\n' > "$tmp/update-boot/b/0.6.0-dev.27/system.efi"
jq -nc \
	--arg hash "$(sha256sum "$tmp/update-boot/b/0.6.0-dev.27/system.efi" | cut -d ' ' -f 1)" \
	'{schema:"youeye.system-update.v1",target_image_version:"0.6.0-dev.27",
	  recovery_version:"1",artifacts:[{role:"system-b-uki",sha256:$hash}]}' \
	> "$tmp/update-boot/b/0.6.0-dev.27/manifest.json"
chmod 0600 "$tmp/update-boot/b/0.6.0-dev.27/manifest.json"
jq -nc '{schema_version:1,slots:{current:"B",current_image_version:"0.6.0-dev.27",
	previous:"A",previous_image_version:"0.6.0-dev.26"},transaction:{}}' \
	> "$tmp/appliance-state.json"
run_repair
cmp -s "$tmp/update-boot/b/0.6.0-dev.27/system.efi" "$esp/EFI/YouEye/youeye-system-b.efi"
grep -Fxq 'version 0.6.0-dev.27-b' "$esp/loader/entries/youeye-system-b+3-0.conf"

before="$(esp_digest)"
printf 'corrupt\n' >> "$tmp/update-boot/b/0.6.0-dev.27/system.efi"
if run_repair >/dev/null 2>&1; then
	printf '%s\n' 'corrupt updated-version UKI was accepted' >&2
	exit 1
fi
test "$(esp_digest)" = "$before"
rm -f "$tmp/appliance-state.json"
sed -i '$d' "$tmp/update-boot/b/0.6.0-dev.27/system.efi"
run_repair
cmp -s "$state/boot/system-b.efi" "$esp/EFI/YouEye/youeye-system-b.efi"

write_manifest
before="$(esp_digest)"
printf 'corrupt\n' >> "$state/appliance-manifest.json"
if run_repair >/dev/null 2>&1; then
    printf '%s\n' 'changed installed manifest was accepted' >&2
    exit 1
fi
test "$(esp_digest)" = "$before"

: > "$tmp/mount.log"
: > "$tmp/umount.log"
TEST_SUPPORT_LABEL=YOUEYE-SUP TEST_FSTYPE=vfat run_export
mapfile -t support_files < <(find "$support" -maxdepth 1 -type f -name 'youeye-support-*.txt')
test "${#support_files[@]}" -eq 1
grep -Fq 'Appliance health (recovery): healthy' "${support_files[0]}"
test "$(stat -c %a "${support_files[0]}")" = 600
grep -Fq -- "-t vfat -o rw,nodev,nosuid,noexec,umask=0077 $tmp/support-device $support" "$tmp/mount.log"
grep -Fxq "$support" "$tmp/umount.log"

rm -f "$support"/youeye-support-*.txt
: > "$tmp/mount.log"
: > "$tmp/umount.log"
TEST_SUPPORT_LABEL=YOUEYE-SUPPORT TEST_FSTYPE=ext4 run_export
mapfile -t support_files < <(find "$support" -maxdepth 1 -type f -name 'youeye-support-*.txt')
test "${#support_files[@]}" -eq 1
grep -Fq -- "-t ext4 -o rw,nodev,nosuid,noexec $tmp/support-device $support" "$tmp/mount.log"

rm -f "$support"/youeye-support-*.txt
before_mounts=$(wc -l < "$tmp/mount.log")
if TEST_DUPLICATE_LABEL=1 run_export >/dev/null 2>&1; then
    printf '%s\n' 'duplicate support labels were accepted' >&2
    exit 1
fi
test "$(wc -l < "$tmp/mount.log")" = "$before_mounts"
test -z "$(find "$support" -maxdepth 1 -type f -name 'youeye-support-*.txt' -print -quit)"

if TEST_PARTLABEL=YE-STATE run_export >/dev/null 2>&1; then
    printf '%s\n' 'protected appliance partition was accepted as support media' >&2
    exit 1
fi

if TEST_EXISTING_MOUNT=1 TEST_EXISTING_OPTIONS=rw run_export >/dev/null 2>&1; then
    printf '%s\n' 'support media mounted without restrictive options was accepted' >&2
    exit 1
fi

# Recovery is frozen at install: it must accept State and release documents
# whose schema numbers and authority fields later releases change.
write_manifest
jq -nc --arg sha "$(sha256sum "$state/appliance-manifest.json" | cut -d ' ' -f 1)" \
    '{schema:"youeye.core-release.v9",authority:"signed",members:[{role:"appliance",artifact:{sha256:$sha},extra:1}]}' > "$tmp/core-release.json"
chmod 0600 "$tmp/core-release.json"
printf '%s\n' '{"schema_version":1,"slots":{"current":"A","current_image_version":"0.6.0-dev.26"},"newer":true}' > "$tmp/appliance-state.json"
chmod 0600 "$tmp/appliance-state.json"
rm -f "$tmp/bootctl.log"
run_repair >/dev/null || { echo "FAIL: repair refused a newer State/release format" >&2; exit 1; }
grep -q -- ' install$' "$tmp/bootctl.log" || { echo "FAIL: first repair must install systemd-boot" >&2; exit 1; }
# With systemd-boot present, repair updates (never downgrades) it.
mkdir -p "$esp/EFI/systemd" && printf 'newer\n' > "$esp/EFI/systemd/systemd-bootx64.efi"
rm -f "$tmp/bootctl.log"
run_repair >/dev/null || { echo "FAIL: repair with systemd-boot present" >&2; exit 1; }
grep -q -- '--graceful update$' "$tmp/bootctl.log" && ! grep -q -- ' install$' "$tmp/bootctl.log" ||
    { echo "FAIL: repair must use bootctl update when systemd-boot exists" >&2; cat "$tmp/bootctl.log" >&2; exit 1; }

# Generic requests: any well-formed kind is queued; extra items come from a
# protected menu file written by updatable code.
requests="$tmp/requests"
YOUEYE_RECOVERY_REQUEST_DIR="$requests" "$recovery" --queue reset-owner-password
jq -e '.operation == "reset-owner-password" and .stage == "queued"' "$requests/request.json" >/dev/null ||
    { echo "FAIL: reset-owner-password not queued" >&2; exit 1; }
rm -f "$requests/request.json"
YOUEYE_RECOVERY_REQUEST_DIR="$requests" "$recovery" --queue some-later-kind ||
    { echo "FAIL: a later request kind was refused" >&2; exit 1; }
rm -f "$requests/request.json"
if YOUEYE_RECOVERY_REQUEST_DIR="$requests" "$recovery" --queue 'Bad Kind;rm' 2>/dev/null; then
    echo "FAIL: malformed request kind queued" >&2; exit 1
fi
printf '%s\n' '{"schema":"youeye.recovery-menu.v1","items":[{"operation":"rotate-keys","title":"Rotate keys","confirm":"Rotates them."},{"operation":"BAD","title":"x","confirm":"y"},{"operation":"factory-reset","title":"dup","confirm":"z"}]}' > "$requests/menu.json"
chmod 0600 "$requests/menu.json"
extra=$(YOUEYE_RECOVERY_REQUEST_DIR="$requests" "$recovery" --list-extra)
[ "$extra" = "$(printf 'rotate-keys\tRotate keys\tRotates them.')" ] || { echo "FAIL: extra menu items: $extra" >&2; exit 1; }
chmod 0666 "$requests/menu.json"
[ -z "$(YOUEYE_RECOVERY_REQUEST_DIR="$requests" "$recovery" --list-extra)" ] || { echo "FAIL: unprotected menu file read" >&2; exit 1; }

printf '%s\n' 'PASS: Recovery repair and support export fail closed'
