package systemupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const ReleasePolicySchema = "youeye.release-policy.v1"

// ReleasePolicy is written by the installer into protected State. Repository
// never changes after installation; Channel changes only through
// `youeye channel set`. CoreManifestSHA256 is the digest of the
// core-release.json the installer installed: the root of trust.
type ReleasePolicy struct {
	Schema             string `json:"schema"`
	Repository         string `json:"repository"`
	Channel            string `json:"channel"`
	CoreManifestSHA256 string `json:"core_manifest_sha256"`
	ServiceSelection   string `json:"service_selection,omitempty"`
}

type exactBundleManifest struct {
	Schema       string               `json:"schema"`
	ImageVersion string               `json:"image_version"`
	SourceTree   string               `json:"source_tree"`
	ReleaseSet   appliance.ReleaseSet `json:"release_set"`
}

type ConvergenceResult struct {
	Schema          string `json:"schema"`
	Action          string `json:"action"`
	SelectedTag     string `json:"selected_tag,omitempty"`
	ManifestSHA256  string `json:"manifest_sha256,omitempty"`
	CurrentImage    string `json:"current_image"`
	TargetImage     string `json:"target_image"`
	Bridge          bool   `json:"bridge"`
	RebootRequested bool   `json:"reboot_requested"`
	Status          Status `json:"status"`
}

func LoadReleasePolicy(path string) (ReleasePolicy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ReleasePolicy{}, fmt.Errorf("read release policy: %w", err)
	}
	var policy ReleasePolicy
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return ReleasePolicy{}, fmt.Errorf("decode release policy: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ReleasePolicy{}, errors.New("release policy contains trailing JSON")
	}
	if err := policy.Validate(); err != nil {
		return ReleasePolicy{}, err
	}
	return policy, nil
}

func (policy ReleasePolicy) Validate() error {
	if policy.Schema != ReleasePolicySchema {
		return fmt.Errorf("unsupported release policy schema %q", policy.Schema)
	}
	if repository, err := releasecache.CanonicalRepository(policy.Repository); err != nil || repository != policy.Repository {
		return errors.New("release policy repository must be a canonical https://host/owner/repository URL")
	}
	if !releasecache.ValidChannel(policy.Channel) {
		return fmt.Errorf("release policy channel must be dev, alpha, beta or stable")
	}
	if !validSHA256(policy.CoreManifestSHA256) {
		return errors.New("release policy requires the exact lowercase core-release.json SHA-256")
	}
	if policy.ServiceSelection != "" && policy.ServiceSelection != "sealed" && policy.ServiceSelection != "current" {
		return fmt.Errorf("service selection must be sealed or current")
	}
	return nil
}

// SaveReleasePolicy replaces the protected policy atomically.
func SaveReleasePolicy(path string, policy ReleasePolicy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(policy, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(raw, '\n'), 0600)
}

// BoxRepository is the repository this box follows, from its protected policy.
// Tests replace it.
var BoxRepository = func() (string, error) {
	policy, err := LoadReleasePolicy(filepath.Join(CoreBootstrapPath, "release-policy.json"))
	if err != nil {
		return "", err
	}
	return policy.Repository, nil
}

// CoreBlobURL locates a blob of release r in the box's repository.
func CoreBlobURL(r releasecache.CoreRelease, blob releasecache.CoreBlob) (string, error) {
	repository, err := BoxRepository()
	if err != nil {
		return "", err
	}
	return releasecache.AssetURL(repository, r.Tag, blob), nil
}
