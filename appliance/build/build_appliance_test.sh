#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
"$root/scripts/check-public-release-hygiene.sh" "$root" >/dev/null
node "$root/scripts/generate-third-party-notices.mjs" "$root/THIRD_PARTY_NOTICES.txt"
node "$root/legal/third-party-assets.test.mjs" >/dev/null
python3 "$root/appliance/scripts/youeye-system-update-bootstrap_test.py"
build="$root/appliance/build/build-appliance.sh"
entrypoint="$root/.youeye/build/appliance"

require_default() {
    local text=$1
    grep -Fq -- "$text" "$build" || fail "build defaults are missing: $text"
}

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

require_text() {
    local file=$1 text=$2
    grep -Fq -- "$text" "$file" || fail "$file is missing: $text"
}

bash -n \
    "$build" \
    "$root/appliance/build/build-inputs.sh" \
    "$root/appliance/build/build_inputs_test.sh" \
    "$entrypoint" \
    "$root/spine/internal/boot/scripts/first-deploy.sh" \
    "$root/spine/internal/boot/scripts/network.sh" \
    "$root/appliance/scripts/youeye-console-status" \
    "$root/appliance/scripts/youeye-apply-development-access" \
    "$root/spine/internal/boot/scripts/bless.sh" \
    "$root/spine/internal/boot/scripts/setup-gate.sh" \
	"$root/appliance/scripts/youeye-recovery" \
	"$root/appliance/scripts/youeye-recovery-console" \
	"$root/appliance/scripts/youeye-recovery-apply" \
	"$root/appliance/scripts/youeye-apply-development-overlay" \
	"$root/appliance/scripts/youeye-system-update-bootstrap" \
    "$root/appliance/initramfs/youeye-state" \
    "$root/appliance/initramfs/youeye-state-hook"

for text in \
    'export HOME="$YOUEYE_WORK_DIR/home"' \
    'export GOMODCACHE="${YOUEYE_GOMODCACHE:-$YOUEYE_WORK_DIR/go-mod-cache}"' \
    'export GOCACHE="${YOUEYE_GOCACHE:-$YOUEYE_WORK_DIR/go-build-cache}"'; do
    require_text "$entrypoint" "$text"
done

require_text "$root/installer/go.mod" \
    'replace github.com/openwall/yescrypt-go => ./third_party/openwall/yescrypt-go'
for vendored in LICENSE go.mod yescrypt.go yescrypt_wrapper.go; do
    [[ -s $root/installer/third_party/openwall/yescrypt-go/$vendored ]] || \
        fail "source-owned yescrypt dependency is missing: $vendored"
done
require_text "$build" 'e2fsprogs,restic,zstd'

for default in \
	'build_inputs="${BUILD_INPUTS_PATH:-$source_dir/appliance/build-inputs.json}"' \
	'build_inputs_validate "$build_inputs"' \
	'input_value()'; do
    require_default "$default"
done
bash "$root/appliance/build/build_inputs_test.sh"
require_text "$entrypoint" 'export BUILD_INPUTS_PATH="$YOUEYE_BUILD_INPUTS"'
for retired in APPLIANCE_BUILD_MODE APPLIANCE_SIGNING_KEY_FILE APPLIANCE_SIGNING_PUBLIC_KEY_FILE APPLIANCE_TRUST_CLASS RELEASE_LOCK_PATH embed-public-trust 'appliance-development' 'openssl pkey' sbom.spdx.json provenance.json SHA256SUMS 'trust:{'; do
    if grep -Fq -- "$retired" "$build" "$entrypoint"; then
        fail "retired signing or release-lock input remains: $retired"
    fi
done

for removed in SPINE_VERSION SPINE_TAG SPINE_COMMIT SPINE_SOURCE_DATE_EPOCH SPINE_SHA256 CP_VERSION CP_TAG CP_COMMIT CP_SHA256 UI_VERSION UI_TAG UI_COMMIT UI_SHA256 MARKET_SOURCE MARKET_SOURCE_COMMIT; do
    if grep -Fq "\${$removed:-" "$build"; then
        fail "release identity still has an independent environment default: $removed"
    fi
done

