package systemupdate

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

const CoreBootstrapPath = "/var/lib/youeye-state/bootstrap"
const CoreStatePath = "/var/lib/youeye-state/core-update"
const CoreDevelopmentTrustPath = "/usr/share/youeye/appliance-development.pub"

var coreTrustLookup = updatetrust.Lookup

// CoreRoleKey resolves current authority for the exact source, raw branch and
// role. Assembly authority never grants a CP publisher permission to sign host
// bytes. A revoked enrollment is an error and cannot fall back to baked trust.
func CoreRoleKey(source, branch, channel, role, developmentKeyPath string) (ed25519.PublicKey, error) {
	scope := "appliance"
	switch role {
	case "cp", "ui", "spine":
		scope = role
	case "assembly", "installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap":
	default:
		return nil, fmt.Errorf("unknown core authority scope")
	}
	grant, err := coreTrustLookup(source, branch, scope)
	if err != nil {
		return nil, err
	}
	if grant != nil {
		return updatetrust.Key(grant.PublicKey)
	}
	if strings.HasPrefix(source, "https://github.com/") {
		if source != releasecache.OfficialRepository || (channel != "stable" && channel != "beta") || (channel == "stable" && branch != "main") || (channel == "beta" && branch != "beta") {
			return nil, fmt.Errorf("core source has no provisioned public authority")
		}
		return publicReleaseKey(channel)
	}
	return readPublicKey(developmentKeyPath)
}

func CoreMemberKey(member releasecache.CoreMember, assemblyChannel, developmentKeyPath string) (ed25519.PublicKey, error) {
	channel, err := releasecache.CoreMemberChannel(member, assemblyChannel)
	if err != nil {
		return nil, err
	}
	return CoreRoleKey(member.Source, member.Branch, channel, member.Role, developmentKeyPath)
}

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

func VerifyCoreSelection(raw, signature []byte, developmentKeyPath string) (releasecache.CoreRelease, string, error) {
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return r, "", err
	}
	key, err := CoreRoleKey(r.Source, r.Branch, r.Channel, "assembly", developmentKeyPath)
	if err != nil {
		return r, "", err
	}
	return releasecache.VerifyCoreRelease(raw, signature, key)
}

func ReadCoreSelection(root, developmentKeyPath string) (releasecache.CoreRelease, string, error) {
	raw, err := ReadCoreState(filepath.Join(root, "core-release.json"), 1<<20)
	if err != nil {
		return releasecache.CoreRelease{}, "", err
	}
	sig, err := ReadCoreState(filepath.Join(root, "core-release.json.sig"), ed25519.SignatureSize)
	if err != nil {
		return releasecache.CoreRelease{}, "", err
	}
	return VerifyCoreSelection(raw, sig, developmentKeyPath)
}

func ValidateCorePolicy(policy ReleasePolicy, r releasecache.CoreRelease, digest string) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	if policy.CoreManifestSHA256 != digest {
		return fmt.Errorf("core selection differs from frozen release policy")
	}
	_, api, err := normalizeReleaseSource(policy.Provider, policy.ReleasesAPI)
	if err != nil {
		return err
	}
	parts := strings.Split(strings.Trim(api.Path, "/"), "/")
	source := ""
	if policy.Provider == "github" && len(parts) == 4 {
		source = "https://github.com/" + parts[1] + "/" + parts[2]
	}
	if policy.Provider == "custom" && len(parts) == 6 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "repos" {
		source = api.Scheme + "://" + api.Host + "/" + parts[3] + "/" + parts[4]
	}
	if source == "" || r.Source != source {
		return fmt.Errorf("core selection differs from selected repository")
	}
	if policy.Mode == "exact" {
		if policy.ExactTag != r.Tag {
			return fmt.Errorf("core selection differs from exact policy tag")
		}
	} else {
		branch := policy.Branch
		if policy.Track == "stable" {
			branch = "main"
		}
		if policy.Track == "development" {
			branch = "dev"
		}
		if r.Branch != branch {
			return fmt.Errorf("core selection differs from selected raw branch")
		}
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
			if member.BuildVersion != image.ImageVersion || member.SourceCommit != image.SourceCommit || member.Source != image.ReleaseSet.Source || member.Branch != image.ReleaseSet.Branch {
				return fmt.Errorf("core host member differs from running immutable image")
			}
		case "spine":
			c := image.ReleaseSet.Spine
			if member.Artifact.SHA256 != c.ArtifactSHA256 || member.SourceCommit != c.SourceCommit || member.BuildVersion != c.Version {
				return fmt.Errorf("core Spine member differs from baked binary")
			}
		}
	}
	return nil
}

// VerifyCoreInstalledMedia is the exact fresh-media gate, before service
// deployment. It checks the signed bundle and running immutable image against
// the selected assembly without claiming that CP/UI are already installed.
func VerifyCoreInstalledMedia(policy ReleasePolicy, root, imagePath, bundlePath, bundleSignaturePath, developmentKeyPath string) (ConvergenceResult, error) {
	r, digest, err := ReadCoreSelection(root, developmentKeyPath)
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
	if member.Artifact.SHA256 != bundleDigest || member.Artifact.SizeBytes != int64(len(bundleRaw)) || policy.Mode == "exact" && policy.ManifestSHA256 != bundleDigest {
		return ConvergenceResult{}, fmt.Errorf("core selection differs from installed signed bundle")
	}
	sig, err := ReadCoreState(bundleSignaturePath, ed25519.SignatureSize)
	if err != nil {
		return ConvergenceResult{}, err
	}
	key, err := CoreMemberKey(member, r.Channel, developmentKeyPath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	id := fmt.Sprintf("%x", sha256.Sum256(der))
	if err != nil || member.KeyID != id || member.DocumentSignature == nil || member.DocumentSignature.SizeBytes != int64(len(sig)) || member.DocumentSignature.SHA256 != fmt.Sprintf("%x", sha256.Sum256(sig)) || !ed25519.Verify(key, bundleRaw, sig) {
		return ConvergenceResult{}, fmt.Errorf("installed bundle role signature rejected")
	}
	var bundle exactBundleManifest
	if json.Unmarshal(bundleRaw, &bundle) != nil || bundle.Schema != "youeye.appliance.manifest.v1" || bundle.ImageVersion != image.ImageVersion || bundle.SourceCommit != image.SourceCommit || !reflect.DeepEqual(bundle.ReleaseSet, *image.ReleaseSet) {
		return ConvergenceResult{}, fmt.Errorf("installed bundle differs from sealed image provenance")
	}
	status := Status{Schema: StatusSchema, State: PhaseHealthy, CurrentImage: image.ImageVersion, RunningImage: image.ImageVersion, TargetImage: image.ImageVersion}
	return ConvergenceResult{Schema: "youeye.first-boot-convergence.v1", Action: "core-media-current", SelectedTag: r.Tag, ManifestSHA256: digest, CurrentImage: image.ImageVersion, TargetImage: image.ImageVersion, Status: status}, nil
}

// CheckCoreMemberAuthority checks revocation/current role identity without
// re-downloading payloads whose complete envelope was already verified at stage.
func CheckCoreMemberAuthority(member releasecache.CoreMember, channel, trustPath string) error {
	key, err := CoreMemberKey(member, channel, trustPath)
	if err != nil {
		return err
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}
	if fmt.Sprintf("%x", sha256.Sum256(der)) != member.KeyID {
		return fmt.Errorf("current core role authority differs from staged member")
	}
	return nil
}
