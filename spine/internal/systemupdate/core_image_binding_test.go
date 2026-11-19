package systemupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// bindImageForTest records, under root (a core-update State directory), that
// the appliance member of r stands for image: what a box holds once it has
// seen the release's bundle manifest.
func bindImageForTest(t *testing.T, root string, r releasecache.CoreRelease, image appliance.Manifest) {
	t.Helper()
	member, err := coreApplianceMember(r)
	if err != nil {
		t.Fatal(err)
	}
	binding := CoreImageBinding{Schema: coreImageBindingSchema, ApplianceSHA256: member.Artifact.SHA256,
		ImageVersion: image.ImageVersion, BuildID: image.BuildID, SourceTree: member.SourceTree}
	if err := (CoreImageBinder{Root: root}).save(binding); err != nil {
		t.Fatal(err)
	}
}

// imageBindingFixture is a release whose appliance member is a real bundle
// manifest for the returned image, in the shape with or without build names.
func imageBindingFixture(t *testing.T, withBuildNames bool) (releasecache.CoreRelease, appliance.Manifest, []byte) {
	t.Helper()
	name := "core-release-no-build.json"
	if withBuildNames {
		name = "core-release.json"
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	// The image keeps its own identity: an image build name that no document
	// field repeats.
	image := testApplianceManifest("0.6.7-dev.1", r.SourceTree)
	bundle, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, BuildID: image.BuildID, SourceTree: image.SourceTree, ReleaseSet: *image.ReleaseSet})
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].Artifact.SHA256, r.Members[i].Artifact.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(bundle)), int64(len(bundle))
		}
	}
	return r, image, bundle
}

// The document binds the bundle manifest by digest, the bundle names the
// image, and the running image must be that image. Build names in the
// document take no part, in either shape.
func TestCoreImageIsBoundThroughTheBundleManifest(t *testing.T) {
	for _, withBuildNames := range []bool{true, false} {
		t.Run(fmt.Sprintf("build names %v", withBuildNames), func(t *testing.T) {
			r, image, bundle := imageBindingFixture(t, withBuildNames)
			dir := t.TempDir()
			installed := filepath.Join(dir, "installer", "appliance-manifest.json")
			if err := atomicWrite(installed, bundle, 0600); err != nil {
				t.Fatal(err)
			}
			binder := CoreImageBinder{Root: filepath.Join(dir, "core-update"), InstalledBundle: installed}
			if err := binder.Bind(r, image); err != nil {
				t.Fatal(err)
			}
			member, _ := r.Member("appliance")
			raw, err := os.ReadFile(binder.path(member.Artifact.SHA256))
			if err != nil || !strings.Contains(string(raw), `"image_version":"0.6.7-dev.1"`) || !strings.Contains(string(raw), `"build_id":"build-0.6.7-dev.1"`) {
				t.Fatalf("binding not kept on State: %s %v", raw, err)
			}
			// The record alone is enough afterwards (the cache and the
			// installer's copy may be gone).
			recorded := CoreImageBinder{Root: binder.Root}
			if err := recorded.Bind(r, image); err != nil {
				t.Fatal(err)
			}
			// A release that reuses the image has the same appliance member,
			// whatever its own name and its other members.
			later := r
			later.Version, later.Tag, later.Sequence = "0.6.14", "youeye-v0.6.14", r.Sequence+10
			if err := recorded.Bind(later, image); err != nil {
				t.Fatal("a release reusing the image is not bound:", err)
			}
			for name, change := range map[string]func(*appliance.Manifest){
				"another image version": func(m *appliance.Manifest) { m.ImageVersion = "0.6.7-dev.2" },
				"another build":         func(m *appliance.Manifest) { m.BuildID = "build-other" },
				"another tree":          func(m *appliance.Manifest) { m.SourceTree = strings.Repeat("9", 40) },
				"no release set":        func(m *appliance.Manifest) { m.ReleaseSet = nil },
			} {
				other := image
				change(&other)
				if err := recorded.Bind(r, other); err == nil {
					t.Errorf("%s: bound", name)
				}
			}
		})
	}
}