for text in \
    'YOUEYE_SOURCE_TREE must provide the exact source tree when Git metadata is absent.' \
    'SOURCE_DATE_EPOCH must be a positive integer when Git metadata is absent.' \
    'Appliance build must emit exactly twelve regular files' \
    'components.spine.source_tree must be the exact Spine source tree.' \
    'components.spine.source_date_epoch must be the exact Spine source epoch.' \
    'components.spine.artifact_sha256 must be the exact Spine binary SHA-256.' \
    'Embedded Spine binary does not match the exact released Spine asset.' \
    'components.control_panel.source_tree must be the exact Control Panel source tree.' \
    'components.control_panel.artifact_sha256 must be the exact Control Panel cp-standalone.tar SHA-256.' \
    'components.ui.source_tree must be the exact UI source tree.' \
    'components.ui.artifact_sha256 must be the exact UI ui-standalone.tar SHA-256.'; do
    require_text "$build" "$text"
done

for retired in release_source release_branch market_source release_channels youeye-seed-market; do
    if grep -Fq "$retired" "$build"; then
        fail "the image must stay host- and channel-neutral; found $retired"
    fi
done
require_text "$build" 'spine_sha256 != "$spine_expected_sha256"'
require_text "$build" '@$spine_source_date_epoch'

require_text "$build" 'lb clean || true'
if grep -Fq 'lb clean --purge' "$build"; then
    fail 'live-build retry must preserve its config tree'
fi
if ! grep -Fq $'lb clean || true\n        configure_live_build' "$build"; then
    fail 'live-build retry must restore its config-stage marker'
fi

awk '/youeye-live-installer.*<</ { capture=1; next } capture && /^EOF$/ { exit } capture' "$build" | bash -n
live_packages="$(awk '/youeye.list.chroot.*<</ { capture=1; next } capture && /^EOF$/ { exit } capture' "$build")"
grep -qx 'systemd-boot-tools' <<<"$live_packages" || fail 'live installer is missing systemd-boot-tools'
grep -qx 'systemd-boot-efi-amd64-signed' <<<"$live_packages" || fail 'live installer is missing the signed systemd-boot EFI binary'
grep -qx 'parted' <<<"$live_packages" || fail 'live installer is missing partprobe from parted'
if grep -qx 'systemd-boot' <<<"$live_packages"; then
    fail 'live installer must not install the stateful systemd-boot integration metapackage'
fi

