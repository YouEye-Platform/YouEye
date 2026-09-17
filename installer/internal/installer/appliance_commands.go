package installer

import (
	"fmt"
	"strconv"
	"strings"
)

type applianceCommand struct {
	Stage applianceWriteStage
	Name  string
	Args  []string
}

type applianceCommandRunner interface {
	Run(name string, args ...string) (string, error)
}

type shellApplianceRunner struct{}

func (shellApplianceRunner) Run(name string, args ...string) (string, error) {
	return run(name, args...)
}

type appliancePayloadAsset struct {
	Path        string
	Compression string
	SHA256      string
	SizeBytes   int64
}

type applianceImageAssets struct {
	Operation       string
	RootPayload     appliancePayloadAsset
	RecoveryPayload appliancePayloadAsset
	SystemAUKIPath  string
	SystemBUKIPath  string
	RecoveryUKIPath string
	ManifestPath    string
	SignaturePath   string
	ManifestSHA256  string
	ImageVersion    string
	TransactionID   string
	Network         applianceAnswerNetwork
	AnswerPath      string
	AuthorizedKeys  []string
}

const (
	espMount           = "/mnt/youeye-esp"
	espVendorDir       = espMount + "/EFI/YouEye"
	systemMount        = "/mnt/youeye-system"
	stateMount         = "/mnt/youeye-state"
	stateBootBackup    = stateMount + "/installer/boot"
	installJournalPath = stateMount + "/installer/install-journal.json"
)

