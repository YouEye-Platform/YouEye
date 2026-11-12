package cmd

import (
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var applianceExecutablePath = os.Executable

// verifyApplianceReleaseSet binds first deployment to the accepted System
// release the installer recorded, and the baked Spine to the sealed image.
func verifyApplianceReleaseSet(manifest appliance.Manifest, _ *config.Config) error {
	if manifest.ReleaseSet == nil {
		return nil
	}
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if err != nil {
		return err
	}
	return verifyCoreDeploymentReleaseSet(manifest, policy)
}