for text in \
    'mmdebstrap' \
    '--extract-hook=' \
    'sign_file="/usr/lib/youeye/no-module-signing"' \
    'Refusing nondeterministic DKMS MOK material' \
    'modinfo -F signer' \
    'trixie-backports incus-base' \
    '6G YE-SYSTEM-IMAGE' \
    '4G YE-RECOVERY-IMG' \
    'system-root.img.zst' \
    'internal-recovery.img.zst' \
    'system-a.efi' \
	'system-b.efi' \
	'youeye-system-updater-linux-amd64' \
	'youeye-system-update-bootstrap' \
	'recovery.efi' \
	'youeye.appliance.manifest.v1' \
	'youeye.system-update.v1' \
	'system-update-manifest.json' \
	'install -m 0644 "$build_inputs" "$artifacts/build-inputs.json"' \
	'cp -a "$artifacts/." config/includes.binary/appliance/' \
	'preserve_state:true,preserve_data:true,preserve_recovery:true' \
	'artifact_kind:$artifact_kind,supported_actions:["recovery","image-update"]' \
    'spine:{version:$spine_version,source_tree:$spine_tree,artifact_sha256:$spine_sha256}' \
	'disk_layout:{version:1,target_min_gib:32' \
    'state_schema_min:2,state_schema_max:2,data_schema_min:1,data_schema_max:1' \
    'kernel_compatibility:">=6.12",zfs_compatibility:">=2.3",zfs_feature_profile:"openzfs-2.2"' \
    'incus_compatibility:">=7.0",recovery_version:"1"' \
    'live-build' \
    'iso-hybrid' \
    '--gpt_disk_guid "$iso_disk_guid"' \
    '-efi-boot-part --efi-boot-image' \
    '-report_system_area plain' \
    "^GPT[[:space:]]*:[[:space:]]+N[[:space:]]+Info$" \
    '-report_el_torito plain' \
    'protective MBR' \
    'systemd-boot-tools' \
    'systemd-boot-efi-amd64-signed' \
    'config/bootloaders/grub-pc/config.cfg' \
    '9999-youeye-reproducible-cache.hook.chroot' \
	'99youeye-no-binary-cache' \
	'DHCP=ipv4' \
	'IPv6AcceptRA=no' \
	'LinkLocalAddressing=ipv4' \
	'60-youeye-appliance-ipv4-only.conf' \
	'net.ipv6.conf.all.disable_ipv6=1' \
	'precedence ::ffff:0:0/96  100' \
    'Dir::Cache::pkgcache "";' \
    'Dir::Cache::srcpkgcache "";' \
    'rm -f /var/cache/apt/pkgcache.bin /var/cache/apt/srcpkgcache.bin' \
    'set timeout=5' \
    'Restart=no' \
    'StandardError=journal' \
    'chvt 1' \
    '--sort=name' \
    '-O ^orphan_file' \
    'hash_seed=$uuid' \
    '-d - "$image"' \
    'e2fsck -fyD' \
    'set_current_time @' \
    'work_key="$(printf '\''%s'\'' "$work_dir" | sha256sum | cut -c1-16)"' \
    'live_dir="/var/tmp/youeye-appliance-live-${source_tree:0:12}-${work_key}"' \
    'LIVE_BUILD_ATTEMPTS must be a positive integer.' \
    'live-build attempt %d/%d failed; cleaning and retrying.' \
    'lb clean || true' \
    'configure_live_build' \
    '--cache-indices true' \
    'prime_live_build_indices' \
    'cache/indices.bootstrap' \
    'live-build bootstrap did not provide signed package indices.' \
    'Acquire::http::Pipeline-Depth=0' \
    'Acquire::http::Timeout=30' \
    'Acquire::http::Proxy=$live_build_apt_proxy' \
    'mmdebstrap_proxy_options+=(--aptopt="Acquire::http::Proxy \"$live_build_apt_proxy\"")' \
    'snapshot_url="http://snapshot.debian.org/archive/debian/$snapshot"' \
    'Acquire::https::Timeout=30' \
    'live_snapshot_url="http://snapshot.debian.org/archive/debian/$snapshot"' \
    'live-build failed after %d attempt(s).' \
    "trap 'exit 129' HUP" \
    'for suffix in dev/pts dev/shm dev/mqueue dev/hugepages proc/sys/fs/binfmt_misc proc sys run dev' \
    'if mountpoint -q "$target"' \
    'umount -- "$target" || true' \
    'tee /dev/ttyS0' \
    'sleep 2' \
    'After=systemd-udev-settle.service getty@tty1.service serial-getty@ttyS0.service' \
    'Conflicts=getty@tty1.service serial-getty@ttyS0.service' \
    'systemctl poweroff'; do
    require_text "$build" "$text"
done

if grep -Fq 'console=tty0' "$build" || grep -Fq 'systemd.show_status=yes' "$build"; then
    fail 'interactive installer and Recovery VTs must not receive routine kernel/systemd chatter'
fi

require_text "$build" 'youeye-installer-linux-amd64'
require_text "$build" "--iso-application 'YouEye Installer'"
require_text "$build" 'Description=YouEye Installer'
require_text "$build" "-A 'YouEye Installer'"
if grep -Fq 'YouEye Appliance Installer' "$build"; then
    fail 'user-facing ISO and service metadata must use the unified YouEye Installer name'
fi

require_text "$build" 'systemd-analyze --root="$rootfs" verify multi-user.target'
require_text "$build" "grep -Eq 'ordering cycle|deleted to break ordering cycle'"
require_text "$build" 'Refusing appliance image with a systemd ordering cycle.'

if grep -Fq 'mount -o loop "$image"' "$build" || grep -Fq 'rsync -aHAX --numeric-ids "$rootfs/"' "$build"; then
    fail 'root images must be populated offline rather than through kernel ext4 allocation'
fi

if grep -Fq 'Restart=on-failure' "$build"; then
    fail 'failed live installs must remain stopped for inspection'
fi

