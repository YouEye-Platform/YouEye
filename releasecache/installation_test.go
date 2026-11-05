package releasecache

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func installationFixture() *InstallationSet {
	return &InstallationSet{Schema: "youeye.installation.v1", Source: "https://github.com/YouEye-Platform/YouEye",
		Appliance:    InstallationImage{Version: "0.5.13", Tag: "appliance-v0.5.13", SourceCommit: strings.Repeat("a", 40), ManifestSHA256: strings.Repeat("b", 64), SpineSHA256: strings.Repeat("c", 64)},
		ControlPanel: InstallationComponent{Version: "0.5.31", Tag: "cp-v0.5.31", SourceCommit: strings.Repeat("d", 40), ArtifactSHA256: strings.Repeat("e", 64)},
		UI:           InstallationComponent{Version: "0.5.10", Tag: "ui-v0.5.10", SourceCommit: strings.Repeat("f", 40), ArtifactSHA256: strings.Repeat("1", 64)}}
}

func TestInstallationSnapshotIndependentServices(t *testing.T) {
	t.Setenv("YOUEYE_DISTRIBUTION_STATE", t.TempDir())
	policy, catalog, key := distributionFixture(t)
	catalog.Installation = installationFixture()
	// A CP-only release can retain the image and UI identities from older commits.
	raw := signDistribution(catalog, key)
	calls := 0
	transport := distributionRT(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != policy.Origin+"/v1/stable.json" {
			return nil, fmt.Errorf("unexpected network request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})
	got, err := InstallationSnapshot(context.Background(), transport, policy, "stable")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) || calls != 1 {
		t.Fatal("signed snapshot not retained exactly")
	}
	verified, _, err := VerifyDistribution(got, "stable", policy.Keys["stable"], time.Now())
	if err != nil || verified.Installation.ControlPanel.Tag != "cp-v0.5.31" {
		t.Fatalf("%+v %v", verified, err)
	}
}

func TestInstallationIdentityRejectsUntrustedMixes(t *testing.T) {
	for name, mutate := range map[string]func(*InstallationSet){
		"source":             func(s *InstallationSet) { s.Source = "https://github.com/other/YouEye" },
		"schema":             func(s *InstallationSet) { s.Schema = "unknown" },
		"cross-channel":      func(s *InstallationSet) { s.ControlPanel.Tag = "cp-beta-v0.5.31" },
		"wrong-component":    func(s *InstallationSet) { s.UI.Tag = "cp-v0.5.10" },
		"floating-image":     func(s *InstallationSet) { s.Appliance.SourceCommit = "main" },
		"missing-image-hash": func(s *InstallationSet) { s.Appliance.ManifestSHA256 = "" },
		"missing-spine-hash": func(s *InstallationSet) { s.Appliance.SpineSHA256 = "" },
		"bad-service-hash":   func(s *InstallationSet) { s.UI.ArtifactSHA256 = strings.Repeat("z", 64) },
		"ambiguous-version":  func(s *InstallationSet) { s.UI.Version = "00.5.10"; s.UI.Tag = "ui-v00.5.10" },
	} {
		t.Run(name, func(t *testing.T) {
			policy, catalog, key := distributionFixture(t)
			catalog.Installation = installationFixture()
			mutate(catalog.Installation)
			if _, _, err := VerifyDistribution(signDistribution(catalog, key), "stable", policy.Keys["stable"], time.Now()); err == nil {
				t.Fatal("invalid signed installation accepted")
			}
		})
	}
}

func TestInstallationSnapshotMissingSelectionFailsClosed(t *testing.T) {
	t.Setenv("YOUEYE_DISTRIBUTION_STATE", t.TempDir())
	policy, catalog, key := distributionFixture(t)
	raw := signDistribution(catalog, key)
	transport := distributionRT(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})
	if _, err := InstallationSnapshot(context.Background(), transport, policy, "stable"); err == nil {
		t.Fatal("missing selection accepted")
	}
	// Older distribution consumers still accept catalogs without this extension.
	var envelope DistributionEnvelope
	if json.Unmarshal(raw, &envelope) != nil {
		t.Fatal("invalid fixture")
	}
	if _, _, err := VerifyDistribution(raw, "stable", policy.Keys["stable"], time.Now()); err != nil {
		t.Fatal(err)
	}
}