func applianceCommandPlan(plan applianceInstallPlan, assets applianceImageAssets) ([]applianceCommand, error) {
	if strings.TrimSpace(plan.TargetDiskPath) == "" {
		return nil, fmt.Errorf("appliance command plan requires an installation drive")
	}
	if plan.RootSlotBytes != applianceRootSlotBytes {
		return nil, fmt.Errorf("appliance command plan requires the fixed %s root slot size", formatBytes(applianceRootSlotBytes))
	}
	if err := validateAppliancePayloadAsset("root", assets.RootPayload); err != nil {
		return nil, err
	}
	if err := validateAppliancePayloadAsset("recovery", assets.RecoveryPayload); err != nil {
		return nil, err
	}
	for name, path := range map[string]string{
		"System A UKI": assets.SystemAUKIPath,
		"System B UKI": assets.SystemBUKIPath,
		"Recovery UKI": assets.RecoveryUKIPath,
		"manifest":     assets.ManifestPath,
		"signature":    assets.SignaturePath,
	} {
		if strings.TrimSpace(path) == "" {
			return nil, fmt.Errorf("%s path is required", name)
		}
	}
	if !validSHA256Hex(assets.ManifestSHA256) {
		return nil, fmt.Errorf("manifest SHA-256 is required")
	}
	if strings.TrimSpace(assets.ImageVersion) == "" {
		return nil, fmt.Errorf("image version is required")
	}
	if !validApplianceTransactionID(assets.TransactionID) {
		return nil, fmt.Errorf("appliance transaction identity is invalid")
	}
	if strings.TrimSpace(assets.AnswerPath) == "" {
		return nil, fmt.Errorf("appliance answer path is required")
	}
	if assets.Operation != "erase-install" && assets.Operation != "preserve-reinstall" {
		return nil, fmt.Errorf("appliance operation %q is invalid", assets.Operation)
	}

	rootMiB := plan.RootSlotBytes / applianceMiB
	recoveryMiB := applianceRecoveryBytes / applianceMiB
	stateMiB := applianceStateBytes / applianceMiB
	target := plan.TargetDiskPath
	esp := partitionPath(target, 1)
	recovery := partitionPath(target, 2)
	systemA := partitionPath(target, 3)
	systemB := partitionPath(target, 4)
	state := partitionPath(target, 5)
	dataPart := partitionPath(target, 6)

	commands := []applianceCommand{
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RootPayload.Path}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RecoveryPayload.Path}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.SystemAUKIPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.SystemBUKIPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RecoveryUKIPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.ManifestPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.SignaturePath}},
		{Stage: stagePartitionTarget, Name: "sgdisk", Args: []string{"--zap-all", target}},
		{Stage: stagePartitionTarget, Name: "sgdisk", Args: []string{
			"--new=1:2048:+1024M", "--typecode=1:EF00", "--change-name=1:YE-ESP",
			"--new=2:0:+" + strconv.FormatInt(recoveryMiB, 10) + "M", "--typecode=2:8300", "--change-name=2:YE-RECOVERY",
			"--new=3:0:+" + strconv.FormatInt(rootMiB, 10) + "M", "--typecode=3:8300", "--change-name=3:YE-SYSTEM-A",
			"--new=4:0:+" + strconv.FormatInt(rootMiB, 10) + "M", "--typecode=4:8300", "--change-name=4:YE-SYSTEM-B",
			"--new=5:0:+" + strconv.FormatInt(stateMiB, 10) + "M", "--typecode=5:8300", "--change-name=5:YE-STATE",
			"--new=6:0:0", "--typecode=6:BF01", "--change-name=6:YE-DATA",
			target,
		}},
		{Stage: stagePartitionTarget, Name: "partprobe", Args: []string{target}},
		{Stage: stagePartitionTarget, Name: "udevadm", Args: []string{"settle"}},
		{Stage: stageFormatState, Name: "mkfs.ext4", Args: []string{"-F", "-L", "YE-STATE", state}},
		{Stage: stageInitializeJournal, Name: "mkdir", Args: []string{"-p", stateMount}},
		{Stage: stageInitializeJournal, Name: "mount", Args: []string{state, stateMount}},
		installJournalCommand(stageInitializeJournal, plan, assets),
		{Stage: stagePrepareData, Name: "wipefs", Args: []string{"-a", dataPart}},
		payloadWriteCommand(stageWriteSystemA, assets.RootPayload, systemA),
		payloadReadbackCommand(stageWriteSystemA, assets.RootPayload, systemA),
		installJournalCommand(stageWriteSystemA, plan, assets),
		payloadWriteCommand(stageWriteSystemB, assets.RootPayload, systemB),
		payloadReadbackCommand(stageWriteSystemB, assets.RootPayload, systemB),
		installJournalCommand(stageWriteSystemB, plan, assets),
		payloadWriteCommand(stageWriteRecovery, assets.RecoveryPayload, recovery),
		payloadReadbackCommand(stageWriteRecovery, assets.RecoveryPayload, recovery),
		installJournalCommand(stageWriteRecovery, plan, assets),
		{Stage: stageInitializeState, Name: "mkdir", Args: []string{"-p", systemMount}},
		{Stage: stageInitializeState, Name: "mount", Args: []string{"-o", "ro", systemA, systemMount}},
		{Stage: stageInitializeState, Name: "sh", Args: applianceStateInitArgs(assets)},
		{Stage: stageInitializeState, Name: "sync", Args: []string{}},
		{Stage: stageInitializeState, Name: "umount", Args: []string{systemMount}},
		installJournalCommand(stageInitializeState, plan, assets),
		{Stage: stageInstallBootAssets, Name: "mkfs.vfat", Args: []string{"-F", "32", "-n", "YE-ESP", esp}},
		{Stage: stageInstallBootAssets, Name: "mkdir", Args: []string{"-p", espMount}},
		{Stage: stageInstallBootAssets, Name: "mount", Args: []string{"-t", "vfat", "-o", "rw,nodev,nosuid,noexec,umask=0077", esp, espMount}},
		{Stage: stageInstallBootAssets, Name: "bootctl", Args: []string{"--esp-path=" + espMount, "--no-variables", "install"}},
		{Stage: stageInstallBootAssets, Name: "mkdir", Args: []string{"-p", espVendorDir, espMount + "/loader/entries"}},
		{Stage: stageInstallBootAssets, Name: "mkdir", Args: []string{"-p", stateBootBackup}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemAUKIPath, espVendorDir + "/youeye-system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemBUKIPath, espVendorDir + "/youeye-system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.RecoveryUKIPath, espVendorDir + "/youeye-recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemAUKIPath, stateBootBackup + "/system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemBUKIPath, stateBootBackup + "/system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.RecoveryUKIPath, stateBootBackup + "/recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "sh", Args: []string{"-c", applianceLoaderConfigScript()}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemAUKIPath, espVendorDir + "/youeye-system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemBUKIPath, espVendorDir + "/youeye-system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.RecoveryUKIPath, espVendorDir + "/youeye-recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemAUKIPath, stateBootBackup + "/system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemBUKIPath, stateBootBackup + "/system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.RecoveryUKIPath, stateBootBackup + "/recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "sync", Args: []string{}},
		installJournalCommand(stageInstallBootAssets, plan, assets),
		{Stage: stageInstallBootAssets, Name: "umount", Args: []string{espMount}},
		{Stage: stageActivateSystemBoot, Name: "efibootmgr", Args: []string{"--create", "--disk", target, "--part", "1", "--label", "YouEye Boot Manager", "--loader", "\\EFI\\systemd\\systemd-bootx64.efi"}},
		installJournalCommand(stageActivateSystemBoot, plan, assets),
		{Stage: stageVerifyInstall, Name: "sgdisk", Args: []string{"--verify", target}},
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", systemA}},
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", systemB}},
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", recovery}},
		installJournalCommand(stageVerifyInstall, plan, assets),
		{Stage: stageVerifyInstall, Name: "sync", Args: []string{}},
		{Stage: stageVerifyInstall, Name: "umount", Args: []string{stateMount}},
	}
	return commands, nil
}

