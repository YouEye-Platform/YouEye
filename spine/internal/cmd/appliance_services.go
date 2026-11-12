package cmd

import (
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var deploymentPolicyPath = "/var/lib/youeye-state/bootstrap/release-policy.json"

// selectApplianceServices leaves the sealed image identity intact. A
// core-release install selects services from its accepted release; any other
// install keeps the sealed pins.
func selectApplianceServices(manifest appliance.Manifest) (appliance.Manifest, error) {
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if err != nil {
		return manifest, err
	}
	return selectCoreServices(manifest, policy)
}

// Health checks consume the frozen selection without fetching or changing it.
func pinnedDeploymentManifest(manifest appliance.Manifest) (appliance.Manifest, error) {
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if err != nil {
		return manifest, err
	}
	return coreDeploymentManifest(manifest, policy)
}
