package cmd

import (
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestNormalizeApplianceHealthProfile(t *testing.T) {
	for _, profile := range []string{"structural", " recovery ", "OPERATIONAL"} {
		if _, err := normalizeApplianceHealthProfile(profile); err != nil {
			t.Fatalf("profile %q was rejected: %v", profile, err)
		}
	}
	if _, err := normalizeApplianceHealthProfile("offline"); err == nil {
		t.Fatal("unknown health profile was accepted")
	}
}

func TestValidateInstalledReleaseIdentityBindsVersionTagBranchAndDigest(t *testing.T) {
	digest := strings.Repeat("a", 64)
	expected := appliance.ComponentRelease{Version: "0.5.22.1", Tag: "cp-dev-v0.5.22.1", ArtifactSHA256: digest}
	installed := installedReleaseIdentity{Version: expected.Version, Tag: expected.Tag, Branch: "dev", ArtifactSHA256: digest}
	if err := validateInstalledReleaseIdentity("Server interface", expected, "dev", installed); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*installedReleaseIdentity){
		"version": func(value *installedReleaseIdentity) { value.Version = "0.5.22.2" },
		"tag":     func(value *installedReleaseIdentity) { value.Tag = "cp-dev-v0.5.22.2" },
		"branch":  func(value *installedReleaseIdentity) { value.Branch = "main" },
		"digest":  func(value *installedReleaseIdentity) { value.ArtifactSHA256 = strings.Repeat("b", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := installed
			mutate(&candidate)
			if err := validateInstalledReleaseIdentity("Server interface", expected, "dev", candidate); err == nil {
				t.Fatal("mismatched installed provenance was accepted")
			}
		})
	}
}

func TestFirstDeployReleaseComponentsUseDeployedPackagePaths(t *testing.T) {
	components := firstDeployReleaseComponents(appliance.ReleaseSet{})
	if len(components) != 2 {
		t.Fatalf("component count = %d, want 2", len(components))
	}
	if components[0].container != "youeye-control" || components[0].appDir != "/opt/app" {
		t.Fatalf("Control Panel package path = %s:%s, want youeye-control:/opt/app", components[0].container, components[0].appDir)
	}
	if components[1].container != "youeye-ui" || components[1].appDir != "/opt/youeye-ui" {
		t.Fatalf("UI package path = %s:%s, want youeye-ui:/opt/youeye-ui", components[1].container, components[1].appDir)
	}
}

func TestAggregateApplianceHealthStableExitCodes(t *testing.T) {
	for _, tc := range []struct {
		checks []applianceHealthCheck
		status string
		code   int
	}{
		{[]applianceHealthCheck{{Status: "pass"}}, "healthy", healthExitHealthy},
		{[]applianceHealthCheck{{Status: "pass"}, {Status: "warn"}}, "degraded", healthExitDegraded},
		{[]applianceHealthCheck{{Status: "warn"}, {Status: "fail"}}, "unhealthy", healthExitUnhealthy},
	} {
		status, code := aggregateApplianceHealth(tc.checks)
		if status != tc.status || code != tc.code {
			t.Errorf("aggregate=%s,%d want %s,%d", status, code, tc.status, tc.code)
		}
	}
}

func TestMountOptionsContainUsesExactTokens(t *testing.T) {
	if !mountOptionsContain("rw,relatime,ro", "ro") {
		t.Fatal("expected ro")
	}
	if mountOptionsContain("rw,errors=remount-ro", "ro") {
		t.Fatal("must not match remount-ro")
	}
}
