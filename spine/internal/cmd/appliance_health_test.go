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

// An installed Control Panel or UI is the release member's when its artifact
// digest is the member's and it was built from the member's git tree. A tree
// built before 0.6.12 says no tree: it is compared by version with the
// member's build name, which only documents up to 0.6.12 carry.
func TestValidateInstalledReleaseIdentityBindsTreeAndDigest(t *testing.T) {
	digest, tree := strings.Repeat("a", 64), strings.Repeat("1", 40)
	oldShape := appliance.ComponentRelease{Version: "0.6.1-dev.1", SourceTree: tree, ArtifactSHA256: digest}
	newShape := appliance.ComponentRelease{SourceTree: tree, ArtifactSHA256: digest}
	for name, c := range map[string]struct {
		expected  appliance.ComponentRelease
		installed installedReleaseIdentity
		ok        bool
	}{
		"old tree, old document":               {oldShape, installedReleaseIdentity{Version: "0.6.1-dev.1", ArtifactSHA256: digest}, true},
		"old tree of another build":            {oldShape, installedReleaseIdentity{Version: "0.6.1-dev.2", ArtifactSHA256: digest}, false},
		"old tree, document without names":     {newShape, installedReleaseIdentity{Version: "0.6.1-dev.1", ArtifactSHA256: digest}, false},
		"tree decides over the version shown":  {oldShape, installedReleaseIdentity{Version: "0.6.1", SourceTree: tree, ArtifactSHA256: digest}, true},
		"tree, document without names":         {newShape, installedReleaseIdentity{Version: "0.6.13", SourceTree: tree, ArtifactSHA256: digest}, true},
		"another tree under the member's name": {oldShape, installedReleaseIdentity{Version: "0.6.1-dev.1", SourceTree: strings.Repeat("2", 40), ArtifactSHA256: digest}, false},
		"another digest":                       {newShape, installedReleaseIdentity{Version: "0.6.13", SourceTree: tree, ArtifactSHA256: strings.Repeat("b", 64)}, false},
		"no digest recorded":                   {newShape, installedReleaseIdentity{Version: "0.6.13", SourceTree: tree}, false},
		"nothing readable":                     {oldShape, installedReleaseIdentity{ArtifactSHA256: digest}, false},
	} {
		if err := validateInstalledReleaseIdentity("Server interface", c.expected, c.installed); (err == nil) != c.ok {
			t.Errorf("%s: %v", name, err)
		}
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
