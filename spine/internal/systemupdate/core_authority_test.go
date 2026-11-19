package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestNativeCoreAuthorityUsesFrozenTargetWithoutDiscovery(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Version, r.Build, r.Tag = "0.6.1-dev.2", "0.6.1-dev.2", "youeye-v0.6.1-dev.2"
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = appliance.CurrentStateSchema
	r.Compatibility.StateMax = appliance.CurrentStateSchema
	raw, _ = json.Marshal(r)
	digest := checksum(raw)
	state := testState()
	statePath := filepath.Join(root, "appliance-state.json")
	stateRaw, _ := json.Marshal(state)
	if err = os.WriteFile(statePath, stateRaw, 0600); err != nil {
		t.Fatal(err)
	}
	machine := CoreMachineIdentity{InstallIDRef: state.InstallIDRef, DeviceIDRef: state.DeviceIDRef, ParentDiskID: state.ParentDiskID, StatePartUUID: state.StatePartUUID, DataPartUUID: state.DataPartUUID}
	m := CoreManager{Root: filepath.Join(root, "core")}
	receipt, err := m.Initialize(ctx, CoreHostSelection{Raw: raw}, digest, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return machine, "fixture acceptance", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	j := CoreJournal{RequestID: "authority-fixture", ManifestSHA256: digest, Target: r, Previous: receipt, Phase: "prepared", RestartRequired: true, Steps: []CoreStep{{Name: "checkpoint", State: "pending"}}}
	requests := 0
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		return nil, fmt.Errorf("fixture offline")
	})}
	a := NativeCoreAuthority{Checkpoint: NativeCoreCheckpoint{Root: m.Root, DataRoot: root, StatePath: statePath, MachineObservation: func() (CoreMachineIdentity, error) { return machine, nil }}, Client: client}
	if err = a.AuthorizeTarget(ctx, j, false); err != nil {
		t.Fatal(err)
	}
	j.Steps[0].State = "started"
	j.Phase = "applying"
	if err = a.AuthorizeTarget(ctx, j, true); err != nil {
		t.Fatal("frozen continuation required discovery", err)
	}
	if requests != 0 {
		t.Fatal("authority re-resolved the channel for a digest-bound target")
	}
	if err = a.AuthorizePrevious(ctx, j); err != nil {
		t.Fatal("independently authorized recovery refused", err)
	}
	machine.DeviceIDRef = "another-device"
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("ignored hardware replacement")
	}
	machine = receipt.Machine
	if err = os.WriteFile(filepath.Join(m.Root, "targets", digest+".json"), append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.AuthorizeTarget(ctx, j, true); err == nil {
		t.Fatal("changed retained release admitted")
	}
}

func TestCoreCompatibilityBoundaries(t *testing.T) {
	_, _, r := coreJournalFixture(t)
	r.Compatibility.MinimumRelease = "0.5.36"
	r.Compatibility.StateMin = appliance.CurrentStateSchema
	r.Compatibility.StateMax = appliance.CurrentStateSchema
	state := testState()
	if err := validateCoreCompatibility(r, state, r.Version); err != nil {
		t.Fatal(err)
	}
	if err := validateCoreCompatibility(r, state, "0.5.1"); err == nil {
		t.Fatal("missing bridge accepted")
	}
	state.DataSchemaVersion++
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("future Data accepted")
	}
	state = testState()
	r.Compatibility.Capabilities = append(r.Compatibility.Capabilities, "future-reader")
	if err := validateCoreCompatibility(r, state, r.Version); err == nil {
		t.Fatal("unknown capability accepted")
	}
}

