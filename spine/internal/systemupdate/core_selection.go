package systemupdate

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const CoreBootstrapPath = "/var/lib/youeye-state/bootstrap"
const CoreStatePath = "/var/lib/youeye-state/core-update"

// ReadCoreState accepts only bounded, protected, regular state files. It never
// treats a malformed or unreadable selected manifest as a legacy installation.
func ReadCoreState(path string, limit int64) ([]byte, error) {
	if limit <= 0 || limit > 1<<30 {
		return nil, fmt.Errorf("invalid core state limit")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || int(stat.Uid) != os.Geteuid() || info.Size() <= 0 || info.Size() > limit {
		return nil, fmt.Errorf("unsafe protected core state")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || int64(len(raw)) != info.Size() || int64(len(raw)) > limit || !after.ModTime().Equal(info.ModTime()) || after.Size() != info.Size() {
		return nil, fmt.Errorf("protected core state changed during read")
	}
	return raw, nil
}

// ReadCoreSelection reads the protected installer-recorded core release and
// binds it to the exact digest in the release policy stored beside it. That
// digest, fetched over HTTPS and recorded by the installer, is the root of
// trust for every member artifact.
func ReadCoreSelection(root string) (releasecache.CoreRelease, string, error) {
	_, r, digest, err := ReadAcceptedCoreSelection(root)
	return r, digest, err
}

// ReadCoreBootstrapSelection reads the installer-recorded bytes without a
// policy binding. Callers must compare its digest with an accepted record.
func ReadCoreBootstrapSelection(root string) (CoreHostSelection, error) {
	raw, err := ReadCoreState(filepath.Join(root, "core-release.json"), 1<<20)
	if err != nil {
		return CoreHostSelection{}, err
	}
	if _, _, err := releasecache.ParseCoreRelease(raw); err != nil {
		return CoreHostSelection{}, err
	}
	return CoreHostSelection{Raw: raw}, nil
}

// ReadAcceptedCoreSelection reads the installer-recorded release and requires
// its digest to equal the protected release policy's core_manifest_sha256.
func ReadAcceptedCoreSelection(root string) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	selection, err := ReadCoreBootstrapSelection(root)
	if err != nil {
		return selection, releasecache.CoreRelease{}, "", err
	}
	r, digest, err := releasecache.ParseCoreRelease(selection.Raw)
	if err != nil {
		return selection, r, "", err
	}
	policy, err := LoadReleasePolicy(filepath.Join(root, "release-policy.json"))
	if err != nil {
		return selection, r, "", err
	}
	if policy.CoreManifestSHA256 != digest {
		return selection, r, "", fmt.Errorf("core selection differs from the accepted release digest")
	}
	return selection, r, digest, nil
}

// PolicyCoreSelection is what the box follows: the repository and channel in
// its protected, installer-written policy. No configuration writable through
// the Spine API (and so by the Control Panel) participates.
func PolicyCoreSelection(root string) (CoreReleaseSelection, error) {
	policy, err := LoadReleasePolicy(filepath.Join(root, "release-policy.json"))
	if err != nil {
		return CoreReleaseSelection{}, err
	}
	return CoreReleaseSelection{Repository: policy.Repository, Channel: policy.Channel}, nil
}

func ValidateCorePolicy(policy ReleasePolicy, r releasecache.CoreRelease, digest string) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	if policy.CoreManifestSHA256 != digest {
		return fmt.Errorf("core selection differs from frozen release policy")
	}
	return nil
}

// BindCoreImage checks immutable media identity independently of the complete
// installed release. Service-only selections may keep an older host version.
func BindCoreImage(r releasecache.CoreRelease, image appliance.Manifest) error {
	if image.ReleaseSet == nil {
		return fmt.Errorf("core selection requires sealed image provenance")
	}
	for _, member := range r.Members {
		switch member.Role {
		case "appliance":
			if member.BuildVersion != image.ImageVersion || member.SourceTree != image.SourceTree {
				return fmt.Errorf("core host member differs from running immutable image")
			}
		case "spine":
			c := image.ReleaseSet.Spine
			if member.Artifact.SHA256 != c.ArtifactSHA256 || member.SourceTree != c.SourceTree || member.BuildVersion != c.Version {
				return fmt.Errorf("core Spine member differs from baked binary")
			}
		}
	}
	return nil
}

// VerifyCoreInstalledMedia is the exact fresh-media gate, before service
// deployment. It checks the digest-bound bundle and running immutable image
// against the selected release without claiming that CP/UI are installed.
func VerifyCoreInstalledMedia(policy ReleasePolicy, root, imagePath, bundlePath string) (ConvergenceResult, error) {
	r, digest, err := ReadCoreSelection(root)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if err := ValidateCorePolicy(policy, r, digest); err != nil {
		return ConvergenceResult{}, err
	}
	imageRaw, err := os.ReadFile(imagePath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	image, err := appliance.ParseManifest(imageRaw)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if err := BindCoreImage(r, image); err != nil {
		return ConvergenceResult{}, err
	}
	var member releasecache.CoreMember
	for _, m := range r.Members {
		if m.Role == "appliance" {
			member = m
		}
	}
	bundleRaw, err := ReadCoreState(bundlePath, 1<<20)
	if err != nil {
		return ConvergenceResult{}, err
	}
	bundleDigest := fmt.Sprintf("%x", sha256.Sum256(bundleRaw))
	if member.Artifact.SHA256 != bundleDigest || member.Artifact.SizeBytes != int64(len(bundleRaw)) {
		return ConvergenceResult{}, fmt.Errorf("core selection differs from installed bundle")
	}
	var bundle exactBundleManifest
	if json.Unmarshal(bundleRaw, &bundle) != nil || bundle.Schema != "youeye.appliance.manifest.v1" || bundle.ImageVersion != image.ImageVersion || bundle.SourceTree != image.SourceTree || !reflect.DeepEqual(bundle.ReleaseSet, *image.ReleaseSet) {
		return ConvergenceResult{}, fmt.Errorf("installed bundle differs from sealed image provenance")
	}
	status := Status{Schema: StatusSchema, State: PhaseHealthy, CurrentImage: image.ImageVersion, RunningImage: image.ImageVersion, TargetImage: image.ImageVersion}
	return ConvergenceResult{Schema: "youeye.first-boot-convergence.v1", Action: "core-media-current", SelectedTag: r.Tag, ManifestSHA256: digest, CurrentImage: image.ImageVersion, TargetImage: image.ImageVersion, Status: status}, nil
}
