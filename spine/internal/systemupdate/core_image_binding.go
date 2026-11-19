package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// How a release is tied to the image a slot runs.
//
// The release document binds its appliance member (the image bundle's
// appliance-manifest.json) by SHA-256. That manifest names the image:
// image_version, build_id and source_tree. The running image's own sealed
// marker must name the same three. No build name in the document takes part:
// a document may have none, and the image keeps its own identity.
//
// A slot cannot hold the digest of its own bundle manifest, so the three
// values are recorded on State once, when the digest-checked manifest is at
// hand (the installed bundle of a fresh install, the update cache at
// verify-members), under the manifest's digest:
// core-update/image-bindings/<appliance sha256>.json. Releases that reuse an
// image share the record. A missing record is derived again from those same
// two places; nothing else can create one. The update engine fills the cache
// again when it has to (ensureImageBinding): before staging, and after the
// reboot into a new image, where the Spine up to 0.6.11 that staged the
// release left no record and the cache alone would decide.

const coreImageBindingSchema = "youeye.core-image-binding.v1"

// CoreInstalledBundlePath is the bundle manifest the installer left on State.
const CoreInstalledBundlePath = appliance.StateMountpoint + "/installer/appliance-manifest.json"

// CoreUpdateCachePath is the update cache on Data (blobs by digest).
const CoreUpdateCachePath = appliance.DataMountpoint + "/cache/core-update"

// ErrCoreImageBindingUnknown: this box holds no digest-checked bundle manifest
// for the release's appliance member, so the image cannot be judged.
var ErrCoreImageBindingUnknown = errors.New("the image identity of this release is not recorded on this box")

// CoreImageBinding is the image a release's appliance member stands for.
type CoreImageBinding struct {
	Schema          string `json:"schema"`
	ApplianceSHA256 string `json:"appliance_sha256"`
	ImageVersion    string `json:"image_version"`
	BuildID         string `json:"build_id"`
	SourceTree      string `json:"source_tree"`
}

func (b CoreImageBinding) valid() bool {
	return b.Schema == coreImageBindingSchema && validSHA256(b.ApplianceSHA256) && b.ImageVersion != "" && b.BuildID != "" && releasecache.ValidGitTree(b.SourceTree)
}

// CoreImageBinder reads and keeps image bindings. Root is the core-update
// State directory. CacheRoot (the update cache) and InstalledBundle (the
// installer's bundle manifest) are where a missing record may be derived from;
// either may be empty.
type CoreImageBinder struct {
	Root            string
	CacheRoot       string
	InstalledBundle string
}

// coreImageBinder is the binder of an installation whose core-update State is
// root. The installed appliance also has its installer bundle; a caller with a
// cache passes it.
func coreImageBinder(root, cacheRoot string) CoreImageBinder {
	b := CoreImageBinder{Root: root, CacheRoot: cacheRoot}
	if root == CoreStatePath {
		b.InstalledBundle = CoreInstalledBundlePath
		if b.CacheRoot == "" {
			b.CacheRoot = CoreUpdateCachePath
		}
	}
	return b
}

// InstalledCoreImageBinder is the binder of the installed appliance. Tests
// replace it.
var InstalledCoreImageBinder = func() CoreImageBinder { return coreImageBinder(CoreStatePath, "") }

// BindCoreImage checks that image is the image r's appliance member stands
// for, on the installed appliance. It is independent of the services: a
// service-only release keeps an older image, with the same appliance member.
func BindCoreImage(r releasecache.CoreRelease, image appliance.Manifest) error {
	return InstalledCoreImageBinder().Bind(r, image)
}

func (b CoreImageBinder) path(digest string) string {
	return filepath.Join(b.Root, "image-bindings", digest+".json")
}

// parseCoreImageBundle reads the three identity fields of a bundle manifest
// whose bytes the caller has already checked against the member's digest.
func parseCoreImageBundle(raw []byte, member releasecache.CoreMember) (CoreImageBinding, error) {
	var bundle exactBundleManifest
	if json.Unmarshal(raw, &bundle) != nil || bundle.Schema != "youeye.appliance.manifest.v1" {
		return CoreImageBinding{}, fmt.Errorf("appliance member is not an image bundle manifest")
	}
	binding := CoreImageBinding{Schema: coreImageBindingSchema, ApplianceSHA256: member.Artifact.SHA256,
		ImageVersion: bundle.ImageVersion, BuildID: bundle.BuildID, SourceTree: bundle.SourceTree}
	if !binding.valid() {
		return CoreImageBinding{}, fmt.Errorf("image bundle manifest has no complete image identity")
	}
	// The member's own tree is the image build's tree.
	if member.SourceTree != binding.SourceTree {
		return CoreImageBinding{}, fmt.Errorf("image bundle manifest differs from the release's appliance member")
	}
	return binding, nil
}