// minimum_release is a line. A document up to 0.6.12 names a build there,
// which is read as its line: any release of that line may install it.
func TestCoreMinimumReleaseIsALine(t *testing.T) {
	_, _, r := coreJournalFixture(t)
	r.Compatibility.StateMin, r.Compatibility.StateMax = appliance.CurrentStateSchema, appliance.CurrentStateSchema
	state := testState()
	for _, c := range []struct {
		minimum, installed string
		ok                 bool
	}{
		{"0.6.12", "0.6.12", true},
		{"0.6.12", "0.6.12-dev.3", true},
		{"0.6.12", "0.6.12-alpha.1", true},
		{"0.6.12", "0.6.13-dev.1", true},
		{"0.6.12", "0.6.11", false},
		{"0.6.12", "0.6.11-dev.6", false},
		{"0.6.5-dev.2", "0.6.5-dev.1", true}, // the old rule refused this build of the minimum's own line
		{"0.6.5-dev.2", "0.6.5-alpha.1", true},
		{"0.6.5-dev.2", "0.6.11", true},
		{"0.6.5-dev.2", "0.6.4", false},
		{"0.6.12", "", false},
		{"0.6.12", "unknown", false},
	} {
		r.Compatibility.MinimumRelease = c.minimum
		err := validateCoreCompatibility(r, state, c.installed)
		if (err == nil) != c.ok {
			t.Errorf("minimum %s, installed %q: %v", c.minimum, c.installed, err)
		}
		if err != nil && c.installed == "0.6.11-dev.6" && err.Error() != "YouEye 0.5.38 needs YouEye 0.6.12 or later; this box has 0.6.11-dev.6" {
			t.Errorf("message: %v", err)
		}
	}
}

// A document without build names (members carry no build_version) is bound to
// the host update manifest by digests and trees alone.
func TestCoreHostMembershipNeedsNoBuildNames(t *testing.T) {
	f := newManagerFixture(t)
	hostRaw, _ := json.Marshal(f.update)
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-no-build.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i := range r.Members {
		m := &r.Members[i]
		m.SourceTree = targetCommit
		if m.Role == "system-update" {
			m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = "system-update-manifest.json", checksum(hostRaw), int64(len(hostRaw))
		}
		for _, a := range f.update.Artifacts {
			if a.Role == m.Role {
				m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = a.Path, a.SHA256, a.SizeBytes
			}
		}
	}
	verified := VerifiedManifest{Manifest: f.update, Raw: hostRaw, SHA256: checksum(hostRaw)}
	encode := func(r releasecache.CoreRelease) CoreHostSelection {
		raw, _ := json.Marshal(r)
		return CoreHostSelection{Raw: raw}
	}
	if _, _, err := f.manager.verifyCoreHost(encode(r), verified); err != nil {
		t.Fatal(err)
	}
	// The old shape still binds the same way; its build names are not compared
	// with the image version or with each other.
	old := r
	old.Build, old.MinimumReader = "0.6.12-dev.4", 1
	old.Members = append([]releasecache.CoreMember{}, r.Members...)
	for i := range old.Members {
		old.Members[i].BuildVersion = fmt.Sprintf("0.6.%d-dev.1", i+1)
	}
	if _, _, err := f.manager.verifyCoreHost(encode(old), verified); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*releasecache.CoreRelease){
		"another update manifest": func(r *releasecache.CoreRelease) {
			for i := range r.Members {
				if r.Members[i].Role == "system-update" {
					r.Members[i].Artifact.SHA256 = checksum([]byte("other"))
				}
			}
		},
		"another payload": func(r *releasecache.CoreRelease) {
			for i := range r.Members {
				if r.Members[i].Role == "system-root" {
					r.Members[i].Artifact.SHA256 = checksum([]byte("other"))
				}
			}
		},
		"a payload of another tree": func(r *releasecache.CoreRelease) {
			for i := range r.Members {
				if r.Members[i].Role == "system-root" {
					r.Members[i].SourceTree = baselineCommit
				}
			}
		},
		"an update manifest of another tree": func(r *releasecache.CoreRelease) {
			for i := range r.Members {
				if r.Members[i].Role == "system-update" {
					r.Members[i].SourceTree = baselineCommit
				}
			}
		},
	} {
		changed := r
		changed.Members = append([]releasecache.CoreMember{}, r.Members...)
		change(&changed)
		if _, _, err := f.manager.verifyCoreHost(encode(changed), verified); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
