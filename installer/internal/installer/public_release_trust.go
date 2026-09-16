package installer

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// Only public keys installed in the exact source can authorize a public release.
//
//go:embed public-release-trust.json
var publicReleaseTrustJSON []byte

func publicReleaseAnchor(class string) ([]byte, error) {
	var policy struct {
		Schema string            `json:"schema"`
		Keys   map[string]string `json:"keys"`
	}
	if (class != "beta" && class != "stable") || json.Unmarshal(publicReleaseTrustJSON, &policy) != nil || policy.Schema != "youeye.public-trust.v1" || policy.Keys[class] == "" {
		return nil, fmt.Errorf("public %s trust is not provisioned in this Installer", class)
	}
	raw := []byte(policy.Keys[class])
	if _, err := parseEd25519PublicKey(raw); err != nil {
		return nil, err
	}
	return raw, nil
}
func applianceReleaseAnchor(release applianceRelease) ([]byte, error) {
	if class := applianceReleaseTrustClass(release); class != "development" {
		return publicReleaseAnchor(class)
	}
	return embeddedApplianceDevelopmentTrust, nil
}

func applianceReleaseTrustClass(release applianceRelease) string {
	if !privateForgejoMainRelease(release) {
		if strings.HasPrefix(release.TagName, "appliance-v") {
			return "stable"
		}
		if strings.HasPrefix(release.TagName, "appliance-beta-v") {
			return "beta"
		}
	}
	return "development"
}
