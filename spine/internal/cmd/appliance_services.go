package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var deploymentPolicyPath = "/var/lib/youeye-state/bootstrap/release-policy.json"

// selectApplianceServices leaves the sealed image identity intact. A
// core-release install selects services from its accepted release; any other
// install keeps the sealed pins.
func selectApplianceServices(manifest appliance.Manifest) (appliance.Manifest, error) {
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if errors.Is(err, os.ErrNotExist) {
		return manifest, nil
	}
	if err != nil {
		return manifest, err
	}
	if policy.CoreManifestSHA256 != "" {
		return selectCoreServices(manifest, policy)
	}
	if policy.ServiceSelection == "current" {
		return manifest, fmt.Errorf("current service selection requires a core release")
	}
	return manifest, pinDeploymentServices(manifest)
}

// Health checks consume the frozen selection without fetching or changing it.
func pinnedDeploymentManifest(manifest appliance.Manifest) (appliance.Manifest, error) {
	policy, policyErr := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if policyErr == nil && policy.CoreManifestSHA256 != "" {
		return coreDeploymentManifest(manifest, policy)
	}
	if policyErr != nil && !errors.Is(policyErr, os.ErrNotExist) {
		return manifest, policyErr
	}
	return manifest, nil
}

// Installation owns temporary pins only. An explicit owner pin/source/channel
// is never silently replaced; a conflicting choice stops deployment safely.
func pinDeploymentServices(manifest appliance.Manifest) error {
	if manifest.ReleaseSet == nil {
		return nil
	}
	config, err := channels.Load()
	if err != nil {
		return err
	}
	for name, c := range map[string]appliance.ComponentRelease{channels.ComponentControl: manifest.ReleaseSet.ControlPanel, channels.ComponentUI: manifest.ReleaseSet.UI} {
		ch, _ := currentOverride(config, name)
		if ch.PinOrigin != "installation" && (ch.Tag != "" || ch.ArtifactSHA256 != "") {
			if ch.Tag != c.Tag || ch.ArtifactSHA256 != c.ArtifactSHA256 {
				return fmt.Errorf("%s owner pin conflicts with installation selection", name)
			}
			continue
		}
		// A verified complete selection may reuse a member from a different
		// branch than the legacy image seed. Installation owns that seed;
		// explicit owner channels, source boundaries and fallback remain guarded.
		if ch.Source != "" && !sameReleaseSource(ch.Source, manifest.ReleaseSet.Source) || ch.PinOrigin != "installation" && ch.Branch != "" && ch.Branch != manifest.ReleaseSet.ComponentBranch(c) || len(ch.Fallback) > 0 {
			return fmt.Errorf("%s owner channel conflicts with installation selection", name)
		}
		if err = config.SetChannel(name, channels.Channel{Source: manifest.ReleaseSet.Source, Branch: manifest.ReleaseSet.ComponentBranch(c), PinOrigin: "installation", Tag: c.Tag, ArtifactSHA256: c.ArtifactSHA256, Fallback: []string{}}); err != nil {
			return err
		}
	}
	return config.Save()
}
