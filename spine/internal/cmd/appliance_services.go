package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var deploymentDistributionPolicy = releasecache.DistributionPolicyFromSource

var deploymentPolicyPath = "/var/lib/youeye-state/bootstrap/release-policy.json"
var deploymentSelectionPath = "/var/lib/youeye-state/first-deploy/installation.json"

// selectApplianceServices leaves the sealed image identity intact. The returned
// deployment view may replace only services, authenticated by a signed selection
// naming this exact image and baked Spine. Exact-media installs default to the
// sealed pins; tracked public installs select current compatible services.
func selectApplianceServices(manifest appliance.Manifest) (appliance.Manifest, error) {
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if errors.Is(err, os.ErrNotExist) {
		return manifest, nil
	}
	if err != nil {
		return manifest, err
	}
	if policy.ServiceSelection == "sealed" || (policy.Mode == "exact" && policy.ServiceSelection != "current") || policy.Provider != "github" {
		return manifest, nil
	}
	if manifest.ReleaseSet == nil || manifest.ReleaseSet.Source != "https://github.com/YouEye-Platform/YouEye" {
		return manifest, fmt.Errorf("signed service selection requires official image identity")
	}
	channel := "stable"
	if manifest.ReleaseSet.Branch == "beta" {
		channel = "beta"
	} else if manifest.ReleaseSet.Branch != "main" {
		return manifest, fmt.Errorf("unsupported service selection branch")
	}
	trust := deploymentDistributionPolicy()
	raw, err := readPinnedServices(deploymentSelectionPath)
	if os.IsNotExist(err) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		// Protected candidate cache can contain the original signed endpoint bytes;
		// normal installed guests use the same public HTTPS endpoint.
		raw, err = releasecache.InstallationSnapshot(ctx, releasecache.Wrap(nil), trust, channel)
		if err != nil {
			return manifest, err
		}
		selected, e := releasecache.VerifyPinnedInstallation(raw, channel, trust.Keys[channel])
		if e != nil {
			return manifest, e
		}
		if _, e = bindInstallationServices(manifest, *selected); e != nil {
			return manifest, e
		}
		if policy.Mode == "exact" && selected.Appliance.ManifestSHA256 != policy.ManifestSHA256 {
			return manifest, fmt.Errorf("service selection does not match exact installed manifest")
		}
		if err = writePinnedServices(deploymentSelectionPath, raw); err != nil {
			return manifest, err
		}
	} else if err != nil {
		return manifest, err
	}
	selected, err := releasecache.VerifyPinnedInstallation(raw, channel, trust.Keys[channel])
	if err != nil {
		return manifest, err
	}
	if policy.Mode == "exact" && selected.Appliance.ManifestSHA256 != policy.ManifestSHA256 {
		return manifest, fmt.Errorf("service selection does not match exact installed manifest")
	}
	deployment, err := bindInstallationServices(manifest, *selected)
	if err != nil {
		return manifest, err
	}
	config, err := channels.Load()
	if err != nil {
		return manifest, err
	}
	for name, component := range map[string]appliance.ComponentRelease{channels.ComponentControl: deployment.ReleaseSet.ControlPanel, channels.ComponentUI: deployment.ReleaseSet.UI} {
		if err = config.SetChannel(name, channels.Channel{Source: selected.Source, Branch: manifest.ReleaseSet.Branch, Tag: component.Tag, ArtifactSHA256: component.ArtifactSHA256, Fallback: []string{}}); err != nil {
			return manifest, err
		}
	}
	if err = config.Save(); err != nil {
		return manifest, err
	}
	return deployment, nil
}

func bindInstallationServices(manifest appliance.Manifest, selected releasecache.InstallationSet) (appliance.Manifest, error) {
	if manifest.ReleaseSet == nil || selected.Source != manifest.ReleaseSet.Source || selected.Appliance.Version != manifest.ImageVersion || selected.Appliance.SourceCommit != manifest.SourceCommit || selected.Appliance.SpineSHA256 != manifest.ReleaseSet.Spine.ArtifactSHA256 {
		return manifest, fmt.Errorf("installation services are not accepted for this exact appliance")
	}
	set := *manifest.ReleaseSet
	convert := func(c releasecache.InstallationComponent) appliance.ComponentRelease {
		return appliance.ComponentRelease{Version: c.Version, Tag: c.Tag, SourceCommit: c.SourceCommit, ArtifactSHA256: c.ArtifactSHA256}
	}
	set.ControlPanel, set.UI = convert(selected.ControlPanel), convert(selected.UI)
	manifest.ReleaseSet = &set
	return manifest, nil
}

func readPinnedServices(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 16<<20 || !ok || int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("unsafe pinned installation state")
	}
	return os.ReadFile(path)
}
func writePinnedServices(path string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".installation-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// Health checks consume the frozen selection without fetching or changing it.
func pinnedDeploymentManifest(manifest appliance.Manifest) (appliance.Manifest, error) {
	raw, err := readPinnedServices(deploymentSelectionPath)
	if errors.Is(err, os.ErrNotExist) {
		return manifest, nil
	}
	if err != nil {
		return manifest, err
	}
	if manifest.ReleaseSet == nil {
		return manifest, fmt.Errorf("pinned services have no appliance identity")
	}
	channel := "stable"
	if manifest.ReleaseSet.Branch == "beta" {
		channel = "beta"
	} else if manifest.ReleaseSet.Branch != "main" {
		return manifest, fmt.Errorf("pinned public services cannot select a private channel")
	}
	policy := deploymentDistributionPolicy()
	selection, err := releasecache.VerifyPinnedInstallation(raw, channel, policy.Keys[channel])
	if err != nil {
		return manifest, err
	}
	return bindInstallationServices(manifest, *selection)
}
