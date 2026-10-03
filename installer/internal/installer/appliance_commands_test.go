package installer

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplianceCommandPlanOrdersVerifiedWritesBeforeBootActivation(t *testing.T) {
	plan, err := planApplianceInstall(
		applianceDisk{Path: "/dev/vda", Serial: "target", SizeBytes: 128 * applianceGiB},
		validApplianceArtifacts(8*applianceGiB),
	)
	if err != nil {
		t.Fatal(err)
	}
	commands, err := applianceCommandPlan(plan, validCommandAssets())
	if err != nil {
		t.Fatal(err)
	}
	index := map[applianceWriteStage]int{}
	for i, command := range commands {
		if _, ok := index[command.Stage]; !ok {
			index[command.Stage] = i
		}
	}
	for _, before := range []applianceWriteStage{
		stagePartitionTarget, stageInitializeJournal, stageWriteSystemA,
		stageWriteSystemB, stageWriteRecovery, stageInitializeState,
		stageInstallBootAssets,
	} {
		if index[before] >= index[stageActivateSystemBoot] {
			t.Fatalf("%s must occur before boot activation", before)
		}
	}
	if commands[0].Stage != stageVerifyInputs || commands[0].Name != "test" {
		t.Fatalf("first command must verify inputs, got %+v", commands[0])
	}
	if commands[len(commands)-1].Stage != stageVerifyInstall {
		t.Fatalf("last command must verify install, got %+v", commands[len(commands)-1])
	}
}

func TestApplianceCommandPlanUsesFixedLayoutAndThreeUKIs(t *testing.T) {
	commands, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/nvme0n1",
		RootSlotBytes:  applianceRootSlotBytes,
	}, validCommandAssets())
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(commands)
	for _, want := range []string{
		"--new=2:0:+4096M",
		"--new=3:0:+8192M",
		"--new=4:0:+8192M",
		"--new=5:0:+4096M",
		"--new=6:0:0",
		"mount -t vfat -o rw,nodev,nosuid,noexec,umask=0077 /dev/nvme0n1p1 /mnt/youeye-esp",
		"bootctl --esp-path=/mnt/youeye-esp --no-variables install",
		"install -m 0644 /artifacts/system-a.efi /mnt/youeye-esp/EFI/YouEye/youeye-system-a.efi",
		"install -m 0644 /artifacts/system-b.efi /mnt/youeye-esp/EFI/YouEye/youeye-system-b.efi",
		"install -m 0644 /artifacts/recovery.efi /mnt/youeye-esp/EFI/YouEye/youeye-recovery.efi",
		"efibootmgr --create --disk /dev/nvme0n1 --part 1 --label YouEye Boot Manager --loader \\EFI\\systemd\\systemd-bootx64.efi",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("commands missing %q:\n%s", want, joined)
		}
	}
}

func TestApplianceCommandPlanStreamsCompressedPayloadsAndReadsBackHashes(t *testing.T) {
	commands, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda",
		RootSlotBytes:  applianceRootSlotBytes,
	}, validCommandAssets())
	if err != nil {
		t.Fatal(err)
	}
	var compressedWrites, readbacks int
	for _, command := range commands {
		args := strings.Join(command.Args, " ")
		if command.Name == "bash" && strings.Contains(args, "zstd -dc") {
			compressedWrites++
		}
		if command.Name == "bash" && strings.Contains(args, "sha256sum") {
			readbacks++
		}
	}
	if compressedWrites != 3 {
		t.Fatalf("compressed writes=%d, want root A, root B, and recovery", compressedWrites)
	}
	if readbacks != 3 {
		t.Fatalf("readbacks=%d, want three payload verifications", readbacks)
	}
}

