package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

func releaseNeedsDetachedLock(release applianceRelease) bool {
	if applianceReleaseTrustClass(release) != "development" {
		return true
	}
	_, err := findApplianceReleaseAsset(release, applianceReleaseLockName)
	return err == nil
}

// The checksum signature authenticates provenance, which authenticates the
// detached lock. The lock is intentionally not another SHA256SUMS entry.
// Call only after verifying provenance against the signed checksum document.
func validateDetachedApplianceLock(provenanceRaw, lockRaw []byte, manifest applianceBundleManifest) error {
	var provenance struct {
		Schema         string `json:"schema"`
		SourceCommit   string `json:"source_commit"`
		LockSHA256     string `json:"resolved_lock_sha256"`
		DebianSnapshot string `json:"debian_snapshot"`
		Source         struct {
			Commit string `json:"commit"`
			Branch string `json:"branch"`
		} `json:"source"`
		ReleaseSet applianceManifestReleases `json:"release_set"`
		Market     struct {
			Source string `json:"source"`
			Commit string `json:"source_commit"`
			Branch string `json:"branch"`
		} `json:"market"`
	}
	if err := json.Unmarshal(provenanceRaw, &provenance); err != nil {
		return fmt.Errorf("parse signed appliance provenance: %w", err)
	}
	digest := sha256.Sum256(lockRaw)
	if provenance.Schema != "youeye.appliance.provenance.v2" || !validSHA256Hex(provenance.LockSHA256) || hex.EncodeToString(digest[:]) != provenance.LockSHA256 {
		return fmt.Errorf("detached release lock does not match signed provenance")
	}
	var lock struct {
		Schema string `json:"schema"`
		Image  struct {
			Version        string `json:"version"`
			Source         string `json:"release_source"`
			Branch         string `json:"release_branch"`
			DebianSnapshot string `json:"debian_snapshot"`
		} `json:"image"`
		Components map[string]applianceManifestComponent `json:"components"`
		Market     struct {
			Source string `json:"source"`
			Commit string `json:"commit"`
			Branch string `json:"branch"`
		} `json:"market"`
	}
	if err := json.Unmarshal(lockRaw, &lock); err != nil {
		return fmt.Errorf("parse detached appliance release lock: %w", err)
	}
	set := manifest.ReleaseSet
	if lock.Schema != "youeye.appliance.release-lock.v1" || lock.Image.Version != manifest.ImageVersion ||
		lock.Image.Source != set.Source || lock.Image.Branch != set.Branch ||
		provenance.SourceCommit != manifest.SourceCommit || provenance.Source.Commit != manifest.SourceCommit || provenance.Source.Branch != set.Branch ||
		provenance.ReleaseSet.Source != set.Source || provenance.ReleaseSet.Branch != set.Branch || len(provenance.ReleaseSet.Fallback) != 0 ||
		lock.Image.DebianSnapshot == "" || lock.Image.DebianSnapshot != provenance.DebianSnapshot {
		return fmt.Errorf("detached release lock/provenance differs from signed appliance identity")
	}
	if len(lock.Components) != 3 || lock.Components["spine"] != set.Spine || lock.Components["control_panel"] != set.ControlPanel || lock.Components["ui"] != set.UI ||
		provenance.ReleaseSet.Spine != set.Spine || provenance.ReleaseSet.ControlPanel != set.ControlPanel || provenance.ReleaseSet.UI != set.UI {
		return fmt.Errorf("detached release lock/provenance component pins differ from signed appliance")
	}
	if lock.Market.Source == "" || lock.Market.Branch == "" || len(lock.Market.Commit) != 40 || !isLowerHex(lock.Market.Commit) ||
		lock.Market.Source != provenance.Market.Source || lock.Market.Branch != provenance.Market.Branch || lock.Market.Commit != provenance.Market.Commit {
		return fmt.Errorf("detached release lock Market differs from signed provenance")
	}
	if manifest.Trust.Class != "development" {
		if lock.Market.Source != "https://github.com/YouEye-Platform/Market" || set.Source != "https://github.com/YouEye-Platform/YouEye" ||
			set.Spine.SourceCommit != manifest.SourceCommit || set.ControlPanel.SourceCommit != manifest.SourceCommit || set.UI.SourceCommit != manifest.SourceCommit {
			return fmt.Errorf("public detached release lock must bind official sources and the exact snapshot commit")
		}
	}
	return nil
}
