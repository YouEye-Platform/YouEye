package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

type frozenCandidateFixture struct {
	manager   SpineCandidateManager
	request   SpineCandidateRequest
	selection CoreHostSelection
	release   releasecache.CoreRelease
	revoked   *string
}

func newFrozenCandidateFixture(t *testing.T) frozenCandidateFixture {
	t.Helper()
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	public := private.Public().(ed25519.PublicKey)
	der, _ := x509.MarshalPKIXPublicKey(public)
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	prior := coreTrustLookup
	revoked := ""
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if revoked == scope {
			return nil, fmt.Errorf("fixture current role revoked")
		}
		if source != releasecache.OfficialRepository && source != "https://private-builder.example.test/team/YouEye" {
			return nil, fmt.Errorf("unexpected fixture source")
		}
		return &updatetrust.Grant{Repository: source, Branch: branch, Scope: scope, PublicKey: keyPEM}, nil
	}
	t.Cleanup(func() { coreTrustLookup = prior })
	root, digest, source, _ := spineCandidateFixture(t)
	sums, err := os.ReadFile(filepath.Join(root, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "SHA256SUMS.sig"), ed25519.Sign(private, sums), 0600); err != nil {
		t.Fatal(err)
	}
	stateRoot := t.TempDir()
	o := spineCandidateBaselineObservation{BootstrapRoot: filepath.Join(stateRoot, "bootstrap"), ImagePath: filepath.Join(stateRoot, "appliance-release"), BundlePath: filepath.Join(stateRoot, "installer", "appliance-manifest.json"), BundleSignaturePath: filepath.Join(stateRoot, "installer", "appliance-manifest.json.sig"), BakedPath: filepath.Join(stateRoot, "youeye"), FirstDeployRoot: filepath.Join(stateRoot, "first-deploy"), CacheRoot: filepath.Join(stateRoot, "cache")}
	write := func(path string, raw []byte, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, mode); err != nil {
			t.Fatal(err)
		}
	}
	vectorRaw, err := os.ReadFile("../../../releasecache/testdata/core-metadata-v2-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Execution []byte `json:"execution"`
	}
	if err := json.Unmarshal(vectorRaw, &vector); err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(vector.Execution)
	if err != nil {
		t.Fatal(err)
	}
	baked := []byte("exact baked signed media Spine remains unchanged")
	var host, spine releasecache.CoreMember
	for index := range r.Members {
		m := &r.Members[index]
		m.KeyID = checksum(der)
		if m.Role == "spine" {
			m.Artifact.SHA256 = checksum(baked)
			m.Artifact.SizeBytes = int64(len(baked))
			spine = *m
		}
		if m.Role == "appliance" {
			host = *m
		}
	}
	image := testApplianceManifest(host.BuildVersion, host.SourceCommit)
	image.ReleaseSet.Source, image.ReleaseSet.Branch, image.ReleaseSet.Schema = host.Source, host.Branch, "youeye.release-set.v2"
	for _, m := range r.Members {
		c := appliance.ComponentRelease{Version: m.BuildVersion, Branch: m.Branch, Tag: m.Tag, SourceCommit: m.SourceCommit, ArtifactSHA256: m.Artifact.SHA256}
		switch m.Role {
		case "spine":
			image.ReleaseSet.Spine = c
		case "cp":
			image.ReleaseSet.ControlPanel = c
		case "ui":
			image.ReleaseSet.UI = c
		}
	}
	imageRaw, _ := json.Marshal(image)
	bundleRaw, _ := json.Marshal(struct {
		appliance.Manifest
		Schema     string `json:"schema"`
		DiskLayout struct {
			Version int `json:"version"`
		} `json:"disk_layout"`
	}{Manifest: image, Schema: "youeye.appliance.manifest.v1", DiskLayout: struct {
		Version int `json:"version"`
	}{Version: appliance.CurrentDiskLayout}})
	bundleSig := ed25519.Sign(private, bundleRaw)
	for index := range r.Members {
		m := &r.Members[index]
		if m.Role == "appliance" {
			m.Artifact.SHA256, m.Artifact.SizeBytes = checksum(bundleRaw), int64(len(bundleRaw))
			m.DocumentSignature.SHA256, m.DocumentSignature.SizeBytes = checksum(bundleSig), 64
		}
	}
	files := metadataFixtureEnvelope(t, &r, private, true)
	execution, _ := json.Marshal(r)
	executionSig := ed25519.Sign(private, execution)
	canonical, err := releasecache.EncodeCoreMetadataV2(r)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := releasecache.EncodeCoreMetadataPair(execution, canonical)
	if err != nil {
		t.Fatal(err)
	}
	documents := releasecache.CoreMetadataDocuments{Canonical: canonical, CanonicalSignature: ed25519.Sign(private, canonical), Pair: pair, PairSignature: ed25519.Sign(private, pair)}
	facts, err := releasecache.VerifyCoreMetadataBundle(execution, executionSig, documents, public, func(releasecache.CoreMember) (ed25519.PublicKey, error) { return public, nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range r.Members {
		if m.Role == "spine" {
			spine = m
		}
	}
	proof := releasecache.CoreMetadataProof{Schema: "youeye.core-metadata-proof.v1", ExecutionManifestSHA256: checksum(execution), Advertised: true, SpineChecksums: files[spine.Checksums.URL], SpineSignature: files[spine.Signature.URL], SpineProvenance: files[spine.Provenance.URL], Documents: documents, Bindings: facts.Bindings}
	proofRaw, _ := json.Marshal(proof)
	selection := CoreHostSelection{Raw: execution, Signature: executionSig, MetadataProof: proofRaw}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: r.Tag, ManifestSHA256: checksum(bundleRaw), CoreManifestSHA256: checksum(execution), Freshness: "require-current"}
	policyRaw, _ := json.Marshal(policy)
	write(o.ImagePath, imageRaw, 0444)
	write(o.BundlePath, bundleRaw, 0600)
	write(o.BundleSignaturePath, bundleSig, 0600)
	write(o.BakedPath, baked, 0700)
	for name, raw := range map[string][]byte{"core-release.json": execution, "core-release.json.sig": executionSig, CoreMetadataProofName: proofRaw, "release-policy.json": policyRaw} {
		write(filepath.Join(o.BootstrapRoot, name), raw, 0600)
	}
	write(filepath.Join(o.FirstDeployRoot, "progress.json"), []byte(`{"schema":"youeye.appliance.progress.v2","operation":"first-deploy","state":"needs_attention","stage":"needs_attention","detail":"fixture stopped before service selection","percent":99,"attempt":8,"updated_at":"2026-11-04T13:00:00Z"}`), 0600)
	write(filepath.Join(o.FirstDeployRoot, "lock"), nil, 0644)
	hardware := "30803ef1-d063-48ed-88df-2196f3b2e869"
	machine := CoreMachineIdentity{InstallIDRef: "install:frozen", DeviceIDRef: "device:frozen", ParentDiskID: "disk:frozen", StatePartUUID: "state-frozen", DataPartUUID: "data-frozen"}
	o.Hardware = func() (string, error) { return hardware, nil }
	o.EffectiveUID = func() int { return 0 }
	o.Image = func() (appliance.RuntimeStatus, *appliance.Manifest, error) { return appliance.DetectAt(o.ImagePath) }
	o.Machine = func() (CoreMachineIdentity, error) { return machine, nil }
	o.Capture = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	o.Client = &http.Client{Transport: signedRedirectTransport(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("fixture offline metadata transport")
	})}
	m := SpineCandidateManager{Root: filepath.Dir(root), CoreRoot: filepath.Join(stateRoot, "core-update"), LifecycleRoot: filepath.Join(stateRoot, "lifecycle"), baselineObservation: &o}
	return frozenCandidateFixture{manager: m, request: SpineCandidateRequest{Root: root, CandidateID: "spine-candidate-b-frozen-fixture", ArtifactSHA256: digest, SourceCommit: source, Identity: hardware}, selection: selection, release: r, revoked: &revoked}
}

