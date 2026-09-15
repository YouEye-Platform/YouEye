package systemupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const (
	baselineCommit = "0123456789012345678901234567890123456789"
	targetCommit   = "1123456789012345678901234567890123456789"
)

func testReleaseSet(commit string) appliance.ReleaseSet {
	return appliance.ReleaseSet{
		Source: "https://github.com/YouEye-Platform/YouEye", Branch: "dev", Fallback: []string{},
		Spine:        appliance.ComponentRelease{Version: "0.6.0", SourceCommit: commit, ArtifactSHA256: strings.Repeat("a", 64)},
		ControlPanel: appliance.ComponentRelease{Version: "1.0.0", Tag: "cp-dev-v1.0.0", SourceCommit: strings.Repeat("2", 40), ArtifactSHA256: strings.Repeat("b", 64)},
		UI:           appliance.ComponentRelease{Version: "1.0.0", Tag: "ui-dev-v1.0.0", SourceCommit: strings.Repeat("3", 40), ArtifactSHA256: strings.Repeat("c", 64)},
	}
}

func testApplianceManifest(version, commit string) appliance.Manifest {
	set := testReleaseSet(commit)
	return appliance.Manifest{
		SchemaVersion: 1, ImageVersion: version,
		BuildID: "build-" + version, SourceCommit: commit, Architecture: "amd64", FirmwareMode: "uefi",
		DiskLayoutVersion: appliance.CurrentDiskLayout, StateSchemaMin: 2, StateSchemaMax: 2,
		DataSchemaMin: 1, DataSchemaMax: 1, KernelCompatibility: ">=6.12", ZFSCompatibility: ">=2.3",
		ZFSFeatureProfile: "openzfs-2.2", IncusCompatibility: ">=7.0", RecoveryVersion: "1",
		ArtifactKind: "development", SupportedActions: []string{"recovery", "image-update"}, ReleaseSet: &set,
	}
}

func testPlan1Manifest() appliance.Manifest {
	manifest := testApplianceManifest("0.6.0-dev.26", baselineCommit)
	manifest.SupportedActions = []string{"recovery"}
	return manifest
}

func testState() appliance.StateRecord {
	return appliance.StateRecord{
		SchemaVersion: 2, Lifecycle: appliance.LifecycleConfigured,
		InstallIDRef: "install:test", DeviceIDRef: "device:test", DiskLayoutVersion: appliance.CurrentDiskLayout,
		StatePartUUID: "state-partuuid", DataPartUUID: "data-partuuid", ParentDiskID: "disk-v3:test",
		DataSchemaVersion: 1,
		Slots:             appliance.SlotState{Current: "A", CurrentImageVersion: "0.6.0-dev.26"},
		RecoveryVersion:   "1",
	}
}

