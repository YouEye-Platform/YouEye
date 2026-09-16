package systemupdate

import (
	"crypto/ed25519"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"fmt"
)

//go:embed public-release-trust.json
var publicReleaseTrustJSON []byte

func publicReleaseKey(class string) (ed25519.PublicKey, error) {
	var policy struct {
		Schema string            `json:"schema"`
		Keys   map[string]string `json:"keys"`
	}
	if (class != "beta" && class != "stable") || json.Unmarshal(publicReleaseTrustJSON, &policy) != nil || policy.Schema != "youeye.public-trust.v1" || policy.Keys[class] == "" {
		return nil, fmt.Errorf("public %s trust is not provisioned in this updater", class)
	}
	block, _ := pem.Decode([]byte(policy.Keys[class]))
	if block == nil {
		return nil, fmt.Errorf("invalid public trust anchor")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	key, ok := parsed.(ed25519.PublicKey)
	if err != nil || !ok {
		return nil, fmt.Errorf("invalid public trust anchor")
	}
	return key, nil
}