func TestCoreImageBindingIsNeverGuessedFromNames(t *testing.T) {
	r, image, bundle := imageBindingFixture(t, true)
	dir := t.TempDir()
	// The old rule: the appliance member's build name equals the image
	// version. Without the bundle manifest that is not a binding.
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].BuildVersion = image.ImageVersion
		}
	}
	binder := CoreImageBinder{Root: filepath.Join(dir, "core-update"), CacheRoot: filepath.Join(dir, "cache"), InstalledBundle: filepath.Join(dir, "installer", "appliance-manifest.json")}
	if err := binder.Bind(r, image); !errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("an image was bound by its name: %v", err)
	}
	// A bundle manifest with other bytes (another image's) is not this
	// release's, wherever it lies.
	other := append(append([]byte{}, bundle...), ' ')
	member, _ := r.Member("appliance")
	blob := filepath.Join(binder.CacheRoot, "blobs", member.Artifact.SHA256)
	for _, path := range []string{binder.InstalledBundle, blob} {
		if err := atomicWrite(path, other, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := binder.Bind(r, image); !errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("a foreign bundle manifest bound the image: %v", err)
	}
	// The update cache holds the digest-checked member: that is a binding,
	// and it is recorded.
	if err := atomicWrite(blob, bundle, 0600); err != nil {
		t.Fatal(err)
	}
	if err := binder.Bind(r, image); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(binder.path(member.Artifact.SHA256)); err != nil {
		t.Fatal("binding from the cache was not kept:", err)
	}
	// A record that names another member, or cannot be read, is not trusted;
	// it is derived again.
	if err := os.Remove(blob); err != nil {
		t.Fatal(err)
	}
	for _, damaged := range []string{`{"schema":"youeye.core-image-binding.v1","appliance_sha256":"` + strings.Repeat("0", 64) + `","image_version":"0.6.7-dev.1","build_id":"build-0.6.7-dev.1","source_tree":"` + image.SourceTree + `"}`, `{`} {
		if err := atomicWrite(binder.path(member.Artifact.SHA256), []byte(damaged), 0600); err != nil {
			t.Fatal(err)
		}
		if err := binder.Bind(r, image); !errors.Is(err, ErrCoreImageBindingUnknown) {
			t.Fatalf("a damaged record was trusted: %v", err)
		}
	}
	// A digest-checked bundle whose tree is not the member's tree is refused
	// outright (not "unknown"): the document contradicts its own member.
	wrong, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, BuildID: image.BuildID, SourceTree: strings.Repeat("9", 40), ReleaseSet: *image.ReleaseSet})
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].Artifact.SHA256, r.Members[i].Artifact.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(wrong)), int64(len(wrong))
		}
	}
	member, _ = r.Member("appliance")
	if err := atomicWrite(filepath.Join(binder.CacheRoot, "blobs", member.Artifact.SHA256), wrong, 0600); err != nil {
		t.Fatal(err)
	}
	if err := binder.Bind(r, image); err == nil || errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("a bundle of another tree: %v", err)
	}
	// So is a bundle manifest without a build id.
	incomplete, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, SourceTree: image.SourceTree, ReleaseSet: *image.ReleaseSet})
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].Artifact.SHA256, r.Members[i].Artifact.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(incomplete)), int64(len(incomplete))
		}
	}
	member, _ = r.Member("appliance")
	if err := atomicWrite(filepath.Join(binder.CacheRoot, "blobs", member.Artifact.SHA256), incomplete, 0600); err != nil {
		t.Fatal(err)
	}
	if err := binder.Bind(r, image); err == nil || errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("a bundle without a build id: %v", err)
	}
}

