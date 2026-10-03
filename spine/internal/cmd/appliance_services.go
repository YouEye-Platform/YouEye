package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var deploymentDistributionPolicy = releasecache.DistributionPolicyFromSource
var deploymentPolicyPath = "/var/lib/youeye-state/bootstrap/release-policy.json"
var deploymentSelectionPath = "/var/lib/youeye-state/first-deploy/installation.json"
var deploymentInstalledBundlePath = "/var/lib/youeye-state/installer/appliance-manifest.json"
var deploymentBundleSnapshotPath = "/var/lib/youeye-state/first-deploy/appliance-manifest.json"

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
	if policy.ServiceSelection == "sealed" || (policy.Mode == "exact" && policy.ServiceSelection != "current") {
		return manifest, nil
	}
	private := policy.Provider == "custom" && manifest.ReleaseSet != nil && manifest.ReleaseSet.Branch == "main"
	official := policy.Provider == "github" && manifest.ReleaseSet != nil && manifest.ReleaseSet.Source == releasecache.OfficialRepository && (policy.ReleasesAPI == "" || policy.ReleasesAPI == systemupdate.DefaultReleasesAPI)
	if !private && !official {
		if policy.ServiceSelection == "current" {
			return manifest, fmt.Errorf("source does not advertise a signed compatible service selection")
		}
		return manifest, pinDeploymentServices(manifest)
	}
	if manifest.ReleaseSet == nil || (!private && manifest.ReleaseSet.Source != "https://github.com/YouEye-Platform/YouEye") {
		return manifest, fmt.Errorf("signed service selection requires official image identity")
	}
	if private {
		source, err := url.Parse(manifest.ReleaseSet.Source)
		if err != nil {
			return manifest, err
		}
		parts := strings.Split(strings.TrimPrefix(source.Path, "/"), "/")
		if len(parts) != 2 || policy.ReleasesAPI != source.Scheme+"://"+source.Host+"/api/v1/repos/"+parts[0]+"/"+parts[1]+"/releases" {
			return manifest, fmt.Errorf("private installation policy source differs from signed image")
		}
	}
	channel := "stable"
	if manifest.ReleaseSet.Branch == "beta" {
		channel = "beta"
	} else if manifest.ReleaseSet.Branch != "main" {
		return manifest, fmt.Errorf("unsupported service selection branch")
	}
	trust := deploymentDistributionPolicy()
	verify := func(raw []byte) (*releasecache.InstallationSet, error) {
		if private {
			return releases.VerifyPrivateInstallation(raw, manifest.ReleaseSet.Source)
		}
		return releasecache.VerifyPinnedInstallation(raw, channel, trust.Keys[channel])
	}
	raw, err := readPinnedServices(deploymentSelectionPath)
	if os.IsNotExist(err) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		// Protected candidate cache can contain the original signed endpoint bytes;
		// normal installed guests use the same public HTTPS endpoint.
		if private {
			raw, err = releases.PrivateInstallationSnapshot(ctx, manifest.ReleaseSet.Source)
		} else {
			raw, err = releasecache.InstallationSnapshot(ctx, releasecache.Wrap(nil), trust, channel)
		}
		if err != nil {
			return manifest, err
		}
		selected, e := verify(raw)
		if e != nil {
			return manifest, e
		}
		if _, e = bindInstallationServices(manifest, *selected); e != nil {
			return manifest, e
		}
		if err := verifySelectedManifest(manifest, *selected); err != nil {
			return manifest, err
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
	selected, err := verify(raw)
	if err != nil {
		return manifest, err
	}
	if err := verifySelectedManifest(manifest, *selected); err != nil {
		return manifest, err
	}
	if policy.Mode == "exact" && selected.Appliance.ManifestSHA256 != policy.ManifestSHA256 {
		return manifest, fmt.Errorf("service selection does not match exact installed manifest")
	}
	deployment, err := bindInstallationServices(manifest, *selected)
	if err != nil {
		return manifest, err
	}
	if err := pinDeploymentServices(deployment); err != nil {
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
	if manifest.ReleaseSet.Source != "https://github.com/YouEye-Platform/YouEye" {
		if manifest.ReleaseSet.Branch != "main" {
			return manifest, fmt.Errorf("unsupported pinned private channel")
		}
		selection, err := releases.VerifyPrivateInstallation(raw, manifest.ReleaseSet.Source)
		if err != nil {
			return manifest, err
		}
		return bindInstallationServices(manifest, *selection)
	}
	policy := deploymentDistributionPolicy()
	selection, err := releasecache.VerifyPinnedInstallation(raw, channel, policy.Keys[channel])
	if err != nil {
		return manifest, err
	}
	return bindInstallationServices(manifest, *selection)
}

// Release only pins owned by installation after all deployment invariants pass.
// Frozen installation bytes and installed provenance remain unchanged. Owner
// pins have no installation origin and are never removed by this transition.
func finishApplianceServiceChannels() error {
	policy, err := systemupdate.LoadReleasePolicy(deploymentPolicyPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if policy.Mode == "exact" || policy.ServiceSelection == "sealed" {
		return nil
	}
	config, err := channels.Load()
	if err != nil {
		return err
	}
	changed := false
	for _, name := range []string{channels.ComponentControl, channels.ComponentUI} {
		ch, _ := currentOverride(config, name)
		if ch.PinOrigin != "installation" {
			continue
		}
		ch.Tag, ch.ArtifactSHA256, ch.PinOrigin = "", "", ""
		if err = config.SetChannel(name, ch); err != nil {
			return err
		}
		changed = true
	}
	if !changed {
		return nil
	}
	return config.Save()
}

// The signed selection hashes the release bundle manifest, not the smaller
// runtime marker inside System. Authenticate those exact bundle bytes, then
// compare their immutable image identity with the running marker.
func verifyInstallationBundle(raw []byte, manifest appliance.Manifest, selected releasecache.InstallationSet) error {
	if len(raw) > 16<<20 || fmt.Sprintf("%x", sha256.Sum256(raw)) != selected.Appliance.ManifestSHA256 {
		return fmt.Errorf("installation services do not match the installed manifest digest")
	}
	var bundle struct {
		appliance.Manifest
		Schema     string `json:"schema"`
		DiskLayout struct {
			Version int `json:"version"`
		} `json:"disk_layout"`
	}
	if err := json.Unmarshal(raw, &bundle); err != nil || bundle.Schema != "youeye.appliance.manifest.v1" || bundle.DiskLayout.Version != manifest.DiskLayoutVersion {
		return fmt.Errorf("installation bundle manifest is invalid")
	}
	// These marker-only fields have no counterpart in the external bundle.
	expected := manifest
	expected.SchemaVersion, expected.DiskLayoutVersion = 0, 0
	expected.ArtifactKind, expected.SupportedActions = "", nil
	if !reflect.DeepEqual(bundle.Manifest, expected) {
		return fmt.Errorf("installation bundle does not match the running sealed System")
	}
	return nil
}

func verifySelectedManifest(manifest appliance.Manifest, selected releasecache.InstallationSet) error {
	raw, err := readPinnedServices(deploymentBundleSnapshotPath)
	if err == nil {
		return verifyInstallationBundle(raw, manifest, selected)
	}
	if !os.IsNotExist(err) {
		return err
	}
	raw, err = readPinnedServices(deploymentInstalledBundlePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(raw)) != selected.Appliance.ManifestSHA256 {
		// A tracked first boot may have converged to a newer signed System than
		// the installation media. Fetch its exact bundle through the same cache
		// transport; the already authenticated selection supplies its hash.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		endpoint := selected.Source + "/releases/download/" + url.PathEscape(selected.Appliance.Tag) + "/appliance-manifest.json"
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		response, err := releases.NewIPv4Client(30 * time.Second).Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("installation bundle returned HTTP %d", response.StatusCode)
		}
		raw, err = io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		if err != nil {
			return err
		}
	}
	if err := verifyInstallationBundle(raw, manifest, selected); err != nil {
		return err
	}
	return writePinnedServices(deploymentBundleSnapshotPath, raw)
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
		if ch.Source != "" && !sameReleaseSource(ch.Source, manifest.ReleaseSet.Source) || ch.Branch != "" && ch.Branch != manifest.ReleaseSet.ComponentBranch(c) || len(ch.Fallback) > 0 {
			return fmt.Errorf("%s owner channel conflicts with installation selection", name)
		}
		if err = config.SetChannel(name, channels.Channel{Source: manifest.ReleaseSet.Source, Branch: manifest.ReleaseSet.ComponentBranch(c), PinOrigin: "installation", Tag: c.Tag, ArtifactSHA256: c.ArtifactSHA256, Fallback: []string{}}); err != nil {
			return err
		}
	}
	return config.Save()
}
