package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func verifyCoreServiceChild(ctx context.Context, parent *os.File, name string, index CorePayloadIndex, mode CorePayloadMode) (CorePayloadFindings, error) {
	dir, err := openCorePayloadDirectory(int(parent.Fd()), name)
	if err != nil {
		return CorePayloadFindings{}, err
	}
	defer dir.Close()
	return verifyCorePayloadDescriptor(ctx, dir, index, mode)
}

// coreTreeHoldsExactly: the child holds every recorded file of the index,
// unchanged. A tree that cannot be opened or walked is an error, not "no".
func coreTreeHoldsExactly(ctx context.Context, parent *os.File, name string, index CorePayloadIndex) (bool, CorePayloadFindings, error) {
	found, err := verifyCoreServiceChild(ctx, parent, name, index, CorePayloadStrict)
	var differs *CorePayloadDifferenceError
	if errors.As(err, &differs) {
		return false, found, nil
	}
	return err == nil, found, err
}

// stageCoreServiceTree exchanges complete directory trees atomically. The old
// tree remains under the owned stage name. Partial extraction is deliberately
// unknown and requires the paired recovery path.
//
// Which side is checked how: the tree this request writes (the extracted stage,
// then the application directory after the exchange) is checked strictly
// against the next index. The tree this request did not write (the installed
// application directory before the exchange, the same tree under the stage name
// afterwards, and a reused member) is walked in record mode: it may hold files
// we did not ship, changed files or be missing files, and it is replaced or
// reused as it is. Record mode still requires that directory to exist.
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
		// A reused member is reused as it is. Its differences were recorded by
		// verify-members and are recorded again by authenticated-health.
		if _, err := verifyCoreServiceChild(ctx, parent, base, next, CorePayloadRecord); err != nil {
			return err
		}
		r.Phase = "reused"
		return save(*r)
	}
	switch r.Phase {
	case "prepared":
		if _, err := verifyCoreServiceChild(ctx, parent, base, old, CorePayloadRecord); err != nil {
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
		if _, err := verifyCoreServiceChild(ctx, parent, base, next, CorePayloadStrict); err != nil {
			return err
		}
		_, err := verifyCoreServiceChild(ctx, parent, r.StageName, old, CorePayloadRecord)
		return err
	}
	if r.Phase == "exchange-requested" {
		// The exchange was requested and its acknowledgement lost. The old tree
		// proves nothing (it is not checked strictly, and it may even hold all of
		// next's files), so the decision rests on the tree this request wrote:
		// the exchange happened when the application directory holds exactly
		// next's files and the stage does not. When both hold them, the freshly
		// extracted tree is the one without extra files; an application directory
		// with none is as good as that extraction, so nothing is exchanged again.
		// Whatever is decided, the request ends with an application directory
		// that passed the strict check against next, or with an error.
		baseNext, baseFound, err := coreTreeHoldsExactly(ctx, parent, base, next)
		if err != nil {
			return err
		}
		stageNext, _, err := coreTreeHoldsExactly(ctx, parent, r.StageName, next)
		if err != nil {
			return err
		}
		if baseNext && (!stageNext || baseFound.Unrecorded == 0) {
			r.Phase = "swapped"
			return save(*r)
		}
	}
	if _, err := verifyCoreServiceChild(ctx, parent, base, old, CorePayloadRecord); err != nil {
		return err
	}
	if _, err := verifyCoreServiceChild(ctx, parent, r.StageName, next, CorePayloadStrict); err != nil {
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
	if _, err := verifyCoreServiceChild(ctx, parent, base, next, CorePayloadStrict); err != nil {
		return err
	}
	if _, err := verifyCoreServiceChild(ctx, parent, r.StageName, old, CorePayloadRecord); err != nil {
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