// verify-members makes sure the image of the installed and of the target
// release is on record. When neither State nor the cache has the bundle
// manifest (an older Spine staged the release), the appliance member alone is
// downloaded, checked against the document and recorded.
func TestCoreImageBindingIsRetainedBeforeAnUpdate(t *testing.T) {
	r, image, bundle := imageBindingFixture(t, false)
	repository := useBoxRepository(t)
	member, _ := r.Member("appliance")
	// The appliance member also names its build inputs; the cache keeps a
	// member's blobs together.
	inputs := []byte(`{"inputs":"exact"}`)
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].BuildInputs = &releasecache.CoreBlob{Name: "build-inputs.json", SHA256: checksum(inputs), SizeBytes: int64(len(inputs))}
		}
	}
	raw, _ := json.Marshal(r)
	digest := checksum(raw)
	dir := t.TempDir()
	m := CoreManager{Root: filepath.Join(dir, "core-update")}
	if err := m.retainSelection(CoreHostSelection{Raw: raw}, digest); err != nil {
		t.Fatal(err)
	}
	requested := []string{}
	serve := true
	runtime := NativeCoreRuntime{Root: m.Root, Cache: CoreArtifactCache{Root: filepath.Join(dir, "data", "cache"),
		AvailableBytes: func(string) (uint64, error) { return 1 << 40, nil },
		Client: &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			requested = append(requested, req.URL.String())
			data := map[string][]byte{
				releasecache.AssetURL(repository, "", r.Tag, member.Artifact):                                  bundle,
				releasecache.AssetURL(repository, "", r.Tag, releasecache.CoreBlob{Name: "build-inputs.json"}): inputs,
			}[req.URL.String()]
			if data == nil || !serve {
				return nil, fmt.Errorf("undeclared or unavailable URL %s", req.URL)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
		})}}}
	// Unreachable release host and nothing on the box: the request stops at
	// verify-members, before anything is staged.
	serve = false
	if err := runtime.ensureImageBinding(context.Background(), digest); err == nil {
		t.Fatal("an image without a binding passed")
	}
	if err := runtime.imageBinder().Bind(r, image); !errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("bound without a bundle manifest: %v", err)
	}
	serve = true
	if err := runtime.ensureImageBinding(context.Background(), digest); err != nil {
		t.Fatal(err)
	}
	if len(requested) == 0 {
		t.Fatal("the appliance member was not downloaded")
	}
	for _, url := range requested {
		if !strings.HasSuffix(url, "/"+member.Artifact.Name) && !strings.HasSuffix(url, "/build-inputs.json") {
			t.Fatalf("another member was downloaded: %s", url)
		}
	}
	// On record now: no download, and the host manager (which has no cache)
	// binds from State alone.
	requested = nil
	if err := runtime.ensureImageBinding(context.Background(), digest); err != nil || len(requested) != 0 {
		t.Fatal("a recorded binding was fetched again:", err, requested)
	}
	if err := (CoreImageBinder{Root: m.Root}).Bind(r, image); err != nil {
		t.Fatal(err)
	}
}