func checksum(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func testUpdateManifest(files map[string][]byte) Manifest {
	artifacts := make([]Artifact, 0, 4)
	for _, item := range []struct{ role, path string }{
		{"system-root", "system-root.img.zst"}, {"system-a-uki", "system-a.efi"},
		{"system-b-uki", "system-b.efi"}, {"system-updater", "youeye-system-updater-linux-amd64"},
	} {
		artifact := Artifact{Role: item.role, Path: item.path, SHA256: checksum(files[item.path]), SizeBytes: int64(len(files[item.path]))}
		if item.role == "system-root" {
			artifact.Compression = "zstd"
			artifact.UncompressedSHA256 = strings.Repeat("d", 64)
			artifact.UncompressedSizeBytes = RootSlotBytes
		}
		artifacts = append(artifacts, artifact)
	}
	return Manifest{
		Schema: ManifestSchema, TargetImageVersion: "0.6.0-dev.27",
		BuildID: "build-target", SourceCommit: targetCommit, Architecture: "amd64", FirmwareMode: "uefi",
		HardwareProfile: "youeye-appliance-amd64-v1", DiskLayoutVersion: appliance.CurrentDiskLayout,
		StateSchemaMin: 2, StateSchemaMax: 2, DataSchemaMin: 1, DataSchemaMax: 1, RecoveryVersion: "1",
		MinimumCurrentImageVersion: "0.6.0-dev.26",
		RootSlotSizeBytes:          RootSlotBytes, BootAttempts: BootAttempts, HealthProfile: "operational",
		ArtifactKind: "development", Trust: Trust{Class: TrustClassDev, KeyID: "test-key"},
		Rollback:   RollbackContract{Supported: true, StateSchemaMin: 2, StateSchemaMax: 2, DataSchemaMin: 1, DataSchemaMax: 1, PreserveState: true, PreserveData: true, PreserveRecovery: true},
		ReleaseSet: testReleaseSet(targetCommit), Artifacts: artifacts, SourceDateEpoch: 1,
	}
}

func writeSignedBundle(t *testing.T, dir string, manifest Manifest, files map[string][]byte) (string, string) {
	return writeSignedBundleWithTrustID(t, dir, manifest, files, false)
}

func writeSignedBundleWithTrustID(t *testing.T, dir string, manifest Manifest, files map[string][]byte, preserveTrustID bool) (string, string) {
	t.Helper()
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if !preserveTrustID {
		manifest.Trust.KeyID, err = publicKeyID(publicKey)
		if err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "system-update-manifest.json")
	if err := os.WriteFile(manifestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	signaturePath := manifestPath + ".sig"
	if err := os.WriteFile(signaturePath, ed25519.Sign(privateKey, raw), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "trust.pub"), []byte(base64.StdEncoding.EncodeToString(publicKey)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "trust.key"), privateKey, 0600); err != nil {
		t.Fatal(err)
	}
	return manifestPath, signaturePath
}

type managerFixture struct {
	manager       *Manager
	dir           string
	manifestPath  string
	signaturePath string
	files         map[string][]byte
	update        Manifest
	runs          [][]string
	writes        []string
	bootInstalls  int
	bootCreates   int
	bootRemoves   int
}

func newManagerFixture(t *testing.T) *managerFixture {
	t.Helper()
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundle")
	if err := os.MkdirAll(bundleDir, 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"system-root.img.zst": []byte("root-zstd"), "system-a.efi": []byte("uki-a"),
		"system-b.efi": []byte("uki-b"), "youeye-system-updater-linux-amd64": []byte("updater"),
	}
	update := testUpdateManifest(files)
	manifestPath, signaturePath := writeSignedBundle(t, bundleDir, update, files)
	currentPath := filepath.Join(dir, "appliance-release")
	currentRaw, _ := json.Marshal(testApplianceManifest("0.6.0-dev.26", baselineCommit))
	if err := os.WriteFile(currentPath, currentRaw, 0444); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "state", "appliance-state.json")
	if err := appliance.WriteStateAtomic(statePath, testState()); err != nil {
		t.Fatal(err)
	}
	cmdlinePath := filepath.Join(dir, "cmdline")
	if err := os.WriteFile(cmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-A ro"), 0600); err != nil {
		t.Fatal(err)
	}
	f := &managerFixture{dir: dir, manifestPath: manifestPath, signaturePath: signaturePath, files: files, update: update}
	journalPath := filepath.Join(dir, "state", "system-update", "journal.json")
	cacheDir := filepath.Join(dir, "data", "system-update")
	layout := Layout{
		ESP:      layoutDevice{Path: "/dev/test1", PartUUID: "esp", ParentName: "test"},
		Recovery: layoutDevice{Path: "/dev/test2", PartUUID: "recovery", ParentName: "test"},
		SystemA:  layoutDevice{Path: filepath.Join(dir, "system-a"), PartUUID: "a", ParentName: "test", Size: RootSlotBytes},
		SystemB:  layoutDevice{Path: filepath.Join(dir, "system-b"), PartUUID: "b", ParentName: "test", Size: RootSlotBytes},
		State:    layoutDevice{Path: "/dev/test5", PartUUID: "state-partuuid", ParentName: "test"},
		Data:     layoutDevice{Path: "/dev/test6", PartUUID: "data-partuuid", ParentName: "test"},
		Parent:   "test", ActiveSlot: "A", InactiveSlot: "B",
		ActiveDevice: filepath.Join(dir, "system-a"), InactiveDevice: filepath.Join(dir, "system-b"),
	}
	config := Config{
		CurrentManifestPath: currentPath, StatePath: statePath,
		JournalPath: journalPath, HealthyManifestPath: filepath.Join(dir, "state", "system-update", "healthy-manifest.json"), ConvergencePath: filepath.Join(dir, "state", "first-deploy", "convergence-intent.json"), CacheDir: cacheDir,
		TrustKeyPath: filepath.Join(bundleDir, "trust.pub"), KernelCmdlinePath: cmdlinePath, ESPMountpoint: filepath.Join(dir, "efi"),
		Now: func() time.Time { return time.Unix(100, 0) },
		DiscoverLayout: func(active string) (Layout, error) {
			copy := layout
			if active == "B" {
				copy.ActiveSlot, copy.InactiveSlot = "B", "A"
				copy.ActiveDevice, copy.InactiveDevice = layout.SystemB.Path, layout.SystemA.Path
			}
			return copy, nil
		},
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			f.runs = append(f.runs, append([]string{name}, args...))
			return nil, nil
		},
		WriteRoot: func(_ context.Context, _ string, _ Artifact, target string) error {
			f.writes = append(f.writes, target)
			return nil
		},
		VerifyTarget:     func(context.Context, string, Manifest) error { return nil },
		VerifyStagedRoot: func(context.Context, string, Artifact) error { return nil },
		VerifyBootAssets: func(context.Context, Layout, Manifest) error { return nil },
		InstallBootAssets: func(context.Context, Layout, Manifest, string, string, string) error {
			f.bootInstalls++
			journal, err := loadJournal(journalPath)
			if err != nil {
				return err
			}
			transactionDir := filepath.Join(cacheDir, journal.TransactionID)
			if err := os.MkdirAll(transactionDir, 0o700); err != nil {
				return err
			}
			for source, destination := range map[string]string{
				f.manifestPath:  filepath.Join(transactionDir, "system-update-manifest.json"),
				f.signaturePath: filepath.Join(transactionDir, "system-update-manifest.json.sig"),
			} {
				raw, err := os.ReadFile(source)
				if err != nil {
					return err
				}
				if err := os.WriteFile(destination, raw, 0o600); err != nil {
					return err
				}
			}
			return nil
		},
		CreateBootEntry:   func(Layout, Manifest) error { f.bootCreates++; return nil },
		RemoveBootEntries: func(Layout) error { f.bootRemoves++; return nil },
		ExecutablePath:    func() (string, error) { return filepath.Join(bundleDir, "youeye-system-updater-linux-amd64"), nil },
	}
	f.manager = New(config)
	return f
}