require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'deploy --resume'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'incus list youeye-control'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'Continuing an interrupted Server interface transaction'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'needs_attention'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'appliance health --profile=operational --json'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'youeye.installer.progress.v1'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'update system converge'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" 'YOUEYE_FIRST_DEPLOY_PROGRESS_PATH'
require_text "$root/spine/internal/boot/scripts/network.sh" 'youeye.bootstrap-network.v1'
require_text "$root/spine/internal/boot/scripts/network.sh" 'previous network configuration was restored'
require_text "$root/spine/internal/boot/scripts/first-deploy.sh" '$setup_gate open'
require_text "$root/appliance/systemd/youeye-setup-gate.service" 'Before=incus.service incus-startup.service youeye.service youeye-first-deploy.service'
require_text "$root/appliance/systemd/youeye-setup-gate.service" 'ExecStart=/usr/local/bin/youeye boot setup-gate close'
require_text "$root/spine/internal/boot/scripts/setup-gate.sh" 'tcp dport { 80, 443 } drop'
require_text "$root/appliance/initramfs/youeye-state" '/root/etc/machine-id'
require_text "$root/appliance/initramfs/youeye-state" '/root/etc/hostid'
require_text "$root/appliance/initramfs/youeye-state" '/root/etc/shadow'
require_text "$root/appliance/initramfs/youeye-state" '/root/etc/ssh'
require_text "$root/appliance/initramfs/youeye-state" '"$state_root/root" /root/root'
require_text "$root/appliance/initramfs/youeye-state" '/root/var/lib/systemd'
require_text "$root/appliance/initramfs/youeye-state" '/root/var/log'
require_text "$root/appliance/initramfs/youeye-state" 'migrate_youeye_network_state'
require_text "$root/appliance/initramfs/youeye-state" 'migrate_youeye_state_file "$state_root/etc/shadow" /root/etc/shadow 0640'
require_text "$root/appliance/initramfs/youeye-state-hook" 'youeye-network-state'
require_text "$root/appliance/initramfs/youeye-state-hook" 'youeye-state-migration'
require_text "$build" 'usr/lib/youeye/initramfs/youeye-state-migration'
require_text "$build" 'youeye-development-access.service'
require_text "$build" 'youeye-development-overlay.service'
require_text "$build" 'youeye-apply-development-access'
require_text "$build" 'youeye-console-serial.service'
require_text "$root/appliance/systemd/youeye-console-status.service" 'youeye-installer console --console-kind physical'
require_text "$root/appliance/systemd/youeye-console-serial.service" 'youeye-installer console --console-kind serial'
require_text "$build" 'usr/lib/youeye/initramfs/youeye-network-state'
require_text "$root/appliance/systemd/youeye-appliance-storage.service" 'Before=incus.socket incus-user.socket incus.service youeye.service'
require_text "$root/appliance/systemd/youeye-appliance-storage.service" 'DefaultDependencies=no'
require_text "$root/appliance/systemd/youeye-appliance-storage.service" 'After=youeye-appliance-state.service local-fs.target'
if grep -Fq 'Wants=incus.socket incus-user.socket' "$root/appliance/systemd/youeye-appliance-storage.service"; then
    fail 'storage must not pull early Incus sockets into the sockets.target ordering cycle'
fi
require_text "$root/appliance/systemd/youeye-recovery-apply.service" 'DefaultDependencies=no'
require_text "$root/appliance/systemd/youeye-appliance-incus-sockets.service" 'Requires=youeye-appliance-storage.service youeye-recovery-apply.service incus.socket incus-user.socket'
require_text "$root/appliance/systemd/youeye-appliance-incus-sockets.service" 'After=youeye-appliance-storage.service youeye-recovery-apply.service incus.socket incus-user.socket'
require_text "$root/appliance/systemd/youeye-appliance-incus-sockets.service" 'Before=youeye.service youeye-first-deploy.service'
require_text "$root/appliance/systemd/incus.service.d/youeye-appliance.conf" 'ExecStartPost=/usr/libexec/incus/incusd waitready --timeout=60'
require_text "$root/appliance/systemd/incus.service.d/youeye-appliance.conf" 'TimeoutStartSec=90s'
require_text "$root/appliance/systemd/incus.service.d/youeye-appliance.conf" 'RestartSec=2s'
require_text "$root/appliance/systemd/youeye-core-update.service" 'Requires=youeye-appliance-storage.service youeye-appliance-incus-sockets.service incus.service'
require_text "$root/appliance/systemd/youeye-core-update.service" 'After=network-online.target youeye-appliance-storage.service youeye-appliance-incus-sockets.service incus.service youeye.service youeye-first-deploy.service'
require_text "$root/appliance/systemd/youeye.service" 'Requires=youeye-appliance-storage.service youeye-appliance-incus-sockets.service'
require_text "$root/appliance/systemd/youeye-first-deploy.service" 'Requires=youeye-appliance-storage.service youeye-appliance-incus-sockets.service'
require_text "$root/appliance/systemd/youeye-first-deploy.service" 'Wants=network-online.target youeye.service'
require_text "$root/appliance/systemd/youeye-first-deploy.service" 'StartLimitBurst=8'
require_text "$root/appliance/systemd/youeye-console-status.service" 'Conflicts=getty@tty1.service serial-getty@ttyS0.service'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'youeye.development-access-status.v2'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'local_root_console_requested:$console_requested'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'local_root_console_persisted:$console_persisted'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'local_root_console_active:$console_active'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'local_root_console_effective:$console_effective'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'systemctl enable --runtime "$console_unit"'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'systemctl start --no-block "$console_unit"'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'systemctl disable --runtime "$console_unit"'
require_text "$root/appliance/scripts/youeye-apply-development-access" 'systemctl stop --no-block "$console_unit"'
if grep -Eq 'getty@tty1|serial-getty@ttyS0|enable --now|disable --now' "$root/appliance/scripts/youeye-apply-development-access"; then
    fail 'development access may only operate the stock tty2 getty lifecycle'