// After the reboot into a new image the first steps bind the running image.
// The Spine that staged the release may have kept no record (one up to 0.6.11
// keeps none) and the cache may have been cleared since: host-health then
// downloads the appliance member again, checks it against the document and
// records it, so neither it nor commit-host is stranded.
func TestCoreImageBindingIsFetchedAgainAfterTheReboot(t *testing.T) {
	r, image, bundle := imageBindingFixture(t, true)
	repository := useBoxRepository(t)
	member, _ := r.Member("appliance")
	// The cache keeps a member's blobs together: its build inputs come along.
	inputs := []byte(`{"inputs":"exact"}`)
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			r.Members[i].BuildInputs = &releasecache.CoreBlob{Name: "build-inputs.json", SHA256: checksum(inputs), SizeBytes: int64(len(inputs))}
		}
	}
	raw, _ := json.Marshal(r)
	digest := checksum(raw)
	dir := t.TempDir()
	m := CoreManager{Root: filepath.Join(dir, "core-update")}
	if err := m.retainSelection(CoreHostSelection{Raw: raw}, digest); err != nil {
		t.Fatal(err)
	}
	j := CoreJournal{RequestID: "after-reboot", ManifestSHA256: digest, Target: r, RestartRequired: true}
	requested := []string{}
	served := bundle
	healthRuns := 0
	var runtime NativeCoreRuntime
	runtime = NativeCoreRuntime{Root: m.Root, Cache: CoreArtifactCache{Root: filepath.Join(dir, "data", "cache"),
		AvailableBytes: func(string) (uint64, error) { return 1 << 40, nil },
		Client: &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			requested = append(requested, req.URL.String())
			data := map[string][]byte{
				releasecache.AssetURL(repository, "", r.Tag, member.Artifact):                                  served,
				releasecache.AssetURL(repository, "", r.Tag, releasecache.CoreBlob{Name: "build-inputs.json"}): inputs,
			}[req.URL.String()]
			if data == nil || served == nil {
				return nil, fmt.Errorf("undeclared or unavailable URL %s", req.URL)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
		})}},
		// What the appliance's host health does first: bind the running image.
		HostHealth: func(_ context.Context, j CoreJournal) (string, error) {
			healthRuns++
			if err := runtime.imageBinder().Bind(j.Target, image); err != nil {
				return "", err
			}
			return "selected immutable host", nil
		}}
	step := CoreStep{Name: "host-health"}
	stateOnly := CoreImageBinder{Root: m.Root}

	// The release host is unreachable: the step fails as it did before, and
	// may run again.
	served = nil
	if _, err := runtime.execute(context.Background(), j, step); err == nil || healthRuns != 0 {
		t.Fatalf("host health ran without an image identity: %v (%d runs)", err, healthRuns)
	}
	// Other bytes under the member's name are not the document's member.
	served = append([]byte{}, bundle...)
	served[len(served)-2] ^= 1
	if _, err := runtime.execute(context.Background(), j, step); err == nil || healthRuns != 0 {
		t.Fatalf("a bundle manifest that differs from the document was accepted: %v", err)
	}
	if err := stateOnly.Bind(r, image); !errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("a binding was recorded from an unchecked file: %v", err)
	}
	// Reachable: the appliance member alone is downloaded, and the step passes.
	served, requested = bundle, nil
	result, err := runtime.execute(context.Background(), j, step)
	if err != nil || result.State != "succeeded" || healthRuns != 1 {
		t.Fatalf("host health after a cleared cache: %+v %v (%d runs)", result, err, healthRuns)
	}
	if len(requested) == 0 {
		t.Fatal("the appliance member was not downloaded")
	}
	for _, url := range requested {
		if !strings.HasSuffix(url, "/"+member.Artifact.Name) && !strings.HasSuffix(url, "/build-inputs.json") {
			t.Fatalf("another member was downloaded: %s", url)
		}
	}
	// The record is on State now: commit-host (a host manager, no cache) binds
	// by it, also when the cache is cleared again and the release host and the
	// retained document are gone.
	if err := os.RemoveAll(runtime.Cache.Root); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(m.Root, "targets", digest+".json")); err != nil {
		t.Fatal(err)
	}
	served, requested = nil, nil
	if err := stateOnly.Bind(r, image); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ensureTargetImageBinding(context.Background(), j); err != nil || len(requested) != 0 {
		t.Fatalf("a recorded binding needed the network or the document: %v %v", err, requested)
	}
	if result, err := runtime.execute(context.Background(), j, step); err != nil || result.State != "succeeded" || healthRuns != 2 {
		t.Fatalf("host health with a recorded binding: %+v %v", result, err)
	}
	// Another image under the same record is still refused.
	other := image
	other.BuildID = "build-of-another-image"
	if err := stateOnly.Bind(r, other); err == nil || errors.Is(err, ErrCoreImageBindingUnknown) {
		t.Fatalf("another image passed: %v", err)
	}
}
