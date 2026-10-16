package installer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

// New media carries this immutable capability marker. Legacy media and retained
// answers keep their original contract; new media cannot silently use legacy
// appliance discovery when complete System metadata is missing.
const coreSelectionRequiredPath = "/usr/share/youeye/core-selection-required"

func prepareCoreInstallInput(ctx context.Context, input applianceInstallInput, bundle verifiedApplianceBundle, client *http.Client, required bool) (applianceInstallInput, error) {
	if input.CoreRelease == nil && !required {
		return input, nil
	}
	if input.CoreRelease == nil {
		if input.ReleaseCacheSHA256 != "" {
			return input, fmt.Errorf("new media requires a v5 answer binding its existing transport cache to the complete System selection")
		}
		if input.Operation == "resume" {
			return input, fmt.Errorf("resume requires the original signed System answer; supply the retained v5 answer")
		}
		policy := input.ReleasePolicy
		channel := policy.Track
		if policy.Mode == "exact" {
			channel = "exact"
		} else if channel == "branch" {
			channel = "branch:" + policy.Branch
		}
		release, err := resolveApplianceRelease(ctx, client, policy.Provider, policy.ReleasesAPI, channel, policy.ExactTag)
		if err != nil {
			return input, err
		}
		if release.core == nil {
			return input, fmt.Errorf("this media requires a complete signed System release; supply a v5 answer or select a published System release")
		}
		input.CoreRelease = coreAnswerFromRelease(release)
		input.ReleasePolicy.CoreManifestSHA256 = release.coreSHA256
		// Freeze the resolved selection into a new protected runtime answer. Do
		// not modify the supplied answer or select another head after disk writes.
		input.AnswerPath = ""
	}
	if err := validateApplianceReleasePolicy(input.ReleasePolicy); err != nil {
		return input, err
	}
	answer := applianceAnswer{CoreRelease: input.CoreRelease, ReleasePolicy: input.ReleasePolicy}
	if err := validateCoreAnswer(answer); err != nil {
		return input, err
	}
	raw, _ := base64.StdEncoding.Strict().DecodeString(input.CoreRelease.ManifestBase64)
	release, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return input, err
	}
	if err := bindCoreInstallBundle(release, bundle); err != nil {
		return input, err
	}
	if input.ReleasePolicy.Mode == "exact" && input.ReleasePolicy.ManifestSHA256 != bundle.ManifestSHA256 {
		return input, fmt.Errorf("exact System answer differs from the verified media manifest")
	}
	return input, nil
}

func bindCoreInstallBundle(release releasecache.CoreRelease, bundle verifiedApplianceBundle) error {
	for _, member := range release.Members {
		switch member.Role {
		case "appliance":
			if member.Artifact.SHA256 != bundle.ManifestSHA256 || member.BuildVersion != bundle.Manifest.ImageVersion || member.SourceCommit != bundle.Manifest.SourceCommit || member.Source != bundle.Manifest.ReleaseSet.Source || member.Branch != bundle.Manifest.ReleaseSet.Branch {
				return fmt.Errorf("selected System does not contain this signed appliance media; use its matching ISO or an exact selection that contains this media")
			}
		case "spine":
			spine := bundle.Manifest.ReleaseSet.Spine
			if member.Artifact.SHA256 != spine.ArtifactSHA256 || member.BuildVersion != spine.Version || member.SourceCommit != spine.SourceCommit {
				return fmt.Errorf("selected System differs from the media's baked Spine")
			}
		}
		if asset, ok := bundle.Assets[member.Role]; ok && (member.Artifact.SHA256 != asset.Manifest.SHA256 || member.Artifact.SizeBytes != asset.Manifest.SizeBytes) {
			return fmt.Errorf("selected %s differs from verified media bytes", member.Role)
		}
	}
	return nil
}

// Retain selection at the first resumable checkpoint, before writing System A.
// Only signed public metadata and transaction identity are retained here; the
// original answer may also contain credentials and stays on its own medium.
func retainCoreInstallSelectionCommand(assets applianceImageAssets) applianceCommand {
	return applianceCommand{Stage: stageInitializeJournal, Name: "sh", Args: []string{"-c", `set -eu
answer="$1"; state_root="$2"; manifest="$3"
if jq -e '.schema == "youeye.appliance.answer.v5"' "$answer" >/dev/null; then
 install -d -m 0700 "$state_root/installer"
 path="$state_root/installer/core-selection.json"
 jq --arg manifest "$manifest" '{transaction_id,target_serial,release_policy,core_release,manifest_sha256:$manifest}' "$answer" > "$path.tmp"
 chmod 0600 "$path.tmp"; sync -f "$path.tmp"; mv -f "$path.tmp" "$path"; sync -f "$state_root/installer"
fi`, "youeye-retain-core-selection", assets.AnswerPath, stateMount, assets.ManifestSHA256}}
}

func restoreCoreInstallSelection(runner applianceCommandRunner, disk applianceDisk, input applianceInstallInput, manifest string) (applianceInstallInput, error) {
	raw, err := runner.Run("sh", "-c", `set -eu
state="$1"; mountpoint="$2"
mkdir -p "$mountpoint"
mount -o ro,nodev,nosuid,noexec "$state" "$mountpoint"
trap 'umount "$mountpoint"' EXIT
path="$mountpoint/installer/core-selection.json"
[ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%u:%a' "$path")" = 0:600 ]
[ "$(stat -c %s "$path")" -le 2097152 ]
cat "$path"`, "youeye-read-core-selection", partitionPath(disk.Path, 5), "/run/youeye-appliance/resume-state")
	if err != nil {
		return input, fmt.Errorf("original signed System selection unavailable; supply the original v5 answer: %w", err)
	}
	var saved struct {
		TransactionID  string                 `json:"transaction_id"`
		TargetSerial   string                 `json:"target_serial"`
		ManifestSHA256 string                 `json:"manifest_sha256"`
		ReleasePolicy  applianceReleasePolicy `json:"release_policy"`
		CoreRelease    *coreAnswerSelection   `json:"core_release"`
	}
	if len(raw) > 2<<20 || json.Unmarshal([]byte(raw), &saved) != nil || saved.TransactionID != input.TransactionID || !strings.EqualFold(saved.TargetSerial, disk.Serial) || saved.ManifestSHA256 != manifest || saved.CoreRelease == nil {
		return input, fmt.Errorf("retained System selection differs from this installation transaction")
	}
	if input.CoreRelease != nil {
		if !reflect.DeepEqual(input.CoreRelease, saved.CoreRelease) || !reflect.DeepEqual(input.ReleasePolicy, saved.ReleasePolicy) {
			return input, fmt.Errorf("resume answer changed the frozen System selection")
		}
		return input, nil
	}
	input.ReleasePolicy, input.CoreRelease, input.AnswerPath = saved.ReleasePolicy, saved.CoreRelease, ""
	return input, nil
}