fi
require_text "$root/appliance/build/build-appliance.sh" 'openssh-server,login,ca-certificates'
require_text "$root/appliance/build/build-appliance.sh" 'PasswordAuthentication no'
require_text "$root/appliance/build/build-appliance.sh" 'KbdInteractiveAuthentication no'
require_text "$root/appliance/build/build-appliance.sh" 'PermitRootLogin prohibit-password'
require_text "$root/appliance/build/build-appliance.sh" 'PubkeyAcceptedAlgorithms -ssh-rsa'
require_text "$root/appliance/build/build-appliance.sh" 'passwd -l root'
require_text "$root/appliance/systemd/youeye-appliance-ssh-keys.service" 'Requires=youeye-appliance-state.service'
require_text "$root/appliance/systemd/youeye-appliance-ssh-keys.service" 'Before=ssh.service'
require_text "$root/appliance/systemd/youeye-appliance-ssh-keys.service" 'youeye appliance ssh-key reconcile'
if grep -Fq 'Requires=youeye-appliance-storage.service youeye.service' "$root/appliance/systemd/youeye-first-deploy.service"; then
    fail 'first deployment must survive the intentional youeye.service restart'
fi
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'Wants=network-online.target incus.service incus-startup.service youeye.service'
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'After=network-online.target youeye-appliance-storage.service youeye-appliance-incus-sockets.service youeye.service youeye-first-deploy.service'
if grep -Eq '^After=.*incus\.(service|socket)' "$root/appliance/systemd/youeye-appliance-bless.service"; then
    fail 'boot blessing must not wait behind a wedged Incus start or stop job'
fi
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'ExecStart=/usr/local/bin/youeye boot bless'
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'StartLimitIntervalSec=180'
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'StartLimitBurst=36'
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'Restart=on-failure'
require_text "$root/appliance/systemd/youeye-appliance-bless.service" 'RestartSec=5s'
require_text "$root/spine/internal/boot/scripts/bless.sh" "-name 'LoaderBootCountPath-*'"
require_text "$root/spine/internal/boot/scripts/bless.sh" 'appliance health --profile=operational --json'
require_text "$root/spine/internal/boot/scripts/bless.sh" 'first-deploy/complete'
require_text "$root/spine/internal/boot/scripts/bless.sh" '/usr/lib/systemd/systemd-bless-boot'
require_text "$root/spine/internal/boot/scripts/bless.sh" '"$bless_boot_bin" good'
require_text "$root/spine/internal/boot/scripts/bless.sh" 'youeye.appliance.boot-bless.v1'
require_text "$root/appliance/systemd/journald.conf.d/20-youeye-appliance.conf" 'SystemMaxUse=256M'
require_text "$root/appliance/scripts/youeye-system-update-bootstrap" '.authority == "digest"'
require_text "$root/appliance/scripts/youeye-system-update-bootstrap" 'update core bootstrap --request'
for file in "$root/appliance/scripts/youeye-system-update-bootstrap" "$root/appliance/scripts/youeye-recovery" "$root/spine/internal/boot/scripts/network.sh"; do
    if grep -Fq 'openssl pkey' "$file"; then
        fail "release signature verification remains in $file"
    fi
