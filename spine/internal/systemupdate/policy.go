package systemupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const ReleasePolicySchema = "youeye.release-policy.v1"

type ReleasePolicy struct {
	ServiceSelection   string `json:"service_selection,omitempty"`
	Schema             string `json:"schema"`
	Provider           string `json:"provider"`
	ReleasesAPI        string `json:"releases_api,omitempty"`
	Mode               string `json:"mode"`
	Track              string `json:"track,omitempty"`
	Branch             string `json:"branch,omitempty"`
	ExactTag           string `json:"exact_tag,omitempty"`
	ManifestSHA256     string `json:"manifest_sha256,omitempty"`
	CoreManifestSHA256 string `json:"core_manifest_sha256,omitempty"`
	Freshness          string `json:"freshness"`
}

type exactBundleManifest struct {
	Schema       string               `json:"schema"`
	ImageVersion string               `json:"image_version"`
	SourceCommit string               `json:"source_commit"`
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
		return ReleasePolicy{}, fmt.Errorf("read first-boot release policy: %w", err)
	}
	var policy ReleasePolicy
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return ReleasePolicy{}, fmt.Errorf("decode first-boot release policy: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ReleasePolicy{}, errors.New("first-boot release policy contains trailing JSON")
	}
	if err := policy.Validate(); err != nil {
		return ReleasePolicy{}, err
	}
	return policy, nil
}

func (policy ReleasePolicy) Validate() error {
	if policy.Schema != ReleasePolicySchema {
		return fmt.Errorf("unsupported first-boot release policy schema %q", policy.Schema)
	}
	if policy.ServiceSelection != "" && policy.ServiceSelection != "sealed" && policy.ServiceSelection != "current" {
		return fmt.Errorf("service selection must be sealed or current")
	}
	// Every installation records the exact core-release.json it accepted. That
	// digest is the root of trust for every installed artifact.
	if !validSHA256(policy.CoreManifestSHA256) {
		return errors.New("release policy requires the exact lowercase core-release.json SHA-256")
	}
	if policy.Freshness != "require-current" && policy.Freshness != "prefer-current" {
		return errors.New("first-boot freshness must be require-current or prefer-current")
	}
	provider := strings.ToLower(strings.TrimSpace(policy.Provider))
	if _, _, err := normalizeReleaseSource(provider, policy.ReleasesAPI); err != nil {
		return err
	}
	switch policy.Mode {
	case "track":
		if policy.ExactTag != "" || policy.ManifestSHA256 != "" {
			return errors.New("tracking first-boot policy cannot include an exact identity")
		}
		switch policy.Track {
		case "stable", "development":
			if policy.Branch != "" {
				return errors.New("Stable and Development tracks cannot include a branch")
			}
		case "branch":
			if !validReleaseBranch(policy.Branch) {
				return errors.New("branch track requires a safe release branch")
			}
		default:
			return errors.New("first-boot track must be stable, development, or branch")
		}
	case "exact":
		core := strings.HasPrefix(policy.ExactTag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(policy.ExactTag, "youeye-v"))
		if !core || policy.Track != "" || policy.Branch != "" || !validSHA256(policy.ManifestSHA256) {
			return errors.New("Exact release policy requires a youeye-v release tag and lowercase appliance-manifest SHA-256")
		}
	default:
		return errors.New("first-boot release policy mode must be track or exact")
	}
	return nil
}
