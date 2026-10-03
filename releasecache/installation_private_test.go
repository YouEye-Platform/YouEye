package releasecache

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func privateInstallationFixture() *InstallationSet {
	s := installationFixture()
	s.Source = "https://forge.example.test/owner/YouEye"
	s.Appliance.Version += ".0.1"
	s.Appliance.Tag = "appliance-v" + s.Appliance.Version
	s.ControlPanel.Version += ".0.2"
	s.ControlPanel.Tag = "cp-v" + s.ControlPanel.Version
	s.UI.Version += ".0.1"
	s.UI.Tag = "ui-v" + s.UI.Version
	return s
}
func TestPrivateInstallationAuthorityAndIdentity(t *testing.T) {
	policy, catalog, key := distributionFixture(t)
	catalog.Channel = "repository-main"
	catalog.Repositories = map[string]DistributionRepository{}
	catalog.Installation = privateInstallationFixture()
	raw := signDistribution(catalog, key)
	if s, e := VerifyPinnedInstallation(raw, "repository-main", policy.Keys["stable"]); e != nil || s.ControlPanel.SourceCommit == s.Appliance.SourceCommit {
		t.Fatalf("independent selection: %v", e)
	}
	for name, mutate := range map[string]func(*DistributionCatalog){
		"public metadata": func(c *DistributionCatalog) {
			c.Repositories["YouEye"] = DistributionRepository{Releases: []json.RawMessage{}}
		},
		"wrong source scheme": func(c *DistributionCatalog) { c.Installation.Source = "http://forge.example.test/owner/YouEye" },
		"source credentials": func(c *DistributionCatalog) {
			c.Installation.Source = "https://user:pass@forge.example.test/owner/YouEye"
		},
		"public impersonation": func(c *DistributionCatalog) { c.Installation.Source = "https://github.com/YouEye-Platform/YouEye" },
		"wrong source path":    func(c *DistributionCatalog) { c.Installation.Source += "/releases" },
		"source query":         func(c *DistributionCatalog) { c.Installation.Source += "?x=y" },
		"cross channel": func(c *DistributionCatalog) {
			c.Installation.ControlPanel.Tag = "cp-dev-v" + c.Installation.ControlPanel.Version
		},
		"missing baked identity": func(c *DistributionCatalog) { c.Installation.Appliance.SpineSHA256 = "" },
		"floating commit":        func(c *DistributionCatalog) { c.Installation.ControlPanel.SourceCommit = "main" },
		"bad digest":             func(c *DistributionCatalog) { c.Installation.UI.ArtifactSHA256 = strings.Repeat("z", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := catalog
			bad.Repositories = map[string]DistributionRepository{}
			bad.Installation = privateInstallationFixture()
			mutate(&bad)
			if _, e := VerifyPinnedInstallation(signDistribution(bad, key), "repository-main", policy.Keys["stable"]); e == nil {
				t.Fatal("invalid private selection accepted")
			}
		})
	}
	if _, e := VerifyPinnedInstallation(raw, "stable", policy.Keys["stable"]); e == nil {
		t.Fatal("private envelope accepted as official public")
	}
	_, _, wrongKey := distributionFixture(t)
	if _, e := VerifyPinnedInstallation(signDistribution(catalog, wrongKey), "repository-main", policy.Keys["stable"]); e == nil {
		t.Fatal("wrong signer accepted")
	}
	raw[len(raw)/2] ^= 1
	if _, e := VerifyPinnedInstallation(raw, "repository-main", policy.Keys["stable"]); e == nil {
		t.Fatal("corrupted envelope accepted")
	}
	// Immutable private selections retain their accepted identity after publication;
	// freshness for mutable public catalogs remains enforced by VerifyDistribution.
	catalog.IssuedAt = time.Now().Add(-90 * 24 * time.Hour)
	catalog.ExpiresAt = catalog.IssuedAt.Add(30 * 24 * time.Hour)
	if _, e := VerifyPinnedInstallation(signDistribution(catalog, key), "repository-main", policy.Keys["stable"]); e != nil {
		t.Fatal(e)
	}
	if _, _, e := VerifyDistribution(signDistribution(catalog, key), "repository-main", policy.Keys["stable"], time.Now()); e == nil {
		t.Fatal("expired live catalog accepted")
	}
}
