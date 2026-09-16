#!/bin/bash
set -euo pipefail

umask 022

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="${SOURCE_DIR:-$(cd -- "$script_dir/../.." && pwd)}"
output_dir="${OUTPUT_DIR:-$source_dir/dist/appliance}"
work_dir="${WORK_DIR:-$source_dir/.build/appliance}"
release_lock="${RELEASE_LOCK_PATH:-$source_dir/appliance/release-lock.json}"
release_lock_source_mode="${RELEASE_LOCK_SOURCE_MODE:-public}"
# A separately supplied lock is the supported explicit source override. Keep
# the repository default public, including aliases/symlinks to that same file.
# An explicit mode always wins; all modes still validate exact release identity.
if [[ -n ${RELEASE_LOCK_PATH:-} && ! $release_lock -ef $source_dir/appliance/release-lock.json ]]; then
    release_lock_source_mode="${RELEASE_LOCK_SOURCE_MODE:-custom}"
fi
# shellcheck source=release-lock.sh
. "$script_dir/release-lock.sh"
if ! release_lock_validate "$release_lock" "$release_lock_source_mode"; then
    printf 'RELEASE_LOCK_PATH must name a valid YouEye appliance release lock: %s\n' "$release_lock_error" >&2
    exit 1
fi
lock_value() { jq -er "$1" "$release_lock"; }
snapshot="$(lock_value '.image.debian_snapshot')"
release_source="$(lock_value '.image.release_source')"
release_branch="$(lock_value '.image.release_branch')"
image_version="$(lock_value '.image.version')"
minimum_current_image_version="$(lock_value '.image.minimum_current_version')"
market_source="$(lock_value '.market.source')"
market_branch="$(lock_value '.market.branch')"
market_source_commit="$(lock_value '.market.commit')"
spine_version="$(lock_value '.components.spine.version')"
spine_tag="$(lock_value '.components.spine.tag')"
spine_commit="$(lock_value '.components.spine.source_commit')"
spine_source_date_epoch="$(lock_value '.components.spine.source_date_epoch')"
spine_expected_sha256="$(lock_value '.components.spine.artifact_sha256')"
cp_version="$(lock_value '.components.control_panel.version')"
cp_tag="$(lock_value '.components.control_panel.tag')"
cp_commit="$(lock_value '.components.control_panel.source_commit')"
cp_sha256="$(lock_value '.components.control_panel.artifact_sha256')"
ui_version="$(lock_value '.components.ui.version')"
ui_tag="$(lock_value '.components.ui.tag')"
ui_commit="$(lock_value '.components.ui.source_commit')"
ui_sha256="$(lock_value '.components.ui.artifact_sha256')"
build_mode="${APPLIANCE_BUILD_MODE:-signed}"
signing_key="${APPLIANCE_SIGNING_KEY_FILE:-}"
signing_public_key="${APPLIANCE_SIGNING_PUBLIC_KEY_FILE:-$source_dir/installer/internal/installer/appliance-development.pub}"
live_build_attempts="${LIVE_BUILD_ATTEMPTS:-3}"
live_build_apt_proxy="${LIVE_BUILD_APT_PROXY:-}"
trust_class="${APPLIANCE_TRUST_CLASS:-development}"
if [[ $trust_class != development && $trust_class != beta && $trust_class != stable ]]; then echo "Invalid appliance trust class" >&2; exit 1; fi
if [[ $trust_class != development ]]; then
    signing_public_key="$source_dir/installer/internal/installer/appliance-public.pub"
    python3 "$source_dir/installer/scripts/embed-public-trust.py" --source "$source_dir" --check --require "$trust_class"
    release_lock_validate_public_recipe "$release_lock" "$source_dir/appliance/release-recipe.json" || { echo "$release_lock_error" >&2; exit 1; }
    [[ $release_branch == beta && $trust_class == beta || $release_branch == main && $trust_class == stable ]] || { echo "Public trust/branch mismatch" >&2; exit 1; }
fi
artifact_kind="${ARTIFACT_KIND:-$trust_class}"
test_fault="${APPLIANCE_TEST_FAULT:-none}"

