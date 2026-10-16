package releasecache

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestProductPromotionPreservesOriginalBuildAuthority(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	releasePublic, releasePrivate, _ := ed25519.GenerateKey(rand.Reader)
	releaseDER, _ := x509.MarshalPKIXPublicKey(releasePublic)
	for _, product := range []string{"pointer", "market", "canvas", "cinema", "notes", "search", "translate", "weather", "wiki"} {
		t.Run(product, func(t *testing.T) {
			source := "https://github.com/YouEye-Platform/" + product
			b := ProductBuild{Schema: "youeye.product-build.v1", Product: product, Kind: "source", BuildVersion: "0.5.40-beta.1", Source: source, Branch: "beta", SourceCommit: strings.Repeat("a", 40), Tag: ProductTag(product, "beta", "0.5.40-beta.1"), InputSHA256: strings.Repeat("b", 64), ContractSHA256: strings.Repeat("c", 64), SignerSHA256: productDigest(der), Primary: "source.tar.gz"}
			b.Assets = []CoreBlob{{Name: b.Primary, URL: source + "/releases/download/" + b.Tag + "/" + b.Primary, SHA256: strings.Repeat("d", 64), SizeBytes: 42}}
			buildRaw, _ := json.Marshal(b)
			buildSig := ed25519.Sign(private, buildRaw)
			r := ProductRelease{Schema: "youeye.product-release.v1", Product: product, Version: "0.5.40-alpha.1", Source: "https://forge.example.test/owner/" + product, Branch: "main", Channel: "alpha", Sequence: 10, MinimumReader: 1, SignerSHA256: productDigest(releaseDER), BuildManifestBase64: base64.StdEncoding.EncodeToString(buildRaw), BuildSignatureBase64: base64.StdEncoding.EncodeToString(buildSig)}
			for _, channel := range []string{"alpha", "beta", "stable"} {
				if channel == "beta" {
					r.Source = source
					r.Branch = "beta"
					r.Version = "0.5.40-beta.2"
				}
				if channel == "stable" {
					r.Branch = "main"
					r.Version = "0.5.40"
				}
				r.Channel = channel
				r.Tag = ProductTag(product, r.Branch, r.Version)
				r.Sequence++
				raw, _ := json.Marshal(r)
				sig := ed25519.Sign(releasePrivate, raw)
				_, got, _, err := VerifyProductRelease(raw, sig, releasePublic, public)
				if err != nil || got.Assets[0] != b.Assets[0] || got.SourceCommit != b.SourceCommit {
					t.Fatal("promotion changed original bytes", channel, err)
				}
				if _, _, _, err = VerifyProductRelease(raw, sig, releasePublic, releasePublic); err == nil {
					t.Fatal("release authority replaced original build authority")
				}
			}
			b.Source = "https://private.example.test/owner/" + product
			b.Assets[0].URL = b.Source + "/releases/download/" + b.Tag + "/" + b.Primary
			buildRaw, _ = json.Marshal(b)
			r.BuildManifestBase64 = base64.StdEncoding.EncodeToString(buildRaw)
			r.BuildSignatureBase64 = base64.StdEncoding.EncodeToString(ed25519.Sign(private, buildRaw))
			if r.Validate() == nil {
				t.Fatal("Stable wrapper laundered a private build")
			}
		})
	}
}
