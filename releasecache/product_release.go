package releasecache

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// ProductBuild describes immutable product inputs and all original output
// envelopes. It is signed once, before any channel promotion. Package-manager
// versions remain build identity, independently of ProductRelease.Version.
type ProductBuild struct {
	Schema         string     `json:"schema"`
	Product        string     `json:"product"`
	Kind           string     `json:"kind"`
	BuildVersion   string     `json:"build_version"`
	Source         string     `json:"source"`
	Branch         string     `json:"branch"`
	SourceCommit   string     `json:"source_commit"`
	Tag            string     `json:"tag"`
	InputSHA256    string     `json:"input_sha256"`
	ContractSHA256 string     `json:"contract_sha256"`
	SignerSHA256   string     `json:"signer_sha256"`
	Primary        string     `json:"primary"`
	Assets         []CoreBlob `json:"assets"`
}

type ProductRelease struct {
	Schema                 string `json:"schema"`
	Product                string `json:"product"`
	Version                string `json:"version"`
	Source                 string `json:"source"`
	Branch                 string `json:"branch"`
	Tag                    string `json:"tag"`
	Channel                string `json:"channel"`
	Sequence               uint64 `json:"sequence"`
	PreviousManifestSHA256 string `json:"previous_manifest_sha256,omitempty"`
	MinimumReader          int    `json:"minimum_reader"`
	SignerSHA256           string `json:"signer_sha256"`
	BuildManifestBase64    string `json:"build_manifest_base64"`
	BuildSignatureBase64   string `json:"build_signature_base64"`
}