func appliancePreserveCommandPlan(plan applianceInstallPlan, assets applianceImageAssets, manifest applianceBundleManifest) ([]applianceCommand, error) {
	if _, err := applianceCommandPlan(plan, assets); err != nil {
		return nil, err
	}
	target := plan.TargetDiskPath
	esp := partitionPath(target, 1)
	recovery := partitionPath(target, 2)
	systemA := partitionPath(target, 3)
	systemB := partitionPath(target, 4)
	state := partitionPath(target, 5)
	dataPart := partitionPath(target, 6)
	verifyLayout := `set -eu
disk="$1"; recovery="$2"; system_a="$3"; system_b="$4"; state="$5"; data="$6"
sgdisk --verify "$disk" >/dev/null
expected="YE-ESP YE-RECOVERY YE-SYSTEM-A YE-SYSTEM-B YE-STATE YE-DATA"
actual="$(lsblk -nrpo PARTLABEL "$disk" | sed '/^$/d' | paste -sd ' ' -)"
[ "$actual" = "$expected" ]
[ "$(blockdev --getsize64 "$recovery")" -eq 4294967296 ]
[ "$(blockdev --getsize64 "$system_a")" -eq 8589934592 ]
[ "$(blockdev --getsize64 "$system_b")" -eq 8589934592 ]
[ "$(blockdev --getsize64 "$state")" -eq 4294967296 ]
[ "$(blockdev --getsize64 "$data")" -gt 0 ]`
	verifyState := `set -eu
state="$1"; mountpoint="$2"; state_schema="$3"; data_schema="$4"; layout="$5"; recovery="$6"
mkdir -p "$mountpoint"
umount "$mountpoint" 2>/dev/null || true
mount -o ro,nodev,nosuid "$state" "$mountpoint"
trap 'umount "$mountpoint" 2>/dev/null || true' EXIT
jq -e --argjson state_schema "$state_schema" --argjson data_schema "$data_schema" --argjson layout "$layout" --arg recovery "$recovery" '
  .schema_version == $state_schema and .data_schema_version == $data_schema and
  .disk_layout_version == $layout and .recovery_version == $recovery and
  (.slots.current == "A" or .slots.current == "B") and
  (.lifecycle == "unconfigured" or .lifecycle == "configured" or .lifecycle == "factory")
' "$mountpoint/appliance-state.json" >/dev/null
[ -s "$mountpoint/etc/machine-id" ]
[ -s "$mountpoint/etc/systemd/network/20-youeye.network" ]`
	updateState := `set -eu
state_root="$1"; manifest="$2"; signature="$3"; image="$4"; recovery="$5"
path="$state_root/appliance-state.json"; tmp="$path.tmp"
jq --arg image "$image" --arg recovery "$recovery" '
  .slots = {current:"A",current_image_version:$image} |
  .transaction = {} | .recovery_version = $recovery
' "$path" > "$tmp"
chmod 0600 "$tmp"; sync -f "$tmp"; mv -f "$tmp" "$path"
install -m 0644 "$manifest" "$state_root/installer/appliance-manifest.json"
install -m 0644 "$signature" "$state_root/installer/appliance-manifest.json.sig"
sync -f "$state_root/installer"; sync -f "$state_root"`
	commands := []applianceCommand{
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RootPayload.Path}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RecoveryPayload.Path}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.SystemAUKIPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.SystemBUKIPath}},
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-e", assets.RecoveryUKIPath}},
		{Stage: stageVerifyInputs, Name: "sh", Args: []string{"-c", verifyLayout, "youeye-preserve-layout", target, recovery, systemA, systemB, state, dataPart}},
		{Stage: stageVerifyInputs, Name: "sh", Args: []string{"-c", verifyState, "youeye-preserve-state", state, stateMount, strconv.Itoa(manifest.StateSchemaMin), strconv.Itoa(manifest.DataSchemaMin), strconv.Itoa(manifest.DiskLayout.Version), manifest.RecoveryVersion}},
		{Stage: stageInitializeJournal, Name: "mkdir", Args: []string{"-p", stateMount}},
		{Stage: stageInitializeJournal, Name: "mount", Args: []string{state, stateMount}},
		installJournalCommand(stageInitializeJournal, plan, assets),
		payloadWriteCommand(stageWriteSystemA, assets.RootPayload, systemA),
		payloadReadbackCommand(stageWriteSystemA, assets.RootPayload, systemA),
		installJournalCommand(stageWriteSystemA, plan, assets),
		payloadWriteCommand(stageWriteSystemB, assets.RootPayload, systemB),
		payloadReadbackCommand(stageWriteSystemB, assets.RootPayload, systemB),
		installJournalCommand(stageWriteSystemB, plan, assets),
		payloadWriteCommand(stageWriteRecovery, assets.RecoveryPayload, recovery),
		payloadReadbackCommand(stageWriteRecovery, assets.RecoveryPayload, recovery),
		installJournalCommand(stageWriteRecovery, plan, assets),
		{Stage: stageInitializeState, Name: "sh", Args: []string{"-c", updateState, "youeye-preserve-state-update", stateMount, assets.ManifestPath, assets.SignaturePath, assets.ImageVersion, manifest.RecoveryVersion}},
		installJournalCommand(stageInitializeState, plan, assets),
		{Stage: stageInstallBootAssets, Name: "mkdir", Args: []string{"-p", espMount}},
		{Stage: stageInstallBootAssets, Name: "mount", Args: []string{"-t", "vfat", "-o", "rw,nodev,nosuid,noexec,umask=0077", esp, espMount}},
		{Stage: stageInstallBootAssets, Name: "bootctl", Args: []string{"--esp-path=" + espMount, "--no-variables", "install"}},
		{Stage: stageInstallBootAssets, Name: "mkdir", Args: []string{"-p", espVendorDir, espMount + "/loader/entries", stateBootBackup}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemAUKIPath, espVendorDir + "/youeye-system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemBUKIPath, espVendorDir + "/youeye-system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.RecoveryUKIPath, espVendorDir + "/youeye-recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemAUKIPath, stateBootBackup + "/system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.SystemBUKIPath, stateBootBackup + "/system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"-m", "0644", assets.RecoveryUKIPath, stateBootBackup + "/recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "sh", Args: []string{"-c", applianceLoaderConfigScript()}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemAUKIPath, espVendorDir + "/youeye-system-a.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.SystemBUKIPath, espVendorDir + "/youeye-system-b.efi"}},
		{Stage: stageInstallBootAssets, Name: "cmp", Args: []string{"-s", assets.RecoveryUKIPath, espVendorDir + "/youeye-recovery.efi"}},
		{Stage: stageInstallBootAssets, Name: "sync"},
		installJournalCommand(stageInstallBootAssets, plan, assets),
		{Stage: stageInstallBootAssets, Name: "umount", Args: []string{espMount}},
		{Stage: stageActivateSystemBoot, Name: "efibootmgr", Args: []string{"--create", "--disk", target, "--part", "1", "--label", "YouEye Boot Manager", "--loader", "\\EFI\\systemd\\systemd-bootx64.efi"}},
		installJournalCommand(stageActivateSystemBoot, plan, assets),
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", systemA}},
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", systemB}},
		{Stage: stageVerifyInstall, Name: "e2fsck", Args: []string{"-f", "-n", recovery}},
		installJournalCommand(stageVerifyInstall, plan, assets),
		{Stage: stageVerifyInstall, Name: "sync"},
		{Stage: stageVerifyInstall, Name: "umount", Args: []string{stateMount}},
	}
	return commands, nil
}

