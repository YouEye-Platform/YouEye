package systemupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// CoreHostSelection carries the exact accepted release document, never a
// caller supplied artifact URL override. Its digest binds every host payload.
type CoreHostSelection struct {
	Raw []byte
}

func (m *Manager) CoreHostOptions(selection CoreHostSelection) (SourceOptions, error) {
	r, _, err := releasecache.ParseCoreRelease(selection.Raw)
	if err != nil {
		return SourceOptions{}, err
	}
	for _, member := range r.Members {
		if member.Role == "system-update" {
			source, err := CoreBlobURL(r, member.Artifact)
			if err != nil {
				return SourceOptions{}, err
			}
			return SourceOptions{ManifestSource: source,
				ExpectedManifestSHA256: member.Artifact.SHA256, ReleaseTag: r.Tag, Core: &selection}, nil
		}
	}
	return SourceOptions{}, fmt.Errorf("core release has no host update")
}

// Keep delivery scoped to this invocation's accepted selection. Never mutate a
// shared client's transport or teach a host-only request these aliases.
func (m *Manager) withCoreTransport(selection *CoreHostSelection) (*Manager, error) {
	if selection == nil {
		return m, nil
	}
	r, _, err := releasecache.ParseCoreRelease(selection.Raw)
	if err != nil {
		return nil, err
	}
	_ = r
	client := *m.config.HTTPClient
	client.Transport = releasecache.Wrap(client.Transport)
	bound := *m
	bound.config.HTTPClient = &client
	return &bound, nil
}

// verifyHostManifest binds a core-owned request to the system-update member's
// exact digest. A host-only request (tests) is bound only by an explicit expected digest.
func (m *Manager) verifyHostManifest(manifestPath string, selection *CoreHostSelection) (VerifiedManifest, string, error) {
	verified, err := VerifyManifest(manifestPath, "")
	if err != nil || selection == nil {
		return verified, "", err
	}
	_, digest, err := m.verifyCoreHost(*selection, verified)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	return verified, digest, nil
}

func (m *Manager) verifyCoreHost(selection CoreHostSelection, verified VerifiedManifest) (releasecache.CoreRelease, string, error) {
	r, digest, err := releasecache.ParseCoreRelease(selection.Raw)
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
		host.BuildVersion != manifest.TargetImageVersion || host.SourceTree != manifest.SourceTree {
		return r, "", fmt.Errorf("host update differs from core release membership")
	}
	for _, artifact := range manifest.Artifacts {
		member, ok := members[artifact.Role]
		if !ok || member.Artifact.Name != artifact.Path || member.Artifact.SHA256 != artifact.SHA256 || member.Artifact.SizeBytes != artifact.SizeBytes ||
			member.BuildVersion != host.BuildVersion || member.SourceTree != host.SourceTree {
			return r, "", fmt.Errorf("host payload %s differs from core release membership", artifact.Role)
		}
	}
	return r, digest, nil
}

func (m *Manager) hostArtifactSource(options SourceOptions, artifact Artifact) (string, error) {
	if options.Core == nil {
		return resolveArtifactSource(options.ManifestSource, artifact.Path)
	}
	r, _, err := releasecache.ParseCoreRelease(options.Core.Raw)
	if err != nil {
		return "", err
	}
	for _, member := range r.Members {
		if member.Role == artifact.Role && member.Artifact.Name == artifact.Path && member.Artifact.SHA256 == artifact.SHA256 && member.Artifact.SizeBytes == artifact.SizeBytes {
			return CoreBlobURL(r, member.Artifact)
		}
	}
	return "", fmt.Errorf("host artifact lacks exact core membership")
}

// verifyTransactionManifest binds the saved manifest to the durable journal
// digest and, for a core-owned transaction, to the protected saved release.
func (m *Manager) verifyTransactionManifest(journal Journal, manifestPath string) (VerifiedManifest, error) {
	if journal.CoreManifestSHA256 == "" {
		return VerifyManifest(manifestPath, journal.ManifestSHA256)
	}
	raw, err := ReadCoreState(filepath.Join(m.transactionDir(journal.TransactionID), "core-release.json"), 1<<20)
	if err != nil {
		return VerifiedManifest{}, err
	}
	verified, digest, err := m.verifyHostManifest(manifestPath, &CoreHostSelection{Raw: raw})
	if err != nil {
		return VerifiedManifest{}, err
	}
	if digest != journal.CoreManifestSHA256 {
		return VerifiedManifest{}, fmt.Errorf("host core membership differs from durable journal")
	}
	return verified, nil
}

func (m *Manager) persistHostCore(dir string, selection *CoreHostSelection) error {
	if selection == nil {
		return nil
	}
	return atomicWrite(filepath.Join(dir, "core-release.json"), selection.Raw, 0600)
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
