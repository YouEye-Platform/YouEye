package systemupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreBootstrap retains a signed coordinator outside both immutable host slots.
// Its authority is the exact target's original Spine member, never a downloaded
// key or an arbitrary executable path. It uses the normal paired transaction.
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
func (m CoreManager) verifyBootstrap(b CoreBootstrap, trust string) (string, error) {
	j, err := m.Read()
	if err != nil || j.RequestID != b.RequestID || j.ManifestSHA256 != b.ManifestSHA256 || !j.RestartRequired || j.NoOp || j.MetadataOnly {
		return "", fmt.Errorf("bootstrap differs from the retained host transition")
	}
	_, target, err := m.Selection(b.ManifestSHA256, trust)
	if err != nil {
		return "", err
	}
	member, err := coreServiceMember(target, "spine")
	if err != nil || member.Artifact.SHA256 != b.ArtifactSHA256 {
		return "", fmt.Errorf("bootstrap is not the signed target Spine")
	}
	key, err := CoreMemberKey(member, target.Channel, trust)
	if err != nil {
		return "", err
	}
	file, err := m.BootstrapBinaryPath(b.ArtifactSHA256)
	if err != nil {
		return "", err
	}
	for _, directory := range []string{m.Root, filepath.Join(m.Root, "bootstrap"), filepath.Dir(file)} {
		s, err := os.Lstat(directory)
		if err != nil {
			return "", err
		}
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || !s.IsDir() || s.Mode().Perm()&0022 != 0 || int(st.Uid) != os.Geteuid() {
			return "", fmt.Errorf("unsafe bootstrap directory")
		}
	}
	err = releasecache.VerifyCoreMember(member, key, func(blob releasecache.CoreBlob) (io.ReadCloser, error) {
		name := map[string]string{member.Artifact.URL: "youeye", member.Checksums.URL: "checksums", member.Signature.URL: "signature", member.Provenance.URL: "provenance", member.SBOM.URL: "sbom"}[blob.URL]
		if name == "" {
			return nil, fmt.Errorf("unexpected bootstrap envelope input")
		}
		raw, err := ReadCoreState(filepath.Join(filepath.Dir(file), name), 128<<20)
		if err != nil {
			return nil, err
		}
		return io.NopCloser(bytes.NewReader(raw)), nil
	})
	if err != nil {
		return "", fmt.Errorf("retained bootstrap envelope failed: %w", err)
	}
	return file, nil
}

// BootstrapExecutable rechecks retained authority on every invocation, including
// after rollback. Absence selects the ordinary installed coordinator.
func (m CoreManager) BootstrapExecutable(trust string) (string, error) {
	b, err := m.readBootstrap()
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return m.verifyBootstrap(b, trust)
}

// RegisterBootstrap is allowed before the first action only. Repeating exactly
// the accepted request reconciles its record rather than replacing a live runner.
func (m CoreManager) RegisterBootstrap(request, digest, executable, trust string) (string, error) {
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
	file, err := m.verifyBootstrap(b, trust)
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