func validateAppliancePayloadAsset(name string, asset appliancePayloadAsset) error {
	if strings.TrimSpace(asset.Path) == "" || asset.SizeBytes <= 0 || !validSHA256Hex(asset.SHA256) {
		return fmt.Errorf("%s payload path, size, and SHA-256 are required", name)
	}
	if asset.Compression != "" && asset.Compression != "zstd" {
		return fmt.Errorf("%s payload compression %q is not supported", name, asset.Compression)
	}
	return nil
}

func payloadWriteCommand(stage applianceWriteStage, asset appliancePayloadAsset, target string) applianceCommand {
	if asset.Compression == "zstd" {
		return applianceCommand{Stage: stage, Name: "bash", Args: []string{
			"-o", "pipefail", "-c", `zstd -dc -- "$1" | dd of="$2" bs=16M conv=fsync status=none`,
			"youeye-payload-write", asset.Path, target,
		}}
	}
	return applianceCommand{Stage: stage, Name: "dd", Args: []string{"if=" + asset.Path, "of=" + target, "bs=16M", "conv=fsync", "status=none"}}
}

func payloadReadbackCommand(stage applianceWriteStage, asset appliancePayloadAsset, target string) applianceCommand {
	return applianceCommand{Stage: stage, Name: "bash", Args: []string{
		"-o", "pipefail", "-c",
		`actual="$(head -c "$1" -- "$2" | sha256sum | cut -d ' ' -f 1)"; test "$actual" = "$3"`,
		"youeye-payload-readback", strconv.FormatInt(asset.SizeBytes, 10), target, asset.SHA256,
	}}
}

