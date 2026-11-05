package systemupdate

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path"
	"sort"

	"golang.org/x/sys/unix"
)

// extractCorePayload writes only into an already-created, operation-owned empty
// directory. It never executes tar, Node or any other container binary. Caller
// journals creation before this function; an interrupted extraction is not an
// absent attempt and is never silently discarded or restarted.
func extractCorePayload(ctx context.Context, archive *os.File, destination *os.File, index CorePayloadIndex, uid, gid int) error {
	if err := index.Validate(); err != nil {
		return err
	}
	if uid < 0 || gid < 0 {
		return fmt.Errorf("mapped core filesystem ownership required")
	}
	hash := sha256.New()
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if _, err := io.Copy(hash, archive); err != nil {
		return err
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != index.ArtifactSHA256 {
		return fmt.Errorf("staged core archive digest differs")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	children, err := destination.ReadDir(1)
	if err != io.EOF || len(children) != 0 {
		return fmt.Errorf("core staging directory is not empty")
	}
	entries := make(map[string]CorePayloadEntry, len(index.Entries))
	dirs := []CorePayloadEntry{}
	for _, e := range index.Entries {
		entries[e.Path] = e
		if e.Kind == "directory" {
			dirs = append(dirs, e)
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Path < dirs[j].Path })
	for _, e := range dirs {
		parent, name, err := corePayloadParent(destination, e.Path)
		if err != nil {
			return err
		}
		err = mkdirCoreMapped(parent, name, 0700)
		if err == nil {
			var sub *os.File
			sub, err = openCorePayloadDirectory(int(parent.Fd()), name)
			if err == nil {
				err = unix.Fchown(int(sub.Fd()), uid, gid)
				sub.Close()
			}
		}
		parent.Close()
		if err != nil {
			return fmt.Errorf("core staging directory creation failed")
		}
	}
	reader := tar.NewReader(archive)
	seen := map[string]bool{}
	hardlinks := map[string]string{}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name, err := cleanPayloadPath(header.Name)
		if err != nil {
			return err
		}
		if name == "." && header.Typeflag == tar.TypeDir {
			continue
		}
		e, ok := entries[name]
		if !ok || seen[name] {
			return fmt.Errorf("core archive changed after indexing")
		}
		seen[name] = true
		switch header.Typeflag {
		case tar.TypeDir:
			if e.Kind != "directory" || header.Mode != e.Mode {
				return fmt.Errorf("core archive directory differs")
			}
		case tar.TypeReg, tar.TypeRegA:
			if e.Kind != "file" || header.Mode != e.Mode || header.Size != e.Size {
				return fmt.Errorf("core archive file differs")
			}
			parent, base, err := corePayloadParent(destination, name)
			if err != nil {
				return err
			}
			fd, err := openCoreMappedExclusive(parent, base, 0600)
			parent.Close()
			if err != nil {
				return fmt.Errorf("core staging file creation failed")
			}
			file := os.NewFile(uintptr(fd), base)
			hash := sha256.New()
			n, err := io.CopyN(io.MultiWriter(file, hash), reader, e.Size)
			if err == nil && (n != e.Size || fmt.Sprintf("%x", hash.Sum(nil)) != e.SHA256) {
				err = fmt.Errorf("core staged bytes differ")
			}
			if err == nil {
				err = unix.Fchown(fd, uid, gid)
			}
			if err == nil {
				err = unix.Fchmod(fd, uint32(e.Mode))
			}
			if err == nil {
				err = file.Sync()
			}
			file.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if e.Kind != "symlink" || header.Linkname != e.Link {
				return fmt.Errorf("core archive link differs")
			}
			parent, base, err := corePayloadParent(destination, name)
			if err != nil {
				return err
			}
			err = symlinkCoreMapped(parent, e.Link, base)
			if err == nil {
				err = unix.Fchownat(int(parent.Fd()), base, uid, gid, unix.AT_SYMLINK_NOFOLLOW)
			}
			parent.Close()
			if err != nil {
				return err
			}
		case tar.TypeLink:
			target, err := cleanPayloadPath(header.Linkname)
			if err != nil {
				return err
			}
			original, ok := entries[target]
			if !ok || original.Kind != "file" || e.Kind != "file" || e.Size != original.Size || e.Mode != original.Mode || e.SHA256 != original.SHA256 {
				return fmt.Errorf("core hardlink differs")
			}
			hardlinks[name] = target
		default:
			return fmt.Errorf("core archive special file refused")
		}
	}
	for name, target := range hardlinks {
		if _, nested := hardlinks[target]; nested {
			return fmt.Errorf("core hardlink chain refused")
		}
		parent, base, err := corePayloadParent(destination, name)
		if err != nil {
			return err
		}
		source, sourceBase, err := corePayloadParent(destination, target)
		if err != nil {
			parent.Close()
			return err
		}
		err = mutateCoreMapped(parent, func() error {
			return unix.Linkat(int(source.Fd()), sourceBase, int(parent.Fd()), base, 0)
		})
		source.Close()
		parent.Close()
		if err != nil {
			return err
		}
	}
	// Finalize permissions bottom-up after writes; mode-000 directories cannot
	// prevent the host from constructing children or weaken the signed modes.
	for i := len(dirs) - 1; i >= 0; i-- {
		sub, err := openCorePayloadDirectory(int(destination.Fd()), dirs[i].Path)
		if err != nil {
			return err
		}
		err = unix.Fchmod(int(sub.Fd()), uint32(dirs[i].Mode))
		if err == nil {
			err = sub.Sync()
		}
		sub.Close()
		if err != nil {
			return err
		}
	}
	if err := destination.Sync(); err != nil {
		return err
	}
	// A fresh descriptor resets the directory cursor and verifies every result,
	// including implicit directories and flattened hardlinks.
	fd, err := unix.Openat(int(destination.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	verify := os.NewFile(uintptr(fd), "core-stage")
	defer verify.Close()
	return verifyCorePayloadDescriptor(ctx, verify, index)
}

func corePayloadParent(root *os.File, name string) (*os.File, string, error) {
	parent := path.Dir(name)
	if parent == "." {
		fd, err := unix.Openat(int(root.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, "", err
		}
		return os.NewFile(uintptr(fd), "core-parent"), path.Base(name), nil
	}
	file, err := openCorePayloadDirectory(int(root.Fd()), parent)
	return file, path.Base(name), err
}
