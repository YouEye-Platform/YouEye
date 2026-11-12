package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/update"
)

type coreDeploymentFixture struct {
	image        appliance.Manifest
	release      releasecache.CoreRelease
	policy       systemupdate.ReleasePolicy
	root, binary string
	// seed is the image's baked Spine; it defaults to binary (the running one).
	seed string
}

func coreTestHash(raw []byte) string { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

// newCoreDeploymentFixture installs the shared core-release.json as the
// accepted release. The image carries an older CP/UI (reused media): first
// deployment uses the release members, never the image's own service pins.
func newCoreDeploymentFixture(t *testing.T) *coreDeploymentFixture {
	t.Helper()
	f := &coreDeploymentFixture{root: t.TempDir()}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	f.release, _, err = releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i := range f.release.Members {
		m := &f.release.Members[i]
		if m.Role == "spine" {
			payload := []byte("immutable fixture Spine")
			f.binary = filepath.Join(f.root, coreBakedExecutable)
			if err := os.MkdirAll(filepath.Dir(f.binary), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(f.binary, payload, 0755); err != nil {
				t.Fatal(err)
			}
			m.Artifact.SHA256, m.Artifact.SizeBytes = coreTestHash(payload), int64(len(payload))
		}
	}
	oldPolicy, oldSelection, oldExecutable, oldCfg, oldVersion, oldReader := deploymentPolicyPath, coreSelectionRoot, applianceExecutablePath, cfg, Version, coreInstalledReaderHost
	oldVerifyRunning := verifyRunningSpine
	t.Cleanup(func() {
		deploymentPolicyPath, coreSelectionRoot, applianceExecutablePath, cfg, Version = oldPolicy, oldSelection, oldExecutable, oldCfg, oldVersion
		coreInstalledReaderHost, verifyRunningSpine = oldReader, oldVerifyRunning
	})
	// The fixture binary is the seed baked into the image; the running Spine
	// must be it or a Spine selected for the booted slot (none here).
	verifyRunningSpine = func(executable string) error {
		if executable == coreBakedExecutable {
			executable = f.binary
		}
		digest, err := spineselect.FileDigest(executable)
		if err != nil {
			return err
		}
		seedPath := f.seed
		if seedPath == "" {
			seedPath = f.binary
		}
		seed, err := spineselect.FileDigest(seedPath)
		if err != nil {
			return err
		}
		return spineselect.Running(filepath.Join(f.root, "spine"), "A", digest, seed)
	}
	deploymentPolicyPath = filepath.Join(f.root, "release-policy.json")
	coreSelectionRoot = f.root
	applianceExecutablePath = func() (string, error) { return f.binary, nil }
	coreInstalledReaderHost = func() coreInstalledReaderObserver {
		return coreInstalledReaderObserver{Root: f.root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return coreBakedExecutable, nil }, CurrentSHA256: func() (string, error) { raw, e := os.ReadFile(f.binary); return coreTestHash(raw), e }}
	}
	cfg = config.Default()
	f.writeSelection(t)
	return f
}

func (f *coreDeploymentFixture) writeSelection(t *testing.T) {
	t.Helper()
	raw, err := json.Marshal(f.release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "core-release.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	f.policy = systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Repository: "https://forge.example.test/team/YouEye", Channel: "dev", CoreManifestSHA256: coreTestHash(raw)}
	if err := systemupdate.SaveReleasePolicy(deploymentPolicyPath, f.policy); err != nil {
		t.Fatal(err)
	}
	media, _ := f.release.Member("appliance")
	spine, _ := f.release.Member("spine")
	Version = spine.BuildVersion
	older := appliance.ComponentRelease{Version: "0.6.0-rc.3", SourceTree: strings.Repeat("2", 40), ArtifactSHA256: strings.Repeat("b", 64)}
	f.image = appliance.Manifest{ImageVersion: media.BuildVersion, SourceTree: media.SourceTree, ReleaseSet: &appliance.ReleaseSet{
		Spine:        appliance.ComponentRelease{Version: spine.BuildVersion, SourceTree: spine.SourceTree, ArtifactSHA256: spine.Artifact.SHA256},
		ControlPanel: older, UI: older,
	}}
}

func TestCoreFirstDeploymentKeepsSealedImage(t *testing.T) {
	f := newCoreDeploymentFixture(t)
	before, _ := json.Marshal(f.image)
	selected, err := selectApplianceServices(f.image)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyApplianceReleaseSet(selected, GetConfig()); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(f.image)
	if !bytes.Equal(before, after) || !reflect.DeepEqual(selected, f.image) {
		t.Fatal("sealed image was rewritten")
	}
	if _, err = selectApplianceServices(f.image); err != nil {
		t.Fatalf("resume: %v", err)
	}
	// The baked Spine is only the seed: an image whose Spine differs from the
	// release's is accepted (the release's Spine is selected on State).
	f.image.ReleaseSet.Spine.ArtifactSHA256 = strings.Repeat("c", 64)
	if err = verifyApplianceReleaseSet(f.image, GetConfig()); err != nil {
		t.Fatalf("image whose seed Spine differs from the release refused: %v", err)
	}
	// A running Spine that is neither the seed nor selected for the slot is refused.
	f.seed = filepath.Join(f.root, "other-seed")
	if err := os.WriteFile(f.seed, []byte("another seed"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = verifyApplianceReleaseSet(f.image, GetConfig()); err == nil {
		t.Fatal("unselected running Spine accepted")
	}
	raw, err := os.ReadFile(f.binary)
	if err != nil {
		t.Fatal(err)
	}
	entry := spineselect.Entry{SHA256: coreTestHash(raw), Version: "0.6.1-rc.1", HelperContract: spineselect.HelperContract, DiskLayout: spineselect.DiskLayout}
	spineRoot := filepath.Join(f.root, "spine")
	if err := spineselect.Stage(spineRoot, f.binary, entry); err != nil {
		t.Fatal(err)
	}
	if err := spineselect.Select(spineRoot, "A", entry, spineselect.ThisHost(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err = verifyApplianceReleaseSet(f.image, GetConfig()); err != nil {
		t.Fatalf("Spine selected for the slot refused: %v", err)
	}
}

func TestCoreDeploymentRejectsChangedSelection(t *testing.T) {
	for _, name := range []string{"changed document", "other policy digest", "missing document", "missing policy"} {
		t.Run(name, func(t *testing.T) {
			f := newCoreDeploymentFixture(t)
			p := filepath.Join(f.root, "core-release.json")
			switch name {
			case "changed document":
				r := f.release
				r.Sequence++
				raw, _ := json.Marshal(r)
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "other policy digest":
				f.policy.CoreManifestSHA256 = strings.Repeat("e", 64)
				if err := systemupdate.SaveReleasePolicy(deploymentPolicyPath, f.policy); err != nil {
					t.Fatal(err)
				}
			case "missing document":
				if err := os.Remove(p); err != nil {
					t.Fatal(err)
				}
			case "missing policy":
				if err := os.Remove(deploymentPolicyPath); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := selectApplianceServices(f.image); err == nil {
				t.Fatal("changed selection admitted")
			}
			if err := verifyApplianceReleaseSet(f.image, GetConfig()); err == nil {
				t.Fatal("changed selection verified")
			}
		})
	}
}

func TestCoreFirstDeploymentHealthChecksReleaseMembers(t *testing.T) {
	f := newCoreDeploymentFixture(t)
	oldRoot, oldVersion := coreInstalledHealthStateRoot, firstDeployPackageVersion
	t.Cleanup(func() { coreInstalledHealthStateRoot, firstDeployPackageVersion = oldRoot, oldVersion })
	coreInstalledHealthStateRoot = filepath.Join(f.root, "core-state")
	t.Cleanup(update.SetProvenanceDir(filepath.Join(f.root, "provenance")))
	versions := map[string]string{}
	for _, m := range f.release.Members {
		if m.Role != "cp" && m.Role != "ui" {
			continue
		}
		key, container := "control", "youeye-control"
		if m.Role == "ui" {
			key, container = "ui", "youeye-ui"
		}
		versions[container] = m.BuildVersion
		if err := update.WriteProvenance(key, update.ProvenanceEntry{Version: m.BuildVersion, ArtifactSHA256: m.Artifact.SHA256}); err != nil {
			t.Fatal(err)
		}
	}
	firstDeployPackageVersion = func(container, _ string) string { return versions[container] }
	checks := map[string]string{}
	observe := func() {
		checks = map[string]string{}
		addFirstDeployReleaseSetChecks(f.image, func(name, status, _ string) { checks[name] = status })
	}
	observe()
	for _, name := range []string{"System core provenance", "Server interface provenance", "YouEye interface provenance"} {
		if checks[name] != "pass" {
			t.Fatalf("first-deploy health %s: %+v", name, checks)
		}
	}
	// The image's own (older) service pins are not what is checked.
	versions["youeye-control"] = f.image.ReleaseSet.ControlPanel.Version
	observe()
	if checks["Server interface provenance"] != "fail" {
		t.Fatal("image service version passed instead of the release member", checks)
	}
	versions["youeye-control"] = ""
	for _, m := range f.release.Members {
		if m.Role == "cp" {
			versions["youeye-control"] = m.BuildVersion
		}
	}
	ui, ok := update.GetProvenance("ui")
	if !ok {
		t.Fatal("missing UI fixture")
	}
	ui.ArtifactSHA256 = strings.Repeat("f", 64)
	if err := update.WriteProvenance("ui", ui); err != nil {
		t.Fatal(err)
	}
	observe()
	if checks["Server interface provenance"] != "pass" || checks["YouEye interface provenance"] != "fail" {
		t.Fatal("changed installed digest passed health", checks)
	}
}

// The System update source is host-owned: currentCoreSelection reads only the
// protected policy, and `youeye channel set` changes only its channel.
func TestCoreSelectionFollowsProtectedPolicy(t *testing.T) {
	f := newCoreDeploymentFixture(t)
	selection, err := currentCoreSelection()
	want := systemupdate.CoreReleaseSelection{Repository: f.policy.Repository, Channel: "dev"}
	if err != nil || selection != want {
		t.Fatalf("selection = %+v, %v; want %+v", selection, err, want)
	}
	if _, err := setReleaseChannel(deploymentPolicyPath, "beta"); err != nil {
		t.Fatal(err)
	}
	want.Channel = "beta"
	if selection, err = currentCoreSelection(); err != nil || selection != want {
		t.Fatalf("selection = %+v, %v; want %+v", selection, err, want)
	}
	// The accepted release is still the same document: a channel change
	// never rewrites the root of trust.
	if _, err := selectApplianceServices(f.image); err != nil {
		t.Fatal(err)
	}
}
