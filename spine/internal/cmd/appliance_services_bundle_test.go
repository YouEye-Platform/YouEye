package cmd

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func installationBundleFixture(t *testing.T, marker appliance.Manifest) []byte {
	t.Helper()
	raw, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	var bundle map[string]any
	if err = json.Unmarshal(raw, &bundle); err != nil {
		t.Fatal(err)
	}
	delete(bundle, "schema_version")
	delete(bundle, "disk_layout_version")
	delete(bundle, "supported_actions")
	delete(bundle, "artifact_kind")
	bundle["schema"] = "youeye.appliance.manifest.v1"
	bundle["disk_layout"] = map[string]any{"version": marker.DiskLayoutVersion}
	bundle["artifacts"] = []any{map[string]any{"filename": "system-root.img.zst", "sha256": "signed-image-hash"}}
	raw, err = json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestInstallationBundleUsesExternalManifestAndBindsRuntime(t *testing.T) {
	marker := appliance.Manifest{SchemaVersion: 1, ImageVersion: "1.0.0", BuildID: "build", SourceCommit: "source", DiskLayoutVersion: 3, StateSchemaMin: 2, StateSchemaMax: 2, Architecture: "amd64", ArtifactKind: "release", SupportedActions: []string{"recovery", "image-update"}, ReleaseSet: &appliance.ReleaseSet{Source: "https://code.example.test/owner/YouEye", Branch: "main", Spine: appliance.ComponentRelease{ArtifactSHA256: "spine"}}}
	bundle := installationBundleFixture(t, marker)
	selected := releasecache.InstallationSet{Appliance: releasecache.InstallationImage{ManifestSHA256: fmt.Sprintf("%x", sha256.Sum256(bundle))}}
	runtime, _ := json.Marshal(marker)
	if sha256.Sum256(runtime) == sha256.Sum256(bundle) {
		t.Fatal("fixture lost distinct runtime/bundle identities")
	}
	if err := verifyInstallationBundle(bundle, marker, selected); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*appliance.Manifest){
		func(m *appliance.Manifest) { m.ImageVersion = "other" },
		func(m *appliance.Manifest) { m.BuildID = "other" },
		func(m *appliance.Manifest) { m.SourceCommit = "other" },
		func(m *appliance.Manifest) { m.DiskLayoutVersion = 4 },
		func(m *appliance.Manifest) { m.StateSchemaMax = 3 },
		func(m *appliance.Manifest) { m.ReleaseSet = nil },
	} {
		other := marker
		change(&other)
		if verifyInstallationBundle(bundle, other, selected) == nil {
			t.Fatal("accepted different running System")
		}
	}
	if verifyInstallationBundle(runtime, marker, selected) == nil || verifyInstallationBundle(append(bundle, ' '), marker, selected) == nil {
		t.Fatal("accepted runtime marker or altered signed bytes as external manifest")
	}
}

func TestInstallationBundleConvergedImageUsesExactCachedBundle(t *testing.T) {
	root := t.TempDir()
	oldInstalled, oldSnapshot := deploymentInstalledBundlePath, deploymentBundleSnapshotPath
	t.Cleanup(func() { deploymentInstalledBundlePath, deploymentBundleSnapshotPath = oldInstalled, oldSnapshot })
	deploymentInstalledBundlePath, deploymentBundleSnapshotPath = filepath.Join(root, "old-image.json"), filepath.Join(root, "snapshot.json")
	if err := os.WriteFile(deploymentInstalledBundlePath, []byte("old signed installation media"), 0600); err != nil {
		t.Fatal(err)
	}
	marker := appliance.Manifest{ImageVersion: "1.1.0", SourceCommit: "new source", DiskLayoutVersion: 3}
	bundle := installationBundleFixture(t, marker)
	digest := fmt.Sprintf("%x", sha256.Sum256(bundle))
	selected := releasecache.InstallationSet{Source: "https://code.example.test/owner/YouEye", Appliance: releasecache.InstallationImage{Tag: "appliance-v1.1.0", ManifestSHA256: digest}}
	cache := filepath.Join(root, "cache")
	if err := os.MkdirAll(filepath.Join(cache, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	endpoint := selected.Source + "/releases/download/" + selected.Appliance.Tag + "/appliance-manifest.json"
	index, _ := json.Marshal(map[string]any{"schema": "youeye.release-cache.v1", "objects": map[string]any{endpoint: map[string]any{"sha256": digest, "bytes": len(bundle)}}})
	for path, raw := range map[string][]byte{filepath.Join(cache, "index.json"): index, filepath.Join(cache, "objects", digest): bundle} {
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("YOUEYE_RELEASE_CACHE", cache)
	if err := verifySelectedManifest(marker, selected); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(cache); err != nil {
		t.Fatal(err)
	}
	if err := verifySelectedManifest(marker, selected); err != nil {
		t.Fatalf("retry fetched instead of using authenticated snapshot: %v", err)
	}
	if err := os.WriteFile(deploymentBundleSnapshotPath, []byte("corrupted snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	if verifySelectedManifest(marker, selected) == nil {
		t.Fatal("corrupt frozen snapshot accepted")
	}
}
