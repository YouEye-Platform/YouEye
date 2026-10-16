package systemupdate

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// CP needs the complete current selection even when its own payload is reused.
// Both files remain behind the service hold until this pair is verified. A
// crash between their atomic renames leaves a recorded, reconcilable partial
// pair; it cannot expose an unsigned or silently re-resolved selection.
func installCoreServiceSelection(root *os.File, r *CoreServiceStage, previous, next CoreHostSelection, save func(CoreServiceStage) error) error {
	if r.Role != "cp" || (r.Phase != "swapped" && r.Phase != "reused") || fmt.Sprintf("%x", sha256.Sum256(next.Raw)) != r.ManifestSHA256 {
		return fmt.Errorf("verified CP core selection required")
	}
	if r.SelectionState != "" && r.SelectionState != "requested" && r.SelectionState != "installed" {
		return fmt.Errorf("unknown CP selection state")
	}
	dir, err := openCorePayloadDirectory(int(root.Fd()), "var/lib/youeye-state/core-selection")
	if err != nil {
		return err
	}
	defer dir.Close()
	type part struct {
		name     string
		old, new []byte
		limit    int64
	}
	parts := []part{{"core-release.json", previous.Raw, next.Raw, 1 << 20}, {"core-release.json.sig", previous.Signature, next.Signature, 64}}
	for _, p := range parts {
		actual, err := readCoreContainerStateAtLimit(dir, p.name, p.limit)
		if err != nil {
			return err
		}
		isNew := bytes.Equal(actual, p.new)
		if r.SelectionState == "installed" {
			if !isNew {
				return fmt.Errorf("installed CP selection changed")
			}
			continue
		}
		if !bytes.Equal(actual, p.old) && !(r.SelectionState == "requested" && isNew) {
			return fmt.Errorf("CP selection differs from retained transition")
		}
	}
	if r.SelectionState == "installed" {
		return nil
	}
	r.SelectionState = "requested"
	if err = save(*r); err != nil {
		return err
	}
	for _, p := range parts {
		if err = writeCoreContainerFileAt(dir, p.name, r.StageName+"."+p.name, p.new, p.limit); err != nil {
			return err
		}
	}
	r.SelectionState = "installed"
	return save(*r)
}

func writeCoreContainerFileAt(dir *os.File, name, temp string, data []byte, limit int64) error {
	if len(data) == 0 || int64(len(data)) > limit {
		return fmt.Errorf("invalid core state write bound")
	}
	actual, err := readCoreContainerStateAtLimit(dir, name, limit)
	if err == nil && bytes.Equal(actual, data) {
		return nil
	}
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	existing, err := readCoreContainerStateAtLimit(dir, temp, limit)
	if err == nil {
		if !bytes.Equal(existing, data) {
			return fmt.Errorf("interrupted core state differs; paired recovery required")
		}
	} else if errors.Is(err, unix.ENOENT) {
		var owner unix.Stat_t
		if unix.Fstat(int(dir.Fd()), &owner) != nil || owner.Mode&0022 != 0 {
			return fmt.Errorf("unsafe core state directory")
		}
		fd, err := openCoreMappedExclusive(dir, temp, 0600)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), "core-state")
		_, err = file.Write(data)
		if err == nil {
			err = unix.Fchown(fd, int(owner.Uid), int(owner.Gid))
		}
		if err == nil {
			err = file.Sync()
		}
		file.Close()
		if err != nil {
			return err
		}
	} else {
		return err
	}
	if err = mutateCoreMapped(dir, func() error {
		return unix.Renameat(int(dir.Fd()), temp, int(dir.Fd()), name)
	}); err != nil {
		return err
	}
	return dir.Sync()
}
