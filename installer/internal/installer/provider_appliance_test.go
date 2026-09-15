package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplianceProviderPlanOnlyCompletesWithoutDiskWrites(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	seedPath := writeTestSeed(t, bundle.manifestSHA, "TARGET")
	cfg := installConfig{
		ApplianceSeedPath:     seedPath,
		ApplianceTargetDisk:   "/dev/vda",
		ApplianceTargetDiskGB: 128,
		AppliancePlanOnly:     true,
	}
	bundle.apply(&cfg)
	var messages []engineMsg
	ch := make(chan engineMsg, 16)
	installAppliance(cfg, ch)
	close(ch)
	for msg := range ch {
		messages = append(messages, msg)
	}
	last := messages[len(messages)-1]
	if !last.Done || last.Err != nil || last.ResultIP != "appliance-plan-only" {
		t.Fatalf("unexpected final message: %+v", last)
	}
}

func TestApplianceProviderExecutesVerifiedCommandPlanWithInjectedRunner(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	seedPath := writeTestSeed(t, bundle.manifestSHA, "TARGET")
	runner := &applianceExecutionRunner{}
	cfg := installConfig{
		ApplianceSeedPath: seedPath,
	}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 256)
	installApplianceWithRunner(cfg, ch, runner)
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err != nil || !final.Done || final.ResultIP != "appliance-installed" {
		t.Fatalf("unexpected final message: %+v", final)
	}
	if !containsCall(runner.calls, "sgdisk --zap-all /dev/vda") {
		t.Fatalf("system disk was not partitioned: %v", runner.calls)
	}
	if !containsCall(runner.calls, "efibootmgr --create --disk /dev/vda --part 1 --label YouEye Boot Manager --loader \\EFI\\systemd\\systemd-bootx64.efi") {
		t.Fatalf("boot activation did not run: %v", runner.calls)
	}
}

func TestApplianceProviderRejectsEffectfulExplicitDiskOverrides(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{
		ApplianceSeedPath:   writeTestSeed(t, bundle.manifestSHA, "TARGET"),
		ApplianceTargetDisk: "/dev/vda", ApplianceTargetDiskGB: 128,
	}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 32)
	installApplianceWithRunner(cfg, ch, &recordingRunner{})
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err == nil || !strings.Contains(final.Err.Error(), "plan-only") {
		t.Fatalf("expected effectful override rejection, got %+v", final)
	}
}

func TestApplianceCommandProgressRedactsShellArguments(t *testing.T) {
	command := applianceCommand{Stage: stageInitializeState, Name: "sh", Args: []string{"-c", "script", "ssh-ed25519 sensitive-public-key"}}
	detail := applianceCommandProgressDetail(command)
	if strings.Contains(detail, "sensitive") || !strings.Contains(detail, "redacted") {
		t.Fatalf("shell progress was not redacted: %q", detail)
	}
}

func TestApplianceProviderRejectsSeedForDifferentManifest(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	cfg := installConfig{
		ApplianceSeedPath:     writeTestSeed(t, validSHA256(), "TARGET"),
		ApplianceTargetDisk:   "/dev/vda",
		ApplianceTargetDiskGB: 128,
		AppliancePlanOnly:     true,
	}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 16)
	installApplianceWithRunner(cfg, ch, &recordingRunner{})
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err == nil || !strings.Contains(final.Err.Error(), "manifest identity") {
		t.Fatalf("expected manifest binding rejection, got %+v", final)
	}
}

func TestApplianceProviderRequiresSignedBundleBeforeInstallerInput(t *testing.T) {
	ch := make(chan engineMsg, 16)
	installAppliance(installConfig{}, ch)
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err == nil || !strings.Contains(final.Err.Error(), "manifest") {
		t.Fatalf("expected signed bundle requirement error, got %+v", final)
	}
}

type testApplianceBundle struct {
	manifestPath  string
	signaturePath string
	trustKeyPath  string
	manifestSHA   string
}

type applianceExecutionRunner struct {
	calls []string
}

func (r *applianceExecutionRunner) Run(name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if call == "lsblk --json --bytes --output NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,RO,MOUNTPOINTS,FSTYPE,LABEL" {
		return `{"blockdevices":[
		  {"name":"vda","path":"/dev/vda","type":"disk","size":137438953472,"model":"appliance","serial":"TARGET","rm":false,"ro":false,"mountpoints":[],"fstype":"","label":""}
		]}`, nil
	}
	return "", nil
}

