package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"golang.org/x/sys/unix"
)

const coreBakedExecutable = "/usr/local/bin/youeye"
const coreQuickSpineDropIn = "/run/systemd/system/youeye.service.d/90-youeye-development-spine.conf"
const coreQuickSpineRoot = "/var/lib/youeye-state/development-overlays/artifacts"

var coreQuickSpineID = regexp.MustCompile(`^devart-b-[A-Za-z0-9._-]{1,120}$`)
var coreReaderDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var coreReaderCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)

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
	APISHA256         func(context.Context) (string, error)
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

type coreQuickSpineMarker struct {
	Schema       string `json:"schema"`
	Component    string `json:"component"`
	State        string `json:"state"`
	Unsigned     bool   `json:"unsigned"`
	ArtifactID   string `json:"artifact_id"`
	SourceCommit string `json:"source_commit"`
	SHA256       string `json:"sha256"`
}

func parseCoreQuickSpineMarker(raw []byte) (coreQuickSpineMarker, error) {
	var marker coreQuickSpineMarker
	// This producer emits one flat object. Duplicate keys, even equal ones, are
	// ambiguous retained admission rather than a reason to choose a last value.
	d := json.NewDecoder(bytes.NewReader(raw))
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return marker, fmt.Errorf("invalid quick reader marker")
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return marker, fmt.Errorf("ambiguous quick reader marker")
		}
		seen[name] = true
		if err := d.Decode(new(json.RawMessage)); err != nil {
			return marker, fmt.Errorf("invalid quick reader marker")
		}
	}
	if _, err := d.Token(); err != nil || d.Decode(new(any)) != io.EOF {
		return marker, fmt.Errorf("invalid quick reader marker")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&marker) != nil || marker.Schema != "youeye.development-overlay-runtime.v1" || marker.Component != "spine" || marker.State != "active" || !marker.Unsigned || !coreQuickSpineID.MatchString(marker.ArtifactID) || strings.Contains(marker.ArtifactID, "..") || !coreReaderCommit.MatchString(marker.SourceCommit) || !coreReaderDigest.MatchString(marker.SHA256) {
		return marker, fmt.Errorf("invalid quick reader marker")
	}
	return marker, nil
}

func observeCoreInstalledReader(ctx context.Context, o coreInstalledReaderObserver) (coreInstalledReaderObservation, error) {
	var empty coreInstalledReaderObservation
	if ctx.Err() != nil {
		return empty, ctx.Err()
	}
	if !filepath.IsAbs(o.Root) || filepath.Clean(o.Root) != o.Root || o.CurrentExecutable == nil || o.CurrentSHA256 == nil || o.APISHA256 == nil {
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
	// Production registration is authenticated first. Corrupt retained production
	// state cannot fall back to a test reader or its marker.
	bootstrap, err := manager.BootstrapExecutable(systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return empty, err
	}
	if bootstrap != "" {
		path, err := o.logical(bootstrap)
		if err != nil {
			return empty, err
		}
		// A valid production coordinator takes precedence over retained test
		// state. Its authority belongs only to this exact registered self; an
		// unrelated external executable cannot inherit it through equal bytes.
		if self != path && self != coreBakedExecutable {
			return empty, fmt.Errorf("executing reader differs from registered production coordinator")
		}
		digest, err := o.hash(path)
		if err != nil {
			return empty, err
		}
		return finish(path, digest, "production-bootstrap")
	}
	marker, markerErr := o.read(spineCandidateOverlay)
	if markerErr != nil && !errors.Is(markerErr, os.ErrNotExist) {
		return empty, markerErr
	}
	quickDropIn, quickErr := o.read(coreQuickSpineDropIn)
	if quickErr != nil && !errors.Is(quickErr, os.ErrNotExist) {
		return empty, quickErr
	}
	candidateDropIn, candidateErr := o.read(spineCandidateDropIn)
	if candidateErr != nil && !errors.Is(candidateErr, os.ErrNotExist) {
		return empty, candidateErr
	}
	candidate := systemupdate.SpineCandidateManager{Root: o.path(systemupdate.SpineCandidateRoot), CoreRoot: manager.Root}
	_, bindingErr := candidate.ReadBinding()
	if bindingErr != nil && !errors.Is(bindingErr, os.ErrNotExist) {
		return empty, bindingErr
	}
	if bindingErr == nil {
		if quickErr == nil {
			return empty, fmt.Errorf("signed and unsigned reader bindings conflict")
		}
		b, err := candidate.VerifyBindingContext(ctx)
		if err != nil {
			return empty, err
		}
		path, err := o.logical(filepath.Join(b.Root, systemupdate.SpineCandidateArtifact))
		if err != nil {
			return empty, err
		}
		if markerErr != nil || !bytes.Equal(marker, candidateOverlayBytes(b)) || candidateErr != nil || !bytes.Equal(candidateDropIn, candidateOverride(path)) {
			return empty, fmt.Errorf("signed candidate runtime evidence differs")
		}
		digest, err := o.hash(path)
		if err != nil || digest != b.ArtifactSHA256 {
			return empty, fmt.Errorf("signed candidate payload differs")
		}
		apiHash, err := o.APISHA256(ctx)
		if err != nil || apiHash != digest {
			return empty, fmt.Errorf("actual API differs from signed candidate")
		}
		after, err := candidate.VerifyBindingContext(ctx)
		if err != nil || after != b {
			return empty, fmt.Errorf("signed candidate binding changed")
		}
		return finish(path, digest, "signed-candidate")
	}
	if markerErr == nil {
		if candidateErr == nil {
			return empty, fmt.Errorf("orphan signed candidate override")
		}
		m, err := parseCoreQuickSpineMarker(marker)
		if err != nil {
			return empty, err
		}
		path := filepath.Join(coreQuickSpineRoot, m.ArtifactID, "youeye")
		want := []byte("[Service]\nExecStart=\nExecStart=" + path + " api serve\n")
		if quickErr != nil || !bytes.Equal(quickDropIn, want) {
			return empty, fmt.Errorf("quick reader API override differs")
		}
		digest, err := o.hash(path)
		if err != nil || digest != m.SHA256 {
			return empty, fmt.Errorf("quick reader payload differs")
		}
		apiHash, err := o.APISHA256(ctx)
		if err != nil || apiHash != digest {
			return empty, fmt.Errorf("actual API differs from quick reader")
		}
		afterMarker, err := o.read(spineCandidateOverlay)
		if err != nil || !bytes.Equal(marker, afterMarker) {
			return empty, fmt.Errorf("quick reader marker changed")
		}
		afterDropIn, err := o.read(coreQuickSpineDropIn)
		if err != nil || !bytes.Equal(quickDropIn, afterDropIn) {
			return empty, fmt.Errorf("quick reader API override changed")
		}
		afterDigest, err := o.hash(path)
		if err != nil || afterDigest != digest {
			return empty, fmt.Errorf("quick reader payload changed")
		}
		return finish(path, digest, "unsigned-development")
	}
	if quickErr == nil || candidateErr == nil {
		return empty, fmt.Errorf("reader override has no protected binding")
	}
	return finish(coreBakedExecutable, "", "baked")
}

var coreInstalledReaderHost = func() coreInstalledReaderObserver {
	return coreInstalledReaderObserver{Root: "/", Owner: 0, CurrentExecutable: os.Executable, CurrentSHA256: func() (string, error) { return fileSHA256("/proc/self/exe") }, APISHA256: candidateAPIHash}
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
