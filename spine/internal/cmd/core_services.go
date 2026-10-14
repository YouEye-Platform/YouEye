package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var coreServiceTrustPath = systemupdate.CoreDevelopmentTrustPath

func coreDeploymentManifest(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	r, digest, err := systemupdate.ReadCoreSelection(filepath.Dir(deploymentPolicyPath), coreServiceTrustPath)
	if err != nil {
		return image, err
	}
	if err = systemupdate.ValidateCorePolicy(policy, r, digest); err != nil {
		return image, err
	}
	if err = systemupdate.BindCoreImage(r, image); err != nil {
		return image, err
	}
	return bindCoreServices(image, r)
}

func bindCoreServices(image appliance.Manifest, r releasecache.CoreRelease) (appliance.Manifest, error) {
	if err := systemupdate.BindCoreImage(r, image); err != nil {
		return image, err
	}
	set := *image.ReleaseSet
	set.Schema = "youeye.release-set.v2"
	set.Spine.Branch = image.ReleaseSet.ComponentBranch(image.ReleaseSet.Spine)
	for _, member := range r.Members {
		if member.Role != "cp" && member.Role != "ui" {
			continue
		}
		// The existing deployment view has one source. Mixed service sources use
		// the coordinator's scoped lifecycle, never a misleading image view.
		if member.Source != set.Source {
			return image, fmt.Errorf("core first deployment requires services from its selected source")
		}
		c := appliance.ComponentRelease{Version: member.BuildVersion, Branch: member.Branch, Tag: member.Tag, SourceCommit: member.SourceCommit, ArtifactSHA256: member.Artifact.SHA256}
		if member.Role == "cp" {
			set.ControlPanel = c
		} else {
			set.UI = c
		}
	}
	image.ReleaseSet = &set
	return image, set.Validate()
}

func selectCoreServices(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	deployment, err := coreDeploymentManifest(image, policy)
	if err != nil {
		return image, err
	}
	if err = pinDeploymentServices(deployment); err != nil {
		return image, err
	}
	r, digest, err := systemupdate.ReadCoreSelection(filepath.Dir(deploymentPolicyPath), coreServiceTrustPath)
	if err != nil {
		return image, err
	}
	if err := initializeSystemChannel(r, digest, policy); err != nil {
		return image, err
	}
	return deployment, nil
}

func initializeSystemChannel(r releasecache.CoreRelease, digest string, policy systemupdate.ReleasePolicy) error {
	c, err := channels.Load()
	if err != nil {
		return err
	}
	if !c.System.IsZero() {
		effective := c.Effective(channels.ComponentSystem, GetConfig())
		if err := channels.ValidateSystemChannel(effective); err != nil {
			return err
		}
		if effective.Source != r.Source || effective.Branch != r.Branch || effective.Tag != "" && (effective.Tag != r.Tag || effective.ArtifactSHA256 != digest) {
			return fmt.Errorf("retained System source/pin differs from frozen installation selection")
		}
		return nil
	}
	ch := channels.Channel{Source: r.Source, Branch: r.Branch, Fallback: c.Effective(channels.ComponentDefault, GetConfig()).Fallback}
	if policy.Mode == "exact" {
		ch.Tag, ch.ArtifactSHA256, ch.PinOrigin = r.Tag, digest, "installation"
	}
	if err := c.SetChannel(channels.ComponentSystem, ch); err != nil {
		return err
	}
	return c.Save()
}