func (f *managerFixture) sourceOptions() SourceOptions {
	return SourceOptions{ManifestSource: f.manifestPath, SignatureSource: f.signaturePath}
}

func (f *managerFixture) bootstrapSourceOptions() SourceOptions {
	options := f.sourceOptions()
	options.Bootstrap = true
	return options
}

func (f *managerFixture) setCurrentManifest(t *testing.T, manifest appliance.Manifest) {
	t.Helper()
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.manager.config.CurrentManifestPath, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.CurrentManifestPath, raw, 0444); err != nil {
		t.Fatal(err)
	}
}

func TestStageRejectsInsufficientYEDataCapacityBeforeSlotWrite(t *testing.T) {
	f := newManagerFixture(t)
	f.manager.config.AvailableBytes = func(string) (uint64, error) { return updateHeadroomBytes, nil }
	_, err := f.manager.Stage(context.Background(), f.sourceOptions())
	if err == nil || !strings.Contains(err.Error(), "insufficient YE-DATA capacity") {
		t.Fatalf("expected capacity rejection, got %v", err)
	}
	if len(f.writes) != 0 || f.bootInstalls != 0 || f.bootCreates != 0 {
		t.Fatalf("capacity failure mutated a slot or boot state: writes=%v installs=%d creates=%d", f.writes, f.bootInstalls, f.bootCreates)
	}
}

