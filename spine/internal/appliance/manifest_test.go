package appliance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validManifest = `{
  "schema_version": 1,
  "image_version": "1.0.0",
  "build_id": "build-1",
  "source_commit": "0123456789012345678901234567890123456789",
  "architecture": "amd64",
  "firmware_mode": "uefi",
  "disk_layout_version": 3,
  "state_schema_min": 2,
  "state_schema_max": 2,
  "data_schema_min": 1,
  "data_schema_max": 1,
  "kernel_compatibility": ">=6.12",
  "zfs_compatibility": ">=2.3",
	"zfs_feature_profile": "openzfs-2.2",
  "incus_compatibility": ">=7.0",
  "recovery_version": "1",
  "artifact_kind": "test",
  "supported_actions": ["recovery"]
}`

func TestDetectAbsentMarkerIsMutableHost(t *testing.T) {
	status, manifest, err := DetectAt(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}
	if manifest != nil || status.Kind != RuntimeMutableHost || !status.Capabilities.SystemUpdate {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestDetectValidApplianceDisablesHostMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release")
	if err := os.WriteFile(path, []byte(validManifest), 0444); err != nil {
		t.Fatal(err)
	}
	status, _, err := DetectAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if status.Kind != RuntimeApplianceImage || !status.ManifestValid {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.Capabilities.SpineUpdate || status.Capabilities.SystemUpdate || status.Capabilities.IncusUpdate {
		t.Fatalf("host mutation unexpectedly enabled: %+v", status.Capabilities)
	}
	if !status.Capabilities.ControlUpdate || !status.Capabilities.Recovery {
		t.Fatalf("expected app/recovery capabilities: %+v", status.Capabilities)
	}
}

func TestPresentInvalidMarkerFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release")
	if err := os.WriteFile(path, []byte(`{"schema_version":1}`), 0444); err != nil {
		t.Fatal(err)
	}
	status, _, err := DetectAt(path)
	if err == nil || status.Kind != RuntimeApplianceImage || !status.RepairRequired || status.Capabilities.SystemUpdate {
		t.Fatalf("invalid marker did not fail closed: status=%+v err=%v", status, err)
	}
}

func TestWritableMarkerFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release")
	if err := os.WriteFile(path, []byte(validManifest), 0644); err != nil {
		t.Fatal(err)
	}
	status, _, err := DetectAt(path)
	if err == nil || status.ErrorCode != "manifest_mutable" || status.Kind != RuntimeApplianceImage {
		t.Fatalf("writable marker did not fail closed: %+v %v", status, err)
	}
}

func TestManifestRejectsUnknownAndTrailingContent(t *testing.T) {
	for _, mutation := range []string{
		strings.Replace(validManifest, `"supported_actions"`, `"unexpected": true, "supported_actions"`, 1),
		validManifest + ` {}`,
	} {
		if _, err := ParseManifest([]byte(mutation)); err == nil {
			t.Fatalf("expected strict parse failure for %q", mutation[len(mutation)-8:])
		}
	}
}

func exactReleaseSetManifest() string {
	return strings.Replace(validManifest, `"supported_actions": ["recovery"]`, `"supported_actions": ["recovery"],
  "release_set": {
    "source": "https://github.com/YouEye-Platform/YouEye",
    "branch": "dev",
    "fallback": [],
    "spine": {"version":"1.0.0","source_commit":"0123456789012345678901234567890123456789","artifact_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    "control_panel": {"version":"2.0.0","tag":"cp-dev-v2.0.0","source_commit":"1123456789012345678901234567890123456789","artifact_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    "ui": {"version":"3.0.0","tag":"ui-dev-v3.0.0","source_commit":"2123456789012345678901234567890123456789","artifact_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
  }`, 1)
}

func TestManifestAcceptsExactReleaseSet(t *testing.T) {
	m, err := ParseManifest([]byte(exactReleaseSetManifest()))
	if err != nil {
		t.Fatal(err)
	}
	if m.ReleaseSet == nil || m.ReleaseSet.ControlPanel.Tag != "cp-dev-v2.0.0" {
		t.Fatalf("unexpected release set: %+v", m.ReleaseSet)
	}
}