func TestSpineCandidateFrozenMediaAdmitsExactSignedPreDeployment(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	binding, err := f.manager.NewBinding(f.request)
	if err != nil {
		t.Fatalf("valid frozen signed media without committed receipt must admit explicit candidate: %v", err)
	}
	if binding.BaselineKind != "frozen-media" || binding.InstalledManifestSHA256 != checksum(f.selection.Raw) || binding.BaselineMachine.Validate() != nil || !validSHA256(binding.FrozenMediaSHA256) {
		t.Fatal("frozen baseline identity missing", binding)
	}
	if _, err := os.Lstat(filepath.Join(f.manager.core().Root, "committed.json")); !os.IsNotExist(err) {
		t.Fatal("candidate manufactured committed receipt", err)
	}
	if err := f.manager.WriteBinding(binding); err != nil {
		t.Fatal(err)
	}
	if got, err := f.manager.VerifyBinding(); err != nil || got != binding {
		t.Fatal("frozen binding did not survive exact readback", got, err)
	}
}

func (f frozenCandidateFixture) bind(t *testing.T) SpineCandidateBinding {
	t.Helper()
	b, err := f.manager.NewBinding(f.request)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.manager.WriteBinding(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func (f frozenCandidateFixture) initialize(t *testing.T) CoreReceipt {
	t.Helper()
	m := f.manager.core()
	receipt, err := m.Initialize(context.Background(), f.selection, checksum(f.selection.Raw), CoreDevelopmentTrustPath, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		baseline, err := f.manager.frozenMediaBaseline(f.request.Identity, false, false)
		return baseline.Machine, "unit fixture verified media and native machine", err
	})
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func TestSpineCandidateFrozenMediaActualInitializeRequiresExplicitReconciliation(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	before := f.bind(t)
	o := f.manager.baselineObservation
	progressPath := filepath.Join(o.FirstDeployRoot, "progress.json")
	progress, err := os.ReadFile(progressPath)
	if err != nil {
		t.Fatal(err)
	}
	running := bytes.ReplaceAll(bytes.ReplaceAll(progress, []byte(`"state":"needs_attention"`), []byte(`"state":"running"`)), []byte(`"stage":"needs_attention"`), []byte(`"stage":"verifying"`))
	if err := os.WriteFile(progressPath, running, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.VerifyBinding(); err != nil {
		t.Fatal("recorded first-deploy retry rejected before genuine initialization", err)
	}
	receipt := f.initialize(t)
	committedPath := filepath.Join(f.manager.core().Root, "committed.json")
	committedRaw, err := os.ReadFile(committedPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.VerifyBinding(); err == nil {
		t.Fatal("genuine new committed receipt silently advanced frozen candidate binding")
	}
	if _, err := f.manager.TestExecutable(); err == nil {
		t.Fatal("reader observer accepted changed baseline before explicit reconciliation")
	}
	if err := os.WriteFile(progressPath, progress, 0600); err != nil {
		t.Fatal(err)
	}
	after, err := f.manager.ReconcileBaseline(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	want := before
	want.BaselineKind = "committed"
	if after != want {
		t.Fatal("reconciliation changed candidate/source/hardware/original provenance", after, want)
	}
	if receipt.ManifestSHA256 != after.InstalledManifestSHA256 || receipt.Machine != after.BaselineMachine {
		t.Fatal("genuine initialized receipt differs")
	}
	if path, err := f.manager.TestExecutable(); err != nil || path != filepath.Join(f.request.Root, SpineCandidateArtifact) {
		t.Fatal("exact reader continuation remains rejected", path, err)
	}
	if second, err := f.manager.ReconcileBaseline(context.Background(), f.request); err != nil || second != after {
		t.Fatal("explicit reconciliation retry is not idempotent", second, err)
	}
	currentRaw, err := os.ReadFile(committedPath)
	if err != nil || !bytes.Equal(currentRaw, committedRaw) {
		t.Fatal("candidate reconciliation modified normal committed receipt", err)
	}
	currentProgress, err := os.ReadFile(progressPath)
	if err != nil || !bytes.Equal(currentProgress, progress) {
		t.Fatal("candidate manufactured deployment progress/completion", err)
	}
	if _, err := os.Lstat(filepath.Join(o.FirstDeployRoot, "complete")); !os.IsNotExist(err) {
		t.Fatal("candidate opened first setup", err)
	}
}

func TestSpineCandidateFrozenMediaCannotFallBackFromCorruptCommittedReceipt(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"manifest_sha256":"bad"}`, `{"broken"`} {
		t.Run(raw, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			path := filepath.Join(f.manager.core().Root, "committed.json")
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := f.manager.NewBinding(f.request); err == nil {
				t.Fatal("corrupt committed receipt fell back to media")
			}
		})
	}
}

func TestSpineCandidateFrozenMediaAdmissionRequiresStoppedKnownRecovery(t *testing.T) {
	for _, name := range []string{"running progress", "unknown progress", "no progress", "complete", "firstdeploy active", "core active", "production bootstrap", "unprivileged"} {
		t.Run(name, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			o := f.manager.baselineObservation
			path := filepath.Join(o.FirstDeployRoot, "progress.json")
			switch name {
			case "running progress":
				raw, _ := os.ReadFile(path)
				if err := os.WriteFile(path, bytes.ReplaceAll(raw, []byte("needs_attention"), []byte("running")), 0600); err != nil {
					t.Fatal(err)
				}
			case "unknown progress":
				if err := os.WriteFile(path, []byte(`{"schema":"unknown"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "no progress":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "complete":
				if err := os.WriteFile(filepath.Join(o.FirstDeployRoot, "complete"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "firstdeploy active", "core active":
				o.Capture = func(_ context.Context, _ string, args ...string) ([]byte, error) {
					last := args[len(args)-1]
					if name == "firstdeploy active" && last == "youeye-first-deploy.service" {
						return []byte("youeye-first-deploy.service loaded activating start fixture"), nil
					}
					if name == "core active" && last == "youeye-core-*.service" {
						return []byte("youeye-core-controller.service loaded active running fixture"), nil
					}
					return nil, nil
				}
			case "production bootstrap":
				path := filepath.Join(f.manager.core().Root, "bootstrap-coordinator.json")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(`{"schema":"unknown"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "unprivileged":
				o.EffectiveUID = func() int { return 1000 }
			}
			if _, err := f.manager.NewBinding(f.request); err == nil {
				t.Fatal("unsupported recovery admission accepted")
			}
			if _, err := os.Lstat(f.manager.BindingPath()); !os.IsNotExist(err) {
				t.Fatal("failed admission wrote binding", err)
			}
		})
	}
}

func TestSpineCandidateFrozenMediaRechecksSignedInputsAndNativeIdentity(t *testing.T) {
	for _, name := range []string{"policy", "bundle signature", "proof", "missing proof", "baked", "image", "hardware", "partitions", "cp revoked", "ui revoked", "spine revoked", "appliance revoked", "marker symlink"} {
		t.Run(name, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			f.bind(t)
			o := f.manager.baselineObservation
			switch name {
			case "policy":
				path := filepath.Join(o.BootstrapRoot, "release-policy.json")
				raw, _ := os.ReadFile(path)
				raw = append(raw, ' ')
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "bundle signature":
				if err := os.WriteFile(o.BundleSignaturePath, bytes.Repeat([]byte{0}, 64), 0600); err != nil {
					t.Fatal(err)
				}
			case "proof":
				path := filepath.Join(o.BootstrapRoot, CoreMetadataProofName)
				raw, _ := os.ReadFile(path)
				var proof releasecache.CoreMetadataProof
				if err := json.Unmarshal(raw, &proof); err != nil {
					t.Fatal(err)
				}
				proof.Documents.Pair = nil
				raw, _ = json.Marshal(proof)
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing proof":
				if err := os.Remove(filepath.Join(o.BootstrapRoot, CoreMetadataProofName)); err != nil {
					t.Fatal(err)
				}
			case "baked":
				if err := os.WriteFile(o.BakedPath, []byte("changed"), 0700); err != nil {
					t.Fatal(err)
				}
			case "image":
				if err := os.Chmod(o.ImagePath, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(o.ImagePath, []byte(`{}`), 0444); err != nil {
					t.Fatal(err)
				}
			case "hardware":
				o.Hardware = func() (string, error) { return "40803ef1-d063-48ed-88df-2196f3b2e869", nil }
			case "partitions":
				machine, _ := o.Machine()
				machine.DataPartUUID = "different"
				o.Machine = func() (CoreMachineIdentity, error) { return machine, nil }
			case "cp revoked", "ui revoked", "spine revoked", "appliance revoked":
				*f.revoked = strings.TrimSuffix(name, " revoked")
			case "marker symlink":
				if err := os.Rename(o.ImagePath, o.ImagePath+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(o.ImagePath+".original", o.ImagePath); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.manager.VerifyBinding(); err == nil {
				t.Fatal("changed/revoked frozen baseline accepted")
			}
		})
	}
}

func TestSpineCandidateFrozenMediaReconcileRejectsWrongIdentityAndActiveWork(t *testing.T) {
	for _, name := range []string{"candidate", "source", "sha", "hardware", "partitions", "active firstdeploy", "policy", "receipt absent", "canceled"} {
		t.Run(name, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			f.bind(t)
			if name != "receipt absent" {
				f.initialize(t)
			}
			before, err := os.ReadFile(f.manager.BindingPath())
			if err != nil {
				t.Fatal(err)
			}
			r := f.request
			o := f.manager.baselineObservation
			ctx := context.Background()
			switch name {
			case "candidate":
				r.CandidateID = "spine-candidate-b-foreign"
			case "source":
				r.SourceCommit = strings.Repeat("f", 40)
			case "sha":
				r.ArtifactSHA256 = strings.Repeat("f", 64)
			case "hardware":
				r.Identity = "40803ef1-d063-48ed-88df-2196f3b2e869"
			case "partitions":
				machine, _ := o.Machine()
				machine.StatePartUUID = "foreign"
				o.Machine = func() (CoreMachineIdentity, error) { return machine, nil }
			case "active firstdeploy":
				o.Capture = func(_ context.Context, _ string, args ...string) ([]byte, error) {
					if args[len(args)-1] == "youeye-first-deploy.service" {
						return []byte("youeye-first-deploy.service loaded activating start fixture"), nil
					}
					return nil, nil
				}
			case "policy":
				path := filepath.Join(o.BootstrapRoot, "release-policy.json")
				raw, _ := os.ReadFile(path)
				if err := os.WriteFile(path, append(raw, ' '), 0600); err != nil {
					t.Fatal(err)
				}
			case "canceled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if _, err := f.manager.ReconcileBaseline(ctx, r); err == nil {
				t.Fatal("invalid reconciliation accepted")
			}
			after, err := os.ReadFile(f.manager.BindingPath())
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("failed reconciliation changed retained binding", err)
			}
		})
	}
}

func TestSpineCandidateFrozenMediaReconciledBindingRetainsPolicyGuardAndLegacyCompatibility(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	f.bind(t)
	f.initialize(t)
	b, err := f.manager.ReconcileBaseline(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(f.manager.baselineObservation.BootstrapRoot, "release-policy.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.VerifyBinding(); err == nil {
		t.Fatal("reconciled media origin lost original policy guard")
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	b.BaselineKind = ""
	b.BaselineMachine = CoreMachineIdentity{}
	b.FrozenMediaSHA256 = ""
	legacyRaw, _ := json.Marshal(b)
	if err := os.WriteFile(f.manager.BindingPath(), legacyRaw, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := f.manager.VerifyBinding()
	if err != nil || !reflect.DeepEqual(got, b) {
		t.Fatal("existing v1 committed binding rejected", got, err)
	}
	if err := os.Remove(filepath.Join(f.manager.core().Root, "committed.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.VerifyBinding(); err == nil || errors.Is(err, os.ErrNotExist) {
		t.Fatal("legacy committed binding silently became frozen media", err)
	}
}

func TestSpineCandidateFrozenMediaQuiescenceHoldsActualFirstDeployLockThroughEffects(t *testing.T) {
	f := newFrozenCandidateFixture(t)
	path := filepath.Join(f.manager.baselineObservation.FirstDeployRoot, "lock")
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := f.manager.WithQuiescent(context.Background(), func() error { called = true; return nil }); err == nil || called {
		t.Fatal("active first-deploy lock did not exclude binding effects", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.WithQuiescent(context.Background(), func() error {
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			return fmt.Errorf("first-deploy could start while binding effects run")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal("first-deploy lock was not released", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	f.bind(t)
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.VerifyBinding(); err != nil {
		t.Fatal("runtime observation tried to lock out legitimate first-deploy retry", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
}

func TestSpineCandidateFrozenMediaFirstDeployLockRejectsUnsafeOrUnknownFiles(t *testing.T) {
	for _, name := range []string{"missing", "symlink", "hardlink", "writable", "oversized", "unsafe directory"} {
		t.Run(name, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			o := f.manager.baselineObservation
			path := filepath.Join(o.FirstDeployRoot, "lock")
			switch name {
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".original", path); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(path, path+".alias"); err != nil {
					t.Fatal(err)
				}
			case "writable":
				if err := os.Chmod(path, 0666); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				if err := os.WriteFile(path, bytes.Repeat([]byte{' '}, 4097), 0600); err != nil {
					t.Fatal(err)
				}
			case "unsafe directory":
				if err := os.Chmod(o.FirstDeployRoot, 0777); err != nil {
					t.Fatal(err)
				}
			}
			called := false
			if err := f.manager.WithQuiescent(context.Background(), func() error { called = true; return nil }); err == nil || called {
				t.Fatal("unsafe lock allowed binding effects", err)
			}
		})
	}
}

func TestSpineCandidateFrozenMediaSettledUnitRejectsNotLoadedAndContradictoryState(t *testing.T) {
	for _, line := range []string{"youeye-first-deploy.service not-found inactive dead fixture", "youeye-first-deploy.service loaded inactive running fixture", "youeye-first-deploy.service loaded failed dead fixture", "foreign.service loaded inactive dead fixture", "youeye-first-deploy.service loaded unknown unknown fixture"} {
		t.Run(line, func(t *testing.T) {
			f := newFrozenCandidateFixture(t)
			f.manager.baselineObservation.Capture = func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[len(args)-1] == "youeye-first-deploy.service" {
					return []byte(line), nil
				}
				return nil, nil
			}
			if _, err := f.manager.NewBinding(f.request); err == nil {
				t.Fatal("unknown unit state accepted")
			}
		})
	}
}