func installJournalCommand(stage applianceWriteStage, plan applianceInstallPlan, assets applianceImageAssets) applianceCommand {
	script := `set -eu
path="$1"
mkdir -p "$(dirname "$path")"
tmp="${path}.tmp"
jq -n \
	  --arg schema "youeye.appliance.install-journal.v3" \
	  --arg operation "$2" \
	  --arg transaction_id "$3" \
	  --arg manifest_sha256 "$4" \
	  --arg image_version "$5" \
	  --arg stage "$6" \
	  --arg target_disk "$7" \
	  --arg target_serial "$8" \
	  '{schema:$schema,operation:$operation,transaction_id:$transaction_id,manifest_sha256:$manifest_sha256,image_version:$image_version,stage:$stage,target_disk:$target_disk,target_serial:$target_serial}' > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$path"
sync -f "$(dirname "$path")"`
	return applianceCommand{Stage: stage, Name: "sh", Args: []string{
		"-c", script, "youeye-install-journal", installJournalPath,
		assets.Operation, assets.TransactionID, assets.ManifestSHA256, assets.ImageVersion, string(stage), plan.TargetDiskPath,
		plan.TargetSerial,
	}}
}

func applianceStateInitArgs(assets applianceImageAssets) []string {
	script := `set -eu
source_root="$1"
state_root="$2"
manifest="$3"
signature="$4"
network_mode="$5"
address="$6"
gateway="$7"
dns="$8"
adapter_mac="$9"
answer="${10}"
shift 10

install -d -m 0700 "$state_root/installer" "$state_root/bootstrap" "$state_root/root/.ssh"
install -d -m 0755 "$state_root/etc/ssh" "$state_root/etc/systemd/network"
install -d -m 0755 "$state_root/var/lib/systemd" "$state_root/var/log"
cp -a "$source_root/etc/ssh/." "$state_root/etc/ssh/"
install -m 0640 "$source_root/etc/shadow" "$state_root/etc/shadow"
cp -a "$source_root/var/lib/systemd/." "$state_root/var/lib/systemd/"
cp -a "$source_root/var/log/." "$state_root/var/log/"
rm -f "$state_root/etc/ssh/ssh_host_"*
ssh-keygen -A -f "$state_root"
install -m 0644 "$manifest" "$state_root/installer/appliance-manifest.json"
install -m 0644 "$signature" "$state_root/installer/appliance-manifest.json.sig"
tr -d '-' < /proc/sys/kernel/random/uuid > "$state_root/etc/machine-id"
printf '\n' >> "$state_root/etc/machine-id"
openssl rand 4 > "$state_root/etc/hostid"
chmod 0644 "$state_root/etc/hostid"

network_match='Name=en* eth*'
if [ -n "$adapter_mac" ]; then
  network_match="MACAddress=$adapter_mac"
fi
if [ "$network_mode" = static ]; then
  cat > "$state_root/etc/systemd/network/20-youeye.network" <<EOF
[Match]
$network_match

[Network]
Address=$address
Gateway=$gateway
DNS=$dns
IPv6AcceptRA=no
LinkLocalAddressing=no
EOF
else
  cat > "$state_root/etc/systemd/network/20-youeye.network" <<EOF
[Match]
$network_match

[Network]
DHCP=ipv4
IPv6AcceptRA=no
LinkLocalAddressing=ipv4
EOF
fi
chmod 0644 "$state_root/etc/systemd/network/20-youeye.network"

# Persist desired bootstrap policy outside the sealed System slots. The answer
# file is protected and the password hash is never copied through argv or logs.
if jq -e '.schema == "youeye.appliance.answer.v3" or .schema == "youeye.appliance.answer.v4"' "$answer" >/dev/null 2>&1; then
  jq -e '.release_policy' "$answer" > "$state_root/bootstrap/release-policy.json.tmp"
  jq -e '.development_access' "$answer" > "$state_root/bootstrap/development-access.json.tmp"
else
  jq -n '{schema:"youeye.release-policy.v1",provider:"github",mode:"track",track:"stable",freshness:"require-current"}' > "$state_root/bootstrap/release-policy.json.tmp"
  jq -n '{schema:"youeye.development-access.v1",local_root_console:false,root_password_ssh:false}' > "$state_root/bootstrap/development-access.json.tmp"
fi
jq -n --arg mode "$network_mode" --arg adapter_mac "$adapter_mac" --arg address "$address" --arg gateway "$gateway" --arg dns "$dns" '
  {schema:"youeye.network-profile.v1",id:"primary",kind:"ethernet",ipv4:{mode:$mode}}
  + if $adapter_mac != "" then {adapter_mac:$adapter_mac} else {} end
  + if $mode == "static" then {ipv4:{mode:$mode,address:$address,gateway:$gateway,dns:[$dns]}} else {} end
' > "$state_root/bootstrap/network-profile.json.tmp"
for file in release-policy development-access network-profile; do
  chmod 0600 "$state_root/bootstrap/$file.json.tmp"
  mv -f "$state_root/bootstrap/$file.json.tmp" "$state_root/bootstrap/$file.json"
done
sync -f "$state_root/bootstrap"
# Optional transport cache from the same answer medium. Artifact signatures and
# sealed component pins remain mandatory when these bytes are consumed.
cache_digest=$(jq -r '.release_cache_sha256 // empty' "$answer")
if [ -n "$cache_digest" ]; then
  cache_source="$(dirname "$answer")/release-cache"
  test "$(sha256sum "$cache_source/index.json" | awk '{print $1}')" = "$cache_digest"
  test ! -e "$state_root/release-cache"
  mkdir -p "$state_root/release-cache/objects"
  cp -- "$cache_source/index.json" "$state_root/release-cache/index.json"
  # The full digest is split across short path segments on ISO9660 media.
  # Restore the normal content-addressed layout only after verifying each object.
  jq -er '.objects | type == "object"' "$cache_source/index.json" >/dev/null
  jq -r '.objects[].sha256' "$cache_source/index.json" | sort -u | while IFS= read -r digest; do
    printf '%s\n' "$digest" | grep -Eq '^[0-9a-f]{64}$'
    relative=$(printf '%s\n' "$digest" | awk '{print substr($0,1,16) "/" substr($0,17,16) "/" substr($0,33,16) "/" substr($0,49,16)}')
    source="$cache_source/objects/$relative"
    test -f "$source" && test ! -L "$source"
    test "$(sha256sum "$source" | awk '{print $1}')" = "$digest"
    cp -- "$source" "$state_root/release-cache/objects/$digest"
    chmod 0400 "$state_root/release-cache/objects/$digest"
  done
  chmod 0400 "$state_root/release-cache/index.json"
  chmod 0700 "$state_root/release-cache" "$state_root/release-cache/objects"
fi


if [ "$#" -gt 0 ]; then
  printf '%s\n' "$@" > "$state_root/root/.ssh/authorized_keys"
  chmod 0600 "$state_root/root/.ssh/authorized_keys"
fi`
	mode := strings.ToLower(strings.TrimSpace(assets.Network.Mode))
	if mode == "" {
		mode = "dhcp"
	}
	args := []string{
		"-c", script, "youeye-state-init", systemMount, stateMount,
		assets.ManifestPath, assets.SignaturePath, mode,
		assets.Network.Address, assets.Network.Gateway, assets.Network.DNS,
		assets.Network.AdapterMAC,
		assets.AnswerPath,
	}
	return append(args, assets.AuthorizedKeys...)
}

