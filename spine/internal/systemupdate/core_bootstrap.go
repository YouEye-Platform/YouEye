package systemupdate

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreBootstrap retains a coordinator outside both immutable host slots. Its
// identity is the exact target's Spine member digest, never an arbitrary
// executable path. It uses the normal paired transaction.
type CoreBootstrap struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ArtifactSHA256 string `json:"artifact_sha256"`
}

func (m CoreManager) bootstrapPath() string {
	return filepath.Join(m.Root, "bootstrap-coordinator.json")
}
func (m CoreManager) BootstrapBinaryPath(digest string) (string, error) {
	if !filepath.IsAbs(m.Root) || !validSHA256(digest) {
		return "", fmt.Errorf("invalid bootstrap identity")
	}
	return filepath.Join(m.Root, "bootstrap", digest, "youeye"), nil
}
func (m CoreManager) readBootstrap() (CoreBootstrap, error) {
	var b CoreBootstrap
	raw, err := ReadCoreState(m.bootstrapPath(), 4096)
	if err != nil {
		return b, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&b) != nil || d.Decode(new(any)) != io.EOF || b.Schema != "youeye.core-bootstrap.v1" || !coreRequestPattern.MatchString(b.RequestID) || !validSHA256(b.ManifestSHA256) || !validSHA256(b.ArtifactSHA256) {
		return b, fmt.Errorf("invalid retained bootstrap coordinator")
	}
	return b, nil
}
func (m CoreManager) verifyBootstrap(b CoreBootstrap) (string, error) {
	j, err := m.Read()
	if err != nil || j.RequestID != b.RequestID || j.ManifestSHA256 != b.ManifestSHA256 || !j.RestartRequired || j.NoOp || j.MetadataOnly {
		return "", fmt.Errorf("bootstrap differs from the retained host transition")
	}
	_, target, err := m.Selection(b.ManifestSHA256)
	if err != nil {
		return "", err
	}
	return m.verifyBootstrapMember(target, b.ArtifactSHA256)
}

// VerifyBootstrapReader verifies a protected, digest-bound Stable reader
// without preparing an update or retaining coordinator/transaction state. The
// API bridge calls it again before accepting the owner's first stage action.
func (m CoreManager) VerifyBootstrapReader(executable, digest string) error {
	if !validSHA256(digest) {
		return fmt.Errorf("exact reader manifest digest required")
	}
	artifact := filepath.Base(filepath.Dir(executable))
	file, err := m.BootstrapBinaryPath(artifact)
	if err != nil || executable != file {
		return fmt.Errorf("reader must use its protected content-addressed path")
	}
	if err := m.verifyBootstrapDirectories(file); err != nil {
		return err
	}
	raw, err := ReadCoreState(filepath.Join(filepath.Dir(file), "core-release.json"), 1<<20)
	if err != nil {
		return err
	}
	target, actual, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return err
	}
	if actual != digest || target.Source != releasecache.OfficialRepository || target.Branch != "main" || target.Channel != "stable" {
		return fmt.Errorf("reader requires the exact official Stable selection")
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil || member.Source != releasecache.OfficialRepository || member.Branch != "main" {
		return fmt.Errorf("reader requires an original Stable Spine")
	}
	channel, err := releasecache.CoreMemberChannel(member, target.Channel)
	if err != nil || channel != "stable" {
		return fmt.Errorf("reader requires an original Stable Spine")
	}
	verified, err := m.verifyBootstrapMember(target, artifact)
	if err != nil {
		return err
	}
	if verified != executable {
		return fmt.Errorf("reader differs from the selected Spine")
	}
	return nil
}

func (m CoreManager) verifyBootstrapDirectories(file string) error {
	for _, directory := range []string{m.Root, filepath.Join(m.Root, "bootstrap"), filepath.Dir(file)} {
		s, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || !s.IsDir() || s.Mode().Perm()&0022 != 0 || int(st.Uid) != os.Geteuid() {
			return fmt.Errorf("unsafe bootstrap directory")
		}
	}
	return nil
}

func (m CoreManager) verifyBootstrapMember(target releasecache.CoreRelease, artifact string) (string, error) {
	member, err := coreServiceMember(target, "spine")
	if err != nil || member.Artifact.SHA256 != artifact {
		return "", fmt.Errorf("bootstrap is not the target Spine")
	}
	file, err := m.BootstrapBinaryPath(artifact)
	if err != nil {
		return "", err
	}
	if err := m.verifyBootstrapDirectories(file); err != nil {
		return "", err
	}
	raw, err := ReadCoreState(file, 128<<20)
	if err != nil {
		return "", err
	}
	if int64(len(raw)) != member.Artifact.SizeBytes || fmt.Sprintf("%x", sha256.Sum256(raw)) != member.Artifact.SHA256 {
		return "", fmt.Errorf("retained bootstrap Spine failed digest/size verification")
	}
	return file, nil
}

// BootstrapExecutable rechecks retained authority on every invocation, including
// after rollback. Absence selects the ordinary installed coordinator.
func (m CoreManager) BootstrapExecutable() (string, error) {
	b, err := m.readBootstrap()
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return m.verifyBootstrap(b)
}

// RegisterBootstrap is allowed before the first action only. Repeating exactly
// the accepted request reconciles its record rather than replacing a live runner.
func (m CoreManager) RegisterBootstrap(request, digest, executable string) (string, error) {
	unlock, err := m.lockCore()
	if err != nil {
		return "", err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.ManifestSHA256 != digest {
		return "", fmt.Errorf("exact bootstrap request required")
	}
	member, err := coreServiceMember(j.Target, "spine")
	if err != nil {
		return "", err
	}
	b := CoreBootstrap{"youeye.core-bootstrap.v1", request, digest, member.Artifact.SHA256}
	file, err := m.verifyBootstrap(b)
	if err != nil {
		return "", err
	}
	if executable != file {
		return "", fmt.Errorf("bootstrap must run from its protected content-addressed path")
	}
	old, err := m.readBootstrap()
	if err == nil {
		if old != b {
			return "", fmt.Errorf("another bootstrap coordinator is retained")
		}
		return file, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if j.Phase != "prepared" || len(j.RecoverySteps) != 0 {
		return "", fmt.Errorf("bootstrap cannot replace an active transaction coordinator")
	}
	for _, step := range j.Steps {
		if step.State != "pending" {
			return "", fmt.Errorf("bootstrap must precede all native actions")
		}
	}
	raw, _ := json.Marshal(b)
	return file, atomicWrite(m.bootstrapPath(), append(raw, '\n'), 0600)
}

// ForgetBootstrap retires the owned coordinator only after paired completion.
// The binary remains until no process needs it; callers remove the exact boot
// override first and leave other systemd configuration alone.
func (m CoreManager) ForgetBootstrap(request string) error {
	unlock, err := m.lockCore()
	if err != nil {
		return err
	}
	defer unlock()
	b, err := m.readBootstrap()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	j, err := m.Read()
	if err != nil || b.RequestID != request || j.RequestID != request || !m.TransactionComplete(j) {
		return fmt.Errorf("bootstrap transaction is not complete")
	}
	if err = os.Remove(m.bootstrapPath()); err != nil {
		return err
	}
	return syncDirectory(m.Root)
}
