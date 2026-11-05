package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestSpineCandidateOwnedOverrideResumesAndPreservesForeignFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unit.d", "candidate.conf")
	want := candidateOverride("/var/lib/youeye-state/spine-candidates/" + strings.Repeat("a", 64) + "/spine-linux-amd64")
	if !strings.HasPrefix(spineCandidateDropIn, "/run/") || bytes.Contains(want, []byte("/etc/")) {
		t.Fatal("candidate changes immutable host wiring")
	}
	if err := candidateWriteOwned(path, want); err != nil {
		t.Fatal(err)
	}
	if err := candidateWriteOwned(path, want); err != nil {
		t.Fatal("same binding could not reconcile", err)
	}
	if err := candidateWriteOwned(path, []byte("foreign override")); err == nil {
		t.Fatal("another override replaced")
	}
	if err := candidateRemoveOwned(path, []byte("foreign override")); err == nil {
		t.Fatal("another override removed")
	}
	if err := candidateRemoveOwned(path, want); err != nil {
		t.Fatal(err)
	}
	if err := candidateRemoveOwned(path, want); err != nil {
		t.Fatal("same deactivation did not reconcile", err)
	}
	unsafe := filepath.Join(t.TempDir(), "unsafe")
	if err := os.Mkdir(unsafe, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unsafe, 0777); err != nil {
		t.Fatal(err)
	}
	if err := candidateWriteOwned(filepath.Join(unsafe, "unit.conf"), want); err == nil {
		t.Fatal("writable runtime directory admitted")
	}
}
func TestSpineCandidateBindingAndDevelopmentMarkerKeepHonestIdentity(t *testing.T) {
	digest := strings.Repeat("a", 64)
	source := strings.Repeat("b", 40)
	hardware := "30803ef1-d063-48ed-88df-2196f3b2e869"
	b := systemupdate.SpineCandidateBinding{Schema: systemupdate.SpineCandidateBindingSchema, CandidateID: "spine-candidate-b-test", ArtifactSHA256: digest, SourceCommit: source, Root: filepath.Join(systemupdate.SpineCandidateRoot, digest), HardwareUUID: hardware, InstalledManifestSHA256: strings.Repeat("c", 64), ActivatedAt: time.Now().UTC()}
	r := systemupdate.SpineCandidateRequest{Root: b.Root, CandidateID: b.CandidateID, ArtifactSHA256: digest, SourceCommit: source, Identity: "smbios:" + strings.ToUpper(hardware)}
	if err := candidateBindingMatches(b, r); err != nil {
		t.Fatal(err)
	}
	r.SourceCommit = strings.Repeat("d", 40)
	if candidateBindingMatches(b, r) == nil {
		t.Fatal("another source adopted binding")
	}
	var marker map[string]any
	if err := json.Unmarshal(candidateOverlayBytes(b), &marker); err != nil {
		t.Fatal(err)
	}
	if marker["unsigned"] != false || marker["signed"] != true || marker["development"] != true || marker["nonpublishable"] != true || marker["sha256"] != digest {
		t.Fatal("signed test overlay misrepresented production/unsigned state")
	}
}

func TestSpineCandidateStatusVersionsFrozenOriginWithoutRelabelingCommitted(t *testing.T) {
	machine := systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state-fixture", DataPartUUID: "data-fixture"}
	for _, tc := range []struct {
		name         string
		binding      systemupdate.SpineCandidateBinding
		schema, kind string
	}{
		{"legacy committed", systemupdate.SpineCandidateBinding{}, systemupdate.SpineCandidateStatusSchema, "committed"},
		{"ordinary committed", systemupdate.SpineCandidateBinding{BaselineKind: "committed", BaselineMachine: machine}, systemupdate.SpineCandidateStatusSchema, "committed"},
		{"frozen media", systemupdate.SpineCandidateBinding{BaselineKind: "frozen-media", BaselineMachine: machine, FrozenMediaSHA256: strings.Repeat("a", 64)}, systemupdate.SpineCandidateStatusSchemaV2, "frozen-media"},
		{"reconciled committed", systemupdate.SpineCandidateBinding{BaselineKind: "committed", BaselineMachine: machine, FrozenMediaSHA256: strings.Repeat("a", 64)}, systemupdate.SpineCandidateStatusSchemaV2, "committed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			schema, kind, err := spineCandidateStatusIdentity(tc.binding)
			if err != nil || schema != tc.schema || kind != tc.kind {
				t.Fatal(schema, kind, err)
			}
			if schema == systemupdate.SpineCandidateStatusSchemaV2 && (kind == "" || kind != tc.binding.BaselineKind) {
				t.Fatal("v2 baseline kind did not match exact binding")
			}
		})
	}
}

func TestSpineCandidateStatusRejectsUnversionableFrozenEvidence(t *testing.T) {
	machine := systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state-fixture", DataPartUUID: "data-fixture"}
	for _, b := range []systemupdate.SpineCandidateBinding{
		{BaselineKind: "unknown"},
		{BaselineKind: "frozen-media", BaselineMachine: machine},
		{BaselineKind: "frozen-media", BaselineMachine: machine, FrozenMediaSHA256: "bad"},
		{BaselineKind: "frozen-media", FrozenMediaSHA256: strings.Repeat("a", 64)},
		{BaselineMachine: machine, FrozenMediaSHA256: strings.Repeat("a", 64)},
		{BaselineKind: "committed", FrozenMediaSHA256: strings.Repeat("a", 64)},
	} {
		if schema, kind, err := spineCandidateStatusIdentity(b); err == nil {
			t.Fatal("malformed frozen evidence emitted status", schema, kind, b)
		}
	}
}