done
require_text "$build" '"$rootfs/efi"'
require_text "$build" 'disable incus.socket incus-user.socket'
require_text "$build" 'systemd-bless-boot.service'
require_text "$build" 'apt-daily.service apt-daily-upgrade.service'
require_text "$build" 'tmpfs /var/cache tmpfs nodev,nosuid,mode=0755,size=512M'
require_text "$build" 'var/lib/youeye/config/config.yaml'
require_text "$root/appliance/systemd/youeye-recovery.target" 'Wants=youeye-recovery.service'
require_text "$root/appliance/systemd/youeye-recovery.service" 'ExecStart=/usr/local/libexec/youeye-recovery-console'
require_text "$build" 'youeye-recovery-apply.service'
require_text "$build" 'youeye-recovery-apply'
require_text "$build" 'appliance/scripts/youeye-recovery-console'
require_text "$build" 'usr/lib/youeye/config-seeds'
require_text "$root/appliance/scripts/youeye-recovery-console" '/usr/local/libexec/youeye-recovery 2>&1 | tee /dev/ttyS0'
require_text "$root/appliance/scripts/youeye-recovery" "printf 'YOUEYE_RECOVERY_CONSOLE_READY\\n' > /dev/ttyS0"
require_text "$root/appliance/scripts/youeye-recovery" 'verify_boot_asset system-a-uki'
require_text "$root/appliance/scripts/youeye-recovery" 'verify_boot_asset system-b-uki'
require_text "$root/appliance/scripts/youeye-recovery" 'verify_boot_asset recovery-uki'
require_text "$root/appliance/scripts/youeye-recovery" 'bootctl --esp-path="$esp_mount" --no-variables install'
require_text "$root/appliance/scripts/youeye-recovery" 'mount -t vfat -o rw,nodev,nosuid,noexec,umask=0077'
require_text "$root/appliance/scripts/youeye-recovery" 'EFI/YouEye/youeye-system-a.efi'
require_text "$root/appliance/scripts/youeye-recovery" 'set-default ""'
require_text "$root/appliance/scripts/youeye-recovery" 'set-oneshot ""'
require_text "$root/appliance/scripts/youeye-recovery" 'set-oneshot "youeye-system-${slot}.conf"'
if grep -Fq 'efi /EFI/Linux/youeye-' "$root/appliance/scripts/youeye-recovery"; then
    fail 'Recovery repair must remove auto-discovered Type #2 YouEye UKIs from /EFI/Linux'
fi
if grep -Eq '^default[[:space:]]+youeye-system-' "$root/appliance/scripts/youeye-recovery"; then
    fail 'Recovery repair must not force an exhausted normal slot as default'
fi
if grep -Fq 'set-oneshot "youeye-system-${slot}*.conf"' "$root/appliance/scripts/youeye-recovery"; then
    fail 'Recovery slot selection must use systemd-boot stable Type #1 IDs'
fi

if grep -Eq -- '--appliance-(root-payload|internal-recovery|uki|kernel|initrd)' "$root/installer/internal/installer/options.go"; then
    fail 'unsigned appliance artifact override flag remains in the CLI'
fi

bash "$root/spine/internal/boot/scripts/bless_test.sh"
bash "$root/appliance/scripts/youeye-apply-development-access_test.sh"
bash "$root/appliance/scripts/youeye-console-status_test.sh"
bash "$root/appliance/scripts/youeye-apply-development-overlay_test.sh"
bash "$root/spine/internal/boot/scripts/setup-gate_test.sh"
bash "$root/spine/internal/boot/scripts/first-deploy_test.sh"
bash "$root/spine/internal/boot/scripts/network_test.sh"
# Boot orchestration ships with Spine (`youeye boot …`), not in the image.
require_text "$root/appliance/systemd/youeye-first-deploy.service" 'ExecStart=/usr/local/bin/youeye boot first-deploy'
for moved in youeye-first-deploy youeye-bootstrap-network youeye-appliance-bless youeye-setup-gate; do
    if grep -Fq "libexec/$moved" "$build"; then
        fail "$moved must ship with Spine, not the image"
    fi
done
bash "$root/appliance/scripts/youeye-recovery_test.sh"
bash "$root/appliance/scripts/youeye-recovery-apply_test.sh"
for retired in "$root/installer/scripts/proxmox.sh" "$root/installer/scripts/proxmox_bootstrap_test.sh"; do
	[[ ! -e $retired ]] || fail "retired Installer compatibility entry point remains: $retired"
done

printf 'PASS: unified appliance build contract\n'