func TestApplianceCommandPlanInitializesStateAndBootCounting(t *testing.T) {
	assets := validCommandAssets()
	assets.TransactionID = "0123456789abcdef0123456789abcdef"
	assets.Network = applianceAnswerNetwork{Mode: "static", AdapterMAC: "02:00:00:00:00:18", Address: "192.0.2.10/24", Gateway: "192.0.2.1", DNS: "192.0.2.53"}
	assets.AuthorizedKeys = []string{"ssh-ed25519 AAAATEST operator"}
	commands, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda",
		RootSlotBytes:  applianceRootSlotBytes,
	}, assets)
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(commands)
	for _, want := range []string{
		"youeye.appliance.install-journal.v3",
		"0123456789abcdef0123456789abcdef",
		"mount -o ro /dev/vda3 /mnt/youeye-system",
		"$state_root/var/lib/systemd",
		"$state_root/var/log",
		"openssl rand 4",
		"$state_root/etc/hostid",
		"192.0.2.10/24",
		"network_match=\"MACAddress=$adapter_mac\"",
		"02:00:00:00:00:18",
		"adapter_mac:$adapter_mac",
		"IPv6AcceptRA=no",
		"LinkLocalAddressing=no",
		"ssh-ed25519 AAAATEST operator",
		"youeye-system-a+3-0.conf",
		"youeye-system-b+3-0.conf",
		"youeye-recovery.conf",
		"efi /EFI/YouEye/youeye-system-a.efi",
		"efi /EFI/YouEye/youeye-system-b.efi",
		"efi /EFI/YouEye/youeye-recovery.efi",
		"install -m 0644 /artifacts/system-a.efi /mnt/youeye-state/installer/boot/system-a.efi",
		"install -m 0644 /artifacts/system-b.efi /mnt/youeye-state/installer/boot/system-b.efi",
		"install -m 0644 /artifacts/recovery.efi /mnt/youeye-state/installer/boot/recovery.efi",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("commands missing %q", want)
		}
	}
	if strings.Contains(joined, "/EFI/Linux/youeye-") {
		t.Fatal("UKIs in /EFI/Linux would create uncounted Type #2 entries")
	}
	if strings.Contains(joined, "default youeye-system-") {
		t.Fatal("a forced normal-slot default would bypass exhausted-entry assessment")
	}
	if strings.Contains(joined, "uki /EFI/YouEye/") {
		t.Fatal("Type #1 loader entries must use the supported efi field")
	}
}

func TestApplianceStateNetworkIsExplicitlyIPv4Only(t *testing.T) {
	assets := validCommandAssets()
	commands, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda", RootSlotBytes: applianceRootSlotBytes,
	}, assets)
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(commands)
	for _, want := range []string{"DHCP=ipv4", "IPv6AcceptRA=no", "LinkLocalAddressing=ipv4"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("DHCP state network is missing %q", want)
		}
	}
	if strings.Contains(joined, "DHCP=yes") || strings.Contains(joined, "IPv6AcceptRA=yes") {
		t.Fatal("appliance state network must not enable IPv6 implicitly")
	}
}

func TestExecuteApplianceCommandsStopsOnRunnerFailure(t *testing.T) {
	runner := &recordingRunner{failAt: "dd"}
	commands := []applianceCommand{
		{Stage: stageVerifyInputs, Name: "test", Args: []string{"-b", "/root.img"}},
		{Stage: stageWriteSystemA, Name: "dd", Args: []string{"if=/root.img", "of=/dev/vda3"}},
		{Stage: stageWriteSystemB, Name: "dd", Args: []string{"if=/root.img", "of=/dev/vda4"}},
	}
	if err := executeApplianceCommands(commands, runner, nil); err == nil {
		t.Fatal("expected runner failure")
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls=%d want stop after failing command", len(runner.calls))
	}
}

func TestExecuteApplianceCommandsUnmountsAllMountedFilesystemsAfterFailure(t *testing.T) {
	runner := &recordingRunner{failAt: "install"}
	commands := []applianceCommand{
		{Stage: stageInitializeJournal, Name: "mount", Args: []string{"/dev/vda5", stateMount}},
		{Stage: stageInstallBootAssets, Name: "mount", Args: []string{"/dev/vda1", espMount}},
		{Stage: stageInstallBootAssets, Name: "install", Args: []string{"/system.efi", espMount + "/EFI/Linux/system.efi"}},
	}
	if err := executeApplianceCommands(commands, runner, nil); err == nil {
		t.Fatal("expected runner failure")
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "umount "+espMount) || !strings.Contains(joined, "umount "+stateMount) {
		t.Fatalf("cleanup did not unmount ESP and State:\n%s", joined)
	}
}