func TestManifestAcceptsSafeMultiSegmentReleaseBranch(t *testing.T) {
	raw := strings.NewReplacer(
		`"branch": "dev"`, `"branch": "codex/phase1-repository-builds"`,
		`cp-dev-v2.0.0`, `cp-codex/phase1-repository-builds-v2.0.0`,
		`ui-dev-v3.0.0`, `ui-codex/phase1-repository-builds-v3.0.0`,
	).Replace(exactReleaseSetManifest())
	if _, err := ParseManifest([]byte(raw)); err != nil {
		t.Fatalf("safe multi-segment Forgejo branch was rejected: %v", err)
	}
}

func TestManifestKeepsApplianceAndComponentSourceIdentitiesIndependent(t *testing.T) {
	raw := strings.Replace(exactReleaseSetManifest(),
		`"source_commit":"0123456789012345678901234567890123456789"`,
		`"source_commit":"3123456789012345678901234567890123456789"`, 1)
	m, err := ParseManifest([]byte(raw))
	if err != nil {
		t.Fatalf("exact independently released Spine commit was rejected: %v", err)
	}
	if m.ReleaseSet.Spine.SourceCommit == m.SourceCommit {
		t.Fatal("test fixture did not preserve distinct signed source identities")
	}
}

func TestManifestReleaseSetFailsClosed(t *testing.T) {
	base := exactReleaseSetManifest()
	for _, mutation := range []string{
		strings.Replace(base, `"fallback": []`, `"fallback": ["main"]`, 1),
		strings.Replace(base, `cp-dev-v2.0.0`, `cp-v2.0.0`, 1),
		strings.Replace(base, strings.Repeat("b", 64), "bad", 1),
		strings.Replace(base, `"branch": "dev"`, `"branch": "codex//escape"`, 1),
		strings.Replace(base, `"branch": "dev"`, `"branch": "../escape"`, 1),
		strings.Replace(base, `"branch": "dev"`, `"branch": "codex/bad.lock"`, 1),
		strings.Replace(base, `"branch": "dev"`, `"branch": "codex/bad~ref"`, 1),
	} {
		if _, err := ParseManifest([]byte(mutation)); err == nil {
			t.Fatal("expected invalid release set to fail")
		}
	}
}

func TestCompatibilityMatrix(t *testing.T) {
	m, err := ParseManifest([]byte(validManifest))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		state, data         int
		wantState, wantData string
		ok                  bool
	}{
		{2, 1, "compatible", "compatible", true},
		{1, 1, "upgrade-required", "compatible", false},
		{3, 1, "image-too-old", "compatible", false},
		{2, 2, "compatible", "image-too-old", false},
	}
	for _, tc := range tests {
		got := CheckCompatibility(m, tc.state, tc.data)
		if got.State != tc.wantState || got.Data != tc.wantData || got.Compatible != tc.ok {
			t.Errorf("CheckCompatibility(%d,%d)=%+v", tc.state, tc.data, got)
		}
	}
}

func TestPublicImageKindsRecognizedWithoutRelaxingValidation(t *testing.T) {
	for _, kind := range []string{"stable", "beta"} {
		raw := strings.Replace(validManifest, `"artifact_kind": "test"`, `"artifact_kind": "`+kind+`"`, 1)
		if _, err := ParseManifest([]byte(raw)); err != nil {
			t.Fatal(kind, err)
		}
		bad := strings.Replace(raw, `"schema_version": 1`, `"schema_version": 999`, 1)
		if _, err := ParseManifest([]byte(bad)); err == nil {
			t.Fatal("invalid schema accepted", kind)
		}
	}
	raw := strings.Replace(validManifest, `"artifact_kind": "test"`, `"artifact_kind": "unknown"`, 1)
	if _, err := ParseManifest([]byte(raw)); err == nil {
		t.Fatal("unknown kind accepted")
	}
}
