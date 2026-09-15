package installer

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

type installedApplianceIdentity struct {
	ImageVersion string
}

func inspectInstalledApplianceIdentity(runner applianceCommandRunner, target applianceDisk, trustKeyPath string) (*installedApplianceIdentity, error) {
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
signature="$mountpoint/installer/appliance-manifest.json.sig"
if [ ! -f "$manifest" ] || [ ! -f "$signature" ]; then
  exit 0
fi
base64 -w0 "$manifest"
printf '\n'
base64 -w0 "$signature"
printf '\n'`
	out, err := runner.Run("sh", "-c", script, "youeye-read-installed-identity", state, "/run/youeye-appliance/installed-state")
	if err != nil {
		return nil, fmt.Errorf("inspect installed appliance ordering identity: %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		return nil, fmt.Errorf("installed appliance ordering identity is malformed")
	}
	raw, err := base64.StdEncoding.DecodeString(lines[0])
	if err != nil {
		return nil, fmt.Errorf("decode installed appliance manifest: %w", err)
	}
	signatureRaw, err := base64.StdEncoding.DecodeString(lines[1])
	if err != nil {
		return nil, fmt.Errorf("decode installed appliance signature: %w", err)
	}
	signature, err := parseEd25519Signature(signatureRaw)
	if err != nil {
		return nil, err
	}
	publicKey, err := readEd25519PublicKey(trustKeyPath)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(publicKey, raw, signature) {
		return nil, fmt.Errorf("installed appliance manifest signature is not valid")
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
