package installer

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

// coreAnswerSelection carries the exact core-release.json bytes. Base64
// preserves them across answer JSON formatting; the digest is the authority.
type coreAnswerSelection struct {
	ManifestBase64 string `json:"manifest_base64"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

func coreAnswerFromRelease(release applianceRelease) *coreAnswerSelection {
	return &coreAnswerSelection{ManifestBase64: base64.StdEncoding.EncodeToString(release.coreRaw), ManifestSHA256: release.coreSHA256}
}

// coreAnswerSource derives the exact repository URL from a release policy.
func coreAnswerSource(policy applianceReleasePolicy) (string, error) {
	provider, api, err := normalizeApplianceReleaseSource(policy.Provider, policy.ReleasesAPI)
	if err != nil {
		return "", err
	}
	parts := strings.Split(strings.Trim(api.Path, "/"), "/")
	if provider == "github" && len(parts) == 4 {
		return "https://github.com/" + parts[1] + "/" + parts[2], nil
	}
	if provider == "custom" && len(parts) == 6 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "repos" {
		return api.Scheme + "://" + api.Host + "/" + parts[3] + "/" + parts[4], nil
	}
	return "", fmt.Errorf("core release source must be an exact supported repository")
}

func decodeCoreAnswer(c *coreAnswerSelection) (releasecache.CoreRelease, []byte, error) {
	if c == nil || len(c.ManifestBase64) > ((1<<20)+2)/3*4 || !validSHA256Hex(c.ManifestSHA256) {
		return releasecache.CoreRelease{}, nil, fmt.Errorf("core answer requires one bounded exact selection")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(c.ManifestBase64)
	if err != nil {
		return releasecache.CoreRelease{}, nil, err
	}
	r, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return r, nil, err
	}
	if digest != c.ManifestSHA256 {
		return r, nil, fmt.Errorf("core answer manifest digest differs")
	}
	return r, raw, nil
}

func validateCoreAnswer(answer applianceAnswer) error {
	c := answer.CoreRelease
	if c == nil || answer.ReleasePolicy.CoreManifestSHA256 != c.ManifestSHA256 {
		return fmt.Errorf("core answer requires one exact selection bound by the release policy")
	}
	r, _, err := decodeCoreAnswer(c)
	if err != nil {
		return err
	}
	policy := answer.ReleasePolicy
	source, err := coreAnswerSource(policy)
	if err != nil {
		return err
	}
	if r.Source != source {
		return fmt.Errorf("core answer source differs from selected repository")
	}
	if policy.Mode == "exact" && policy.ExactTag != r.Tag {
		return fmt.Errorf("core answer differs from exact release policy")
	}
	if policy.Mode == "track" {
		if branch := coreTrackBranch(policy.Track, policy.Branch); r.Branch != branch {
			return fmt.Errorf("core answer differs from selected branch")
		}
	}
	return nil
}

// coreTrackBranch maps a release track to the source branch its core release
// documents must name. Spine applies the same rule to the recorded policy.
func coreTrackBranch(track, branch string) string {
	switch track {
	case "stable":
		return "main"
	case "development", "dev":
		return "dev"
	}
	return branch
}
