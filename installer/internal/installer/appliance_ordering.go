package installer

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

// installedApplianceIdentity describes an existing installation. ImageVersion
// is the image's internal identity: it orders images (preserve reinstall needs
// a newer one) and is never shown. ReleaseVersion is the name of the release
// the box recorded on State, for display; empty when State has none readable.
type installedApplianceIdentity struct {
	ImageVersion   string
	ReleaseVersion string
}

// label names the installation for the owner: the prefix, then the recorded
// release version when State had one. The image identity is never shown.
func (identity installedApplianceIdentity) label(prefix, separator string) string {
	if identity.ReleaseVersion == "" {
		return prefix
	}
	return prefix + separator + identity.ReleaseVersion
}

// inspectInstalledApplianceIdentity reads the image manifest a previous
// install recorded on YE-STATE (bound by digest when it was installed) and the
// version of the release the box runs: the committed receipt's, else the
// release selected at install time, as the console screen does.
func inspectInstalledApplianceIdentity(runner applianceCommandRunner, target applianceDisk) (*installedApplianceIdentity, error) {
	state := partitionPath(target.Path, 5)
	script := `set -eu
state="$1"
mountpoint="$2"
mkdir -p "$mountpoint"
umount "$mountpoint" 2>/dev/null || true
if ! mount -o ro,nodev,nosuid "$state" "$mountpoint" 2>/dev/null; then
  exit 0
fi
trap 'umount "$mountpoint" 2>/dev/null || true' EXIT
manifest="$mountpoint/installer/appliance-manifest.json"
if [ ! -f "$manifest" ]; then
  exit 0
fi
base64 -w0 "$manifest"
printf '\n'
release=$(jq -r '.release.version // empty' "$mountpoint/core-update/committed.json" 2>/dev/null | head -n 1) || release=
if [ -z "$release" ]; then
  release=$(jq -r '.version // empty' "$mountpoint/bootstrap/core-release.json" 2>/dev/null | head -n 1) || release=
fi
printf '%s\n' "$release"`
	out, err := runner.Run("sh", "-c", script, "youeye-read-installed-identity", state, "/run/youeye-appliance/installed-state")
	if err != nil {
		return nil, fmt.Errorf("inspect installed appliance ordering identity: %w", err)
	}
	return parseInstalledApplianceIdentity(out)
}

// parseInstalledApplianceIdentity reads the inspection output: the manifest in
// base64 on the first line, then the recorded release version (may be absent).
// A release version that is not a release name is dropped, never an error: it
// is only shown.
func parseInstalledApplianceIdentity(out string) (*installedApplianceIdentity, error) {
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	encoded, release, _ := strings.Cut(strings.TrimSpace(out), "\n")
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("decode installed appliance manifest: %w", err)
	}
	var envelope struct {
		Schema       string `json:"schema"`
		ImageVersion string `json:"image_version"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode installed appliance manifest identity: %w", err)
	}
	if envelope.Schema != applianceBundleSchema {
		return nil, fmt.Errorf("installed appliance manifest schema %q is unsupported", envelope.Schema)
	}
	if strings.TrimSpace(envelope.ImageVersion) == "" {
		return nil, fmt.Errorf("installed appliance manifest identity is incomplete")
	}
	release = strings.TrimSpace(release)
	if _, err := ordering.ParseReleaseVersion(release); err != nil {
		release = ""
	}
	return &installedApplianceIdentity{ImageVersion: envelope.ImageVersion, ReleaseVersion: release}, nil
}
