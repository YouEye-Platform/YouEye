package installer

import (
	"encoding/base64"
	"fmt"

	"github.com/youeye-platform/YouEye/releasecache"
)

// coreAnswerSelection carries the exact core-release.json bytes. Base64
// preserves them across answer JSON formatting; the digest is the authority.
type coreAnswerSelection struct {
	ManifestBase64 string `json:"manifest_base64"`
	ManifestSHA256 string `json:"manifest_sha256"`
	// DownloadBase: where the release's files live (channel index
	// download_base); recorded on State for first deployment.
	DownloadBase string `json:"download_base,omitempty"`
}

func coreAnswerFromRelease(release applianceRelease) *coreAnswerSelection {
	return &coreAnswerSelection{ManifestBase64: base64.StdEncoding.EncodeToString(release.coreRaw), ManifestSHA256: release.coreSHA256, DownloadBase: release.DownloadBase}
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
	if _, _, err := decodeCoreAnswer(c); err != nil {
		return err
	}
	if c.DownloadBase != "" && !releasecache.ValidDownloadBase(c.DownloadBase) {
		return fmt.Errorf("core answer download_base must be an HTTPS URL with a lowercase host, no query and no trailing slash")
	}
	return validateApplianceReleasePolicy(answer.ReleasePolicy)
}
