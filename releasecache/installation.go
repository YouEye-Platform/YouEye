package releasecache

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// InstallationSet is authenticated by the distribution envelope. It selects
// independently published services for one tested, immutable appliance image.
// It is not authority to replace the baked Spine or rewrite the image manifest.
type InstallationSet struct {
	Schema       string                `json:"schema"`
	Source       string                `json:"source"`
	Appliance    InstallationImage     `json:"appliance"`
	ControlPanel InstallationComponent `json:"control_panel"`
	UI           InstallationComponent `json:"ui"`
}

type InstallationImage struct {
	Version        string `json:"version"`
	Tag            string `json:"tag"`
	SourceCommit   string `json:"source_commit"`
	ManifestSHA256 string `json:"manifest_sha256"`
	SpineSHA256    string `json:"spine_sha256"`
}

type InstallationComponent struct {
	Version        string `json:"version"`
	Tag            string `json:"tag"`
	SourceCommit   string `json:"source_commit"`
	ArtifactSHA256 string `json:"artifact_sha256"`
}

var installationCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)
var installationHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
var installationStableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var installationBetaVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func (s InstallationSet) Validate(channel string) error {
	if s.Schema != "youeye.installation.v1" || s.Source != "https://github.com/YouEye-Platform/YouEye" {
		return fmt.Errorf("invalid installation identity")
	}
	version, prefix := installationStableVersion, ""
	switch channel {
	case "stable":
	case "beta":
		version, prefix = installationBetaVersion, "beta-"
	default:
		return fmt.Errorf("invalid installation channel")
	}
	if !version.MatchString(s.Appliance.Version) || s.Appliance.Tag != "appliance-"+prefix+"v"+s.Appliance.Version || !installationCommit.MatchString(s.Appliance.SourceCommit) || !installationHash.MatchString(s.Appliance.ManifestSHA256) || !installationHash.MatchString(s.Appliance.SpineSHA256) {
		return fmt.Errorf("invalid installation appliance identity")
	}
	for name, component := range map[string]InstallationComponent{"cp": s.ControlPanel, "ui": s.UI} {
		if !version.MatchString(component.Version) || component.Tag != name+"-"+prefix+"v"+component.Version || !installationCommit.MatchString(component.SourceCommit) || !installationHash.MatchString(component.ArtifactSHA256) {
			return fmt.Errorf("invalid installation %s identity", name)
		}
	}
	return nil
}

// InstallationSnapshot returns the signed envelope, so first deployment can
// persist the authenticated selection before installing any service. Only the
// requested channel is contacted; a missing selection is an error.
func InstallationSnapshot(ctx context.Context, next http.RoundTripper, policy DistributionPolicy, channel string) ([]byte, error) {
	origin, err := url.Parse(policy.Origin)
	if policy.Schema != "youeye.distribution-policy.v1" || err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || (channel != "stable" && channel != "beta") || policy.Keys[channel] == "" {
		return nil, fmt.Errorf("installation distribution trust is not provisioned")
	}
	// Candidate media is an explicitly protected, immutable transport. Verify
	// its signed snapshot without advancing the public channel watermark with
	// unpublished test metadata. Other cache errors remain fatal.
	if file, _, cacheErr := Open(Root(), policy.Origin+"/v1/"+channel+".json"); cacheErr == nil {
		defer file.Close()
		raw, err := io.ReadAll(io.LimitReader(file, (16<<20)+1))
		if err != nil {
			return nil, err
		}
		catalog, _, err := VerifyDistribution(raw, channel, policy.Keys[channel], time.Now().UTC())
		if err != nil {
			return nil, err
		}
		if catalog.Installation == nil {
			return nil, fmt.Errorf("candidate installation selection is missing")
		}
		return raw, nil
	} else if !os.IsNotExist(cacheErr) {
		return nil, cacheErr
	}
	if next == nil {
		next = http.DefaultTransport
	}
	distributionMu.Lock()
	defer distributionMu.Unlock()
	entry, err := loadDistributionChannel(ctx, next, policy, channel)
	if err != nil {
		return nil, err
	}
	if entry.catalog.Installation == nil {
		return nil, fmt.Errorf("no signed installation selection is published")
	}
	root, err := distributionCacheRoot()
	if err != nil {
		return nil, err
	}
	keyHash := sha256.Sum256([]byte(policy.Keys[channel]))
	cacheKey := policy.Origin + "/v1/" + channel + ".json" + fmt.Sprintf("#%x", keyHash)
	raw, err := os.ReadFile(filepath.Join(root, "youeye-distribution", "go", fmt.Sprintf("%x.json", sha256.Sum256([]byte(cacheKey)))))
	if err != nil {
		return nil, err
	}
	_, digest, err := VerifyDistribution(raw, channel, policy.Keys[channel], time.Now().UTC())
	if err != nil {
		return nil, err
	}
	if digest != entry.digest {
		return nil, fmt.Errorf("installation snapshot changed during selection")
	}
	return raw, nil
}

// VerifyPinnedInstallation verifies a previously accepted snapshot for recovery.
// Its caller must load it from protected local deployment state. Expiration
// limits new selections, not recovery of an already installed exact selection.
func VerifyPinnedInstallation(raw []byte, channel, key string) (*InstallationSet, error) {
	catalog, _, err := verifyDistribution(raw, channel, key, time.Now().UTC(), true)
	if err != nil {
		return nil, err
	}
	if catalog.Installation == nil {
		return nil, fmt.Errorf("pinned installation selection is missing")
	}
	return catalog.Installation, nil
}
