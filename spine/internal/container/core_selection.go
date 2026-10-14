package container

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

// A missing legacy selection is allowed; incomplete new-format state is not.
func optionalCoreSelection(root, trustPath string) (*releasecache.CoreRelease, string, error) {
	release, digest, err := systemupdate.ReadCoreSelection(root, trustPath)
	if os.IsNotExist(err) {
		if _, statErr := os.Lstat(filepath.Join(root, "core-release.json")); os.IsNotExist(statErr) {
			if _, sigErr := os.Lstat(filepath.Join(root, "core-release.json.sig")); !os.IsNotExist(sigErr) {
				return nil, "", fmt.Errorf("selected core manifest is missing")
			}
			policy, policyErr := systemupdate.LoadReleasePolicy(filepath.Join(root, "release-policy.json"))
			if policyErr != nil && !errors.Is(policyErr, os.ErrNotExist) {
				return nil, "", policyErr
			}
			if policyErr == nil && policy.CoreManifestSHA256 != "" {
				return nil, "", fmt.Errorf("fresh core policy requires its retained selected manifest")
			}
			return nil, "", nil
		}
	}
	if err != nil {
		return nil, "", fmt.Errorf("verify core selection: %w", err)
	}
	return &release, digest, nil
}

// Reconciliation uses the selected CP payload's build version, not the shared
// assembly version or the CP version recorded by reused installation media.
// The immutable host and baked Spine must still match that signed selection.
func verifyExistingControlVersion(installed string, image appliance.Manifest, root, trustPath string) error {
	if image.ReleaseSet == nil {
		return fmt.Errorf("Control Panel reconciliation requires sealed image provenance")
	}
	selected, _, err := optionalCoreSelection(root, trustPath)
	if err != nil {
		return err
	}
	expected := image.ReleaseSet.ControlPanel.Version
	if selected != nil {
		if err := systemupdate.BindCoreImage(*selected, image); err != nil {
			return err
		}
		expected = ""
		for _, member := range selected.Members {
			if member.Role == "cp" {
				expected = member.BuildVersion
			}
		}
	}
	if expected == "" || installed != expected {
		return fmt.Errorf("existing Control Panel version %q does not match selected release member %q; update the Control Panel through its signed channel before resuming deployment", installed, expected)
	}
	return nil
}

// Carry exact signed bytes to CP for its independent UI-role verification.
func stageCoreSelection(containerName string) error {
	release, digest, err := optionalCoreSelection(systemupdate.CoreBootstrapPath, systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return fmt.Errorf("verify core selection before CP handoff: %w", err)
	}
	if release == nil {
		return nil
	}
	root := "/var/lib/youeye-state/core-selection"
	if err := util.RunIncusExec(containerName, "mkdir", "-p", root); err != nil {
		return err
	}
	if err := util.RunIncusExec(containerName, "chmod", "0700", root); err != nil {
		return err
	}
	for _, name := range []string{"core-release.json", "core-release.json.sig"} {
		if _, err := util.RunCmdCapture("incus", "file", "push", filepath.Join(systemupdate.CoreBootstrapPath, name), containerName+root+"/"+name); err != nil {
			return err
		}
		if err := util.RunIncusExec(containerName, "chmod", "0600", root+"/"+name); err != nil {
			return err
		}
	}
	var artifact string
	for _, member := range release.Members {
		if member.Role == "cp" {
			artifact = member.Artifact.SHA256
		}
	}
	if artifact == "" {
		return fmt.Errorf("selected core has no CP member")
	}
	marker, err := json.Marshal(map[string]string{"schema": "youeye.core-component.v1", "role": "cp", "requestId": "install-" + digest, "manifestSHA256": digest, "artifactSHA256": artifact})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp("", "youeye-core-component-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(marker); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := util.RunIncusExec(containerName, "mkdir", "-p", "/etc/youeye"); err != nil {
		return err
	}
	if _, err := util.RunCmdCapture("incus", "file", "push", temporary.Name(), containerName+"/etc/youeye/.core-component.install.json"); err != nil {
		return err
	}
	script := `set -e
 target=/etc/youeye/core-component.json
 staged=/etc/youeye/.core-component.install.json
 chmod 0600 "$staged"
 chown 0:0 "$staged"
 if test -e "$target" || test -L "$target"; then test -f "$target" && test ! -L "$target" && cmp -s "$target" "$staged"; fi
 mv "$staged" "$target"
 sync -f /etc/youeye`
	return util.RunIncusExec(containerName, "sh", "-c", script)
}