func TestApplianceCommandPlanRequiresVerifiedAssetIdentity(t *testing.T) {
	if _, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda", RootSlotBytes: applianceRootSlotBytes,
	}, applianceImageAssets{}); err == nil {
		t.Fatal("expected missing assets rejection")
	}
	assets := validCommandAssets()
	assets.RootPayload.SHA256 = "caller-trust-is-not-an-identity"
	if _, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda", RootSlotBytes: applianceRootSlotBytes,
	}, assets); err == nil {
		t.Fatal("expected malformed payload identity rejection")
	}
}

func TestApplianceCommandPlanRejectsVariableRootSlotSize(t *testing.T) {
	if _, err := applianceCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda", RootSlotBytes: 12 * applianceGiB,
	}, validCommandAssets()); err == nil {
		t.Fatal("expected non-product root slot rejection")
	}
}

func TestPreserveReinstallVerifiesBeforeWritesAndNeverFormatsPersistentPartitions(t *testing.T) {
	commands, err := appliancePreserveCommandPlan(applianceInstallPlan{
		TargetDiskPath: "/dev/vda", TargetSerial: "target", RootSlotBytes: applianceRootSlotBytes,
	}, validCommandAssets(), applianceBundleManifest{
		StateSchemaMin: applianceStateSchema, DataSchemaMin: applianceDataSchema,
		DiskLayout: applianceManifestLayout{Version: 3}, RecoveryVersion: applianceRecoveryVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := commandStrings(commands)
	for _, want := range []string{
		"youeye-preserve-layout", "youeye-preserve-state", "appliance-state.json",
		"youeye-preserve-state-update", "/dev/vda3", "/dev/vda4", "/dev/vda2",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("preserve plan missing %q", want)
		}
	}
	for _, forbidden := range []string{"--zap-all", "mkfs.ext4", "mkfs.vfat", "wipefs"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("preserve plan contains destructive layout command %q", forbidden)
		}
	}
	firstWrite := len(commands)
	for i, command := range commands {
		if command.Stage == stageWriteSystemA {
			firstWrite = i
			break
		}
	}
	if firstWrite < 7 {
		t.Fatalf("preserve plan did not complete layout/state preflight before first write: %d", firstWrite)
	}
}

