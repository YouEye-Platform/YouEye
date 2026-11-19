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

// optionalCoreSelection reads the accepted bootstrap selection. Only a host
// without bootstrap State (a mutable host) has none; a selection that the
// release policy names must be present and valid.
func optionalCoreSelection(root string) (*releasecache.CoreRelease, string, error) {
	release, digest, err := systemupdate.ReadCoreSelection(root)
	if os.IsNotExist(err) {
		if _, statErr := os.Lstat(filepath.Join(root, "core-release.json")); os.IsNotExist(statErr) {
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

// InstalledIdentity is what a packaged Control Panel or UI says about itself
// in its version.json: the git tree it was built from (builds from 0.6.12 on)
// and a version.
type InstalledIdentity struct {
	Version    string `json:"version"`
	SourceTree string `json:"source_tree"`
}

// MatchesMember reports whether an installed tree with this identity is the
// release's member. The git tree decides. A tree built before 0.6.12 does not
// say its tree; it is then compared by its version with the member's build
// name, which only documents up to 0.6.12 carry.
func (i InstalledIdentity) MatchesMember(member releasecache.CoreMember) error {
	if i.SourceTree != "" {
		if i.SourceTree != member.SourceTree {
			return fmt.Errorf("installed tree was built from %.12s, the selected release member from %.12s", i.SourceTree, member.SourceTree)
		}
		return nil
	}
	if member.BuildVersion == "" {
		return fmt.Errorf("installed tree %q does not say which source tree it was built from", i.Version)
	}
	if i.Version != member.BuildVersion {
		return fmt.Errorf("installed version %q does not match selected release member %q", i.Version, member.BuildVersion)
	}
	return nil
}

// Reconciliation checks the installed CP against the selected CP member, not
// the shared assembly version or the CP recorded by reused installation
// media. The immutable host must still be that selection's image.
func verifyExistingControlVersion(installed InstalledIdentity, image appliance.Manifest, root string) error {
	if image.ReleaseSet == nil {
		return fmt.Errorf("Control Panel reconciliation requires sealed image provenance")
	}
	selected, _, err := optionalCoreSelection(root)
	if err != nil {
		return err
	}
	if selected == nil {
		return fmt.Errorf("Control Panel reconciliation requires the accepted System selection")
	}
	if err := systemupdate.BindCoreImage(*selected, image); err != nil {
		return err
	}
	member, ok := selected.Member("cp")
	if !ok {
		return fmt.Errorf("the accepted System selection has no Control Panel")
	}
	if err := installed.MatchesMember(member); err != nil {
		return fmt.Errorf("existing Control Panel is not the selected release's (%v); update the Control Panel through its release channel before resuming deployment", err)
	}
	return nil
}

// Carry the exact accepted bytes to CP for its UI-role digest verification.
func stageCoreSelection(containerName string) error {
	release, digest, err := optionalCoreSelection(systemupdate.CoreBootstrapPath)
	if err != nil {
		return fmt.Errorf("verify core selection before CP handoff: %w", err)
	}
	if release == nil {
		return nil
	}
	selection, err := systemupdate.ReadCoreBootstrapSelection(systemupdate.CoreBootstrapPath)
	if err != nil {
		return err
	}
	_, actual, err := releasecache.ParseCoreRelease(selection.Raw)
	if err != nil || actual != digest {
		return fmt.Errorf("selected core changed before CP handoff")
	}
	// No container mutation precedes the digest check above.
	root := "/var/lib/youeye-state/core-selection"
	if err := util.RunIncusExec(containerName, "mkdir", "-p", root); err != nil {
		return err
	}
	if err := util.RunIncusExec(containerName, "chmod", "0700", root); err != nil {
		return err
	}
	inputs, err := retainCoreHandoffInputs(selection)
	if err != nil {
		return err
	}
	defer os.RemoveAll(inputs)
	for _, name := range []string{"core-release.json"} {
		if _, err := util.RunCmdCapture("incus", "file", "push", filepath.Join(inputs, name), containerName+root+"/"+name); err != nil {
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

func retainCoreHandoffInputs(selection systemupdate.CoreHostSelection) (string, error) {
	root, err := os.MkdirTemp("", "youeye-core-handoff-*")
	if err != nil {
		return "", err
	}
	for name, raw := range map[string][]byte{"core-release.json": selection.Raw} {
		if err = os.WriteFile(filepath.Join(root, name), raw, 0600); err != nil {
			os.RemoveAll(root)
			return "", err
		}
	}
	return root, nil
}
