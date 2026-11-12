package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"golang.org/x/sys/unix"
)

const coreBakedExecutable = "/usr/local/bin/youeye"

type coreInstalledReaderObservation struct {
	Executable  string
	ReaderClass string
	Bound       bool
}

// Process observations are separate from protected runtime files so tests can
// inspect complete confined files without invoking systemd or the guest API.
type coreInstalledReaderObserver struct {
	Root              string
	Owner             uint32
	CurrentExecutable func() (string, error)
	CurrentSHA256     func() (string, error)
}

func (o coreInstalledReaderObserver) path(logical string) string {
	return filepath.Join(o.Root, logical)
}

func (o coreInstalledReaderObserver) logical(physical string) (string, error) {
	if o.Root == "/" {
		return physical, nil
	}
	if !strings.HasPrefix(physical, o.Root+"/") {
		return "", fmt.Errorf("reader is outside protected runtime")
	}
	return strings.TrimPrefix(physical, o.Root), nil
}

// Resolve every directory without following links. The root is a confined test
// filesystem only in tests; production always uses / and root ownership.
func (o coreInstalledReaderObserver) open(path string, limit int64, executable bool) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, fmt.Errorf("invalid protected reader path")
	}
	fd, err := unix.Open(o.Root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if fd >= 0 {
			unix.Close(fd)
		}
	}()
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for index, part := range parts {
		var directory unix.Stat_t
		if unix.Fstat(fd, &directory) != nil || directory.Uid != o.Owner || directory.Mode&0022 != 0 {
			return nil, fmt.Errorf("unsafe reader directory")
		}
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
		if index < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, err := unix.Openat(fd, part, flags, 0)
		if err != nil {
			return nil, err
		}
		unix.Close(fd)
		fd = next
	}
	file := os.NewFile(uintptr(fd), "protected-reader")
	fd = -1
	var stat unix.Stat_t
	if unix.Fstat(int(file.Fd()), &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != o.Owner || stat.Mode&0022 != 0 || stat.Nlink != 1 || stat.Size <= 0 || stat.Size > limit || executable && stat.Mode&0100 == 0 {
		file.Close()
		return nil, fmt.Errorf("unsafe protected reader file")
	}
	return file, nil
}

func (o coreInstalledReaderObserver) read(path string) ([]byte, error) {
	file, err := o.open(path, 16384, false)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(file, 16385))
	after, statErr := file.Stat()
	if err != nil || statErr != nil || int64(len(raw)) != before.Size() || !before.ModTime().Equal(after.ModTime()) || before.Size() != after.Size() {
		return nil, fmt.Errorf("reader evidence changed during observation")
	}
	return raw, nil
}

func (o coreInstalledReaderObserver) hash(path string) (string, error) {
	file, err := o.open(path, 128<<20, true)
	if err != nil {
		return "", err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return "", err
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(file, (128<<20)+1))
	after, statErr := file.Stat()
	if err != nil || statErr != nil || n != before.Size() || !before.ModTime().Equal(after.ModTime()) || before.Size() != after.Size() {
		return "", fmt.Errorf("reader payload changed during observation")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func observeCoreInstalledReader(ctx context.Context, o coreInstalledReaderObserver) (coreInstalledReaderObservation, error) {
	var empty coreInstalledReaderObservation
	if ctx.Err() != nil {
		return empty, ctx.Err()
	}
	if !filepath.IsAbs(o.Root) || filepath.Clean(o.Root) != o.Root || o.CurrentExecutable == nil || o.CurrentSHA256 == nil {
		return empty, fmt.Errorf("complete installed reader observation required")
	}
	self, err := o.CurrentExecutable()
	if err != nil || !filepath.IsAbs(self) || filepath.Clean(self) != self {
		return empty, fmt.Errorf("current reader executable unavailable")
	}
	ordinary := coreInstalledReaderObservation{Executable: coreBakedExecutable, ReaderClass: "baked"}
	finish := func(path, digest, class string) (coreInstalledReaderObservation, error) {
		if err := ctx.Err(); err != nil {
			return empty, err
		}
		currentPath, err := o.CurrentExecutable()
		if err != nil || currentPath != self {
			return empty, fmt.Errorf("current reader changed during observation")
		}
		if strings.HasPrefix(self, spineRoot+string(filepath.Separator)) {
			// A Spine selected for the booted slot runs from State: bind to
			// its own bytes, checked against the slot's selection.
			currentHash, err := o.CurrentSHA256()
			if err != nil {
				return empty, err
			}
			if err := verifyRunningSpine(self); err != nil {
				return empty, err
			}
			if digest, err := spineselect.FileDigest(self); err != nil || digest != currentHash {
				return empty, fmt.Errorf("executing Spine bytes differ from its selection")
			}
			return coreInstalledReaderObservation{Executable: self, ReaderClass: "selected"}, nil
		}
		if self == coreBakedExecutable {
			digest, err = o.hash(coreBakedExecutable)
			if err != nil {
				return empty, err
			}
		} else if self != path {
			return empty, fmt.Errorf("executing reader has no exact runtime binding")
		}
		currentHash, err := o.CurrentSHA256()
		if err != nil || currentHash != digest {
			return empty, fmt.Errorf("executing reader bytes differ from runtime binding")
		}
		if self == coreBakedExecutable {
			return ordinary, nil
		}
		return coreInstalledReaderObservation{Executable: coreBakedExecutable, ReaderClass: class, Bound: true}, nil
	}
	manager := systemupdate.CoreManager{Root: o.path(systemupdate.CoreStatePath)}
	// A registered production coordinator is verified first. Corrupt retained
	// state cannot fall back to the baked reader.
	bootstrap, err := manager.BootstrapExecutable()
	if err != nil {
		return empty, err
	}
	if bootstrap != "" {
		path, err := o.logical(bootstrap)
		if err != nil {
			return empty, err
		}
		// A valid production coordinator belongs only to this exact registered
		// self; an unrelated external executable cannot inherit it through
		// equal bytes.
		if self != path && self != coreBakedExecutable {
			return empty, fmt.Errorf("executing reader differs from registered production coordinator")
		}
		digest, err := o.hash(path)
		if err != nil {
			return empty, err
		}
		return finish(path, digest, "production-bootstrap")
	}
	return finish(coreBakedExecutable, "", "baked")
}

var coreInstalledReaderHost = func() coreInstalledReaderObserver {
	return coreInstalledReaderObserver{Root: "/", Owner: 0, CurrentExecutable: os.Executable, CurrentSHA256: func() (string, error) { return fileSHA256("/proc/self/exe") }}
}

func readCoreInstalledReader() (coreInstalledReaderObservation, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host := coreInstalledReaderHost()
	reader, err := observeCoreInstalledReader(ctx, host)
	if err == nil {
		reader.Executable = host.path(reader.Executable)
	}
	return reader, err
}