func (b testApplianceBundle) apply(cfg *installConfig) {
	cfg.ApplianceManifestPath = b.manifestPath
	cfg.ApplianceSignaturePath = b.signaturePath
	cfg.ApplianceTrustKeyPath = b.trustKeyPath
}

func writeTestApplianceBundle(t *testing.T) testApplianceBundle {
	t.Helper()
	dir := t.TempDir()
	type testAsset struct {
		role string
		name string
		data []byte
	}
	inputs := []testAsset{
		{role: "system-root", name: "system-root.img", data: []byte("test root image\n")},
		{role: "internal-recovery", name: "internal-recovery.img", data: []byte("test recovery image\n")},
		{role: "system-a-uki", name: "system-a.efi", data: []byte("test system A UKI\n")},
		{role: "system-b-uki", name: "system-b.efi", data: []byte("test system B UKI\n")},
		{role: "recovery-uki", name: "recovery.efi", data: []byte("test recovery UKI\n")},
	}
	assets := make([]applianceManifestAsset, 0, len(inputs))
	for _, input := range inputs {
		path := filepath.Join(dir, input.name)
		if err := os.WriteFile(path, input.data, 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(input.data)
		assets = append(assets, applianceManifestAsset{
			Role: input.role, Path: input.name,
			SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(input.data)),
		})
	}
	manifest := applianceBundleManifest{
		Schema: applianceBundleSchema, ImageVersion: "0.6.0-dev.1", BuildID: "test-build",
		SourceCommit: strings.Repeat("b", 40), Architecture: "amd64", FirmwareMode: "uefi",
		DiskLayout: applianceManifestLayout{
			Version: 3, TargetMinGiB: 32,
			ESPGiB: 1, RecoveryGiB: 4, RootSlotGiB: 8, StateGiB: 4,
		},
		StateSchemaMin: applianceStateSchema, StateSchemaMax: applianceStateSchema,
		DataSchemaMin: applianceDataSchema, DataSchemaMax: applianceDataSchema,
		KernelCompatibility: applianceKernelCompatibility, ZFSCompatibility: applianceZFSCompatibility,
		ZFSFeatureProfile: applianceZFSFeatureProfile, IncusCompatibility: applianceIncusCompatibility,
		RecoveryVersion: applianceRecoveryVersion,
		Trust:           applianceManifestTrust{Class: applianceTrustDev, KeyID: "test-development-key"},
		ReleaseSet: applianceManifestReleases{
			Source: "forgejo", Branch: "dev", Fallback: []string{},
			Spine:        applianceManifestComponent{Version: "0.5.17.0.0.9", SourceCommit: strings.Repeat("b", 40), ArtifactSHA256: validSHA256()},
			ControlPanel: applianceManifestComponent{Version: "0.5.0", Tag: "cp-dev-v0.5.0", SourceCommit: strings.Repeat("d", 40), ArtifactSHA256: validSHA256()},
			UI:           applianceManifestComponent{Version: "0.5.0", Tag: "ui-dev-v0.5.0", SourceCommit: strings.Repeat("e", 40), ArtifactSHA256: validSHA256()},
		},
		Artifacts: assets, SourceDateEpoch: 1,
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	manifestPath := filepath.Join(dir, "appliance-manifest.json")
	if err := os.WriteFile(manifestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(dir, "appliance-manifest.json.sig")
	if err := os.WriteFile(signaturePath, ed25519.Sign(privateKey, raw), 0600); err != nil {
		t.Fatal(err)
	}
	trustKeyPath := filepath.Join(dir, "appliance-development.pub")
	if err := os.WriteFile(trustKeyPath, []byte(hex.EncodeToString(publicKey)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	return testApplianceBundle{
		manifestPath: manifestPath, signaturePath: signaturePath,
		trustKeyPath: trustKeyPath, manifestSHA: hex.EncodeToString(digest[:]),
	}
}

func writeTestSeed(t *testing.T, manifestSHA, targetSerial string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "seed.json")
	doc := applianceSeed{
		Schema: applianceSeedSchema, RigID: "rig-test", ArtifactID: "artifact-test",
		ManifestSHA256: manifestSHA, Operation: "install", Profile: "youeye-minimum-128",
		ProfileVersion: "youeye-minimum-128/v1", ProfileDigest: "digest",
		Scenario: "blank-install", TargetSerial: targetSerial,
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func containsCall(calls []string, want string) bool {
	for _, call := range calls {
		if call == want {
			return true
		}
	}
	return false
}
