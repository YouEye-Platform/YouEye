package systemupdate

import (
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// CoreHostSelection carries the exact signed assembly, never a caller supplied
// artifact URL override. The host verifies its independent signing authority.
type CoreHostSelection struct {
	Raw       []byte
	Signature []byte
}

func (m *Manager) CoreHostOptions(selection CoreHostSelection) (SourceOptions, error) {
	r, _, err := VerifyCoreSelection(selection.Raw, selection.Signature, m.config.TrustKeyPath)
	if err != nil {
		return SourceOptions{}, err
	}
	for _, member := range r.Members {
		if member.Role == "system-update" {
			return SourceOptions{ManifestSource: member.Artifact.URL, SignatureSource: member.DocumentSignature.URL,
				ExpectedManifestSHA256: member.Artifact.SHA256, ExpectedReleaseBranch: member.Branch,
				Channel: r.Channel, ReleaseTag: r.Tag, Core: &selection}, nil
		}
	}
	return SourceOptions{}, fmt.Errorf("core assembly has no host update")
}

func (m *Manager) verifyCoreHost(selection CoreHostSelection, verified VerifiedManifest, signature []byte) (releasecache.CoreRelease, string, error) {
	r, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, m.config.TrustKeyPath)
	if err != nil {
		return r, "", err
	}
	members := map[string]releasecache.CoreMember{}
	for _, member := range r.Members {
		members[member.Role] = member
	}
	host := members["system-update"]
	manifest := verified.Manifest
	if host.Artifact.SHA256 != verified.SHA256 || host.Artifact.SizeBytes != int64(len(verified.Raw)) ||
		host.BuildVersion != manifest.TargetImageVersion || host.SourceCommit != manifest.SourceCommit ||
		host.Source != manifest.ReleaseSet.Source || host.Branch != manifest.ReleaseSet.Branch {
		return r, "", fmt.Errorf("host update differs from signed core membership")
	}
	if host.DocumentSignature == nil || host.DocumentSignature.SHA256 != fmt.Sprintf("%x", sha256.Sum256(signature)) || host.DocumentSignature.SizeBytes != int64(len(signature)) {
		return r, "", fmt.Errorf("host document signature differs from core membership")
	}
	key, err := CoreMemberKey(host, r.Channel, m.config.TrustKeyPath)
	if err != nil {
		return r, "", err
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || host.KeyID != fmt.Sprintf("%x", sha256.Sum256(der)) {
		return r, "", fmt.Errorf("host signing authority differs from core membership")
	}
	for _, artifact := range manifest.Artifacts {
		member, ok := members[artifact.Role]
		if !ok || member.Artifact.Name != artifact.Path || member.Artifact.SHA256 != artifact.SHA256 || member.Artifact.SizeBytes != artifact.SizeBytes ||
			member.BuildVersion != host.BuildVersion || member.SourceCommit != host.SourceCommit || member.Source != host.Source || member.Branch != host.Branch || member.KeyID != host.KeyID {
			return r, "", fmt.Errorf("host payload %s differs from signed core membership", artifact.Role)
		}
	}
	return r, digest, nil
}

func (m *Manager) hostArtifactSource(options SourceOptions, artifact Artifact) (string, error) {
	if options.Core == nil {
		return resolveArtifactSource(options.ManifestSource, artifact.Path)
	}
	r, _, err := VerifyCoreSelection(options.Core.Raw, options.Core.Signature, m.config.TrustKeyPath)
	if err != nil {
		return "", err
	}
	for _, member := range r.Members {
		if member.Role == artifact.Role && member.Artifact.Name == artifact.Path && member.Artifact.SHA256 == artifact.SHA256 && member.Artifact.SizeBytes == artifact.SizeBytes {
			return member.Artifact.URL, nil
		}
	}
	return "", fmt.Errorf("host artifact lacks exact core membership")
}

func (m *Manager) loadHostCore(journal Journal, verified VerifiedManifest, signature []byte) error {
	if journal.CoreManifestSHA256 == "" {
		return nil
	}
	dir := m.transactionDir(journal.TransactionID)
	raw, err := ReadCoreState(filepath.Join(dir, "core-release.json"), 1<<20)
	if err != nil {
		return err
	}
	sig, err := ReadCoreState(filepath.Join(dir, "core-release.json.sig"), 64)
	if err != nil {
		return err
	}
	_, digest, err := m.verifyCoreHost(CoreHostSelection{Raw: raw, Signature: sig}, verified, signature)
	if err != nil {
		return err
	}
	if digest != journal.CoreManifestSHA256 {
		return fmt.Errorf("host core membership differs from durable journal")
	}
	return nil
}

func (m *Manager) persistHostCore(dir string, selection *CoreHostSelection) error {
	if selection == nil {
		return nil
	}
	if err := atomicWrite(filepath.Join(dir, "core-release.json"), selection.Raw, 0600); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, "core-release.json.sig"), selection.Signature, 0600)
}

func (m *Manager) checkHostCore(journal Journal, verified VerifiedManifest, signaturePath string) error {
	if journal.CoreManifestSHA256 == "" {
		return nil
	}
	signature, err := os.ReadFile(signaturePath)
	if err != nil {
		return err
	}
	return m.loadHostCore(journal, verified, signature)
}

// CheckCoreHostCommit prevents independent boot-health machinery from blessing
// a grouped host transaction before service and authenticated checks complete.
func (m *Manager) CheckCoreHostCommit() error {
	journal, err := loadJournal(m.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	// A committed host may remain in use across later service-only releases.
	// Its already-complete journal must not require ownership by the new one.
	if journal.Phase == PhaseHealthy {
		return nil
	}
	if journal.Phase == PhaseRollback && journal.CoreManifestSHA256 != "" {
		cm := CoreManager{Root: m.config.CoreStatePath}
		j, err := cm.Read()
		if err != nil || (j.Phase != "rolled-back" && j.Phase != "cancelled" && j.Phase != "committed") {
			return fmt.Errorf("core recovery/cancellation has not settled")
		}
		receipt, err := cm.ReadReceipt()
		if err != nil {
			return err
		}
		current, state, slot, err := m.current()
		if err != nil {
			return err
		}
		if slot != journal.ActiveSlot || current.ImageVersion != journal.CurrentImage || state.Slots.Current != slot || state.Slots.CurrentImageVersion != current.ImageVersion || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
			return fmt.Errorf("retained previous boot has not settled")
		}
		return BindCoreImage(receipt.Release, current)
	}
	return m.requireCoreHostStep(journal, "commit-host")
}

func (m *Manager) requireCoreHostStep(host Journal, name string) error {
	if host.CoreManifestSHA256 == "" {
		return nil
	}
	j, err := (CoreManager{Root: m.config.CoreStatePath}).Read()
	if err != nil {
		return fmt.Errorf("core coordinator receipt required before %s: %w", name, err)
	}
	if j.ManifestSHA256 != host.CoreManifestSHA256 || !j.RestartRequired || !j.ActivationRequested {
		return fmt.Errorf("core coordinator does not own this host activation")
	}
	if name == "commit-host" && j.Phase == "committed" {
		return nil
	}
	if j.Phase != "applying" {
		return fmt.Errorf("core coordinator is not applying this host transaction")
	}
	for _, step := range j.Steps {
		if step.Name == name {
			if step.State == "started" || step.State == "succeeded" {
				return nil
			}
			break
		}
		if step.State != "succeeded" {
			break
		}
	}
	return fmt.Errorf("core coordinator has not authorized %s", name)
}