func applianceLoaderConfigScript() string {
	return `set -eu
cat > /mnt/youeye-esp/loader/loader.conf <<'EOF'
timeout 3
editor no
auto-entries no
auto-firmware yes
EOF
cat > /mnt/youeye-esp/loader/entries/youeye-system-a+3-0.conf <<'EOF'
title YouEye System A
sort-key youeye-system
version 1-a
efi /EFI/YouEye/youeye-system-a.efi
EOF
cat > /mnt/youeye-esp/loader/entries/youeye-system-b+3-0.conf <<'EOF'
title YouEye System B
sort-key youeye-system
version 0-b
efi /EFI/YouEye/youeye-system-b.efi
EOF
cat > /mnt/youeye-esp/loader/entries/youeye-recovery.conf <<'EOF'
title YouEye Recovery
sort-key zz-youeye-recovery
version 1
efi /EFI/YouEye/youeye-recovery.efi
EOF
printf 'type1\n' > /mnt/youeye-esp/loader/entries.srel`
}

func executeApplianceCommands(commands []applianceCommand, runner applianceCommandRunner, progress func(applianceCommand)) error {
	mounted := map[string]bool{}
	for _, command := range commands {
		if progress != nil {
			progress(command)
		}
		out, err := runner.Run(command.Name, command.Args...)
		if err != nil {
			for _, mountpoint := range []string{systemMount, espMount, stateMount} {
				if mounted[mountpoint] && !(command.Name == "umount" && len(command.Args) == 1 && command.Args[0] == mountpoint) {
					_, _ = runner.Run("umount", mountpoint)
					mounted[mountpoint] = false
				}
			}
			out = strings.TrimSpace(out)
			if out != "" {
				return fmt.Errorf("%s %s: %w: %s", command.Stage, command.Name, err, out)
			}
			return fmt.Errorf("%s %s: %w", command.Stage, command.Name, err)
		}
		if command.Name == "mount" && len(command.Args) >= 2 {
			mountpoint := command.Args[len(command.Args)-1]
			if isTrackedApplianceMount(mountpoint) {
				mounted[mountpoint] = true
			}
		}
		if command.Name == "umount" && len(command.Args) == 1 && isTrackedApplianceMount(command.Args[0]) {
			mounted[command.Args[0]] = false
		}
	}
	return nil
}

func isTrackedApplianceMount(mountpoint string) bool {
	return mountpoint == espMount || mountpoint == systemMount || mountpoint == stateMount
}

func partitionPath(disk string, index int) string {
	if strings.Contains(disk, "nvme") || strings.Contains(disk, "mmcblk") || strings.Contains(disk, "loop") {
		return disk + "p" + strconv.Itoa(index)
	}
	return disk + strconv.Itoa(index)
}
