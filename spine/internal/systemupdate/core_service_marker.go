package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

type coreComponentMarker struct {
	Schema         string `json:"schema"`
	Role           string `json:"role"`
	RequestID      string `json:"requestId"`
	ManifestSHA256 string `json:"manifestSHA256"`
	ArtifactSHA256 string `json:"artifactSHA256"`
}

func readCoreContainerStateAt(dir *os.File, name string) ([]byte, error) {
	return readCoreContainerStateAtLimit(dir, name, 16384)
}

func readCoreContainerStateAtLimit(dir *os.File, name string, limit int64) ([]byte, error) {
	var owner unix.Stat_t
	if unix.Fstat(int(dir.Fd()), &owner) != nil || owner.Mode&0022 != 0 {
		return nil, fmt.Errorf("unsafe core component state directory")
	}
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "core-component-state")
	defer file.Close()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&07777 != 0600 || stat.Uid != owner.Uid || stat.Size < 1 || stat.Size > limit {
		return nil, fmt.Errorf("unsafe core component state file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, fmt.Errorf("invalid core component state file")
	}
	return raw, nil
}

func installCoreComponentMarker(root *os.File, j CoreJournal, r *CoreServiceStage, save func(CoreServiceStage) error) error {
	dir, err := openCorePayloadDirectory(int(root.Fd()), "etc/youeye")
	if err != nil {
		return err
	}
	defer dir.Close()
	raw, err := readCoreContainerStateAt(dir, "core-component.json")
	if err != nil {
		return err
	}
	var old coreComponentMarker
	if json.Unmarshal(raw, &old) != nil || old.Schema != "youeye.core-component.v1" || old.Role != r.Role || !coreRequestPattern.MatchString(old.RequestID) || !validSHA256(old.ManifestSHA256) || !validSHA256(old.ArtifactSHA256) {
		return fmt.Errorf("invalid existing core component marker")
	}
	if r.Phase == "reused" {
		if old.ArtifactSHA256 != r.ArtifactSHA256 {
			return fmt.Errorf("reused core marker differs")
		}
		return nil // retain its completed schema identity; do not run it again
	}
	if r.Phase != "swapped" {
		return fmt.Errorf("verified core tree exchange required before marker")
	}
	target := coreComponentMarker{Schema: "youeye.core-component.v1", Role: r.Role, RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, ArtifactSHA256: r.ArtifactSHA256}
	if r.MarkerState == "installed" {
		if old != target {
			return fmt.Errorf("installed core component marker changed")
		}
		return nil
	}
	if r.MarkerState != "" && r.MarkerState != "requested" {
		return fmt.Errorf("unknown core marker state")
	}
	if old == target {
		if r.MarkerState != "requested" {
			return fmt.Errorf("core marker advanced without recorded intent")
		}
		r.MarkerState = "installed"
		return save(*r)
	}
	if old.ArtifactSHA256 != r.PreviousSHA256 {
		return fmt.Errorf("existing core marker belongs to another payload")
	}
	r.MarkerState = "requested"
	if err = save(*r); err != nil {
		return err
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return err
	}
	temp := r.StageName + ".marker"
	existing, err := readCoreContainerStateAt(dir, temp)
	if err == nil {
		var retained coreComponentMarker
		if json.Unmarshal(existing, &retained) != nil || retained != target {
			return fmt.Errorf("interrupted marker differs; paired recovery required")
		}
	} else if errors.Is(err, unix.ENOENT) {
		var owner unix.Stat_t
		if unix.Fstat(int(dir.Fd()), &owner) != nil {
			return fmt.Errorf("core state ownership unavailable")
		}
		fd, err := unix.Openat(int(dir.Fd()), temp, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), "core-component-marker")
		_, err = file.Write(encoded)
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
	if err = unix.Renameat(int(dir.Fd()), temp, int(dir.Fd()), "core-component.json"); err != nil {
		return err
	}
	if err = dir.Sync(); err != nil {
		return err
	}
	r.MarkerState = "installed"
	return save(*r)
}