func coreApplianceMember(r releasecache.CoreRelease) (releasecache.CoreMember, error) {
	member, ok := r.Member("appliance")
	if !ok || !validSHA256(member.Artifact.SHA256) {
		return member, fmt.Errorf("core release has no appliance member")
	}
	return member, nil
}

// Binding returns the image r's appliance member stands for: the record on
// State, or one derived from a digest-checked bundle manifest on this box
// (and then recorded).
func (b CoreImageBinder) Binding(r releasecache.CoreRelease) (CoreImageBinding, error) {
	member, err := coreApplianceMember(r)
	if err != nil {
		return CoreImageBinding{}, err
	}
	if !filepath.IsAbs(b.Root) {
		return CoreImageBinding{}, fmt.Errorf("image binding requires the protected core state directory")
	}
	raw, err := ReadCoreState(b.path(member.Artifact.SHA256), 16384)
	if err == nil {
		var binding CoreImageBinding
		if json.Unmarshal(raw, &binding) == nil && binding.valid() && binding.ApplianceSHA256 == member.Artifact.SHA256 && binding.SourceTree == member.SourceTree {
			return binding, nil
		}
		// An unreadable record is not trusted; derive it again below.
	} else if !errors.Is(err, os.ErrNotExist) {
		return CoreImageBinding{}, err
	}
	candidates := []string{}
	if b.InstalledBundle != "" {
		candidates = append(candidates, b.InstalledBundle)
	}
	if b.CacheRoot != "" {
		if path, err := (CoreArtifactCache{Root: b.CacheRoot}).Path(member.Artifact); err == nil {
			candidates = append(candidates, path)
		}
	}
	for _, candidate := range candidates {
		raw, err := ReadCoreState(candidate, 1<<20)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != member.Artifact.SHA256 || int64(len(raw)) != member.Artifact.SizeBytes {
			continue
		}
		binding, err := parseCoreImageBundle(raw, member)
		if err != nil {
			return CoreImageBinding{}, err
		}
		// Keeping the record is what makes later checks independent of the
		// cache; a failed write leaves this check valid all the same.
		_ = b.save(binding)
		return binding, nil
	}
	return CoreImageBinding{}, fmt.Errorf("%w (appliance manifest %.12s)", ErrCoreImageBindingUnknown, member.Artifact.SHA256)
}

func (b CoreImageBinder) save(binding CoreImageBinding) error {
	raw, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	return atomicWrite(b.path(binding.ApplianceSHA256), append(raw, '\n'), 0600)
}

// Bind checks that image is the image r's appliance member stands for.
func (b CoreImageBinder) Bind(r releasecache.CoreRelease, image appliance.Manifest) error {
	if image.ReleaseSet == nil {
		return fmt.Errorf("core selection requires sealed image provenance")
	}
	binding, err := b.Binding(r)
	if err != nil {
		return err
	}
	if binding.ImageVersion != image.ImageVersion || binding.BuildID != image.BuildID || binding.SourceTree != image.SourceTree {
		return fmt.Errorf("core host member differs from running immutable image")
	}
	return nil
}

// imageBinder is the binder of the installation this host manager serves.
func (m *Manager) imageBinder() CoreImageBinder {
	return coreImageBinder(m.config.CoreStatePath, "")
}

func (r NativeCoreRuntime) imageBinder() CoreImageBinder {
	return coreImageBinder(r.Root, r.Cache.Root)
}

// ensureImageBinding makes sure the image of the release retained under digest
// is recorded on State. When no bundle manifest for it is on this box (an
// older Spine staged the release, or the cache was cleared), the appliance
// member is downloaded into the cache and checked against the document first.
func (r NativeCoreRuntime) ensureImageBinding(ctx context.Context, digest string) error {
	selection, release, err := (CoreManager{Root: r.Root}).Selection(digest)
	if err != nil {
		return err
	}
	binder := r.imageBinder()
	if _, err = binder.Binding(release); !errors.Is(err, ErrCoreImageBindingUnknown) {
		return err
	}
	if _, _, err = r.Cache.stage(ctx, selection, map[string]bool{"appliance": true}); err != nil {
		return fmt.Errorf("retain the release's image identity: %w", err)
	}
	_, err = binder.Binding(release)
	return err
}

// ensureTargetImageBinding is ensureImageBinding for the release a request
// installs, for the steps after the reboot into its image. A record on State
// (or a bundle manifest on the box) answers without the network and without
// the retained document; only when both are gone is the appliance member
// downloaded again, checked against the document retained for the request.
func (r NativeCoreRuntime) ensureTargetImageBinding(ctx context.Context, j CoreJournal) error {
	if _, err := r.imageBinder().Binding(j.Target); !errors.Is(err, ErrCoreImageBindingUnknown) {
		return err
	}
	return r.ensureImageBinding(ctx, j.ManifestSHA256)
}
