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
	if privateForgejoMainRelease(release) {
		return embeddedApplianceDevelopmentTrust, nil
	}
	if strings.HasPrefix(release.TagName, "appliance-v") {
		return publicReleaseAnchor("stable")
	}
	if strings.HasPrefix(release.TagName, "appliance-beta-v") {
		return publicReleaseAnchor("beta")
	}
	return embeddedApplianceDevelopmentTrust, nil
}
