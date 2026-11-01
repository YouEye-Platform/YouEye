package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

// All signing identities and effects are local fixtures. In particular, these
// tests never write the immutable key path or the installation's owner policy.
// The assembly and host deliberately have different sources and private keys.
type coreHostTrustFixture struct {
	f               *managerFixture
	release         releasecache.CoreRelease
	selection       CoreHostSelection
	hostPrivate     ed25519.PrivateKey
	assemblyPrivate ed25519.PrivateKey
	hostRaw         []byte
	hostSignature   []byte
	policy          updatetrust.Policy
}

func coreHostTrustPEM(t *testing.T, public ed25519.PublicKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

func coreHostTrustPrivate(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return private
}

func coreHostTrustID(t *testing.T, private ed25519.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(private.Public())
	if err != nil {
		t.Fatal(err)
	}
	return checksum(der)
}

func newCoreHostTrustFixture(t *testing.T) *coreHostTrustFixture {
	t.Helper()
	f := newManagerFixture(t)
	f.manager.config.CoreStatePath = filepath.Join(f.dir, "core")
	f.manager.config.TrustKeyPath = CoreDevelopmentTrustPath
	private, err := os.ReadFile(filepath.Join(filepath.Dir(f.manifestPath), "trust.key"))
	if err != nil {
		t.Fatal(err)
	}
	c := &coreHostTrustFixture{f: f, hostPrivate: ed25519.PrivateKey(private),
		assemblyPrivate: coreHostTrustPrivate(t), policy: updatetrust.Policy{Schema: updatetrust.Schema}}
	oldPEM, oldLookup := coreDevelopmentTrustPEM, coreTrustLookup
	t.Cleanup(func() { coreDevelopmentTrustPEM, coreTrustLookup = oldPEM, oldLookup })
	coreDevelopmentTrustPEM = coreHostTrustPEM(t, c.hostPrivate.Public().(ed25519.PublicKey))
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if err := c.policy.Validate(); err != nil {
			return nil, err
		}
		return c.policy.Lookup(source, branch, scope)
	}
	hostSource := "https://forge.example/host/YouEye"
	f.update.ReleaseSet.Source = hostSource
	f.update.Trust.KeyID = coreHostTrustID(t, c.hostPrivate)[:16]
	current, _, _, err := f.manager.current()
	if err != nil {
		t.Fatal(err)
	}
	current.ReleaseSet.Source = hostSource
	currentRaw, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.manager.config.CurrentManifestPath, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.manager.config.CurrentManifestPath, currentRaw, 0600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	c.release, _, err = releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r := &c.release
	r.Source, r.Branch, r.Channel = "https://forge.example/assembly/YouEye", "dev", "dev"
	r.Version, r.Tag, r.SourceCommit = "0.6.0-dev.28", "youeye-v0.6.0-dev.28", targetCommit
	r.SignerSHA256 = coreHostTrustID(t, c.assemblyPrivate)
	c.policy.Grants = []updatetrust.Grant{{Publisher: "Assembly fixture", Repository: r.Source,
		Branch: r.Branch, Scope: "appliance", PublicKey: string(coreHostTrustPEM(t, c.assemblyPrivate.Public().(ed25519.PublicKey)))}}
	for i := range r.Members {
		m := &r.Members[i]
		m.Source, m.Branch, m.SourceCommit, m.KeyID = hostSource, "dev", targetCommit, coreHostTrustID(t, c.hostPrivate)
		m.Tag, m.BuildVersion = "youeye-v0.6.0-dev.27", f.update.TargetImageVersion
		if m.Role == "system-update" {
			m.Artifact.Name, m.DocumentSignature.Name = "system-update-manifest.json", "system-update-manifest.json.sig"
		}
		for _, a := range f.update.Artifacts {
			if a.Role == m.Role {
				m.Artifact.Name, m.Artifact.SHA256, m.Artifact.SizeBytes = a.Path, a.SHA256, a.SizeBytes
			}
		}
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = m.Source + "/releases/download/" + m.Tag + "/appliance-" + b.Name
			}
		}
	}
	c.signHost(t)
	c.signSelection(t)
	f.manager.config.HTTPClient = &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		var data []byte
		for _, m := range c.release.Members {
			if m.Artifact.URL == req.URL.String() {
				data = f.files[m.Artifact.Name]
				if m.Role == "system-update" {
					data = c.hostRaw
				}
			}
			if m.Role == "system-update" && m.DocumentSignature.URL == req.URL.String() {
				data = c.hostSignature
			}
		}
		if data == nil {
			return nil, fmt.Errorf("unexpected host fixture URL %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)),
			ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	return c
}

func (c *coreHostTrustFixture) signHost(t *testing.T) {
	t.Helper()
	if err := c.f.update.Validate(); err != nil {
		t.Fatal(err)
	}
	var err error
	c.hostRaw, err = json.Marshal(c.f.update)
	if err != nil {
		t.Fatal(err)
	}
	c.hostSignature = ed25519.Sign(c.hostPrivate, c.hostRaw)
	c.bindDocument(t)
}

// A corrupted signature can be rebound into a validly signed envelope. The
// verifier must still reject its cryptography, not just check outer hashes.
func (c *coreHostTrustFixture) bindDocument(t *testing.T) {
	t.Helper()
	for i := range c.release.Members {
		m := &c.release.Members[i]
		if m.Role == "system-update" {
			m.Artifact.SHA256, m.Artifact.SizeBytes = checksum(c.hostRaw), int64(len(c.hostRaw))
			m.DocumentSignature.SHA256, m.DocumentSignature.SizeBytes = checksum(c.hostSignature), int64(len(c.hostSignature))
		}
	}
	for path, raw := range map[string][]byte{c.f.manifestPath: c.hostRaw, c.f.signaturePath: c.hostSignature} {
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func (c *coreHostTrustFixture) signSelection(t *testing.T) {
	t.Helper()
	if err := c.release.Validate(); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(c.release)
	if err != nil {
		t.Fatal(err)
	}
	c.selection = CoreHostSelection{Raw: raw, Signature: ed25519.Sign(c.assemblyPrivate, raw)}
}

func (c *coreHostTrustFixture) verify() (VerifiedManifest, string, error) {
	return c.f.manager.verifyHostManifest(c.f.manifestPath, c.f.signaturePath, &c.selection)
}

func (c *coreHostTrustFixture) stage(t *testing.T) Journal {
	t.Helper()
	options, err := c.f.manager.CoreHostOptions(c.selection)
	if err != nil {
		t.Fatal(err)
	}
	status, err := c.f.manager.Stage(context.Background(), options)
	if err != nil || status.State != PhaseStaged {
		t.Fatal("core-owned host did not stage", status, err)
	}
	j, err := loadJournal(c.f.manager.config.JournalPath)
	if err != nil || j.CoreManifestSHA256 != checksum(c.selection.Raw) {
		t.Fatal("stage did not retain exact assembly", j, err)
	}
	return j
}

func (c *coreHostTrustFixture) authorizeProof(t *testing.T) {
	t.Helper()
	root := c.f.manager.config.CoreStatePath
	for name, raw := range map[string][]byte{
		checksum(c.selection.Raw) + ".json":     c.selection.Raw,
		checksum(c.selection.Raw) + ".json.sig": c.selection.Signature,
	} {
		if err := atomicWrite(filepath.Join(root, "targets", name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	j := CoreJournal{Schema: CoreJournalSchema, RequestID: "trust-fixture", Target: c.release,
		ManifestSHA256: checksum(c.selection.Raw), Phase: "applying", RestartRequired: true, ActivationRequested: true}
	for _, name := range coreStepNames(true) {
		state := "succeeded"
		if name == "commit-host" {
			state = "started"
		}
		j.Steps = append(j.Steps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: state, Evidence: "fixture"})
	}
	if err := (CoreManager{Root: c.f.manager.config.CoreStatePath}).saveCore(&j); err != nil {
		t.Fatal(err)
	}
}

func TestCoreHostTrustDevelopmentStagesReadbackAndProofWithPublicImageAnchor(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	stable := coreHostTrustPrivate(t)
	stablePath := filepath.Join(c.f.dir, "immutable-stable.pub")
	if err := os.WriteFile(stablePath, coreHostTrustPEM(t, stable.Public().(ed25519.PublicKey)), 0600); err != nil {
		t.Fatal(err)
	}
	// Keep both authorities local and independent. Legacy verification reads
	// this real, mismatched image anchor; the selected member uses the exact
	// host grant. No test depends on a key installed on the test runner.
	c.f.manager.config.TrustKeyPath = stablePath
	c.policy.Grants = append(c.policy.Grants, updatetrust.Grant{Publisher: "Owner host",
		Repository: c.f.update.ReleaseSet.Source, Branch: "dev", Scope: "appliance",
		PublicKey: string(coreDevelopmentTrustPEM)})
	// The legacy path must continue rejecting a Development document against
	// a mismatched immutable image key; core authority must not change it.
	empty := updatetrust.Policy{Schema: updatetrust.Schema}
	if _, err := verifyManifestWithOwnerPolicy(c.f.manifestPath, c.f.signaturePath, stablePath, empty); err == nil {
		t.Fatal("legacy verifier accepted the wrong filesystem anchor")
	}
	j := c.stage(t)
	if _, err := c.f.manager.loadTransactionManifest(j); err != nil {
		t.Fatal("core readback returned to the immutable image key", err)
	}
	c.authorizeProof(t)
	if err := c.f.manager.persistHealthyUpdateProof(j); err != nil {
		t.Fatal("core proof returned to the immutable image key", err)
	}
	proof, err := os.ReadFile(c.f.manager.config.HealthyManifestPath)
	if err != nil || !bytes.Equal(proof, c.hostRaw) {
		t.Fatal("healthy proof did not preserve exact signed document", err)
	}
	// Revocation is current policy, even when the same key remains provisioned
	// and every staged byte and signed envelope is still unchanged.
	c.policy.Grants[len(c.policy.Grants)-1].Revoked = true
	if _, err := c.f.manager.loadTransactionManifest(j); err == nil {
		t.Fatal("readback fell back to provisioned trust after revocation")
	}
	if err := c.f.manager.persistHealthyUpdateProof(j); err == nil {
		t.Fatal("healthy proof ignored current host revocation")
	}
	after, err := os.ReadFile(c.f.manager.config.HealthyManifestPath)
	if err != nil || !bytes.Equal(after, proof) {
		t.Fatal("rejected proof changed retained evidence", err)
	}
}

func TestCoreHostTrustRejectsInvalidSigningAndMembership(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, *coreHostTrustFixture)
	}{
		{"wrong-host-signature-rebound-in-envelope", func(t *testing.T, c *coreHostTrustFixture) {
			c.hostSignature = ed25519.Sign(c.assemblyPrivate, c.hostRaw)
			c.bindDocument(t)
			c.signSelection(t)
		}},
		{"corrupt-host-signature-rebound-in-envelope", func(t *testing.T, c *coreHostTrustFixture) {
			c.hostSignature[0] ^= 1
			c.bindDocument(t)
			c.signSelection(t)
		}},
		{"partial-host-signature-rebound-in-envelope", func(t *testing.T, c *coreHostTrustFixture) {
			c.hostSignature = c.hostSignature[:ed25519.SignatureSize-1]
			c.bindDocument(t)
			c.signSelection(t)
		}},
		{"missing-host-signature", func(t *testing.T, c *coreHostTrustFixture) {
			if err := os.Remove(c.f.signaturePath); err != nil {
				t.Fatal(err)
			}
		}},
		{"wrong-manifest-key-id-with-valid-signature", func(t *testing.T, c *coreHostTrustFixture) {
			c.f.update.Trust.KeyID = strings.Repeat("0", 16)
			c.signHost(t)
			c.signSelection(t)
		}},
		{"assembly-key-cannot-claim-host-authority", func(t *testing.T, c *coreHostTrustFixture) {
			c.hostPrivate = c.assemblyPrivate
			c.f.update.Trust.KeyID = coreHostTrustID(t, c.hostPrivate)[:16]
			for i := range c.release.Members {
				c.release.Members[i].KeyID = coreHostTrustID(t, c.hostPrivate)
			}
			c.signHost(t)
			c.signSelection(t)
		}},
		{"wrong-envelope-signature", func(t *testing.T, c *coreHostTrustFixture) {
			c.selection.Signature = ed25519.Sign(c.hostPrivate, c.selection.Raw)
		}},
		{"partial-envelope-signature", func(t *testing.T, c *coreHostTrustFixture) {
			c.selection.Signature = c.selection.Signature[:ed25519.SignatureSize-1]
		}},
		{"missing-envelope-signature", func(t *testing.T, c *coreHostTrustFixture) {
			c.selection.Signature = nil
		}},
		{"signed-document-source-mismatch", func(t *testing.T, c *coreHostTrustFixture) {
			c.f.update.ReleaseSet.Source = "https://forge.example/alternate/YouEye"
			c.signHost(t)
			c.signSelection(t)
		}},
		{"signed-document-raw-branch-mismatch", func(t *testing.T, c *coreHostTrustFixture) {
			c.f.update.ReleaseSet.Branch = "Dev"
			c.f.update.ReleaseSet.ControlPanel.Tag = "cp-Dev-v1.0.0"
			c.f.update.ReleaseSet.UI.Tag = "ui-Dev-v1.0.0"
			c.signHost(t)
			c.signSelection(t)
		}},
		{"document-digest-mismatch", func(t *testing.T, c *coreHostTrustFixture) {
			for i := range c.release.Members {
				if c.release.Members[i].Role == "system-update" {
					c.release.Members[i].Artifact.SHA256 = strings.Repeat("0", 64)
				}
			}
			c.signSelection(t)
		}},
		{"document-signature-binding-mismatch", func(t *testing.T, c *coreHostTrustFixture) {
			for i := range c.release.Members {
				if c.release.Members[i].Role == "system-update" {
					c.release.Members[i].DocumentSignature.SHA256 = strings.Repeat("0", 64)
				}
			}
			c.signSelection(t)
		}},
		{"payload-binding-mismatch", func(t *testing.T, c *coreHostTrustFixture) {
			for i := range c.release.Members {
				if c.release.Members[i].Role == "system-root" {
					c.release.Members[i].Artifact.SizeBytes++
				}
			}
			c.signSelection(t)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newCoreHostTrustFixture(t)
			if _, _, err := c.verify(); err != nil {
				t.Fatal("valid control failed", err)
			}
			tc.mutate(t, c)
			if _, _, err := c.verify(); err == nil {
				t.Fatal("invalid signing or membership accepted")
			}
			if len(c.f.writes) != 0 || c.f.bootInstalls != 0 {
				t.Fatal("document verification performed host effects")
			}
		})
	}
}

func TestCoreHostTrustOwnerGrantIsExactAndCannotBorrowAnotherScope(t *testing.T) {
	for _, change := range []string{"repository", "raw-branch", "app", "ui", "cp", "spine", "wrong-key", "revoked", "malformed-policy"} {
		t.Run(change, func(t *testing.T) {
			c := newCoreHostTrustFixture(t)
			unrelated := coreHostTrustPrivate(t)
			coreDevelopmentTrustPEM = coreHostTrustPEM(t, unrelated.Public().(ed25519.PublicKey))
			grant := updatetrust.Grant{Publisher: "Owner host", Repository: c.f.update.ReleaseSet.Source,
				Branch: "dev", Scope: "appliance", PublicKey: string(coreHostTrustPEM(t, c.hostPrivate.Public().(ed25519.PublicKey)))}
			c.policy.Grants = append(c.policy.Grants, grant)
			verified, _, err := c.verify()
			if err != nil || verified.Publisher != grant.Publisher {
				t.Fatal("exact owner authority was not honored and labeled", err, verified.Publisher)
			}
			last := &c.policy.Grants[len(c.policy.Grants)-1]
			switch change {
			case "repository":
				last.Repository = "https://forge.example/alternate/YouEye"
			case "raw-branch":
				last.Branch = "Dev"
			case "wrong-key":
				last.PublicKey = string(coreDevelopmentTrustPEM)
			case "revoked":
				last.Revoked = true
			case "malformed-policy":
				c.policy.Schema = "invalid"
			default:
				last.Scope = change
			}
			if _, _, err := c.verify(); err == nil {
				t.Fatal("nonmatching, revoked or invalid authority accepted")
			}
		})
	}
}

func TestCoreHostTrustReadbackRequiresExactProtectedRetainedEnvelope(t *testing.T) {
	for _, change := range []string{"missing-envelope", "missing-envelope-signature", "partial-envelope-signature", "changed-valid-envelope", "writable-envelope", "symlink-envelope"} {
		t.Run(change, func(t *testing.T) {
			c := newCoreHostTrustFixture(t)
			j := c.stage(t)
			if _, err := c.f.manager.loadTransactionManifest(j); err != nil {
				t.Fatal("valid retained control failed", err)
			}
			c.authorizeProof(t)
			dir := c.f.manager.transactionDir(j.TransactionID)
			path := filepath.Join(dir, "core-release.json")
			switch change {
			case "missing-envelope":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				// A healthy-manifest fallback must not turn missing protected
				// core state into a legacy transaction.
				j.Phase = PhaseHealthy
				for path, raw := range map[string][]byte{c.f.manager.config.HealthyManifestPath: c.hostRaw,
					c.f.manager.config.HealthyManifestPath + ".sig": c.hostSignature} {
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
				}
			case "missing-envelope-signature":
				if err := os.Remove(path + ".sig"); err != nil {
					t.Fatal(err)
				}
			case "partial-envelope-signature":
				if err := os.WriteFile(path+".sig", c.selection.Signature[:63], 0600); err != nil {
					t.Fatal(err)
				}
			case "changed-valid-envelope":
				c.release.Sequence++
				c.signSelection(t)
				for path, raw := range map[string][]byte{path: c.selection.Raw, path + ".sig": c.selection.Signature} {
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
				}
			case "writable-envelope":
				if err := os.Chmod(path, 0666); err != nil {
					t.Fatal(err)
				}
			case "symlink-envelope":
				target := filepath.Join(c.f.dir, "otherwise-valid-core.json")
				if err := os.WriteFile(target, c.selection.Raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := c.f.manager.loadTransactionManifest(j); err == nil {
				t.Fatal("readback accepted missing, unsafe or different core state")
			}
			if err := c.f.manager.persistHealthyUpdateProof(j); err == nil {
				t.Fatal("healthy proof accepted missing, unsafe or different core state")
			}
		})
	}
}

func TestCoreHostTrustLegacyRequestsKeepTheirFilesystemAuthority(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	c.f.manager.config.TrustKeyPath = filepath.Join(c.f.dir, "legacy.pub")
	if err := os.WriteFile(c.f.manager.config.TrustKeyPath, coreHostTrustPEM(t, c.hostPrivate.Public().(ed25519.PublicKey)), 0600); err != nil {
		t.Fatal(err)
	}
	// Any accidental call into core authority now fails. Legacy verification
	// must still authenticate these same bytes against its configured key.
	coreTrustLookup = func(string, string, string) (*updatetrust.Grant, error) {
		return nil, fmt.Errorf("core authority must not be used for a legacy request")
	}
	verified, digest, err := c.f.manager.verifyHostManifest(c.f.manifestPath, c.f.signaturePath, nil)
	if err != nil || digest != "" || verified.SHA256 != checksum(c.hostRaw) {
		t.Fatal("legacy verification changed authority", digest, err)
	}
}

func TestCoreHostTrustProvisionedDevelopmentStagesReadbackAndProof(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	// No owner host grant is present. The default path selects the existing
	// provisioned Development authority independently of the image anchor.
	j := c.stage(t)
	if _, err := c.f.manager.loadTransactionManifest(j); err != nil {
		t.Fatal("provisioned Development readback failed", err)
	}
	c.authorizeProof(t)
	if err := c.f.manager.persistHealthyUpdateProof(j); err != nil {
		t.Fatal("provisioned Development proof failed", err)
	}
}

func (c *coreHostTrustFixture) bootAndPromote(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	c.authorizeProof(t)
	if _, err := c.f.manager.Activate(ctx, false); err != nil {
		t.Fatal(err)
	}
	c.f.bootTarget(t)
	target := testApplianceManifest(c.f.update.TargetImageVersion, c.f.update.SourceCommit)
	target.ReleaseSet.Source = c.f.update.ReleaseSet.Source
	c.f.setCurrentManifest(t, target)
	if _, err := c.f.manager.Reconcile(ctx, ReconcileOptions{}); err != nil {
		t.Fatal("candidate trial reconciliation failed", err)
	}
	if _, err := appliance.CommitHealthySlot(c.f.manager.config.StatePath, target, "root=PARTLABEL=YE-SYSTEM-B ro"); err != nil {
		t.Fatal(err)
	}
}

func TestCoreHostTrustReconciliationRetainsAuthorityAndHealthyFallback(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	c.stage(t)
	c.bootAndPromote(t)
	result, err := c.f.manager.Reconcile(context.Background(), ReconcileOptions{})
	if err != nil || result.Status.State != PhaseHealthy {
		t.Fatal("healthy reconciliation failed", result, err)
	}
	j, err := loadJournal(c.f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	// Only evict the host document copy. Its protected signed assembly must
	// remain available even when readback uses the durable healthy proof.
	path := filepath.Join(c.f.manager.transactionDir(j.TransactionID), "system-update-manifest.json")
	for _, name := range []string{path, path + ".sig"} {
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.f.manager.loadTransactionManifest(j); err != nil {
		t.Fatal("healthy fallback lost core authority", err)
	}
	c.policy.Grants = append(c.policy.Grants, updatetrust.Grant{Publisher: "Revoked host",
		Repository: c.f.update.ReleaseSet.Source, Branch: "dev", Scope: "appliance",
		PublicKey: string(coreDevelopmentTrustPEM), Revoked: true})
	if _, err := c.f.manager.loadTransactionManifest(j); err == nil {
		t.Fatal("healthy fallback ignored current revocation")
	}
}

func TestCoreHostTrustReconciliationRejectsRevocationBeforeProofOrBootEffects(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	c.stage(t)
	c.bootAndPromote(t)
	c.policy.Grants = append(c.policy.Grants, updatetrust.Grant{Publisher: "Revoked host",
		Repository: c.f.update.ReleaseSet.Source, Branch: "dev", Scope: "appliance",
		PublicKey: string(coreDevelopmentTrustPEM), Revoked: true})
	c.f.runs = nil
	if _, err := c.f.manager.Reconcile(context.Background(), ReconcileOptions{}); err == nil {
		t.Fatal("reconciliation accepted revoked host authority")
	}
	if len(c.f.runs) != 0 {
		t.Fatal("rejected reconciliation changed boot state", c.f.runs)
	}
	if _, err := os.Stat(c.f.manager.config.HealthyManifestPath); !os.IsNotExist(err) {
		t.Fatal("rejected reconciliation created healthy proof", err)
	}
	j, err := loadJournal(c.f.manager.config.JournalPath)
	if err != nil || j.Phase != PhaseTrial {
		t.Fatal("rejected reconciliation advanced its journal", j, err)
	}
}

func TestCoreHostTrustStageRejectsInvalidAuthorityBeforeHostEffects(t *testing.T) {
	for _, change := range []string{"wrong-signature", "corrupt-signature", "partial-signature", "missing-signature", "revoked-host", "revoked-assembly"} {
		t.Run(change, func(t *testing.T) {
			c := newCoreHostTrustFixture(t)
			options, err := c.f.manager.CoreHostOptions(c.selection)
			if err != nil {
				t.Fatal("valid selection control failed", err)
			}
			switch change {
			case "wrong-signature":
				c.hostSignature = ed25519.Sign(c.assemblyPrivate, c.hostRaw)
			case "corrupt-signature":
				c.hostSignature[0] ^= 1
			case "partial-signature":
				c.hostSignature = c.hostSignature[:63]
			case "missing-signature":
				// The frozen selection still requires its original signature.
				// An unavailable download must never use a cached authority.
				c.hostSignature = nil
			case "revoked-host":
				c.policy.Grants = append(c.policy.Grants, updatetrust.Grant{Publisher: "Revoked host",
					Repository: c.f.update.ReleaseSet.Source, Branch: "dev", Scope: "appliance",
					PublicKey: string(coreDevelopmentTrustPEM), Revoked: true})
			case "revoked-assembly":
				c.policy.Grants[0].Revoked = true
			}
			if strings.HasSuffix(change, "signature") && change != "missing-signature" {
				// A valid assembly signature and matching outer hashes cannot
				// compensate for an invalid independent host signature.
				c.bindDocument(t)
				c.signSelection(t)
			}
			options.Core = &c.selection
			if _, err := c.f.manager.Stage(context.Background(), options); err == nil {
				t.Fatal("invalid selected host staged")
			}
			if len(c.f.writes) != 0 || c.f.bootInstalls != 0 || c.f.bootCreates != 0 {
				t.Fatal("invalid authority performed host effects")
			}
		})
	}
}

func TestCoreHostTrustRetainedReadbackRechecksAssemblyRevocation(t *testing.T) {
	c := newCoreHostTrustFixture(t)
	j := c.stage(t)
	c.authorizeProof(t)
	c.policy.Grants[0].Revoked = true
	if _, err := c.f.manager.loadTransactionManifest(j); err == nil {
		t.Fatal("readback accepted revoked assembly authority")
	}
	if err := c.f.manager.persistHealthyUpdateProof(j); err == nil {
		t.Fatal("healthy proof accepted revoked assembly authority")
	}
}