func TestPreserveReinstallReconcilesUpdateHistoryOnlyAfterVerifiedInstall(t *testing.T) {
	root := t.TempDir()
	installer := filepath.Join(root, "installer")
	updates := filepath.Join(root, "system-update")
	for _, path := range []string{installer, updates} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	manifest := []byte(`{"schema":"youeye.appliance.manifest.v1"}`)
	manifestPath := filepath.Join(installer, "appliance-manifest.json")
	if err := os.WriteFile(manifestPath, manifest, 0600); err != nil {
		t.Fatal(err)
	}
	sha := validSHA256()
	// The script must reject an install journal whose signed manifest digest
	// cannot be read back from State, even if the old updater journal exists.
	write := func(path, body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	transaction := "0123456789abcdef0123456789abcdef"
	image := "0.6.0-dev.2"
	write(filepath.Join(installer, "install-journal.json"), `{"schema":"youeye.appliance.install-journal.v3","operation":"preserve-reinstall","transaction_id":"`+transaction+`","manifest_sha256":"`+sha+`","image_version":"`+image+`","stage":"activate-system-boot"}`)
	write(filepath.Join(root, "appliance-state.json"), `{"slots":{"current":"A","current_image_version":"`+image+`"},"transaction":{}}`)
	old := `{"schema":"youeye.system-update.journal.v1","phase":"rolled-back"}`
	write(filepath.Join(updates, "journal.json"), old)
	run := func() error {
		return exec.Command("sh", "-c", preserveSystemUpdateReconcileScript(), "youeye-preserve-update-history", root, transaction, sha, image).Run()
	}
	if err := run(); err == nil {
		t.Fatal("accepted mismatched signed manifest digest")
	}
	if _, err := os.Stat(filepath.Join(updates, "journal.json")); err != nil {
		t.Fatal("old journal moved before verification:", err)
	}
	// Use the actual digest only after proving the mismatch was rejected.
	manifestSHA := fmt.Sprintf("%x", sha256.Sum256(manifest))
	write(filepath.Join(installer, "install-journal.json"), `{"schema":"youeye.appliance.install-journal.v3","operation":"preserve-reinstall","transaction_id":"`+transaction+`","manifest_sha256":"`+manifestSHA+`","image_version":"`+image+`","stage":"activate-system-boot"}`)
	cmd := exec.Command("sh", "-c", preserveSystemUpdateReconcileScript(), "youeye-preserve-update-history", root, transaction, manifestSHA, image)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("reconcile: %v: %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(updates, "journal.json")); !os.IsNotExist(err) {
		t.Fatalf("stale active journal remains: %v", err)
	}
	history := filepath.Join(updates, "history", "preserve-reinstall-"+transaction, "journal.json")
	got, err := os.ReadFile(history)
	if err != nil || string(got) != old {
		t.Fatalf("history was not retained: %v, %q", err, got)
	}
	if err := run(); err == nil {
		t.Fatal("accepted original mismatched manifest after reconciliation")
	}
	cmd = exec.Command("sh", "-c", preserveSystemUpdateReconcileScript(), "youeye-preserve-update-history", root, transaction, manifestSHA, image)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("repeated reconciliation was not idempotent: %v: %s", err, out)
	}
}

func TestApplianceLoaderReplacesPriorSlotEntries(t *testing.T) {
	script := applianceLoaderConfigScript()
	remove := strings.Index(script, "rm -f /mnt/youeye-esp/loader/entries/youeye-system-a*.conf /mnt/youeye-esp/loader/entries/youeye-system-b*.conf")
	newEntry := strings.Index(script, "cat > /mnt/youeye-esp/loader/entries/youeye-system-a+3-0.conf")
	if remove < 0 || newEntry <= remove {
		t.Fatal("installer does not replace stale counted and uncounted System slot entries")
	}
}

func validCommandAssets() applianceImageAssets {
	return applianceImageAssets{
		Operation: "erase-install",
		RootPayload: appliancePayloadAsset{
			Path: "/artifacts/system-root.img.zst", Compression: "zstd",
			SHA256: validSHA256(), SizeBytes: applianceRootSlotBytes,
		},
		RecoveryPayload: appliancePayloadAsset{
			Path: "/artifacts/internal-recovery.img.zst", Compression: "zstd",
			SHA256: validSHA256(), SizeBytes: applianceRecoveryBytes,
		},
		SystemAUKIPath:  "/artifacts/system-a.efi",
		SystemBUKIPath:  "/artifacts/system-b.efi",
		RecoveryUKIPath: "/artifacts/recovery.efi",
		ManifestPath:    "/artifacts/appliance-manifest.json",
		SignaturePath:   "/artifacts/appliance-manifest.json.sig",
		ManifestSHA256:  validSHA256(),
		ImageVersion:    "0.6.0-dev.1",
		TransactionID:   "0123456789abcdef0123456789abcdef",
		Network:         applianceAnswerNetwork{Mode: "dhcp"},
		AnswerPath:      "/run/youeye-appliance/appliance-answer.json",
	}
}

func commandStrings(commands []applianceCommand) string {
	lines := make([]string, 0, len(commands))
	for _, command := range commands {
		lines = append(lines, command.Name+" "+strings.Join(command.Args, " "))
	}
	return strings.Join(lines, "\n")
}

type recordingRunner struct {
	failAt string
	calls  []string
}

func (r *recordingRunner) Run(name string, args ...string) (string, error) {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	if name == r.failAt {
		return "", errors.New("boom")
	}
	return "", nil
}
