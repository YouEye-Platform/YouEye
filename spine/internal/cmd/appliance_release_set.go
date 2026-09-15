package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
)

var applianceExecutablePath = os.Executable

// verifyApplianceReleaseSet binds first deployment to the exact core payload
// declared in the sealed image marker. Legacy appliance markers without a
// release set retain their existing behavior.
func verifyApplianceReleaseSet(manifest appliance.Manifest, cfg *config.Config) error {
	releaseSet := manifest.ReleaseSet
	if releaseSet == nil {
		return nil
	}
	if Version != releaseSet.Spine.Version {
		return fmt.Errorf("appliance release set Spine version %s does not match baked binary %s", releaseSet.Spine.Version, Version)
	}
	executable, err := applianceExecutablePath()
	if err != nil {
		return fmt.Errorf("resolve baked Spine binary: %w", err)
	}
	if err := releases.VerifyFileSHA256(executable, releaseSet.Spine.ArtifactSHA256); err != nil {
		return fmt.Errorf("verify baked Spine binary: %w", err)
	}
	if !sameReleaseSource(cfg.CoreReleaseRepo().RepoURL, releaseSet.Source) {
		return fmt.Errorf("configured core release source does not match sealed appliance release set")
	}

	channelConfig, err := channels.Load()
	if err != nil {
		return fmt.Errorf("load appliance release channels: %w", err)
	}
	expected := map[string]appliance.ComponentRelease{
		channels.ComponentSpine:   releaseSet.Spine,
		channels.ComponentControl: releaseSet.ControlPanel,
		channels.ComponentUI:      releaseSet.UI,
	}
	for component, componentRelease := range expected {
		effective := channelConfig.Effective(component, cfg)
		if !sameReleaseSource(effective.Source, releaseSet.Source) {
			return fmt.Errorf("%s channel source does not match sealed appliance release set", component)
		}
		if effective.Branch != releaseSet.Branch {
			return fmt.Errorf("%s channel branch %q does not match sealed branch %q", component, effective.Branch, releaseSet.Branch)
		}
		if effective.Fallback == nil || len(effective.Fallback) != 0 {
			return fmt.Errorf("%s channel fallback must be explicitly disabled", component)
		}
		if component == channels.ComponentSpine {
			if effective.Tag != "" && effective.Tag != componentRelease.Tag {
				return fmt.Errorf("spine channel tag does not match sealed appliance release set")
			}
			continue
		}
		if effective.Tag != componentRelease.Tag {
			return fmt.Errorf("%s exact tag %q does not match sealed tag %q", component, effective.Tag, componentRelease.Tag)
		}
		if !strings.EqualFold(effective.ArtifactSHA256, componentRelease.ArtifactSHA256) {
			return fmt.Errorf("%s artifact digest does not match sealed appliance release set", component)
		}
	}
	return nil
}

func sameReleaseSource(left, right string) bool {
	a, errA := config.ParseReleaseRepoURL(left)
	b, errB := config.ParseReleaseRepoURL(right)
	if errA != nil || errB != nil {
		return strings.TrimSuffix(left, ".git") == strings.TrimSuffix(right, ".git")
	}
	return a.BaseURL == b.BaseURL && a.Organization == b.Organization && a.Repository == b.Repository
}
