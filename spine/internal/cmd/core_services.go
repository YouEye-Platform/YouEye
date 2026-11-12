package cmd

import (
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func coreDeploymentManifest(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	_, _, err := coreDeploymentSelection(image, policy)
	return image, err
}

func coreDeploymentSelection(image appliance.Manifest, policy systemupdate.ReleasePolicy) (releasecache.CoreRelease, string, error) {
	_, r, digest, err := systemupdate.ReadAcceptedCoreSelection(filepath.Dir(deploymentPolicyPath))
	if err != nil {
		return r, digest, err
	}
	if err = systemupdate.ValidateCorePolicy(policy, r, digest); err != nil {
		return r, digest, err
	}
	if err = systemupdate.BindCoreImage(r, image); err != nil {
		return r, digest, err
	}
	return r, digest, nil
}

// selectCoreServices checks that the services to deploy are the cp and ui
// members of the accepted release, which the deploy steps read directly.
func selectCoreServices(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	if _, _, err := coreDeploymentSelection(image, policy); err != nil {
		return image, err
	}
	return image, verifyCoreDeploymentHost(image)
}

func verifyCoreDeploymentReleaseSet(image appliance.Manifest, policy systemupdate.ReleasePolicy) error {
	if _, _, err := coreDeploymentSelection(image, policy); err != nil {
		return err
	}
	return verifyCoreDeploymentHost(image)
}

func verifyCoreDeploymentHost(image appliance.Manifest) error {
	reader, err := readCoreInstalledReader()
	if err != nil {
		return err
	}
	return verifyRunningSpine(reader.Executable)
}
