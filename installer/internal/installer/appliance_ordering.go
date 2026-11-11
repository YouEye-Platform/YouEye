package installer

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

type installedApplianceIdentity struct {
	ImageVersion string
}

// inspectInstalledApplianceIdentity reads the image manifest a previous
// install recorded on YE-STATE. It was bound by digest when it was installed.
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
printf '\n'`
	out, err := runner.Run("sh", "-c", script, "youeye-read-installed-identity", state, "/run/youeye-appliance/installed-state")
	if err != nil {
		return nil, fmt.Errorf("inspect installed appliance ordering identity: %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
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
	return &installedApplianceIdentity{ImageVersion: envelope.ImageVersion}, nil
}
