package systemupdate

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func verifyCoreServiceChild(ctx context.Context, parent *os.File, name string, index CorePayloadIndex) error {
	dir, err := openCorePayloadDirectory(int(parent.Fd()), name)
	if err != nil {
		return err
	}
	defer dir.Close()
	return verifyCorePayloadDescriptor(ctx, dir, index)
}

// stageCoreServiceTree exchanges complete directory trees atomically. The old
// tree remains under the owned stage name until accepted retention cleanup.
// Readback of both trees reconciles a lost exchange acknowledgement; partial
// extraction is deliberately unknown and requires the paired recovery path.
func stageCoreServiceTree(ctx context.Context, parent, archive *os.File, r *CoreServiceStage, old, next CorePayloadIndex, save func(CoreServiceStage) error) error {
	if err := old.Validate(); err != nil {
		return err
	}
	if err := next.Validate(); err != nil {
		return err
	}
	base := filepath.Base(r.AppDir)
	if len(r.StageName) < 2 || !coreContainerName.MatchString(base) || !coreContainerName.MatchString(r.StageName[1:]) || r.StageName[0] != '.' || r.ArtifactSHA256 != next.ArtifactSHA256 || r.PreviousSHA256 != old.ArtifactSHA256 {
		return fmt.Errorf("exact core tree identities required")
	}
	if r.Phase == "reused" || r.ArtifactSHA256 == r.PreviousSHA256 {
		if err := verifyCoreServiceChild(ctx, parent, base, next); err != nil {
			return err
		}
		r.Phase = "reused"
		return save(*r)
	}
	switch r.Phase {
	case "prepared":
		if err := verifyCoreServiceChild(ctx, parent, base, old); err != nil {
			return err
		}
		live, err := openCorePayloadDirectory(int(parent.Fd()), base)
		if err != nil {
			return err
		}
		var stat unix.Stat_t
		err = unix.Fstat(int(live.Fd()), &stat)
		live.Close()
		if err != nil || stat.Mode&07000 != 0 {
			return fmt.Errorf("unsafe core application root")
		}
		var expanded uint64 = updateHeadroomBytes
		for _, e := range next.Entries {
			if e.Kind == "file" {
				if uint64(e.Size) > (^uint64(0)-expanded)/2 {
					return fmt.Errorf("core tree capacity overflow")
				}
				expanded += 2 * uint64(e.Size)
			}
		}
		var fs unix.Statfs_t
		if unix.Fstatfs(int(parent.Fd()), &fs) != nil || fs.Bsize <= 0 || uint64(fs.Bavail) > ^uint64(0)/uint64(fs.Bsize) || uint64(fs.Bavail)*uint64(fs.Bsize) < expanded {
			return fmt.Errorf("insufficient core tree staging capacity")
		}
		// A foreign/previous directory must not acquire ownership through our new
		// intent. Once extracting is saved, absence never means safe to repeat.
		var existing unix.Stat_t
		err = unix.Fstatat(int(parent.Fd()), r.StageName, &existing, unix.AT_SYMLINK_NOFOLLOW)
		if err != unix.ENOENT {
			return fmt.Errorf("core stage path already exists or is unavailable")
		}
		r.Phase = "extracting"
		if err = save(*r); err != nil {
			return err
		}
		if err = mkdirCoreMapped(parent, r.StageName, 0700); err != nil {
			return err
		}
		if err = parent.Sync(); err != nil {
			return err
		}
		stage, err := openCorePayloadDirectory(int(parent.Fd()), r.StageName)
		if err != nil {
			return err
		}
		err = extractCorePayload(ctx, archive, stage, next, int(stat.Uid), int(stat.Gid))
		if err == nil {
			err = copyCoreEnvironment(parent, base, stage)
		}
		if err == nil {
			err = unix.Fchown(int(stage.Fd()), int(stat.Uid), int(stat.Gid))
		}
		if err == nil {
			err = unix.Fchmod(int(stage.Fd()), stat.Mode&0777)
		}
		if err == nil {
			err = stage.Sync()
		}
		stage.Close()
		if err != nil {
			return err
		}
		r.Phase = "staged"
		if err = save(*r); err != nil {
			return err
		}
	case "extracting":
		return fmt.Errorf("interrupted core extraction requires paired recovery")
	case "staged", "exchange-requested", "swapped":
	default:
		return fmt.Errorf("unknown core service stage phase")
	}
	if r.Phase == "swapped" {
		if err := verifyCoreServiceChild(ctx, parent, base, next); err != nil {
			return err
		}
		return verifyCoreServiceChild(ctx, parent, r.StageName, old)
	}
	if r.Phase == "exchange-requested" {
		// Atomic exchange has exactly two observable sides. If both prove the
		// acknowledged target/baseline, record the same effect instead of replaying.
		if verifyCoreServiceChild(ctx, parent, base, next) == nil && verifyCoreServiceChild(ctx, parent, r.StageName, old) == nil {
			r.Phase = "swapped"
			return save(*r)
		}
	}
	if err := verifyCoreServiceChild(ctx, parent, base, old); err != nil {
		return err
	}
	if err := verifyCoreServiceChild(ctx, parent, r.StageName, next); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.Phase = "exchange-requested"
	if err := save(*r); err != nil {
		return err
	}
	if err := mutateCoreMapped(parent, func() error {
		return unix.Renameat2(int(parent.Fd()), base, int(parent.Fd()), r.StageName, unix.RENAME_EXCHANGE)
	}); err != nil {
		return fmt.Errorf("core tree exchange requires reconciliation")
	}
	if err := parent.Sync(); err != nil {
		return err
	}
	if err := verifyCoreServiceChild(ctx, parent, base, next); err != nil {
		return err
	}
	if err := verifyCoreServiceChild(ctx, parent, r.StageName, old); err != nil {
		return err
	}
	r.Phase = "swapped"
	return save(*r)
}

func copyCoreEnvironment(parent *os.File, base string, stage *os.File) error {
	live, err := openCorePayloadDirectory(int(parent.Fd()), base)
	if err != nil {
		return err
	}
	defer live.Close()
	fd, err := unix.Openat(int(live.Fd()), ".env", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err == unix.ENOENT {
		return nil
	}
	if err != nil {
		return fmt.Errorf("live core configuration is not a plain file")
	}
	source := os.NewFile(uintptr(fd), "core-environment")
	defer source.Close()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&07022 != 0 || stat.Size > 1<<20 {
		return fmt.Errorf("unsafe live core configuration")
	}
	dest, err := openCoreMappedExclusive(stage, ".env", 0600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(dest), "core-environment")
	defer file.Close()
	n, err := io.Copy(file, io.LimitReader(source, stat.Size+1))
	if err != nil || n != stat.Size {
		return fmt.Errorf("live core configuration changed")
	}
	var after unix.Stat_t
	if unix.Fstat(fd, &after) != nil || stat.Size != after.Size || stat.Mtim != after.Mtim || stat.Ctim != after.Ctim {
		return fmt.Errorf("live core configuration changed")
	}
	if err = unix.Fchown(dest, int(stat.Uid), int(stat.Gid)); err != nil {
		return err
	}
	if err = unix.Fchmod(dest, stat.Mode&0777); err != nil {
		return err
	}
	return file.Sync()
}