func ProductTag(product, branch, version string) string {
	prefix := ""
	if product == "market" {
		prefix = "catalog-"
	}
	if branch != "main" {
		prefix += branch + "-"
	}
	return prefix + "v" + version
}
func validIndependentProduct(p string) bool {
	switch p {
	case "pointer", "market", "canvas", "cinema", "notes", "search", "translate", "weather", "wiki":
		return true
	}
	return false
}
func ProductBuildChannel(b ProductBuild) (string, error) {
	v := coreVersionPattern.FindStringSubmatch(b.BuildVersion)
	if v == nil {
		return "", fmt.Errorf("invalid product build version")
	}
	if strings.HasPrefix(b.Source, "https://github.com/") {
		if b.Branch == "main" && v[4] == "" {
			return "stable", nil
		}
		if b.Branch == "beta" && v[4] == "beta" {
			return "beta", nil
		}
		return "", fmt.Errorf("public product build has no scoped original authority")
	}
	if b.Branch == "main" && v[4] == "alpha" {
		return "alpha", nil
	}
	if b.Branch == "dev" && v[4] == "dev" {
		return "dev", nil
	}
	return "feature", nil
}
func (b ProductBuild) Validate() error {
	if b.Schema != "youeye.product-build.v1" || !validIndependentProduct(b.Product) || !ValidCoreVersion(b.BuildVersion) || !ValidCoreBranch(b.Branch) || !installationCommit.MatchString(b.SourceCommit) || !installationHash.MatchString(b.InputSHA256) || !installationHash.MatchString(b.ContractSHA256) || !installationHash.MatchString(b.SignerSHA256) || b.Tag != ProductTag(b.Product, b.Branch, b.BuildVersion) {
		return fmt.Errorf("invalid immutable product build identity")
	}
	if _, err := coreSource(b.Source); err != nil {
		return err
	}
	if _, err := ProductBuildChannel(b); err != nil {
		return err
	}
	if b.Kind != "native" && b.Kind != "source" && b.Kind != "catalog" {
		return fmt.Errorf("unsupported product artifact kind")
	}
	if len(b.Assets) == 0 || len(b.Assets) > 32 {
		return fmt.Errorf("invalid product asset set")
	}
	names := map[string]bool{}
	for _, a := range b.Assets {
		if names[a.Name] {
			return fmt.Errorf("duplicate product asset")
		}
		names[a.Name] = true
		if err := a.validate(b.Source, b.Tag); err != nil {
			return err
		}
	}
	if !names[b.Primary] {
		return fmt.Errorf("primary product artifact is missing")
	}
	if b.Kind == "native" {
		for _, name := range []string{"standalone.tar", "SHA256SUMS", "SHA256SUMS.sig", "provenance.json", "sbom.spdx.json"} {
			if !names[name] {
				return fmt.Errorf("native product envelope is incomplete")
			}
		}
		if b.Primary != "standalone.tar" {
			return fmt.Errorf("native product primary differs")
		}
	}
	return nil
}
func (r ProductRelease) Build() (ProductBuild, []byte, []byte, error) {
	raw, err := base64.StdEncoding.Strict().DecodeString(r.BuildManifestBase64)
	if err != nil {
		return ProductBuild{}, nil, nil, err
	}
	sig, err := base64.StdEncoding.Strict().DecodeString(r.BuildSignatureBase64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ProductBuild{}, nil, nil, fmt.Errorf("invalid immutable build signature encoding")
	}
	b, _, err := ParseProductBuild(raw)
	return b, raw, sig, err
}
func (r ProductRelease) Validate() error {
	if r.Schema != "youeye.product-release.v1" || !validIndependentProduct(r.Product) || !ValidCoreVersion(r.Version) || !ValidCoreBranch(r.Branch) || r.Tag != ProductTag(r.Product, r.Branch, r.Version) || r.MinimumReader != 1 || r.Sequence == 0 || r.Sequence > 9007199254740991 || !installationHash.MatchString(r.SignerSHA256) || r.PreviousManifestSHA256 != "" && !installationHash.MatchString(r.PreviousManifestSHA256) {
		return fmt.Errorf("invalid product release identity")
	}
	if _, err := coreSource(r.Source); err != nil {
		return err
	}
	expected, err := ProductBuildChannel(ProductBuild{Source: r.Source, Branch: r.Branch, BuildVersion: r.Version})
	if err != nil || expected != r.Channel {
		return fmt.Errorf("product release channel differs from its authority")
	}
	b, _, _, err := r.Build()
	if err != nil {
		return err
	}
	if b.Product != r.Product {
		return fmt.Errorf("release references another product")
	}
	if r.Channel == "stable" || r.Channel == "beta" {
		if b.Source != r.Source {
			return fmt.Errorf("public product references private or foreign build")
		}
	}
	return nil
}
func parseProductDocument(raw []byte, value any) error {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return fmt.Errorf("product metadata exceeds bounds")
	}
	if err := uniqueCoreJSON(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return fmt.Errorf("trailing product metadata")
	}
	return nil
}
func productDigest(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func ParseProductBuild(raw []byte) (ProductBuild, string, error) {
	var b ProductBuild
	if err := parseProductDocument(raw, &b); err != nil {
		return b, "", err
	}
	if err := b.Validate(); err != nil {
		return b, "", err
	}
	return b, productDigest(raw), nil
}
func ParseProductRelease(raw []byte) (ProductRelease, string, error) {
	var r ProductRelease
	if err := parseProductDocument(raw, &r); err != nil {
		return r, "", err
	}
	if err := r.Validate(); err != nil {
		return r, "", err
	}
	return r, productDigest(raw), nil
}
func productSignature(raw, sig []byte, key ed25519.PublicKey, fingerprint string) error {
	if len(key) != ed25519.PublicKeySize {
		return fmt.Errorf("scoped product key required")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}
	if productDigest(der) != fingerprint || len(sig) != ed25519.SignatureSize || !ed25519.Verify(key, raw, sig) {
		return fmt.Errorf("product signature rejected")
	}
	return nil
}

// Both authorities are resolved independently by the caller's current policy.
// A release signature cannot grant itself the original build's signing scope.
func VerifyProductRelease(raw, sig []byte, releaseKey, buildKey ed25519.PublicKey) (ProductRelease, ProductBuild, string, error) {
	r, digest, err := ParseProductRelease(raw)
	if err != nil {
		return r, ProductBuild{}, "", err
	}
	if err = productSignature(raw, sig, releaseKey, r.SignerSHA256); err != nil {
		return r, ProductBuild{}, "", err
	}
	b, buildRaw, buildSig, err := r.Build()
	if err != nil {
		return r, b, "", err
	}
	if err = productSignature(buildRaw, buildSig, buildKey, b.SignerSHA256); err != nil {
		return r, b, "", err
	}
	return r, b, digest, nil
}