for source in "$release_source" "$market_source"; do
    if [[ $source != https://* || $source == *'?'* || $source == *'#'* ]]; then
        printf 'Release-lock sources must use credential-free HTTPS repository URLs.\n' >&2
        exit 1
    fi
done
# Branch/tag identity was checked by release_lock_validate above.


for path in "$output_dir" "$work_dir"; do
    if [[ -z $path || $path == / || $path == "$source_dir" ]]; then
        printf 'Build output and work directories must be dedicated paths, not the source root or filesystem root.\n' >&2
        exit 1
    fi
done
if [[ $EUID -ne 0 ]]; then
    printf 'build-appliance.sh must run as root (use sudo with the required environment).\n' >&2
    exit 1
fi
if [[ $build_mode != signed && $build_mode != unsigned ]]; then
    printf 'APPLIANCE_BUILD_MODE must be signed or unsigned.\n' >&2
    exit 1
fi
if [[ $build_mode == signed && ( -z $signing_key || ! -f $signing_key ) ]]; then
    printf 'APPLIANCE_SIGNING_KEY_FILE must name a protected Ed25519 private key for signed builds.\n' >&2
    exit 1
fi
if [[ ! -f $signing_public_key ]]; then
    printf 'APPLIANCE_SIGNING_PUBLIC_KEY_FILE must name the public Ed25519 trust anchor.\n' >&2
    exit 1
fi
if [[ ! $live_build_attempts =~ ^[1-9][0-9]*$ ]]; then
    printf 'LIVE_BUILD_ATTEMPTS must be a positive integer.\n' >&2
    exit 1
fi
if [[ -n $live_build_apt_proxy && ! $live_build_apt_proxy =~ ^http://(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$ ]]; then
    printf 'LIVE_BUILD_APT_PROXY must be an uncredentialed builder-local HTTP endpoint.\n' >&2
    exit 1
fi
if [[ $artifact_kind != "$trust_class" && ! ( $trust_class == development && $artifact_kind == test ) ]]; then
	printf 'ARTIFACT_KIND must be development or test.\n' >&2
	exit 1
fi
if [[ $test_fault != none && $test_fault != system-health ]]; then
	printf 'APPLIANCE_TEST_FAULT must be none or system-health.\n' >&2
	exit 1
fi
if [[ $test_fault != none && $artifact_kind != test ]]; then
	printf 'APPLIANCE_TEST_FAULT requires ARTIFACT_KIND=test.\n' >&2
	exit 1
fi
if [[ $market_source != https://* || $market_source == *'?'* || $market_source == *'#'* ]]; then
	printf 'MARKET_SOURCE must be an HTTPS repository URL without a query or fragment.\n' >&2
	exit 1
fi
if [[ ! $market_source_commit =~ ^[0-9a-f]{40}$ ]]; then
	printf 'MARKET_SOURCE_COMMIT must be a full lowercase Git commit.\n' >&2
	exit 1
fi
if [[ ! $spine_commit =~ ^[0-9a-f]{40}$ ]]; then
    printf 'SPINE_COMMIT must be the exact signed Spine release commit.\n' >&2
    exit 1
fi
if [[ ! $spine_source_date_epoch =~ ^[1-9][0-9]*$ ]]; then
    printf 'SPINE_SOURCE_DATE_EPOCH must be the exact signed Spine source epoch.\n' >&2
    exit 1
fi
if [[ ! $spine_expected_sha256 =~ ^[0-9a-f]{64}$ ]]; then
	printf 'SPINE_SHA256 must be the exact signed Spine binary SHA-256.\n' >&2
	exit 1
fi
if [[ ! $cp_commit =~ ^[0-9a-f]{40}$ ]]; then
	printf 'CP_COMMIT must be the exact signed Control Panel release commit.\n' >&2
	exit 1
fi
if [[ ! $cp_sha256 =~ ^[0-9a-f]{64}$ ]]; then
	printf 'CP_SHA256 must be the exact signed Control Panel standalone.tar SHA-256.\n' >&2
	exit 1
fi
if [[ ! $ui_commit =~ ^[0-9a-f]{40}$ ]]; then
	printf 'UI_COMMIT must be the exact signed UI release commit.\n' >&2
	exit 1
fi
if [[ ! $ui_sha256 =~ ^[0-9a-f]{64}$ ]]; then
	printf 'UI_SHA256 must be the exact signed UI standalone.tar SHA-256.\n' >&2
	exit 1
fi
for command in git go mmdebstrap lb ukify openssl jq tar mkfs.ext4 debugfs modinfo zstd sha256sum xorriso; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required build command is missing: %s\n' "$command" >&2
        exit 1
    fi
done

source_commit="${YOUEYE_SOURCE_COMMIT:-}"
if git_commit="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)"; then
    if [[ -n $source_commit && $source_commit != "$git_commit" ]]; then
        printf 'YOUEYE_SOURCE_COMMIT does not match the checked-out source commit.\n' >&2
        exit 1
    fi
    source_commit="$git_commit"
    if [[ -n $(git -C "$source_dir" status --porcelain --untracked-files=normal) ]]; then
        printf 'Refusing appliance build from a dirty source tree; commit the exact source first.\n' >&2
        exit 1
    fi
fi
if [[ ! $source_commit =~ ^[0-9a-f]{40}$ ]]; then
    printf 'YOUEYE_SOURCE_COMMIT must provide the exact source commit when Git metadata is absent.\n' >&2
    exit 1
fi
source_date_epoch="${SOURCE_DATE_EPOCH:-}"
if [[ -z $source_date_epoch ]] && git -C "$source_dir" cat-file -e "$source_commit^{commit}" 2>/dev/null; then
    source_date_epoch="$(git -C "$source_dir" show -s --format=%ct "$source_commit")"
fi
if [[ ! $source_date_epoch =~ ^[1-9][0-9]*$ ]]; then
    printf 'SOURCE_DATE_EPOCH must be a positive integer when Git metadata is absent.\n' >&2
    exit 1
fi
export SOURCE_DATE_EPOCH="$source_date_epoch"
build_id="appliance-${source_commit:0:12}-${source_date_epoch}"
source_spine_version="$(sed -n 's/^var Version = "\([^"]*\)"/\1/p' "$source_dir/spine/internal/cmd/root.go")"
if [[ -z $source_spine_version || $source_spine_version != "$spine_version" ]]; then
    printf 'Source Spine version must match the exact signed Spine release identity.\n' >&2
    exit 1
fi

rootfs="$work_dir/rootfs"
artifacts="$work_dir/artifacts"
work_key="$(printf '%s' "$work_dir" | sha256sum | cut -c1-16)"
live_dir="/var/tmp/youeye-appliance-live-${source_commit:0:12}-${work_key}"
bin_dir="$work_dir/bin"
snapshot_url="https://snapshot.debian.org/archive/debian/$snapshot"
mmdebstrap_proxy_options=()
if [[ -n $live_build_apt_proxy ]]; then
    # The permanent executor admits only its job-local, no-egress APT broker.
    # Debian Release signatures and their transitive hashes remain the package
    # trust boundary; HTTP lets apt-cacher-ng serve the pinned cached snapshot.
    snapshot_url="http://snapshot.debian.org/archive/debian/$snapshot"
    mmdebstrap_proxy_options+=(--aptopt="Acquire::http::Proxy \"$live_build_apt_proxy\"")
fi
# live-build's APT HTTPS helper can spin indefinitely after the snapshot CDN
# has delivered a response. The snapshot metadata and packages are still
# authenticated by Debian's signed Release file and its transitive hashes, so
# use plain HTTP only for live-build's immutable snapshot fetches. Keep the
# primary appliance root bootstrap on HTTPS.
live_snapshot_url="http://snapshot.debian.org/archive/debian/$snapshot"

cleanup() {
    status=$?
    trap - EXIT INT TERM HUP
    for suffix in dev/pts dev/shm dev/mqueue dev/hugepages proc/sys/fs/binfmt_misc proc sys run dev; do
        target="$rootfs/$suffix"
        if mountpoint -q "$target"; then
            umount -- "$target" || true
        fi
    done
    rm -rf -- "$live_dir"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rm -rf "$work_dir" "$live_dir"
install -d -m 0755 "$output_dir" "$rootfs" "$artifacts" "$live_dir" "$bin_dir"

printf '[1/8] Building exact source binaries\n'
export GOCACHE="$work_dir/go-cache"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C "$source_dir/spine" build \
    -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid= -X github.com/youeye-platform/YouEye/spine/internal/cmd.Version=$spine_version -X github.com/youeye-platform/YouEye/spine/internal/cmd.BuildDate=$(date -u -d "@$spine_source_date_epoch" +%F)" \
    -o "$bin_dir/youeye" ./cmd/youeye
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C "$source_dir/installer" build \
    -trimpath -buildvcs=false -ldflags='-buildid=' \
    -o "$bin_dir/youeye-installer" .
spine_sha256="$(sha256sum "$bin_dir/youeye" | awk '{print $1}')"
if [[ $spine_sha256 != "$spine_expected_sha256" ]]; then
    printf 'Embedded Spine binary does not match the exact released Spine asset.\n' >&2
    exit 1
fi

printf '[2/8] Deriving public development trust material\n'
if [[ $build_mode == signed ]]; then
    openssl pkey -in "$signing_key" -pubout -out "$artifacts/appliance-development.pub" 2>/dev/null
else
    install -m 0644 "$signing_public_key" "$artifacts/appliance-development.pub"
fi
expected_anchor="$source_dir/installer/internal/installer/appliance-development.pub"
if [[ $trust_class != development ]]; then
    expected_anchor="$source_dir/installer/internal/installer/appliance-public.pub"
    jq -er --arg class "$trust_class" '.keys[$class]' "$source_dir/installer/internal/installer/public-release-trust.json" > "$work_dir/embedded-public-anchor.pub"
    cmp -s <(sed '/^[[:space:]]*$/d' "$expected_anchor") <(sed '/^[[:space:]]*$/d' "$work_dir/embedded-public-anchor.pub") || { echo "Public anchor differs from Installer policy" >&2; exit 1; }
fi
if ! cmp -s "$artifacts/appliance-development.pub" "$expected_anchor"; then
    printf '%s\n' 'Refusing appliance signer that does not match the installer development trust anchor.' >&2
    exit 1
fi
key_id="$(openssl pkey -pubin -in "$artifacts/appliance-development.pub" -outform DER 2>/dev/null | sha256sum | cut -c1-16)"

printf '[3/8] Bootstrapping Debian 13 root from snapshot %s\n' "$snapshot"
cat > "$work_dir/youeye-dkms.conf" <<'EOF'
# Secure Boot is deferred. Avoid per-build MOK generation and signatures so
# the development image is reproducible; production signing has its own trust design.
sign_file="/usr/lib/youeye/no-module-signing"
EOF
base_packages="systemd-sysv,systemd-boot,systemd-resolved,systemd-timesyncd,systemd-zram-generator,dbus,linux-image-amd64,linux-headers-amd64,initramfs-tools,zfsutils-linux,zfs-initramfs,openssh-server,login,ca-certificates,curl,jq,openssl,pamtester,apparmor,apparmor-utils,uidmap,nftables,iptables,dnsmasq-base,bridge-utils,iproute2,iputils-ping,ethtool,util-linux,gdisk,dosfstools,e2fsprogs,restic,zstd,bash,coreutils,findutils,grep,sed,gawk,tar,xz-utils,rsync,qemu-guest-agent"
mmdebstrap \
    --variant=apt \
    --architectures=amd64 \
    --components=main,contrib,non-free-firmware \
    --include="$base_packages" \
    --aptopt='Acquire::Check-Valid-Until "false"' \
    --aptopt='Acquire::Retries "5"' \
    "${mmdebstrap_proxy_options[@]}" \
    --extract-hook="mkdir -p \"\$1/etc/dkms/framework.conf.d\"; cp \"$work_dir/youeye-dkms.conf\" \"\$1/etc/dkms/framework.conf.d/youeye-appliance.conf\"" \
    --customize-hook="mkdir -p \"\$1/etc/apt/sources.list.d\"; printf '%s\\n' 'deb [check-valid-until=no] $snapshot_url trixie-backports main contrib non-free-firmware' > \"\$1/etc/apt/sources.list.d/trixie-backports.list\"" \
    --customize-hook='chroot "$1" apt-get update' \
    --customize-hook='DEBIAN_FRONTEND=noninteractive chroot "$1" apt-get install -y -t trixie-backports incus-base' \
    --customize-hook='chroot "$1" apt-get clean' \
    trixie "$rootfs" \
    "deb [check-valid-until=no] $snapshot_url trixie main contrib non-free-firmware"

if [[ -e $rootfs/var/lib/dkms/mok.key || -e $rootfs/var/lib/dkms/mok.pub ]]; then
    printf 'Refusing nondeterministic DKMS MOK material in the appliance image.\n' >&2
    exit 1
fi
while IFS= read -r -d '' module; do
    if [[ -n $(modinfo -F signer "$module" 2>/dev/null) ]]; then
        printf 'Refusing signed DKMS module in development image: %s\n' "$module" >&2
        exit 1
    fi
done < <(find "$rootfs/usr/lib/modules" -path '*/updates/dkms/*.ko*' -type f -print0)
find "$rootfs/var/lib/dkms" -type f -name '*.log' -delete

printf '[4/8] Sealing appliance runtime and exact release channels\n'
install -D -m 0755 "$bin_dir/youeye" "$rootfs/usr/local/bin/youeye"
install -D -m 0755 "$bin_dir/youeye-installer" "$rootfs/usr/local/bin/youeye-installer"
install -D -m 0644 "$artifacts/appliance-development.pub" "$rootfs/usr/share/youeye/appliance-development.pub"
install -D -m 0644 "$source_dir/LICENSE" "$rootfs/usr/share/doc/youeye/LICENSE"
install -D -m 0644 "$source_dir/TRADEMARK.md" "$rootfs/usr/share/doc/youeye/TRADEMARK.md"
install -D -m 0644 "$source_dir/THIRD_PARTY_NOTICES.txt" "$rootfs/usr/share/doc/youeye/THIRD_PARTY_NOTICES.txt"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-first-deploy" "$rootfs/usr/local/libexec/youeye-first-deploy"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-bootstrap-network" "$rootfs/usr/local/libexec/youeye-bootstrap-network"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-seed-market" "$rootfs/usr/local/libexec/youeye-seed-market"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-appliance-bless" "$rootfs/usr/local/libexec/youeye-appliance-bless"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-setup-gate" "$rootfs/usr/local/libexec/youeye-setup-gate"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-recovery" "$rootfs/usr/local/libexec/youeye-recovery"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-recovery-console" "$rootfs/usr/local/libexec/youeye-recovery-console"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-recovery-apply" "$rootfs/usr/local/libexec/youeye-recovery-apply"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-console-status" "$rootfs/usr/local/libexec/youeye-console-status"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-apply-development-access" "$rootfs/usr/local/libexec/youeye-apply-development-access"
install -D -m 0755 "$source_dir/appliance/scripts/youeye-apply-development-overlay" "$rootfs/usr/local/libexec/youeye-apply-development-overlay"
install -D -m 0755 "$source_dir/appliance/initramfs/youeye-state-hook" "$rootfs/etc/initramfs-tools/hooks/youeye-state"
install -D -m 0755 "$source_dir/appliance/initramfs/youeye-state" "$rootfs/etc/initramfs-tools/scripts/local-bottom/youeye-state"
install -D -m 0644 "$source_dir/appliance/initramfs/youeye-network-state" "$rootfs/usr/lib/youeye/initramfs/youeye-network-state"
install -D -m 0644 "$source_dir/appliance/initramfs/youeye-state-migration" "$rootfs/usr/lib/youeye/initramfs/youeye-state-migration"

for unit in \
    youeye.service youeye-appliance-state.service youeye-appliance-storage.service \
    youeye-appliance-ssh-keys.service \
    youeye-appliance-incus-sockets.service \
    youeye-setup-gate.service youeye-first-deploy.service youeye-appliance-bless.service \
    youeye-console-status.service youeye-console-serial.service youeye-development-access.service youeye-development-overlay.service youeye-recovery-apply.service youeye-recovery.service youeye-recovery.target; do
    install -D -m 0644 "$source_dir/appliance/systemd/$unit" "$rootfs/usr/lib/systemd/system/$unit"
done
install -D -m 0644 "$source_dir/appliance/systemd/incus-startup.service.d/youeye-dependency.conf" "$rootfs/usr/lib/systemd/system/incus-startup.service.d/youeye-dependency.conf"
install -D -m 0644 "$source_dir/appliance/systemd/incus.service.d/youeye-appliance.conf" "$rootfs/usr/lib/systemd/system/incus.service.d/youeye-appliance.conf"
install -D -m 0644 "$source_dir/appliance/systemd/journald.conf.d/20-youeye-appliance.conf" "$rootfs/usr/lib/systemd/journald.conf.d/20-youeye-appliance.conf"
install -D -m 0644 "$source_dir/appliance/zram-generator.conf" "$rootfs/usr/lib/systemd/zram-generator.conf"

install -d -m 0755 \
    "$rootfs/efi" "$rootfs/etc/youeye" "$rootfs/etc/systemd/network" "$rootfs/root/.ssh" \
    "$rootfs/usr/lib/youeye" "$rootfs/var/lib/youeye/config" \
    "$rootfs/var/lib/youeye-state" "$rootfs/var/lib/incus" "$rootfs/var/log/journal"
install -d -m 0755 "$rootfs/usr/lib/youeye/market"
rm -f "$rootfs/etc/ssh/ssh_host_"*
: > "$rootfs/etc/machine-id"
: > "$rootfs/etc/hostid"
cat > "$rootfs/etc/hostname" <<'EOF'
youeye
EOF
cat > "$rootfs/etc/systemd/network/20-youeye.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=ipv4
IPv6AcceptRA=no
LinkLocalAddressing=ipv4
EOF
cat > "$rootfs/etc/sysctl.d/60-youeye-appliance-ipv4-only.conf" <<'EOF'
net.ipv6.conf.all.disable_ipv6=1
net.ipv6.conf.default.disable_ipv6=1
EOF
cat >> "$rootfs/etc/gai.conf" <<'EOF'

# The appliance product supports IPv4 networking in this release line.
precedence ::ffff:0:0/96  100
EOF
cat > "$rootfs/etc/ssh/sshd_config.d/20-youeye-appliance.conf" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PubkeyAcceptedAlgorithms -ssh-rsa
EOF
cat > "$rootfs/etc/fstab" <<'EOF'
tmpfs /tmp tmpfs nodev,nosuid,mode=1777 0 0
tmpfs /var/tmp tmpfs nodev,nosuid,mode=1777 0 0
tmpfs /var/cache tmpfs nodev,nosuid,mode=0755,size=512M 0 0
EOF

jq -S -n \
    --arg image_version "$image_version" \
    --arg build_id "$build_id" \
    --arg source_commit "$source_commit" \
    --arg release_source "$release_source" \
    --arg release_branch "$release_branch" \
    --arg spine_version "$spine_version" \
    --arg spine_tag "$spine_tag" \
    --arg spine_commit "$spine_commit" \
    --arg spine_sha256 "$spine_sha256" \
    --arg cp_version "$cp_version" \
    --arg cp_tag "$cp_tag" \
    --arg cp_commit "$cp_commit" \
    --arg cp_sha256 "$cp_sha256" \
    --arg ui_version "$ui_version" \
    --arg ui_tag "$ui_tag" \
	--arg ui_commit "$ui_commit" \
	--arg ui_sha256 "$ui_sha256" \
	--arg artifact_kind "$artifact_kind" \
    '{
      schema_version:1,image_version:$image_version,build_id:$build_id,
      source_commit:$source_commit,architecture:"amd64",firmware_mode:"uefi",
      disk_layout_version:3,state_schema_min:2,state_schema_max:2,
      data_schema_min:1,data_schema_max:1,kernel_compatibility:">=6.12",
      zfs_compatibility:">=2.3",zfs_feature_profile:"openzfs-2.2",
      incus_compatibility:">=7.0",recovery_version:"1",
	  artifact_kind:$artifact_kind,supported_actions:["recovery","image-update"],
      release_set:{source:$release_source,branch:$release_branch,fallback:[],
        spine:{version:$spine_version,tag:$spine_tag,source_commit:$spine_commit,artifact_sha256:$spine_sha256},
        control_panel:{version:$cp_version,tag:$cp_tag,source_commit:$cp_commit,artifact_sha256:$cp_sha256},
        ui:{version:$ui_version,tag:$ui_tag,source_commit:$ui_commit,artifact_sha256:$ui_sha256}}
    }' > "$rootfs/usr/lib/youeye/appliance-release"
chmod 0444 "$rootfs/usr/lib/youeye/appliance-release"

if [[ $test_fault == system-health ]]; then
	install -d -m 0755 "$rootfs/usr/lib/systemd/system/youeye.service.d"
	cat > "$rootfs/usr/lib/systemd/system/youeye.service.d/99-test-health-failure.conf" <<'EOF'
[Unit]
ConditionPathExists=/usr/lib/youeye/test-health-pass
EOF
fi

cat > "$rootfs/var/lib/youeye/config/youeye.yaml" <<EOF
releases:
  repo_url: $release_source
release_branch: $release_branch
release_channels:
  default:
    source: $release_source
    branch: $release_branch
    fallback: []
  spine:
    source: $release_source
    branch: $release_branch
    fallback: []
  control:
    source: $release_source
    branch: $release_branch
    tag: $cp_tag
    artifact_sha256: $cp_sha256
    fallback: []
  ui:
    source: $release_source
    branch: $release_branch
    tag: $ui_tag
    artifact_sha256: $ui_sha256
    fallback: []
EOF
cat > "$rootfs/var/lib/youeye/config/config.yaml" <<EOF
releases:
  repo_url: $release_source
EOF
chmod 0600 "$rootfs/var/lib/youeye/config/youeye.yaml" "$rootfs/var/lib/youeye/config/config.yaml"
install -d -m 0755 "$rootfs/usr/lib/youeye/config-seeds"
install -m 0444 "$rootfs/var/lib/youeye/config/config.yaml" "$rootfs/usr/lib/youeye/config-seeds/config.yaml"
install -m 0444 "$rootfs/var/lib/youeye/config/youeye.yaml" "$rootfs/usr/lib/youeye/config-seeds/youeye.yaml"

jq -S -n --arg repo "$market_source" --arg commit "$market_source_commit" --arg branch "$market_branch" \
	'{id:"official",name:"Official YouEye Market",repo_url:$repo,branch:$branch,resolved_commit:$commit,bootstrap_commit:$commit,enabled:true,priority:0,trust:"official"}' > "$rootfs/usr/lib/youeye/market/market-source.json"
jq -S -n --arg repo "$market_source" --arg commit "$market_source_commit" --arg branch "$market_branch" \
	'{active_sources:[{id:"official",name:"Official YouEye Market",repo_url:$repo,branch:$branch,resolved_commit:$commit,bootstrap_commit:$commit,enabled:true,priority:0,trust:"official"}]}' \
	> "$rootfs/usr/lib/youeye/market/market-sources.json"
chmod 0444 "$rootfs/usr/lib/youeye/market/market-source.json" "$rootfs/usr/lib/youeye/market/market-sources.json"

chroot "$rootfs" passwd -l root >/dev/null
systemctl --root="$rootfs" enable systemd-networkd.service systemd-networkd-wait-online.service ssh.service qemu-guest-agent.service >/dev/null
systemctl --root="$rootfs" enable youeye-appliance-state.service youeye-appliance-storage.service youeye-appliance-ssh-keys.service youeye-development-overlay.service youeye-development-access.service youeye-recovery-apply.service youeye-appliance-incus-sockets.service youeye-setup-gate.service youeye.service youeye-first-deploy.service youeye-appliance-bless.service youeye-console-status.service youeye-console-serial.service >/dev/null
systemctl --root="$rootfs" disable incus.socket incus-user.socket >/dev/null 2>&1 || true
systemctl --root="$rootfs" mask \
    systemd-bless-boot.service \
    apt-daily.service apt-daily-upgrade.service \
    apt-daily.timer apt-daily-upgrade.timer \
    dpkg-db-backup.timer logrotate.timer e2scrub_all.timer >/dev/null
unit_graph_log="$work_dir/systemd-unit-graph.log"
if ! systemd-analyze --root="$rootfs" verify multi-user.target >"$unit_graph_log" 2>&1; then
    cat "$unit_graph_log" >&2
    printf '%s\n' 'Refusing appliance image with an invalid systemd unit graph.' >&2
    exit 1
fi
if grep -Eq 'ordering cycle|deleted to break ordering cycle' "$unit_graph_log"; then
    cat "$unit_graph_log" >&2
    printf '%s\n' 'Refusing appliance image with a systemd ordering cycle.' >&2
    exit 1
fi
chroot "$rootfs" update-initramfs -u -k all

find "$rootfs" -xdev -print0 | xargs -0 touch --no-dereference --date="@$source_date_epoch"

printf '[5/8] Creating fixed-size System and Recovery images\n'
make_ext4_image() {
    local image=$1
    local size=$2
    local label=$3
    local uuid=$4
    rm -f "$image"
    truncate -s "$size" "$image"
    # Kernel-mounted population changes ext4 allocation and journal metadata.
    # Feed one sorted archive to mke2fs so every inode is created offline in a
    # stable order, and set the hash seed before backup superblocks are written.
    tar --sort=name --format=posix --numeric-owner --acls --xattrs --selinux \
        --mtime="@$source_date_epoch" --pax-option=delete=atime,delete=ctime \
        -C "$rootfs" -cf - . | \
        E2FSPROGS_FAKE_TIME="$source_date_epoch" mkfs.ext4 -q -F \
            -L "$label" -U "$uuid" -O ^orphan_file \
            -E "lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,hash_seed=$uuid" \
            -d - "$image"
    local check_status=0
    E2FSPROGS_FAKE_TIME="$source_date_epoch" e2fsck -fyD "$image" >/dev/null || check_status=$?
    if ((check_status > 1)); then
        return "$check_status"
    fi
    local debugfs_commands="$work_dir/debugfs-$label.commands"
    printf '%s\n' \
        "set_current_time @$source_date_epoch" \
        "set_super_value mtime @$source_date_epoch" \
        "set_super_value lastcheck @$source_date_epoch" \
        "set_super_value mkfs_time @$source_date_epoch" \
        "set_super_value wtime @$source_date_epoch" > "$debugfs_commands"
    debugfs -w -f "$debugfs_commands" "$image" >/dev/null 2>&1
}

deterministic_uuid() {
    local hash
    hash="$(printf '%s' "$1" | sha256sum | awk '{print $1}')"
    printf '%s-%s-4%s-a%s-%s\n' "${hash:0:8}" "${hash:8:4}" "${hash:13:3}" "${hash:17:3}" "${hash:20:12}"
}
system_uuid="$(deterministic_uuid "$source_commit-system")"
recovery_uuid="$(deterministic_uuid "$source_commit-recovery")"
make_ext4_image "$artifacts/system-root.img" 8G YE-SYSTEM-IMAGE "$system_uuid"
make_ext4_image "$artifacts/internal-recovery.img" 4G YE-RECOVERY-IMG "$recovery_uuid"
# Compression is a source-owned reproducibility input, never host-adaptive.
# One worker stays within each bounded executor slot when A/B run together.
[[ $(zstd --version) == *"v1.5.7,"* ]] || { printf 'Expected Zstandard 1.5.7 for reproducible appliance compression.\n' >&2; exit 1; }
zstd -q -T1 -10 --long=27 -f "$artifacts/system-root.img" -o "$artifacts/system-root.img.zst"
zstd -q -T1 -10 --long=27 -f "$artifacts/internal-recovery.img" -o "$artifacts/internal-recovery.img.zst"

printf '[6/8] Building A, B, and Recovery UKIs\n'
kernel="$(find "$rootfs/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | sort -V | tail -n 1)"
initrd="${kernel/vmlinuz-/initrd.img-}"
kernel_version="${kernel##*/vmlinuz-}"
if [[ ! -f $kernel || ! -f $initrd ]]; then
    printf 'Kernel or initramfs was not produced.\n' >&2
    exit 1
fi
cat > "$work_dir/cmdline-a" <<'EOF'
root=PARTLABEL=YE-SYSTEM-A rootfstype=ext4 ro rootwait console=ttyS0,115200n8 quiet loglevel=3 systemd.show_status=false udev.log_level=3
EOF
cat > "$work_dir/cmdline-b" <<'EOF'
root=PARTLABEL=YE-SYSTEM-B rootfstype=ext4 ro rootwait console=ttyS0,115200n8 quiet loglevel=3 systemd.show_status=false udev.log_level=3
EOF
cat > "$work_dir/cmdline-recovery" <<'EOF'
root=PARTLABEL=YE-RECOVERY rootfstype=ext4 ro rootwait console=ttyS0,115200n8 quiet loglevel=3 systemd.unit=youeye-recovery.target systemd.show_status=false udev.log_level=3
EOF
for slot in a b recovery; do
    ukify build \
        --linux="$kernel" \
        --initrd="$initrd" \
        --uname="$kernel_version" \
        --os-release="@$rootfs/usr/lib/os-release" \
        --cmdline="@$work_dir/cmdline-$slot" \
        --output="$artifacts/${slot/system-/system-}.efi"
done
mv "$artifacts/a.efi" "$artifacts/system-a.efi"
mv "$artifacts/b.efi" "$artifacts/system-b.efi"

printf '[7/8] Preparing appliance release payload\n'
install -m 0755 "$bin_dir/youeye" "$artifacts/youeye-system-updater-linux-amd64"
install -m 0755 "$source_dir/appliance/scripts/youeye-system-update-bootstrap" "$artifacts/youeye-system-update-bootstrap"
asset_record() {
    local role=$1 path=$2 compression=${3:-}
    local file="$artifacts/$path"
    local sha size
    sha="$(sha256sum "$file" | awk '{print $1}')"
    size="$(stat -c %s "$file")"
    if [[ -n $compression ]]; then
        local raw=${path%.zst}
        local raw_sha raw_size
        raw_sha="$(sha256sum "$artifacts/$raw" | awk '{print $1}')"
        raw_size="$(stat -c %s "$artifacts/$raw")"
        jq -n --arg role "$role" --arg path "$path" --arg sha "$sha" --arg compression "$compression" --arg raw_sha "$raw_sha" --argjson size "$size" --argjson raw_size "$raw_size" \
            '{role:$role,path:$path,sha256:$sha,size_bytes:$size,compression:$compression,uncompressed_sha256:$raw_sha,uncompressed_size_bytes:$raw_size}'
    else
        jq -n --arg role "$role" --arg path "$path" --arg sha "$sha" --argjson size "$size" \
            '{role:$role,path:$path,sha256:$sha,size_bytes:$size}'
    fi
}

if [[ $build_mode == signed ]]; then
    jq -s '.' \
        <(asset_record system-root system-root.img.zst zstd) \
        <(asset_record internal-recovery internal-recovery.img.zst zstd) \
        <(asset_record system-a-uki system-a.efi) \
        <(asset_record system-b-uki system-b.efi) \
        <(asset_record recovery-uki recovery.efi) > "$work_dir/assets.json"

    jq -s '.' \
        <(asset_record system-root system-root.img.zst zstd) \
        <(asset_record system-a-uki system-a.efi) \
        <(asset_record system-b-uki system-b.efi) \
        <(asset_record system-updater youeye-system-updater-linux-amd64) > "$work_dir/system-update-assets.json"

    jq -S -n \
    --slurpfile artifacts "$work_dir/assets.json" \
    --arg image_version "$image_version" --arg build_id "$build_id" \
    --arg source_commit "$source_commit" --arg key_id "$key_id" --arg trust_class "$trust_class" \
    --arg release_source "$release_source" --arg release_branch "$release_branch" \
    --arg spine_version "$spine_version" --arg spine_tag "$spine_tag" --arg spine_commit "$spine_commit" --arg spine_sha256 "$spine_sha256" \
    --arg cp_version "$cp_version" --arg cp_tag "$cp_tag" --arg cp_commit "$cp_commit" --arg cp_sha256 "$cp_sha256" \
    --arg ui_version "$ui_version" --arg ui_tag "$ui_tag" --arg ui_commit "$ui_commit" --arg ui_sha256 "$ui_sha256" \
    --argjson source_date_epoch "$source_date_epoch" \
    '{schema:"youeye.appliance.manifest.v1",image_version:$image_version,build_id:$build_id,
      source_commit:$source_commit,architecture:"amd64",firmware_mode:"uefi",
      disk_layout:{version:3,target_min_gib:32,esp_gib:1,recovery_gib:4,root_slot_gib:8,state_gib:4},
      state_schema_min:2,state_schema_max:2,data_schema_min:1,data_schema_max:1,
      kernel_compatibility:">=6.12",zfs_compatibility:">=2.3",zfs_feature_profile:"openzfs-2.2",
      incus_compatibility:">=7.0",recovery_version:"1",
      trust:{class:$trust_class,key_id:$key_id},
      release_set:{source:$release_source,branch:$release_branch,fallback:[],
        spine:{version:$spine_version,tag:$spine_tag,source_commit:$spine_commit,artifact_sha256:$spine_sha256},
        control_panel:{version:$cp_version,tag:$cp_tag,source_commit:$cp_commit,artifact_sha256:$cp_sha256},
        ui:{version:$ui_version,tag:$ui_tag,source_commit:$ui_commit,artifact_sha256:$ui_sha256}},
      artifacts:$artifacts[0],source_date_epoch:$source_date_epoch}' > "$artifacts/appliance-manifest.json"
    openssl pkeyutl -sign -rawin -inkey "$signing_key" -in "$artifacts/appliance-manifest.json" -out "$artifacts/appliance-manifest.json.sig" 2>/dev/null

    jq -S -n \
	--slurpfile artifacts "$work_dir/system-update-assets.json" \
	--arg target_image_version "$image_version" \
	--arg build_id "$build_id" --arg source_commit "$source_commit" --arg key_id "$key_id" --arg trust_class "$trust_class" \
	--arg minimum_current_image_version "$minimum_current_image_version" \
	--arg artifact_kind "$artifact_kind" \
	--arg release_source "$release_source" --arg release_branch "$release_branch" \
	--arg spine_version "$spine_version" --arg spine_tag "$spine_tag" --arg spine_commit "$spine_commit" --arg spine_sha256 "$spine_sha256" \
	--arg cp_version "$cp_version" --arg cp_tag "$cp_tag" --arg cp_commit "$cp_commit" --arg cp_sha256 "$cp_sha256" \
	--arg ui_version "$ui_version" --arg ui_tag "$ui_tag" --arg ui_commit "$ui_commit" --arg ui_sha256 "$ui_sha256" \
	--argjson source_date_epoch "$source_date_epoch" \
	'{schema:"youeye.system-update.v1",target_image_version:$target_image_version,
	  build_id:$build_id,source_commit:$source_commit,
	  architecture:"amd64",firmware_mode:"uefi",hardware_profile:"youeye-appliance-amd64-v1",
	  disk_layout_version:3,state_schema_min:2,state_schema_max:2,data_schema_min:1,data_schema_max:1,
	  recovery_version:"1",minimum_current_image_version:$minimum_current_image_version,
	  root_slot_size_bytes:8589934592,
	  boot_attempts:3,health_profile:"operational",artifact_kind:$artifact_kind,
	  trust:{class:$trust_class,key_id:$key_id},
	  rollback:{supported:true,state_schema_min:2,state_schema_max:2,data_schema_min:1,data_schema_max:1,
	    preserve_state:true,preserve_data:true,preserve_recovery:true},
	  release_set:{source:$release_source,branch:$release_branch,fallback:[],
	    spine:{version:$spine_version,tag:$spine_tag,source_commit:$spine_commit,artifact_sha256:$spine_sha256},
	    control_panel:{version:$cp_version,tag:$cp_tag,source_commit:$cp_commit,artifact_sha256:$cp_sha256},
	    ui:{version:$ui_version,tag:$ui_tag,source_commit:$ui_commit,artifact_sha256:$ui_sha256}},
	  artifacts:$artifacts[0],source_date_epoch:$source_date_epoch}' > "$artifacts/system-update-manifest.json"
    openssl pkeyutl -sign -rawin -inkey "$signing_key" -in "$artifacts/system-update-manifest.json" -out "$artifacts/system-update-manifest.json.sig" 2>/dev/null

    dpkg-query --root="$rootfs" -W -f='${Package}\t${Version}\t${Architecture}\n' | jq -R -s \
        --arg created "$(date -u -d "@$source_date_epoch" +%FT%TZ)" \
        --arg namespace "https://youeye.local/spdx/$build_id" \
        '{spdxVersion:"SPDX-2.3",dataLicense:"CC0-1.0",SPDXID:"SPDXRef-DOCUMENT",name:"YouEye Appliance",documentNamespace:$namespace,creationInfo:{created:$created,creators:["Tool: youeye-appliance-v1"]},packages:(split("\n")|map(select(length>0)|split("\t")|{name:.[0],SPDXID:("SPDXRef-Package-"+(.[0]|gsub("[^A-Za-z0-9.-]";"-"))),versionInfo:.[1],downloadLocation:"NOASSERTION",filesAnalyzed:false,licenseConcluded:"NOASSERTION",licenseDeclared:"NOASSERTION",supplier:"Organization: Debian"}))}' > "$artifacts/sbom.spdx.json"
    jq -S -n --arg build_id "$build_id" --arg source_commit "$source_commit" --arg snapshot "$snapshot" --arg recipe youeye-appliance-v1 \
        --arg market_source "$market_source" --arg market_source_commit "$market_source_commit" --argjson source_date_epoch "$source_date_epoch" \
        '{schema:"youeye.appliance.provenance.v1",build_id:$build_id,source_commit:$source_commit,recipe:$recipe,debian_snapshot:$snapshot,
          market:{source:$market_source,source_commit:$market_source_commit},source_date_epoch:$source_date_epoch,
          builder:{architecture:"amd64",trust:"development"}}' > "$artifacts/provenance.json"
else
    printf 'Unsigned build: manifests, SBOM, provenance, checksums, and signatures are delegated to Infra validation.\n'
fi

printf '[8/8] Building hybrid UEFI installer ISO\n'
cd "$live_dir"
configure_live_build() {
    local apt_options='--yes -o Acquire::Check-Valid-Until=false -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::http::Pipeline-Depth=0 -o Acquire::https::Timeout=30'
    if [[ -n $live_build_apt_proxy ]]; then
        apt_options+=" -o Acquire::http::Proxy=$live_build_apt_proxy"
    fi
    lb config \
        --mode debian --distribution trixie --architecture amd64 \
        --binary-image iso-hybrid --bootloaders grub-efi \
        --archive-areas 'main contrib non-free-firmware' \
        --cache-indices true \
        --debian-installer none --apt-recommends false --apt-source-archives false \
        --security false --updates false --backports false \
        --mirror-bootstrap "$live_snapshot_url" --mirror-chroot "$live_snapshot_url" --mirror-binary "$live_snapshot_url" \
        --apt-options "$apt_options" \
        --bootappend-live 'boot=live components console=ttyS0,115200n8 quiet loglevel=3 systemd.show_status=false udev.log_level=3' \
        --iso-application 'YouEye Installer' --iso-publisher 'YouEye' \
        --iso-volume YOUEYE_INSTALLER --checksums sha256 --firmware-chroot false --firmware-binary false
}
configure_live_build

install -d -m 0755 config/package-lists config/bootloaders/grub-pc config/hooks/live \
    config/includes.chroot/etc/apt/apt.conf.d \
    config/includes.chroot/usr/local/bin config/includes.chroot/usr/local/libexec \
    config/includes.chroot/usr/lib/systemd/system config/includes.chroot/usr/share/youeye config/includes.binary/appliance
cat > config/package-lists/youeye.list.chroot <<'EOF'
systemd-sysv
live-boot
live-config
gdisk
parted
dosfstools
e2fsprogs
zstd
jq
util-linux
udev
efibootmgr
systemd-boot-tools
systemd-boot-efi-amd64-signed
kbd
ca-certificates
curl
openssh-client
EOF
cat > config/bootloaders/grub-pc/config.cfg <<'EOF'
set default=0
set timeout_style=menu
set timeout=5

if [ x$feature_default_font_path = xy ] ; then
    font=unicode
else
    font=$prefix/unicode.pf2
fi

if loadfont $font ; then
    set gfxmode=800x600
    set gfxpayload=keep
    insmod efi_gop
    insmod efi_uga
    insmod video_bochs
    insmod video_cirrus
else
    set gfxmode=auto
    insmod all_video
fi

insmod gfxterm
insmod png
source /boot/grub/theme.cfg
terminal_output gfxterm
EOF
cat > config/includes.chroot/etc/apt/apt.conf.d/99youeye-no-binary-cache <<'EOF'
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
EOF
cat > config/hooks/live/9999-youeye-reproducible-cache.hook.chroot <<'EOF'
#!/bin/sh
set -eu

# APT's binary caches contain hash-table allocation details that vary between
# otherwise identical live-build runs and are unnecessary on installer media.
rm -f /var/cache/apt/pkgcache.bin /var/cache/apt/srcpkgcache.bin
EOF
chmod 0755 config/hooks/live/9999-youeye-reproducible-cache.hook.chroot
install -m 0755 "$bin_dir/youeye-installer" config/includes.chroot/usr/local/bin/youeye-installer
install -m 0644 "$artifacts/appliance-development.pub" config/includes.chroot/usr/share/youeye/appliance-development.pub
cat > config/includes.chroot/usr/local/libexec/youeye-live-installer <<'EOF'
#!/bin/bash
set -eu
chvt 1 2>/dev/null || true
printf '\033c' > /dev/tty1 2>/dev/null || true
install -d -m 0755 /run/youeye-appliance
ln -sfn /run/live/medium/appliance /run/youeye-appliance/artifacts

answer=""
answer_device="$(findfs LABEL=YOUEYE_ANSWER 2>/dev/null || true)"
if [ -n "$answer_device" ]; then
    install -d -m 0700 /run/youeye-appliance/answer
    mount -o ro,nodev,nosuid,noexec "$answer_device" /run/youeye-appliance/answer
    answer="$(find /run/youeye-appliance/answer -maxdepth 1 -type f -iname 'appliance-answer.json*' -print -quit)"
fi

if [ -n "$answer" ]; then
    set +e
    if [ -c /dev/ttyS0 ]; then
        /usr/local/bin/youeye-installer install --silent --yes --answer "$answer" 2>&1 | tee /dev/ttyS0
        status=${PIPESTATUS[0]}
    else
        /usr/local/bin/youeye-installer install --silent --yes --answer "$answer"
        status=$?
    fi
    set -e
    if [ "$status" -eq 0 ]; then
        sync
        sleep 2
        systemctl poweroff
    fi
    exit "$status"
fi
exec /usr/local/bin/youeye-installer install
EOF
chmod 0755 config/includes.chroot/usr/local/libexec/youeye-live-installer
cat > config/includes.chroot/usr/lib/systemd/system/youeye-installer.service <<'EOF'
[Unit]
Description=YouEye Installer
After=systemd-udev-settle.service getty@tty1.service serial-getty@ttyS0.service
Wants=systemd-udev-settle.service
Conflicts=getty@tty1.service serial-getty@ttyS0.service

[Service]
Type=simple
ExecStart=/usr/local/libexec/youeye-live-installer
StandardInput=tty
StandardOutput=tty
StandardError=journal
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
Restart=no

[Install]
WantedBy=multi-user.target
EOF
install -d -m 0755 config/includes.chroot/etc/systemd/system/multi-user.target.wants
ln -s /usr/lib/systemd/system/youeye-installer.service config/includes.chroot/etc/systemd/system/multi-user.target.wants/youeye-installer.service
cp -a "$artifacts/." config/includes.binary/appliance/
rm -f config/includes.binary/appliance/system-root.img config/includes.binary/appliance/internal-recovery.img

# The snapshot is immutable, and debootstrap has already verified its Release
# signature and package indices. Prime live-build's supported index cache from
# that exact bootstrap state so chroot assembly does not issue a redundant,
# failure-prone refresh against snapshot.debian.org.
prime_live_build_indices() {
    local index_cache=cache/indices.bootstrap
    local -a index_files=()
    SOURCE_DATE_EPOCH="$source_date_epoch" lb bootstrap
    install -d -m 0755 "$index_cache"
    shopt -s nullglob
    index_files=(chroot/var/lib/apt/lists/*_Packages chroot/var/lib/apt/lists/*Release*)
    shopt -u nullglob
    if (( ${#index_files[@]} == 0 )); then
        printf 'live-build bootstrap did not provide signed package indices.\n' >&2
        exit 1
    fi
    cp -a "${index_files[@]}" "$index_cache/"
    if compgen -G 'chroot/etc/apt/trusted.gpg*' >/dev/null; then
        cp -a chroot/etc/apt/trusted.gpg* "$index_cache/"
    fi
}
prime_live_build_indices

live_build_ok=false
for ((attempt = 1; attempt <= live_build_attempts; attempt++)); do
    if SOURCE_DATE_EPOCH="$source_date_epoch" lb build; then
        live_build_ok=true
        break
    fi
    if (( attempt < live_build_attempts )); then
        printf 'live-build attempt %d/%d failed; cleaning and retrying.\n' \
            "$attempt" "$live_build_attempts" >&2
        # Preserve config/ and its repository-owned installer declarations,
        # then restore live-build's config-stage marker before the retry.
        lb clean || true
        configure_live_build
        sleep "$((attempt * 5))"
    fi
done
if [[ $live_build_ok != true ]]; then
    printf 'live-build failed after %d attempt(s).\n' "$live_build_attempts" >&2
    exit 1
fi
live_iso="$(find . -maxdepth 1 -type f \( -name '*.hybrid.iso' -o -name '*.iso' \) | head -n 1)"
if [[ -z $live_iso ]]; then
    printf 'live-build did not produce an ISO.\n' >&2
    exit 1
fi
hybrid_tree="$work_dir/hybrid-tree"
rm -rf "$hybrid_tree"
install -d -m 0755 "$hybrid_tree"
xorriso -osirrox on -indev "$live_iso" -extract / "$hybrid_tree" >/dev/null 2>&1
if [[ ! -f $hybrid_tree/boot/grub/efi.img ]]; then
    printf 'live-build ISO is missing boot/grub/efi.img.\n' >&2
    exit 1
fi
iso_timestamp="$(date -u -d "@$source_date_epoch" +%Y%m%d%H%M%S00)"
iso_disk_guid="$(deterministic_uuid "$source_commit-installer-media-gpt")"
xorriso -as mkisofs \
    -r -iso-level 3 -V YOUEYE_INSTALLER \
    -A 'YouEye Installer' -publisher YouEye \
    --modification-date="$iso_timestamp" --set_all_file_dates "$iso_timestamp" \
    --gpt_disk_guid "$iso_disk_guid" \
    -c boot.catalog -e boot/grub/efi.img -no-emul-boot \
    -efi-boot-part --efi-boot-image \
    -o "$artifacts/youeye-appliance-amd64.iso" "$hybrid_tree"

system_area_report="$(xorriso -indev "$artifacts/youeye-appliance-amd64.iso" -report_system_area plain 2>&1)"
for required in 'MBR partition table' 'GPT partition name' 'EFI boot partition'; do
    if ! grep -Fq "$required" <<<"$system_area_report"; then
        printf 'USB-hybrid ISO validation is missing %s.\n' "$required" >&2
        exit 1
    fi
done
if ! grep -Eq '^GPT[[:space:]]*:[[:space:]]+N[[:space:]]+Info$' <<<"$system_area_report"; then
    printf 'USB-hybrid ISO validation did not find the GPT entry summary.\n' >&2
    exit 1
fi
if ! grep -Eq '0xee|protective' <<<"$system_area_report"; then
    printf 'USB-hybrid ISO validation did not find a protective MBR.\n' >&2
    exit 1
fi
if ! xorriso -indev "$artifacts/youeye-appliance-amd64.iso" -report_el_torito plain 2>&1 | grep -Fq 'UEFI'; then
    printf 'USB-hybrid ISO validation did not find the UEFI El Torito image.\n' >&2
    exit 1
fi
install -m 0755 "$bin_dir/youeye-installer" "$artifacts/youeye-installer-linux-amd64"

rm -rf "$output_dir"
install -d -m 0755 "$output_dir"
if [[ $build_mode == signed ]]; then
    (
        cd "$artifacts"
        sha256sum appliance-development.pub appliance-manifest.json appliance-manifest.json.sig \
            internal-recovery.img.zst provenance.json recovery.efi sbom.spdx.json \
            system-a.efi system-b.efi system-root.img.zst system-update-manifest.json system-update-manifest.json.sig \
            youeye-appliance-amd64.iso youeye-installer-linux-amd64 youeye-system-update-bootstrap \
            youeye-system-updater-linux-amd64 > SHA256SUMS
    )
    openssl pkeyutl -sign -rawin -inkey "$signing_key" -in "$artifacts/SHA256SUMS" -out "$artifacts/SHA256SUMS.sig" 2>/dev/null
    install -m 0644 \
        "$artifacts/appliance-development.pub" "$artifacts/appliance-manifest.json" "$artifacts/appliance-manifest.json.sig" \
        "$artifacts/internal-recovery.img.zst" "$artifacts/provenance.json" "$artifacts/recovery.efi" \
        "$artifacts/sbom.spdx.json" "$artifacts/SHA256SUMS" "$artifacts/SHA256SUMS.sig" \
        "$artifacts/system-a.efi" "$artifacts/system-b.efi" "$artifacts/system-root.img.zst" \
        "$artifacts/system-update-manifest.json" "$artifacts/system-update-manifest.json.sig" \
        "$artifacts/youeye-appliance-amd64.iso" "$output_dir/"
else
    install -m 0644 \
        "$artifacts/internal-recovery.img.zst" "$artifacts/recovery.efi" \
        "$artifacts/system-a.efi" "$artifacts/system-b.efi" "$artifacts/system-root.img.zst" \
        "$artifacts/youeye-appliance-amd64.iso" "$output_dir/"
fi
install -m 0755 "$artifacts/youeye-installer-linux-amd64" "$output_dir/youeye-installer-linux-amd64"
install -m 0755 "$artifacts/youeye-system-update-bootstrap" "$output_dir/youeye-system-update-bootstrap"
install -m 0755 "$artifacts/youeye-system-updater-linux-amd64" "$output_dir/youeye-system-updater-linux-amd64"

if [[ $build_mode == unsigned ]]; then
    output_count="$(find "$output_dir" -maxdepth 1 -type f -printf . | wc -c)"
    if [[ $output_count -ne 9 ]]; then
        printf 'Unsigned appliance build must emit exactly nine regular files; found %s.\n' "$output_count" >&2
        exit 1
    fi
fi
printf '%s build complete: %s\n' "$build_mode" "$output_dir"
sha256sum "$output_dir/youeye-appliance-amd64.iso"
