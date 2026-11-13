package installer

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

// Every built image and installer ISO carries this marker, so a real install
// always freezes a complete System selection before disk writes. Only the
// provider test fixtures run without it.
const coreSelectionRequiredPath = "/usr/share/youeye/core-selection-required"

func prepareCoreInstallInput(ctx context.Context, input applianceInstallInput, bundle verifiedApplianceBundle, client *http.Client, required bool) (applianceInstallInput, error) {
	if input.CoreRelease == nil && !required {
		return input, nil
	}
	if input.CoreRelease == nil {
		if input.ReleaseCacheSHA256 != "" {
			return input, fmt.Errorf("new media requires an answer binding its existing transport cache to the complete System selection")
		}
		if input.Operation == "resume" {
			return input, fmt.Errorf("resume requires the original System answer; supply the retained answer")
		}
		policy := input.ReleasePolicy
		release, err := resolveApplianceRelease(ctx, client, policy.Repository, policy.Channel, "", "")
		if err != nil {
			return input, err
		}
		if release.core == nil {
			return input, fmt.Errorf("this media requires a complete System release; supply an answer or select a published System release")
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
	release, _, err := decodeCoreAnswer(input.CoreRelease)
	if err != nil {
		return input, err
	}
	if err := bindCoreInstallBundle(release, bundle); err != nil {
		return input, err
	}
	return input, nil
}

func bindCoreInstallBundle(release releasecache.CoreRelease, bundle verifiedApplianceBundle) error {
	for _, member := range release.Members {
		switch member.Role {
		case "appliance":
			if member.Artifact.SHA256 != bundle.ManifestSHA256 || member.BuildVersion != bundle.Manifest.ImageVersion || member.SourceTree != bundle.Manifest.SourceTree {
				return fmt.Errorf("selected System does not contain this appliance media; use its matching ISO or an exact selection that contains this media")
			}
		}
		if asset, ok := bundle.Assets[member.Role]; ok && (member.Artifact.SHA256 != asset.Manifest.SHA256 || member.Artifact.SizeBytes != asset.Manifest.SizeBytes) {
			return fmt.Errorf("selected %s differs from verified media bytes", member.Role)
		}
	}
	return nil
}

// Retain selection at the first resumable checkpoint, before writing System A.
// Only the public release document and transaction identity are retained; the
// original answer may also contain credentials and stays on its own medium.
func retainCoreInstallSelectionCommand(assets applianceImageAssets) applianceCommand {
	return applianceCommand{Stage: stageInitializeJournal, Name: "sh", Args: []string{"-c", `set -eu
answer="$1"; state_root="$2"; manifest="$3"
if jq -e '.schema == "youeye.appliance.answer.v1" and .core_release != null' "$answer" >/dev/null; then
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
[ "$(stat -c '%h' "$path")" = 1 ]
[ "$(stat -c %s "$path")" -le 18874368 ]
cat "$path"`, "youeye-read-core-selection", partitionPath(disk.Path, 5), "/run/youeye-appliance/resume-state")
	if err != nil {
		return input, fmt.Errorf("original System selection unavailable; supply the original answer: %w", err)
	}
	var saved struct {
		TransactionID  string                 `json:"transaction_id"`
		TargetSerial   string                 `json:"target_serial"`
		ManifestSHA256 string                 `json:"manifest_sha256"`
		ReleasePolicy  applianceReleasePolicy `json:"release_policy"`
		CoreRelease    *coreAnswerSelection   `json:"core_release"`
	}
	if len(raw) > 18<<20 || json.Unmarshal([]byte(raw), &saved) != nil || saved.TransactionID != input.TransactionID || !strings.EqualFold(saved.TargetSerial, disk.Serial) || saved.ManifestSHA256 != manifest || saved.CoreRelease == nil {
		return input, fmt.Errorf("retained System selection differs from this installation transaction")
	}
	if err := validateCoreAnswer(applianceAnswer{CoreRelease: saved.CoreRelease, ReleasePolicy: saved.ReleasePolicy}); err != nil {
		return input, err
	}
	if input.CoreRelease != nil {
		if input.CoreRelease.ManifestBase64 != saved.CoreRelease.ManifestBase64 || input.CoreRelease.ManifestSHA256 != saved.CoreRelease.ManifestSHA256 || !reflect.DeepEqual(input.ReleasePolicy, saved.ReleasePolicy) {
			return input, fmt.Errorf("resume answer changed the frozen System selection")
		}
		return input, nil
	}
	input.ReleasePolicy, input.CoreRelease, input.AnswerPath = saved.ReleasePolicy, saved.CoreRelease, ""
	return input, nil
}
