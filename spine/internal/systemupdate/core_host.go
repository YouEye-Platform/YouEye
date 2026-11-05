package systemupdate

import (
	"context"
	"crypto/ed25519"
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
	Raw                []byte
	Signature          []byte
	MetadataProof      []byte
	MetadataAdvertised bool
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

// Keep delivery scoped to this invocation's authenticated selection. Never
// mutate a shared client's transport or teach a legacy request these aliases.
func (m *Manager) withCoreTransport(ctx context.Context, selection *CoreHostSelection) (*Manager, error) {
	if selection == nil {
		return m, nil
	}
	verified, _, err := EnsureCoreMetadata(ctx, *selection, m.config.TrustKeyPath, "", m.config.HTTPClient, "")
	if err != nil {
		return nil, err
	}
	*selection = verified
	r, _, err := VerifyCoreSelection(selection.Raw, selection.Signature, m.config.TrustKeyPath)
	if err != nil {
		return nil, err
	}
	client := *m.config.HTTPClient
	transport, err := releasecache.CoreTransport(client.Transport, r)
	if err != nil {
		return nil, err
	}
	client.Transport = releasecache.Wrap(transport)
	bound := *m
	bound.config.HTTPClient = &client
	return &bound, nil
}

// verifyHostManifest uses core authority only for an authenticated core-owned
// request. The assembly selects bytes; its signer never replaces host authority.
func (m *Manager) verifyHostManifest(manifestPath, signaturePath string, selection *CoreHostSelection) (VerifiedManifest, string, error) {
	if selection == nil {
		verified, err := VerifyManifest(manifestPath, signaturePath, m.config.TrustKeyPath)
		return verified, "", err
	}
	r, _, err := VerifyCoreSelection(selection.Raw, selection.Signature, m.config.TrustKeyPath)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	var host releasecache.CoreMember
	for _, member := range r.Members {
		if member.Role == "system-update" {
			host = member
			break
		}
	}
	if host.Role == "" {
		return VerifiedManifest{}, "", fmt.Errorf("core assembly has no host update")
	}
	key, err := CoreMemberKey(host, r.Channel, m.config.TrustKeyPath)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	grant, err := coreTrustLookup(host.Source, host.Branch, "appliance")
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return VerifiedManifest{}, "", fmt.Errorf("read system update manifest: %w", err)
	}
	manifest, err := ParseManifest(raw)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	publisher := ""
	if grant != nil {
		if manifest.Trust.Class != TrustClassDev {
			return VerifiedManifest{}, "", errors.New("owner-built system images must use the development channel")
		}
		publisher = grant.Publisher
	} else {
		channel, err := releasecache.CoreMemberChannel(host, r.Channel)
		if err != nil {
			return VerifiedManifest{}, "", err
		}
		class := TrustClassDev
		if host.Source == releasecache.OfficialRepository && (channel == "stable" || channel == "beta") {
			class = channel
		}
		if manifest.Trust.Class != class {
			return VerifiedManifest{}, "", errors.New("host manifest trust class differs from core member authority")
		}
	}
	verified, err := verifyManifestWithKey(raw, manifest, signaturePath, key, publisher)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	// Membership binds the actual detached-signature file as well as every
	// payload and the host's full SPKI fingerprint, source and raw branch.
	signature, err := os.ReadFile(signaturePath)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	_, digest, err := m.verifyCoreHost(*selection, verified, signature)
	if err != nil {
		return VerifiedManifest{}, "", err
	}
	return verified, digest, nil
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
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, verified.Raw, signature) {
		return r, "", fmt.Errorf("host document signature is not valid for current core member authority")
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

// verifyTransactionManifest requires the protected saved assembly before using
// core authority, then rechecks today's policy and the durable envelope digest.
func (m *Manager) verifyTransactionManifest(journal Journal, manifestPath string) (VerifiedManifest, error) {
	if journal.CoreManifestSHA256 == "" {
		return VerifyManifest(manifestPath, manifestPath+".sig", m.config.TrustKeyPath)
	}
	dir := m.transactionDir(journal.TransactionID)
	raw, err := ReadCoreState(filepath.Join(dir, "core-release.json"), 1<<20)
	if err != nil {
		return VerifiedManifest{}, err
	}
	sig, err := ReadCoreState(filepath.Join(dir, "core-release.json.sig"), 64)
	if err != nil {
		return VerifiedManifest{}, err
	}
	selection := CoreHostSelection{Raw: raw, Signature: sig}
	proof, e := ReadCoreState(filepath.Join(dir, CoreMetadataProofName), CoreMetadataProofMaxBytes)
	if e == nil {
		selection.MetadataProof = proof
	} else if !errors.Is(e, os.ErrNotExist) {
		return VerifiedManifest{}, e
	}
	selection, _, err = EnsureCoreMetadata(context.Background(), selection, m.config.TrustKeyPath, "", m.config.HTTPClient, "")
	if err != nil {
		return VerifiedManifest{}, err
	}
	if err = atomicWrite(filepath.Join(dir, CoreMetadataProofName), selection.MetadataProof, 0600); err != nil {
		return VerifiedManifest{}, err
	}
	verified, digest, err := m.verifyHostManifest(manifestPath, manifestPath+".sig", &selection)
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
	if err := atomicWrite(filepath.Join(dir, "core-release.json"), selection.Raw, 0600); err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(dir, "core-release.json.sig"), selection.Signature, 0600); err != nil {
		return err
	}
	if len(selection.MetadataProof) > 0 {
		return atomicWrite(filepath.Join(dir, CoreMetadataProofName), selection.MetadataProof, 0600)
	}
	return nil
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
