package installer

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

// Base64 preserves the exact signed bytes across answer JSON formatting.
type coreAnswerSelection struct {
	ManifestBase64  string `json:"manifest_base64"`
	SignatureBase64 string `json:"signature_base64"`
	ManifestSHA256  string `json:"manifest_sha256"`
}

func coreAnswerFromRelease(release applianceRelease) *coreAnswerSelection {
	return &coreAnswerSelection{ManifestBase64: base64.StdEncoding.EncodeToString(release.coreRaw), SignatureBase64: base64.StdEncoding.EncodeToString(release.coreSignature), ManifestSHA256: release.coreSHA256}
}

func validateCoreAnswer(answer applianceAnswer) error {
	c := answer.CoreRelease
	if c == nil || len(c.ManifestBase64) > ((1<<20)+2)/3*4 || len(c.SignatureBase64) != 88 || !validSHA256Hex(c.ManifestSHA256) || answer.ReleasePolicy.CoreManifestSHA256 != c.ManifestSHA256 {
		return fmt.Errorf("core answer requires one bounded exact signed selection")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(c.ManifestBase64)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.Strict().DecodeString(c.SignatureBase64)
	if err != nil {
		return err
	}
	r, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil || digest != c.ManifestSHA256 {
		return fmt.Errorf("core answer manifest digest differs")
	}
	policy := answer.ReleasePolicy
	provider, api, err := normalizeApplianceReleaseSource(policy.Provider, policy.ReleasesAPI)
	if err != nil {
		return err
	}
	parts := strings.Split(strings.Trim(api.Path, "/"), "/")
	source := ""
	if provider == "github" && len(parts) == 4 {
		source = "https://github.com/" + parts[1] + "/" + parts[2]
	}
	if provider == "custom" && len(parts) == 6 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "repos" {
		source = api.Scheme + "://" + api.Host + "/" + parts[3] + "/" + parts[4]
	}
	if source == "" || r.Source != source {
		return fmt.Errorf("core answer source differs from selected repository")
	}
	trust := embeddedApplianceDevelopmentTrust
	if provider == "github" {
		trust, err = publicReleaseAnchor(r.Channel)
		if err != nil {
			return err
		}
	}
	key, err := parseEd25519PublicKey(trust)
	if err != nil {
		return err
	}
	if _, _, err := releasecache.VerifyCoreRelease(raw, sig, key); err != nil {
		return err
	}
	if policy.Mode == "exact" && policy.ExactTag != r.Tag {
		return fmt.Errorf("core answer differs from exact release policy")
	}
	if policy.Mode == "track" {
		branch := policy.Branch
		if policy.Track == "stable" {
			branch = "main"
		}
		if policy.Track == "development" {
			branch = "dev"
		}
		if r.Branch != branch {
			return fmt.Errorf("core answer differs from selected branch")
		}
	}
	return nil
}
