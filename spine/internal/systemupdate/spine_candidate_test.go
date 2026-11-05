package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func spineCandidateFixture(t *testing.T) (string, string, string, ed25519.PublicKey) {
	t.Helper()
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	artifact := []byte("synthetic signed Spine candidate; never executed")
	digest := candidateHash(artifact)
	source := strings.Repeat("a", 40)
	root := filepath.Join(base, digest)
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	projection := SpineCandidateProjection{Schema: "youeye.spine-candidate-projection.v1", SourceCommit: source, ProjectedCommit: strings.Repeat("b", 40), Tree: strings.Repeat("c", 40), InputsSHA256: strings.Repeat("d", 64), SourceDateEpoch: 1780000000, TrustFingerprint: strings.Repeat("e", 64), IndependentBuilds: 2}
	provenance, _ := json.Marshal(map[string]any{"schema": "youeye.release.provenance.v1", "component": "spine", "repository": "YouEye", "branch": "main", "version": "0.5.66", "source_commit": source, "source_date_epoch": projection.SourceDateEpoch, "trust_class": "stable", "core_metadata": "paired-v2", "build_projection": projection, "manifest": map[string]string{"path": ".youeye/build/manifests/spine.json", "sha256": strings.Repeat("1", 64)}, "build_kit": map[string]string{"digest": strings.Repeat("2", 64)}, "artifact": map[string]any{"name": SpineCandidateArtifact, "sha256": digest, "size_bytes": len(artifact)}, "validation_profile": "spine-elf-v1", "builder_credentials": false, "signer_network": false})
	assets := map[string][]byte{SpineCandidateArtifact: artifact, "provenance.json": provenance, "sbom.spdx.json": []byte(`{"spdxVersion":"SPDX-2.3"}`), "release-public.pub": []byte("informational public key; never used to authorize this fixture")}
	var sums strings.Builder
	for _, name := range []string{SpineCandidateArtifact, "provenance.json", "sbom.spdx.json", "release-public.pub"} {
		fmt.Fprintf(&sums, "%s  %s\n", candidateHash(assets[name]), name)
	}
	assets["SHA256SUMS"], assets["SHA256SUMS.sig"] = []byte(sums.String()), ed25519.Sign(private, []byte(sums.String()))
	for name, data := range assets {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, digest, source, key
}

func TestSpineCandidateSignedSetUsesActualScopedKeyAndOriginalNames(t *testing.T) {
	root, digest, source, key := spineCandidateFixture(t)
	if err := verifySpineCandidateSet(root, digest, source, key); err != nil {
		t.Fatal(err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if verifySpineCandidateSet(root, digest, source, other) == nil {
		t.Fatal("downloaded/public supplied key became authority")
	}
	if verifySpineCandidateSet(root, digest, strings.Repeat("f", 40), key) == nil {
		t.Fatal("source identity changed")
	}
	if err := os.Rename(filepath.Join(root, SpineCandidateArtifact), filepath.Join(root, "youeye")); err != nil {
		t.Fatal(err)
	}
	if verifySpineCandidateSet(root, digest, source, key) == nil {
		t.Fatal("renamed original signed artifact admitted")
	}
}
func TestSpineCandidateRejectsUnsafeAndChangedEnvelope(t *testing.T) {
	for _, mutation := range []string{"binary", "provenance-marker", "hardlink", "symlink", "writable-directory", "extra-file", "unsigned-checksums"} {
		t.Run(mutation, func(t *testing.T) {
			root, digest, source, key := spineCandidateFixture(t)
			path := filepath.Join(root, SpineCandidateArtifact)
			switch mutation {
			case "binary":
				if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "provenance-marker":
				p := filepath.Join(root, "provenance.json")
				raw, _ := os.ReadFile(p)
				raw = bytes.ReplaceAll(raw, []byte("paired-v2"), []byte("legacy"))
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(path, filepath.Join(filepath.Dir(root), "alias")); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				raw, _ := os.ReadFile(path)
				elsewhere := filepath.Join(filepath.Dir(root), "outside")
				if err := os.WriteFile(elsewhere, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(elsewhere, path); err != nil {
					t.Fatal(err)
				}
			case "writable-directory":
				if err := os.Chmod(root, 0777); err != nil {
					t.Fatal(err)
				}
			case "extra-file":
				if err := os.WriteFile(filepath.Join(root, "extra"), []byte("x"), 0600); err != nil {
					t.Fatal(err)
				}
			case "unsigned-checksums":
				if err := os.WriteFile(filepath.Join(root, "SHA256SUMS"), []byte(candidateHash([]byte("changed"))+"  "+SpineCandidateArtifact+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if verifySpineCandidateSet(root, digest, source, key) == nil {
				t.Fatalf("accepted %s", mutation)
			}
		})
	}
}
func TestSpineCandidateScopedOverrideAndRevocationCannotFallback(t *testing.T) {
	old := coreTrustLookup
	t.Cleanup(func() { coreTrustLookup = old })
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if source != releasecache.OfficialRepository || branch != "main" || scope != "spine" {
			t.Fatal("candidate key scope changed")
		}
		return nil, fmt.Errorf("revoked scoped enrollment")
	}
	if _, err := spineCandidateScopedKey(); err == nil {
		t.Fatal("revocation fell back to embedded publisher")
	}
}
func TestSpineCandidateAbsentBindingDiffersFromCorruptRetainedBinding(t *testing.T) {
	m := SpineCandidateManager{Root: t.TempDir()}
	if executable, err := m.TestExecutable(); err != nil || executable != "" {
		t.Fatal("absent explicit binding changed ordinary execution", err)
	}
	b := SpineCandidateBinding{Schema: SpineCandidateBindingSchema, CandidateID: "spine-candidate-b-test", ArtifactSHA256: strings.Repeat("b", 64), SourceCommit: strings.Repeat("a", 40), HardwareUUID: "30803ef1-d063-48ed-88df-2196f3b2e869", InstalledManifestSHA256: strings.Repeat("c", 64), ActivatedAt: time.Now().UTC()}
	b.Root = filepath.Join(m.root(), b.ArtifactSHA256)
	raw, _ := json.Marshal(b)
	if err := os.WriteFile(m.BindingPath(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.TestExecutable(); err == nil {
		t.Fatal("present but unavailable candidate fell back to baked coordinator")
	}
	if _, err := NormalizeSpineCandidateHardware("00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("unbound hardware accepted")
	}
}

func TestSpineCandidateTransitionRejectsRetainedAndActiveOwners(t *testing.T) {
	ready := func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	for _, kind := range []string{"empty", "bootstrap", "host-transaction", "core-reservation", "copy-reservation", "app-recovery", "running-controller", "unknown-controller"} {
		t.Run(kind, func(t *testing.T) {
			m := SpineCandidateManager{CoreRoot: t.TempDir(), LifecycleRoot: t.TempDir()}
			capture := ready
			switch kind {
			case "host-transaction":
				dir := filepath.Join(filepath.Dir(m.CoreRoot), "system-update")
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				raw, _ := json.Marshal(Journal{Schema: JournalSchema, TransactionID: "host-owned", ManifestSHA256: strings.Repeat("a", 64), CurrentImage: "0.5.64", TargetImage: "0.5.65", ActiveSlot: "A", CandidateSlot: "B", Phase: PhaseTrial, StartedAt: "fixture", UpdatedAt: "fixture"})
				if err := os.WriteFile(filepath.Join(dir, "journal.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "bootstrap":
				raw, _ := json.Marshal(CoreBootstrap{Schema: "youeye.core-bootstrap.v1", RequestID: "request", ManifestSHA256: strings.Repeat("a", 64), ArtifactSHA256: strings.Repeat("b", 64)})
				if err := os.WriteFile(filepath.Join(m.CoreRoot, "bootstrap-coordinator.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "core-reservation":
				if err := os.WriteFile(filepath.Join(m.LifecycleRoot, "core-reservation.json"), []byte(`{"schema":"youeye.core-lifecycle.v1","request_id":"request","manifest_sha256":"`+strings.Repeat("a", 64)+`"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "copy-reservation":
				if err := os.WriteFile(filepath.Join(m.LifecycleRoot, "copy-reservation.json"), []byte(`{"unfinished":"copy"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "app-recovery":
				if err := os.Mkdir(filepath.Join(m.LifecycleRoot, "operations"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(m.LifecycleRoot, "operations", "owned.json"), []byte(`{"schema":"youeye.app-update.v1","phase":"recovery_required"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "running-controller":
				capture = func(context.Context, string, ...string) ([]byte, error) {
					return []byte("youeye-core-control-owned.service loaded active running native work\n"), nil
				}
			case "unknown-controller":
				capture = func(context.Context, string, ...string) ([]byte, error) {
					return nil, fmt.Errorf("observation unavailable")
				}
			}
			err := m.candidateTransitionReady(context.Background(), capture)
			if kind == "empty" && err != nil {
				t.Fatal(err)
			}
			if kind != "empty" && err == nil {
				t.Fatalf("candidate replaced %s owner", kind)
			}
		})
	}
}
