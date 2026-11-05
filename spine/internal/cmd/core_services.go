package cmd

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var coreServiceTrustPath = systemupdate.CoreDevelopmentTrustPath

func coreDeploymentManifest(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	_, _, err := coreDeploymentSelection(image, policy)
	// A Core selection can name independently built services. It must never be
	// represented as the sealed image's legacy single-source release set.
	return image, err
}

func coreDeploymentSelection(image appliance.Manifest, policy systemupdate.ReleasePolicy) (releasecache.CoreRelease, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, r, digest, err := systemupdate.ReadAuthenticatedCoreSelection(ctx, filepath.Dir(deploymentPolicyPath), coreServiceTrustPath, "/var/lib/youeye/cache/core-update", nil)
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

func pinCoreDeploymentServices(config *channels.Config, image appliance.Manifest, r releasecache.CoreRelease) error {
	for _, member := range r.Members {
		if member.Role != "cp" && member.Role != "ui" {
			continue
		}
		name, seed := channels.ComponentControl, image.ReleaseSet.ControlPanel
		if member.Role == "ui" {
			name, seed = channels.ComponentUI, image.ReleaseSet.UI
		}
		ch, _ := currentOverride(config, name)
		exact := ch.Source == member.Source && ch.Branch == member.Branch && ch.Tag == member.Tag && ch.ArtifactSHA256 == member.Artifact.SHA256 && ch.Fallback != nil && len(ch.Fallback) == 0
		if ch.PinOrigin == "installation" {
			// Only the exact image-owned seed or this same authenticated member
			// may be reconciled. An unrelated retained source is not an owner
			// choice that installation can silently replace.
			sealedSeed := ch.Source == image.ReleaseSet.Source && ch.Branch == image.ReleaseSet.ComponentBranch(seed) && ch.Tag == seed.Tag && ch.ArtifactSHA256 == seed.ArtifactSHA256 && ch.Fallback != nil && len(ch.Fallback) == 0
			if !exact && !sealedSeed {
				return fmt.Errorf("%s retained installation pin differs from sealed seed and selected Core member", name)
			}
		} else {
			if ch.Source != "" && !sameReleaseSource(ch.Source, member.Source) || ch.Branch != "" && ch.Branch != member.Branch || len(ch.Fallback) > 0 {
				return fmt.Errorf("%s owner channel conflicts with selected Core member", name)
			}
			if ch.Tag != "" || ch.ArtifactSHA256 != "" {
				effective := config.Effective(name, GetConfig())
				if effective.Source != member.Source || effective.Branch != member.Branch || ch.Tag != member.Tag || ch.ArtifactSHA256 != member.Artifact.SHA256 || len(effective.Fallback) > 0 {
					return fmt.Errorf("%s owner pin conflicts with selected Core member", name)
				}
				continue // Preserve an exact owner pin and its ownership.
			}
		}
		if err := config.SetChannel(name, channels.Channel{Source: member.Source, Branch: member.Branch, Tag: member.Tag, ArtifactSHA256: member.Artifact.SHA256, PinOrigin: "installation", Fallback: []string{}}); err != nil {
			return err
		}
	}
	return nil
}

func selectCoreServices(image appliance.Manifest, policy systemupdate.ReleasePolicy) (appliance.Manifest, error) {
	r, digest, err := coreDeploymentSelection(image, policy)
	if err != nil {
		return image, err
	}
	config, err := channels.Load()
	if err != nil {
		return image, err
	}
	if err := verifyCoreDeploymentHost(image, GetConfig(), config); err != nil {
		return image, err
	}
	if err := pinCoreDeploymentServices(config, image, r); err != nil {
		return image, err
	}
	if err := setInitialSystemChannel(config, r, digest, policy); err != nil {
		return image, err
	}
	return image, config.Save()
}

func initializeSystemChannel(r releasecache.CoreRelease, digest string, policy systemupdate.ReleasePolicy) error {
	c, err := channels.Load()
	if err != nil {
		return err
	}
	if err := setInitialSystemChannel(c, r, digest, policy); err != nil {
		return err
	}
	return c.Save()
}

func setInitialSystemChannel(c *channels.Config, r releasecache.CoreRelease, digest string, policy systemupdate.ReleasePolicy) error {
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
	return nil
}

func verifyCoreDeploymentReleaseSet(image appliance.Manifest, cfg *config.Config, policy systemupdate.ReleasePolicy) error {
	r, _, err := coreDeploymentSelection(image, policy)
	if err != nil {
		return err
	}
	channelsConfig, err := channels.Load()
	if err != nil {
		return err
	}
	if err := verifyCoreDeploymentHost(image, cfg, channelsConfig); err != nil {
		return err
	}
	for _, member := range r.Members {
		name := ""
		switch member.Role {
		case "cp":
			name = channels.ComponentControl
		case "ui":
			name = channels.ComponentUI
		default:
			continue
		}
		effective := channelsConfig.Effective(name, cfg)
		if effective.Source != member.Source || effective.Branch != member.Branch || effective.Tag != member.Tag || effective.ArtifactSHA256 != member.Artifact.SHA256 || effective.Fallback == nil || len(effective.Fallback) != 0 {
			return fmt.Errorf("%s channel differs from authenticated original Core member", name)
		}
	}
	return nil
}

func verifyCoreDeploymentHost(image appliance.Manifest, cfg *config.Config, channelsConfig *channels.Config) error {
	reader, err := readCoreInstalledReader()
	if err != nil {
		return err
	}
	hash, err := fileSHA256(reader.Executable)
	if err != nil || hash != image.ReleaseSet.Spine.ArtifactSHA256 || !reader.Bound && Version != image.ReleaseSet.Spine.Version {
		return fmt.Errorf("baked Spine differs from the selected immutable image")
	}
	if !sameReleaseSource(cfg.CoreReleaseRepo().RepoURL, image.ReleaseSet.Source) {
		return fmt.Errorf("configured image source differs from immutable image")
	}
	// Spine remains the immutable image's own baked release identity. Service
	// origin is independent of this host source and must not rewrite it.
	spine := channelsConfig.Effective(channels.ComponentSpine, cfg)
	if !sameReleaseSource(spine.Source, image.ReleaseSet.Source) || spine.Branch != image.ReleaseSet.ComponentBranch(image.ReleaseSet.Spine) || spine.Fallback == nil || len(spine.Fallback) != 0 || spine.Tag != "" && spine.Tag != image.ReleaseSet.Spine.Tag {
		return fmt.Errorf("Spine channel differs from immutable image")
	}
	return nil
}