func (f *managerFixture) bootTarget(t *testing.T) {
	t.Helper()
	raw, _ := json.Marshal(testApplianceManifest("0.6.0-dev.27", targetCommit))
	if err := os.Chmod(f.manager.config.CurrentManifestPath, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.CurrentManifestPath, raw, 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.KernelCmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-B ro"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestManifestStrictSignatureCompatibilityAndOrdering(t *testing.T) {
	dir := t.TempDir()
	files := map[string][]byte{
		"system-root.img.zst": []byte("root"), "system-a.efi": []byte("a"), "system-b.efi": []byte("b"),
		"youeye-system-updater-linux-amd64": []byte("updater"),
	}
	manifest := testUpdateManifest(files)
	manifestPath, signaturePath := writeSignedBundle(t, dir, manifest, files)
	verified, err := VerifyManifest(manifestPath, signaturePath, filepath.Join(dir, "trust.pub"))
	if err != nil || verified.Manifest.TargetImageVersion != "0.6.0-dev.27" {
		t.Fatalf("verified=%+v err=%v", verified, err)
	}
	if err := manifest.ValidateCurrent(testApplianceManifest("0.6.0-dev.26", baselineCommit), testState(), false); err != nil {
		t.Fatal(err)
	}
	replayed := manifest
	replayed.TargetImageVersion = "0.6.0-dev.26"
	if err := replayed.ValidateCurrent(testApplianceManifest("0.6.0-dev.26", baselineCommit), testState(), false); err == nil {
		t.Fatal("replayed version was accepted")
	}
	testOnly := manifest
	testOnly.ArtifactKind = "test"
	if err := testOnly.ValidateCurrent(testApplianceManifest("0.6.0-dev.26", baselineCommit), testState(), false); err == nil {
		t.Fatal("test image did not require explicit confirmation")
	}
	raw, _ := os.ReadFile(manifestPath)
	raw[0] ^= 1
	if err := os.WriteFile(manifestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyManifest(manifestPath, signaturePath, filepath.Join(dir, "trust.pub")); err == nil {
		t.Fatal("corrupt manifest signature was accepted")
	}
	mismatchDir := t.TempDir()
	mismatchManifest, mismatchSignature := writeSignedBundleWithTrustID(t, mismatchDir, manifest, files, true)
	if _, err := VerifyManifest(mismatchManifest, mismatchSignature, filepath.Join(mismatchDir, "trust.pub")); err == nil {
		t.Fatal("signed manifest with a false trust key ID was accepted")
	}
}

func TestDiscoverEnforcesExactManifestDigest(t *testing.T) {
	fixture := newManagerFixture(t)
	options := fixture.sourceOptions()
	options.ExpectedManifestSHA256 = strings.Repeat("0", 64)
	if _, err := fixture.manager.Discover(context.Background(), options); err == nil || !strings.Contains(err.Error(), "manifest digest mismatch") {
		t.Fatalf("digest mismatch result = %v", err)
	}
}

func TestConvergenceAllowsCurrentSignedTargetWithoutWritingInactiveSlot(t *testing.T) {
	fixture := newManagerFixture(t)
	fixture.update.TargetImageVersion = "0.6.0-dev.26"
	manifestPath, signaturePath := writeSignedBundle(t, filepath.Dir(fixture.manifestPath), fixture.update, fixture.files)
	fixture.manifestPath, fixture.signaturePath = manifestPath, signaturePath
	options := fixture.sourceOptions()
	options.AllowCurrent = true
	status, err := fixture.manager.Stage(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != PhaseHealthy || status.RunningImage != "0.6.0-dev.26" || len(fixture.writes) != 0 || fixture.bootInstalls != 0 {
		t.Fatalf("current convergence mutated inactive System: status=%+v writes=%v installs=%d", status, fixture.writes, fixture.bootInstalls)
	}
}

func TestConvergencePersistsFinalSignedIdentityBeforeActivation(t *testing.T) {
	fixture := newManagerFixture(t)
	options := fixture.sourceOptions()
	options.AllowCurrent = true
	options.Channel = "development"
	options.ReleaseTag = "appliance-dev-v" + fixture.update.TargetImageVersion
	options.ExpectedReleaseBranch = "dev"
	result, err := fixture.manager.Converge(context.Background(), []SourceOptions{options}, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "system-restart" || result.TargetImage != fixture.update.TargetImageVersion {
		t.Fatalf("unexpected convergence result: %+v", result)
	}
	intent, err := loadConvergenceIntent(fixture.manager.config.ConvergencePath)
	if err != nil {
		t.Fatal(err)
	}
	if intent.SelectedTag != options.ReleaseTag || intent.ManifestSHA256 != result.ManifestSHA256 || intent.TargetImage != result.TargetImage || intent.ReleaseBranch != "dev" {
		t.Fatalf("final signed identity was not frozen before activation: %+v", intent)
	}
}

func TestExactFirstBootAcceptsDurablyHealthySignedPostInstallUpdate(t *testing.T) {
	fixture := newManagerFixture(t)
	verified, err := VerifyManifest(fixture.manifestPath, fixture.signaturePath, fixture.manager.config.TrustKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	baseline := testApplianceManifest("0.6.0-dev.26", baselineCommit)
	media := exactBundleManifest{
		Schema: "youeye.appliance.manifest.v1", ImageVersion: baseline.ImageVersion,
		SourceCommit: baseline.SourceCommit, Trust: verified.Manifest.Trust, ReleaseSet: *baseline.ReleaseSet,
	}
	mediaRaw, _ := json.Marshal(media)
	mediaPath := filepath.Join(fixture.dir, "installed-appliance-manifest.json")
	privateKey, err := os.ReadFile(filepath.Join(filepath.Dir(fixture.manager.config.TrustKeyPath), "trust.key"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath, mediaRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath+".sig", ed25519.Sign(ed25519.PrivateKey(privateKey), mediaRaw), 0o600); err != nil {
		t.Fatal(err)
	}
	mediaDigest := sha256.Sum256(mediaRaw)
	policy := ReleasePolicy{
		Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", Freshness: "require-current",
		ExactTag: exactTagForReleaseSet(media.ReleaseSet.Branch, media.ImageVersion), ManifestSHA256: hex.EncodeToString(mediaDigest[:]),
	}
	options := fixture.sourceOptions()
	options.Channel = "development"
	options.ReleaseTag = exactTagForReleaseSet(verified.Manifest.ReleaseSet.Branch, verified.Manifest.TargetImageVersion)
	if _, err := fixture.manager.Stage(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	journal, err := loadJournal(fixture.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	transactionDir := fixture.manager.transactionDir(journal.TransactionID)
	if err := os.MkdirAll(transactionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for source, destination := range map[string]string{
		fixture.manifestPath:  filepath.Join(transactionDir, "system-update-manifest.json"),
		fixture.signaturePath: filepath.Join(transactionDir, "system-update-manifest.json.sig"),
	} {
		raw, readErr := os.ReadFile(source)
		if readErr != nil || os.WriteFile(destination, raw, 0o600) != nil {
			t.Fatalf("copy signed transaction source=%s readErr=%v", source, readErr)
		}
	}
	if _, err := fixture.manager.Activate(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	fixture.bootTarget(t)
	if _, err := fixture.manager.Reconcile(context.Background(), ReconcileOptions{}); err != nil {
		t.Fatal(err)
	}
	target := testApplianceManifest(verified.Manifest.TargetImageVersion, verified.Manifest.SourceCommit)
	if _, err := appliance.CommitHealthySlot(fixture.manager.config.StatePath, target, "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.manager.MarkHealthy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fixture.manager.config.HealthyManifestPath); err != nil {
		t.Fatalf("durable healthy manifest missing: %v", err)
	}
	if _, err := os.Stat(fixture.manager.config.HealthyManifestPath + ".sig"); err != nil {
		t.Fatalf("durable healthy signature missing: %v", err)
	}
	if err := os.RemoveAll(transactionDir); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.manager.VerifyHealthyPromotedExact(policy, mediaPath, mediaPath+".sig")
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "exact-updated-current" || result.CurrentImage != verified.Manifest.TargetImageVersion || result.SelectedTag != options.ReleaseTag {
		t.Fatalf("promoted exact result=%+v", result)
	}
	if err := os.WriteFile(fixture.manager.config.HealthyManifestPath+".sig", []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.manager.VerifyHealthyPromotedExact(policy, mediaPath, mediaPath+".sig"); err == nil {
		t.Fatal("corrupt promoted update signature was accepted")
	}
}

func TestConvergenceCompletesPinnedFinalBundleAfterBridgeRestart(t *testing.T) {
	fixture := newManagerFixture(t)
	current := testApplianceManifest(fixture.update.TargetImageVersion, fixture.update.SourceCommit)
	currentRaw, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fixture.manager.config.CurrentManifestPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.manager.config.CurrentManifestPath, currentRaw, 0o444); err != nil {
		t.Fatal(err)
	}
	state := testState()
	state.Slots.CurrentImageVersion = fixture.update.TargetImageVersion
	if err := appliance.WriteStateAtomic(fixture.manager.config.StatePath, state); err != nil {
		t.Fatal(err)
	}
	manifestRaw, err := os.ReadFile(fixture.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifestRaw)
	selectedTag := "appliance-dev-v" + fixture.update.TargetImageVersion
	intent := convergenceIntent{
		Schema: convergenceIntentSchema, SelectedTag: selectedTag,
		ManifestSHA256: hex.EncodeToString(digest[:]), TargetImage: fixture.update.TargetImageVersion,
		ReleaseBranch: "dev", Bridges: []string{"appliance-dev-v0.6.0-dev.26"}, UpdatedAt: fixture.manager.now(),
	}
	if err := writeConvergenceIntent(fixture.manager.config.ConvergencePath, intent); err != nil {
		t.Fatal(err)
	}
	options := fixture.sourceOptions()
	options.AllowCurrent = true
	options.ReleaseTag = selectedTag
	options.ExpectedReleaseBranch = "dev"
	result, err := fixture.manager.Converge(context.Background(), []SourceOptions{options}, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "current" || result.SelectedTag != selectedTag || !result.Bridge {
		t.Fatalf("unexpected post-bridge convergence result: %+v", result)
	}
	if _, err := os.Stat(fixture.manager.config.ConvergencePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed final convergence intent was not removed: %v", err)
	}
}

func TestBridgeRequirementIsTypedButOtherIntegrityFailuresAreNot(t *testing.T) {
	manifest := testUpdateManifest(map[string][]byte{
		"system-root.img.zst": []byte("root"), "system-a.efi": []byte("a"), "system-b.efi": []byte("b"),
		"youeye-system-updater-linux-amd64": []byte("updater"),
	})
	manifest.MinimumCurrentImageVersion = "0.6.0-dev.27"
	err := manifest.ValidateCurrent(testApplianceManifest("0.6.0-dev.26", baselineCommit), testState(), false)
	if !BridgeRequired(err) {
		t.Fatalf("minimum-current mismatch was not typed as bridge-required: %v", err)
	}
	manifest.Trust.Class = "invalid"
	if err := manifest.Validate(); err == nil || BridgeRequired(err) {
		t.Fatalf("integrity failure could incorrectly trigger bridge fallback: %v", err)
	}
}

func TestManifestRejectsOversizeIncompatibleAndUnsafeInputs(t *testing.T) {
	files := map[string][]byte{
		"system-root.img.zst": []byte("root"), "system-a.efi": []byte("a"), "system-b.efi": []byte("b"),
		"youeye-system-updater-linux-amd64": []byte("updater"),
	}
	base := testUpdateManifest(files)
	sourceMismatch := base
	sourceMismatch.SourceCommit = strings.Repeat("4", 40)
	if err := sourceMismatch.Validate(); err != nil {
		t.Fatalf("independent exact appliance and Spine source commits were rejected: %v", err)
	}
	mutations := []func(*Manifest){
		func(m *Manifest) { m.Architecture = "arm64" },
		func(m *Manifest) { m.RootSlotSizeBytes++ },
		func(m *Manifest) { m.Rollback.PreserveData = false },
		func(m *Manifest) { m.Artifacts[0].UncompressedSizeBytes++ },
		func(m *Manifest) { m.Artifacts[1].Path = "../system-a.efi" },
		func(m *Manifest) { m.Artifacts[1].Path = "nested/system-a.efi" },
		func(m *Manifest) { m.Artifacts[1].Path = m.Artifacts[2].Path },
		func(m *Manifest) { m.Artifacts = append(m.Artifacts, m.Artifacts[1]) },
	}
	for index, mutate := range mutations {
		candidate := base
		candidate.Artifacts = append([]Artifact(nil), base.Artifacts...)
		mutate(&candidate)
		if err := candidate.Validate(); err == nil {
			t.Fatalf("mutation %d was accepted", index)
		}
	}
	state := testState()
	state.RecoveryVersion = "2"
	if err := base.ValidateCurrent(testApplianceManifest("0.6.0-dev.26", baselineCommit), state, false); err == nil {
		t.Fatal("incompatible Recovery expectation was accepted")
	}
	if _, err := resolveArtifactSource("https://updates.test/release/manifest.json?token=secret", "system-a.efi"); err == nil {
		t.Fatal("query-bearing artifact source was accepted")
	}
	large := filepath.Join(t.TempDir(), "large-manifest.json")
	if err := os.WriteFile(large, make([]byte, maxManifestBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	manager := New(Config{})
	if err := manager.downloadSourceAtMost(context.Background(), large, large+".part", large+".copy", maxManifestBytes); err == nil {
		t.Fatal("oversized unsigned metadata was accepted")
	}
}

func TestLayoutThreeUsesOneInstallationDriveAndRejectsUnsafeInactiveSlot(t *testing.T) {
	inventory := func(parentB string, mountedB any) []byte {
		devices := []layoutDevice{{
			Name: "sda", Path: "/dev/sda", Type: "disk", Size: 96 * 1024 * 1024 * 1024,
			Children: []layoutDevice{
				{Name: "sda1", Path: "/dev/sda1", Type: "part", Size: 1, PartLabel: labelESP, PartUUID: "1", ParentName: "sda"},
				{Name: "sda2", Path: "/dev/sda2", Type: "part", Size: 1, PartLabel: labelRecovery, PartUUID: "2", ParentName: "sda"},
				{Name: "sda3", Path: "/dev/sda3", Type: "part", Size: RootSlotBytes, PartLabel: labelSystemA, PartUUID: "3", ParentName: "sda", Mountpoints: []any{"/"}},
				{Name: "sda4", Path: "/dev/sda4", Type: "part", Size: RootSlotBytes, PartLabel: labelSystemB, PartUUID: "4", ParentName: parentB, Mountpoints: []any{mountedB}},
				{Name: "sda5", Path: "/dev/sda5", Type: "part", Size: 1, PartLabel: labelState, PartUUID: "5", ParentName: "sda"},
				{Name: "sda6", Path: "/dev/sda6", Type: "part", Size: 1, PartLabel: labelData, PartUUID: "6", ParentName: "sda"},
			},
		}}
		raw, _ := json.Marshal(layoutInventory{BlockDevices: devices})
		return raw
	}
	layout, err := ParseLayout(inventory("sda", nil), "A")
	if err != nil || layout.InactiveSlot != "B" {
		t.Fatalf("layout=%+v err=%v", layout, err)
	}
	if _, err := ParseLayout(inventory("sdb", nil), "A"); err == nil {
		t.Fatal("split layout-3 drive was accepted")
	}
	if _, err := ParseLayout(inventory("sda", "/mnt"), "A"); err == nil {
		t.Fatal("mounted inactive slot was accepted")
	}
}

func TestVerifyESPMountUsesDeepestSystemdAutomountSource(t *testing.T) {
	dir := t.TempDir()
	device := filepath.Join(dir, "sda1")
	alias := filepath.Join(dir, "by-partuuid")
	target := filepath.Join(dir, "efi", "loader", "entries")
	if err := os.WriteFile(device, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(device, alias); err != nil {
		t.Fatal(err)
	}
	findmntCalls := 0
	manager := New(Config{Run: func(context.Context, string, ...string) ([]byte, error) {
		findmntCalls++
		return []byte("systemd-1\n" + device + "\n"), nil
	}})
	if err := manager.verifyESPMount(context.Background(), alias, target); err == nil {
		t.Fatal("missing ESP child path did not fail before mount verification")
	}
	if findmntCalls != 0 {
		t.Fatalf("findmnt ran before the ESP child lookup: calls=%d", findmntCalls)
	}
	if err := os.MkdirAll(target, 0755); err != nil {
		t.Fatal(err)
	}
	if err := manager.verifyESPMount(context.Background(), alias, target); err != nil {
		t.Fatal(err)
	}
	manager.config.Run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte(device + "\n" + filepath.Join(dir, "overmount") + "\n"), nil
	}
	if err := manager.verifyESPMount(context.Background(), alias, target); err == nil {
		t.Fatal("an effective overmount was accepted as the ESP")
	}
}

func TestStageWritesOnlyInactiveThenActivationArmsCountedTrial(t *testing.T) {
	f := newManagerFixture(t)
	status, err := f.manager.Discover(context.Background(), f.sourceOptions())
	if err != nil || status.State != PhaseAvailable {
		t.Fatalf("discover status=%+v err=%v", status, err)
	}
	status, err = f.manager.Stage(context.Background(), f.sourceOptions())
	if err != nil || status.State != PhaseStaged || status.CandidateSlot != "B" {
		t.Fatalf("stage status=%+v err=%v", status, err)
	}
	if !reflect.DeepEqual(f.writes, []string{filepath.Join(f.dir, "system-b")}) || f.bootInstalls != 1 || f.bootCreates != 0 {
		t.Fatalf("writes=%v installs=%d creates=%d", f.writes, f.bootInstalls, f.bootCreates)
	}
	state, err := appliance.LoadState(f.manager.config.StatePath)
	if err != nil || state.Slots.Candidate != "B" || state.Transaction.Stage != PhaseStaged {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	status, err = f.manager.Activate(context.Background(), false)
	if err != nil || status.State != PhasePending || !status.RebootRequired || f.bootCreates != 1 {
		t.Fatalf("activate status=%+v creates=%d err=%v", status, f.bootCreates, err)
	}
	wantRuns := [][]string{
		{"bootctl", "set-default", "youeye-system-a.conf"},
		{"bootctl", "set-oneshot", "youeye-system-b.conf"},
		{"bootctl", "set-default", ""},
	}
	if !reflect.DeepEqual(f.runs, wantRuns) {
		t.Fatalf("boot calls=%v want=%v", f.runs, wantRuns)
	}
}

func TestPlan1BootstrapAuthenticatesBeforeMutationAndPreservesFallbackState(t *testing.T) {
	t.Run("wrong executable", func(t *testing.T) {
		f := newManagerFixture(t)
		f.setCurrentManifest(t, testPlan1Manifest())
		if err := os.WriteFile(filepath.Join(filepath.Dir(f.manifestPath), "youeye-system-updater-linux-amd64"), []byte("wrong"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Stage(context.Background(), f.bootstrapSourceOptions()); err == nil {
			t.Fatal("unsigned bootstrap executable was accepted")
		}
		if len(f.writes) != 0 || f.bootInstalls != 0 {
			t.Fatalf("bootstrap rejection mutated target: writes=%v installs=%d", f.writes, f.bootInstalls)
		}
		state, err := appliance.LoadState(f.manager.config.StatePath)
		if err != nil || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			t.Fatalf("bootstrap rejection changed State: %+v err=%v", state, err)
		}
		if _, err := os.Stat(f.manager.config.JournalPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("bootstrap rejection created journal: %v", err)
		}
	})

	t.Run("stage activate bless", func(t *testing.T) {
		f := newManagerFixture(t)
		f.setCurrentManifest(t, testPlan1Manifest())
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err == nil {
			t.Fatal("Plan 1 image staged without bootstrap authorization")
		}
		staged, err := f.manager.Stage(context.Background(), f.bootstrapSourceOptions())
		if err != nil || staged.State != PhaseStaged {
			t.Fatalf("staged=%+v err=%v", staged, err)
		}
		state, err := appliance.LoadState(f.manager.config.StatePath)
		if err != nil || !state.Transaction.Plan1Compatible() || state.Transaction.Stage != PhaseStaged {
			t.Fatalf("fallback State=%+v err=%v", state, err)
		}
		if _, err := f.manager.Activate(context.Background(), false); err == nil {
			t.Fatal("Plan 1 transaction activated without bootstrap authorization")
		}
		pending, err := f.manager.ActivateBootstrap(context.Background(), false)
		if err != nil || pending.State != PhasePending {
			t.Fatalf("pending=%+v err=%v", pending, err)
		}
		state, err = appliance.LoadState(f.manager.config.StatePath)
		if err != nil || !state.Transaction.Plan1Compatible() || state.Transaction.Stage != PhasePending {
			t.Fatalf("pending fallback State=%+v err=%v", state, err)
		}

		f.bootTarget(t)
		trial, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || trial.Status.State != PhaseTrial {
			t.Fatalf("trial=%+v err=%v", trial, err)
		}
		state, err = appliance.LoadState(f.manager.config.StatePath)
		if err != nil || !state.Transaction.Plan1Compatible() || state.Transaction.Stage != PhaseTrial {
			t.Fatalf("trial fallback State=%+v err=%v", state, err)
		}
		target := testApplianceManifest("0.6.0-dev.27", targetCommit)
		if _, err := appliance.CommitHealthySlot(f.manager.config.StatePath, target, "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
			t.Fatal(err)
		}
		healthy, err := f.manager.MarkHealthy(context.Background())
		if err != nil || healthy.State != PhaseHealthy || healthy.CurrentImage != "0.6.0-dev.27" {
			t.Fatalf("healthy=%+v err=%v", healthy, err)
		}
	})

	t.Run("failed candidate leaves Plan 1-readable fallback", func(t *testing.T) {
		f := newManagerFixture(t)
		f.setCurrentManifest(t, testPlan1Manifest())
		if _, err := f.manager.Stage(context.Background(), f.bootstrapSourceOptions()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.ActivateBootstrap(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		f.bootTarget(t)
		if _, err := f.manager.Reconcile(context.Background(), ReconcileOptions{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Reconcile(context.Background(), ReconcileOptions{HealthFailed: true}); err != nil {
			t.Fatal(err)
		}
		f.setCurrentManifest(t, testPlan1Manifest())
		if err := os.WriteFile(f.manager.config.KernelCmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-A ro"), 0600); err != nil {
			t.Fatal(err)
		}
		state, err := appliance.LoadState(f.manager.config.StatePath)
		if err != nil || !state.Transaction.Plan1Compatible() {
			t.Fatalf("failed fallback State=%+v err=%v", state, err)
		}
		rolledBack, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || rolledBack.Status.State != PhaseRollback || !rolledBack.Status.RolledBack {
			t.Fatalf("rollback=%+v err=%v", rolledBack, err)
		}
		state, err = appliance.LoadState(f.manager.config.StatePath)
		if err != nil || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			t.Fatalf("rollback State=%+v err=%v", state, err)
		}
	})
}

func TestInterruptedWriteRetriesAndConverges(t *testing.T) {
	f := newManagerFixture(t)
	attempts := 0
	f.manager.config.WriteRoot = func(context.Context, string, Artifact, string) error {
		attempts++
		if attempts == 1 {
			return context.Canceled
		}
		return nil
	}
	if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); !errors.Is(err, context.Canceled) {
		t.Fatalf("first stage err=%v", err)
	}
	failed, err := f.manager.Status()
	if err != nil || failed.State != PhaseFailed || failed.ErrorCode != "interrupted" {
		t.Fatalf("failed status=%+v err=%v", failed, err)
	}
	staged, err := f.manager.Stage(context.Background(), f.sourceOptions())
	if err != nil || staged.State != PhaseStaged || attempts != 2 {
		t.Fatalf("retry status=%+v attempts=%d err=%v", staged, attempts, err)
	}
}

func TestCorruptDownloadAndActivationReadbackNeverArmBootSelection(t *testing.T) {
	t.Run("corrupt download", func(t *testing.T) {
		f := newManagerFixture(t)
		if err := os.WriteFile(filepath.Join(filepath.Dir(f.manifestPath), "system-b.efi"), []byte("corrupt"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err == nil {
			t.Fatal("corrupt artifact was accepted")
		}
		if len(f.writes) != 0 || f.bootInstalls != 0 || len(f.runs) != 0 {
			t.Fatalf("mutation occurred: writes=%v installs=%d boot=%v", f.writes, f.bootInstalls, f.runs)
		}
		state, _ := appliance.LoadState(f.manager.config.StatePath)
		if state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			t.Fatalf("corrupt download changed slot state: %+v", state)
		}
	})

	t.Run("activation readback", func(t *testing.T) {
		f := newManagerFixture(t)
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
			t.Fatal(err)
		}
		f.manager.config.VerifyStagedRoot = func(context.Context, string, Artifact) error {
			return errors.New("inactive System readback SHA-256 mismatch")
		}
		if _, err := f.manager.Activate(context.Background(), false); err == nil {
			t.Fatal("activation accepted a changed inactive root")
		}
		status, err := f.manager.Status()
		if err != nil || status.State != PhaseStaged || status.RebootRequired || f.bootCreates != 0 || len(f.runs) != 0 {
			t.Fatalf("status=%+v creates=%d boot=%v err=%v", status, f.bootCreates, f.runs, err)
		}
	})
}

func TestCandidateBlessingAndAutomaticFallbackState(t *testing.T) {
	t.Run("healthy", func(t *testing.T) {
		f := newManagerFixture(t)
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Activate(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		f.bootTarget(t)
		trial, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || trial.Status.State != PhaseTrial {
			t.Fatalf("trial=%+v err=%v", trial, err)
		}
		target := testApplianceManifest("0.6.0-dev.27", targetCommit)
		if _, err := appliance.CommitHealthySlot(f.manager.config.StatePath, target, "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
			t.Fatal(err)
		}
		healthy, err := f.manager.MarkHealthy(context.Background())
		if err != nil || healthy.State != PhaseHealthy || healthy.CurrentImage != "0.6.0-dev.27" || healthy.PreviousSlot != "A" {
			t.Fatalf("healthy=%+v err=%v", healthy, err)
		}
		if got := f.runs[len(f.runs)-1]; !reflect.DeepEqual(got, []string{"bootctl", "set-default", "youeye-system-b.conf"}) {
			t.Fatalf("healthy boot default=%v", got)
		}
	})

	t.Run("healthy promotion interrupted before journal commit", func(t *testing.T) {
		f := newManagerFixture(t)
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Activate(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		f.bootTarget(t)
		if _, err := f.manager.Reconcile(context.Background(), ReconcileOptions{}); err != nil {
			t.Fatal(err)
		}
		target := testApplianceManifest("0.6.0-dev.27", targetCommit)
		if _, err := appliance.CommitHealthySlot(f.manager.config.StatePath, target, "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
			t.Fatal(err)
		}
		healthy, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || healthy.Status.State != PhaseHealthy || healthy.Status.CurrentImage != "0.6.0-dev.27" {
			t.Fatalf("healthy=%+v err=%v", healthy, err)
		}
		if got := f.runs[len(f.runs)-1]; !reflect.DeepEqual(got, []string{"bootctl", "set-default", "youeye-system-b.conf"}) {
			t.Fatalf("reconciled healthy boot default=%v", got)
		}
	})

	t.Run("rollback", func(t *testing.T) {
		f := newManagerFixture(t)
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Activate(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		f.bootTarget(t)
		if _, err := f.manager.Reconcile(context.Background(), ReconcileOptions{}); err != nil {
			t.Fatal(err)
		}
		failed, err := f.manager.Reconcile(context.Background(), ReconcileOptions{HealthFailed: true})
		if err != nil || !failed.RebootRequired || failed.Status.State != PhaseFailed || failed.Status.TrialFailures != 1 {
			t.Fatalf("failed=%+v err=%v", failed, err)
		}
		baselineRaw, _ := json.Marshal(testApplianceManifest("0.6.0-dev.26", baselineCommit))
		if err := os.Chmod(f.manager.config.CurrentManifestPath, 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.manager.config.CurrentManifestPath, baselineRaw, 0444); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.manager.config.KernelCmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-A ro"), 0600); err != nil {
			t.Fatal(err)
		}
		rolledBack, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || rolledBack.Status.State != PhaseRollback || !rolledBack.Status.RolledBack || f.bootRemoves != 1 {
			t.Fatalf("rollback=%+v removes=%d err=%v", rolledBack, f.bootRemoves, err)
		}
		state, _ := appliance.LoadState(f.manager.config.StatePath)
		if state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			t.Fatalf("rollback left candidate state: %+v", state)
		}
	})

	t.Run("rollback before candidate userspace reconciles", func(t *testing.T) {
		f := newManagerFixture(t)
		if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.manager.Activate(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		rolledBack, err := f.manager.Reconcile(context.Background(), ReconcileOptions{})
		if err != nil || rolledBack.Status.State != PhaseRollback || !rolledBack.Status.RolledBack || f.bootRemoves != 1 {
			t.Fatalf("rollback=%+v removes=%d err=%v", rolledBack, f.bootRemoves, err)
		}
	})
}
