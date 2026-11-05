package cmd

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

type mixedCoreDeploymentFixture struct {
	image               appliance.Manifest
	release             releasecache.CoreRelease
	policy              systemupdate.ReleasePolicy
	root, binary        string
	stable, development ed25519.PrivateKey
	trust               updatetrust.Policy
}

func mixedCoreHash(raw []byte) string { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

func newMixedCoreDeploymentFixture(t *testing.T) *mixedCoreDeploymentFixture {
	t.Helper()
	f := &mixedCoreDeploymentFixture{root: t.TempDir(), stable: ed25519.NewKeyFromSeed(bytes.Repeat([]byte{71}, 32)), development: ed25519.NewKeyFromSeed(bytes.Repeat([]byte{72}, 32))}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	f.release, _, err = releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	keyText := func(key ed25519.PrivateKey) string {
		der, _ := x509.MarshalPKIXPublicKey(key.Public())
		return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	}
	keyID := func(key ed25519.PrivateKey) string {
		der, _ := x509.MarshalPKIXPublicKey(key.Public())
		return mixedCoreHash(der)
	}
	f.release.Version, f.release.Tag = "0.5.65", "youeye-v0.5.65"
	f.release.SignerSHA256 = keyID(f.stable)
	f.trust = updatetrust.Policy{Schema: updatetrust.Schema}
	f.trust.Grants = append(f.trust.Grants, updatetrust.Grant{Publisher: "Fixture Stable", Repository: f.release.Source, Branch: "main", Scope: "appliance", PublicKey: keyText(f.stable)}, updatetrust.Grant{Publisher: "Fixture Stable", Repository: f.release.Source, Branch: "main", Scope: "spine", PublicKey: keyText(f.stable)})
	for i := range f.release.Members {
		m := &f.release.Members[i]
		m.BuildVersion, m.Tag, m.KeyID = "0.5.65", "youeye-v0.5.65", keyID(f.stable)
		if m.Role == "cp" || m.Role == "ui" {
			m.Source = "https://forge.example.test/team/YouEye"
			m.KeyID = keyID(f.development)
			if m.Role == "cp" {
				m.BuildVersion = "0.5.65-alpha.4"
			} else {
				m.BuildVersion = "0.5.65-dev.1"
				m.Branch = "dev"
			}
			m.Tag = "youeye-v" + m.BuildVersion
			f.trust.Grants = append(f.trust.Grants, updatetrust.Grant{Publisher: "Fixture original builder", Repository: m.Source, Branch: m.Branch, Scope: m.Role, PublicKey: keyText(f.development)})
		}
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
			}
		}
		if m.Role == "spine" {
			payload := []byte("immutable fixture Spine")
			f.binary = filepath.Join(f.root, coreBakedExecutable)
			if err := os.MkdirAll(filepath.Dir(f.binary), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(f.binary, payload, 0755); err != nil {
				t.Fatal(err)
			}
			m.Artifact.SHA256, m.Artifact.SizeBytes = mixedCoreHash(payload), int64(len(payload))
		}
	}
	oldPolicy, oldTrust, oldChannels, oldExecutable, oldCfg, oldVersion, oldReader := deploymentPolicyPath, updatetrust.Path, channels.ConfigPath, applianceExecutablePath, cfg, Version, coreInstalledReaderHost
	t.Cleanup(func() {
		deploymentPolicyPath, updatetrust.Path, channels.ConfigPath, applianceExecutablePath, cfg, Version = oldPolicy, oldTrust, oldChannels, oldExecutable, oldCfg, oldVersion
		coreInstalledReaderHost = oldReader
	})
	deploymentPolicyPath = filepath.Join(f.root, "release-policy.json")
	updatetrust.Path = filepath.Join(f.root, "update-trust.json")
	channels.ConfigPath = filepath.Join(f.root, "youeye.yaml")
	applianceExecutablePath = func() (string, error) { return f.binary, nil }
	coreInstalledReaderHost = func() coreInstalledReaderObserver {
		return coreInstalledReaderObserver{Root: f.root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return coreBakedExecutable, nil }, CurrentSHA256: func() (string, error) { raw, e := os.ReadFile(f.binary); return mixedCoreHash(raw), e }, APISHA256: func(context.Context) (string, error) { raw, e := os.ReadFile(f.binary); return mixedCoreHash(raw), e }}
	}
	cfg = config.Default()
	cfg.Releases.RepoURL = f.release.Source
	Version = "0.5.65"
	if err := (&channels.Config{Default: channels.Channel{Source: f.release.Source, Branch: "main", Fallback: []string{}}}).Save(); err != nil {
		t.Fatal(err)
	}
	if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
		t.Fatal(err)
	}
	f.writeSelection(t)
	return f
}

func (f *mixedCoreDeploymentFixture) writeSelection(t *testing.T) {
	t.Helper()
	var spine releasecache.CoreMember
	var provenance, checksums, signature []byte
	for i := range f.release.Members {
		m := &f.release.Members[i]
		if m.Role != "spine" {
			continue
		}
		provenance = []byte(`{"schema":"youeye.release.provenance.v1","core_metadata":"paired-v2","source_commit":"` + m.SourceCommit + `"}`)
		m.Provenance.SHA256, m.Provenance.SizeBytes = mixedCoreHash(provenance), int64(len(provenance))
		checksums = []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
		signature = ed25519.Sign(f.stable, checksums)
		m.Checksums.SHA256, m.Checksums.SizeBytes = mixedCoreHash(checksums), int64(len(checksums))
		m.Signature.SHA256, m.Signature.SizeBytes = mixedCoreHash(signature), 64
		spine = *m
	}
	raw, err := json.Marshal(f.release)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(f.stable, raw)
	canonical, err := releasecache.EncodeCoreMetadataV2(f.release)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := releasecache.EncodeCoreMetadataPair(raw, canonical)
	if err != nil {
		t.Fatal(err)
	}
	docs := releasecache.CoreMetadataDocuments{Canonical: canonical, CanonicalSignature: ed25519.Sign(f.stable, canonical), Pair: pair, PairSignature: ed25519.Sign(f.stable, pair)}
	facts, err := releasecache.VerifyCoreMetadataBundle(raw, sig, docs, f.stable.Public().(ed25519.PublicKey), func(m releasecache.CoreMember) (ed25519.PublicKey, error) {
		if m.Role == "cp" || m.Role == "ui" {
			return f.development.Public().(ed25519.PublicKey), nil
		}
		return f.stable.Public().(ed25519.PublicKey), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	proof := releasecache.CoreMetadataProof{Schema: "youeye.core-metadata-proof.v1", ExecutionManifestSHA256: mixedCoreHash(raw), Advertised: true, SpineChecksums: checksums, SpineSignature: signature, SpineProvenance: provenance, Documents: docs, Bindings: facts.Bindings}
	proofRaw, _ := json.Marshal(proof)
	for name, data := range map[string][]byte{"core-release.json": raw, "core-release.json.sig": sig, "core-metadata.json": proofRaw} {
		if err := os.WriteFile(filepath.Join(f.root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	f.policy = systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: f.release.Tag, ManifestSHA256: strings.Repeat("b", 64), CoreManifestSHA256: mixedCoreHash(raw), Freshness: "require-current"}
	policyRaw, _ := json.Marshal(f.policy)
	if err := os.WriteFile(deploymentPolicyPath, policyRaw, 0600); err != nil {
		t.Fatal(err)
	}
	f.image = appliance.Manifest{ImageVersion: "0.5.65", SourceCommit: f.release.SourceCommit, ReleaseSet: &appliance.ReleaseSet{Schema: "youeye.release-set.v2", Source: f.release.Source, Branch: "main", Fallback: []string{}, Spine: appliance.ComponentRelease{Version: spine.BuildVersion, Branch: spine.Branch, Tag: spine.Tag, SourceCommit: spine.SourceCommit, ArtifactSHA256: spine.Artifact.SHA256}}}
	for _, m := range f.release.Members {
		c := appliance.ComponentRelease{Version: m.BuildVersion, Branch: m.Branch, Tag: m.Tag, SourceCommit: m.SourceCommit, ArtifactSHA256: m.Artifact.SHA256}
		if m.Role == "cp" {
			f.image.ReleaseSet.ControlPanel = c
		}
		if m.Role == "ui" {
			f.image.ReleaseSet.UI = c
		}
	}
}

func TestMixedSignedCoreFirstDeploymentPreservesOriginalServiceSources(t *testing.T) {
	f := newMixedCoreDeploymentFixture(t)
	// Match the image's actual installation-owned seeds before reconciliation.
	c, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	for name, seed := range map[string]appliance.ComponentRelease{channels.ComponentControl: f.image.ReleaseSet.ControlPanel, channels.ComponentUI: f.image.ReleaseSet.UI} {
		if err := c.SetChannel(name, channels.Channel{Source: f.image.ReleaseSet.Source, Branch: f.image.ReleaseSet.ComponentBranch(seed), Tag: seed.Tag, ArtifactSHA256: seed.ArtifactSHA256, PinOrigin: "installation", Fallback: []string{}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(f.image)
	selected, err := selectApplianceServices(f.image)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyApplianceReleaseSet(selected, GetConfig()); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(f.image)
	if !bytes.Equal(before, after) {
		t.Fatal("sealed image was rewritten")
	}
	if !reflect.DeepEqual(selected, f.image) {
		t.Fatal("signed Core was projected into a misleading image release set")
	}
	ch, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range f.release.Members {
		if m.Role != "cp" && m.Role != "ui" {
			continue
		}
		component := channels.ComponentControl
		if m.Role == "ui" {
			component = channels.ComponentUI
		}
		got := ch.Effective(component, GetConfig())
		if got.Source != m.Source || got.Branch != m.Branch || got.Tag != m.Tag || got.ArtifactSHA256 != m.Artifact.SHA256 || got.Fallback == nil || len(got.Fallback) != 0 {
			t.Fatalf("original member pin lost: %+v", got)
		}
	}
	if _, err = selectApplianceServices(f.image); err != nil {
		t.Fatalf("resume: %v", err)
	}
}

func TestMixedCoreDeploymentRejectsChangedProofAndCurrentAuthorityBeforePins(t *testing.T) {
	for _, name := range []string{"signature", "paired proof", "missing pair", "revoked CP", "changed UI authority", "foreign unsigned source", "signed foreign source without role grant", "malformed policy", "foreign host role revoked"} {
		t.Run(name, func(t *testing.T) {
			f := newMixedCoreDeploymentFixture(t)
			switch name {
			case "signature":
				p := filepath.Join(f.root, "core-release.json.sig")
				raw, _ := os.ReadFile(p)
				raw[0] ^= 1
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "paired proof", "missing pair":
				p := filepath.Join(f.root, "core-metadata.json")
				raw, _ := os.ReadFile(p)
				var proof releasecache.CoreMetadataProof
				if err := json.Unmarshal(raw, &proof); err != nil {
					t.Fatal(err)
				}
				if name == "paired proof" {
					proof.Documents.PairSignature[0] ^= 1
				} else {
					proof.Documents.Pair = nil
				}
				raw, _ = json.Marshal(proof)
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "revoked CP", "changed UI authority":
				for i := range f.trust.Grants {
					g := &f.trust.Grants[i]
					if name == "revoked CP" && g.Scope == "cp" {
						g.Revoked = true
					}
					if name == "changed UI authority" && g.Scope == "ui" {
						g.PublicKey = f.trust.Grants[0].PublicKey
					}
				}
				if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
					t.Fatal(err)
				}
			case "foreign unsigned source":
				p := filepath.Join(f.root, "core-release.json")
				raw, _ := os.ReadFile(p)
				raw = bytes.ReplaceAll(raw, []byte("https://forge.example.test/team/YouEye"), []byte("https://foreign.example.test/team/YouEye"))
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "signed foreign source without role grant":
				for i := range f.release.Members {
					m := &f.release.Members[i]
					if m.Role != "cp" {
						continue
					}
					m.Source = "https://github.com/foreign-publisher/YouEye"
					for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM} {
						b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
					}
				}
				// Assembly/pair signatures are genuine, but neither can enroll
				// a publisher for a different member repository and scope.
				f.writeSelection(t)
			case "malformed policy":
				if err := os.WriteFile(updatetrust.Path, []byte(`{"schema":"unknown"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "foreign host role revoked":
				for i := range f.release.Members {
					m := &f.release.Members[i]
					if m.Role != "system-root" {
						continue
					}
					m.Source = "https://host-builder.example.test/team/YouEye"
					for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM} {
						b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
					}
				}
				f.trust.Grants = append(f.trust.Grants, updatetrust.Grant{Publisher: "Fixture host", Repository: "https://host-builder.example.test/team/YouEye", Branch: "main", Scope: "appliance", PublicKey: f.trust.Grants[0].PublicKey})
				if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
					t.Fatal(err)
				}
				f.writeSelection(t)
				f.trust.Grants[len(f.trust.Grants)-1].Revoked = true
				if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(channels.ConfigPath)
			if _, err := selectApplianceServices(f.image); err == nil {
				t.Fatal("invalid selection or authority admitted")
			}
			after, _ := os.ReadFile(channels.ConfigPath)
			if !bytes.Equal(before, after) {
				t.Fatal("rejected selection changed channels")
			}
		})
	}
}

func TestMixedCoreDeploymentPreservesOwnerChoicesAndRejectsTupleDrift(t *testing.T) {
	for _, name := range []string{"foreign owner source with same pin", "owner branch", "owner fallback", "foreign installation seed", "owner System conflict"} {
		t.Run(name, func(t *testing.T) {
			f := newMixedCoreDeploymentFixture(t)
			c, err := channels.Load()
			if err != nil {
				t.Fatal(err)
			}
			cp := f.image.ReleaseSet.ControlPanel
			switch name {
			case "foreign owner source with same pin":
				c.Control = channels.Channel{Source: f.release.Source, Branch: cp.Branch, Tag: cp.Tag, ArtifactSHA256: cp.ArtifactSHA256, Fallback: []string{}}
			case "owner branch":
				c.Control = channels.Channel{Branch: "Owner/Choice"}
			case "owner fallback":
				c.Control = channels.Channel{Fallback: []string{"Owner/Fallback"}}
			case "foreign installation seed":
				c.Control = channels.Channel{Source: "https://foreign.example.test/team/YouEye", Branch: cp.Branch, Tag: cp.Tag, ArtifactSHA256: cp.ArtifactSHA256, PinOrigin: "installation", Fallback: []string{}}
			case "owner System conflict":
				c.System = channels.Channel{Source: "https://owner.example.test/team/YouEye", Branch: "main", Fallback: []string{}}
			}
			if err = c.Save(); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(channels.ConfigPath)
			if _, err = selectApplianceServices(f.image); err == nil {
				t.Fatal("owner choice replaced")
			}
			after, _ := os.ReadFile(channels.ConfigPath)
			if !bytes.Equal(before, after) {
				t.Fatal("partial service pin persisted before rejection")
			}
		})
	}
	for _, name := range []string{"source", "branch", "tag", "hash", "fallback", "revoked after selection"} {
		t.Run(name, func(t *testing.T) {
			f := newMixedCoreDeploymentFixture(t)
			if _, err := selectApplianceServices(f.image); err != nil {
				t.Fatal(err)
			}
			c, err := channels.Load()
			if err != nil {
				t.Fatal(err)
			}
			switch name {
			case "source":
				c.UI.Source = f.release.Source
			case "branch":
				c.UI.Branch = "main"
			case "tag":
				c.UI.Tag = "youeye-v0.5.65-dev.2"
			case "hash":
				c.UI.ArtifactSHA256 = strings.Repeat("f", 64)
			case "fallback":
				c.UI.Fallback = []string{"main"}
			case "revoked after selection":
				f.trust.Grants[len(f.trust.Grants)-1].Revoked = true
				if err := updatetrust.Save(updatetrust.Path, f.trust); err != nil {
					t.Fatal(err)
				}
			}
			if err = c.Save(); err != nil {
				t.Fatal(err)
			}
			if err = verifyApplianceReleaseSet(f.image, GetConfig()); err == nil {
				t.Fatal("changed tuple or authority accepted")
			}
		})
	}
}

func TestMixedCoreFirstDeploymentHealthChecksOriginalServiceSource(t *testing.T) {
	f := newMixedCoreDeploymentFixture(t)
	if _, err := selectApplianceServices(f.image); err != nil {
		t.Fatal(err)
	}
	oldRoot, oldVersion := coreInstalledHealthStateRoot, firstDeployPackageVersion
	t.Cleanup(func() { coreInstalledHealthStateRoot, firstDeployPackageVersion = oldRoot, oldVersion })
	coreInstalledHealthStateRoot = filepath.Join(f.root, "core-state")
	t.Cleanup(update.SetProvenanceDir(filepath.Join(f.root, "provenance")))
	versions := map[string]string{}
	for _, m := range f.release.Members {
		if m.Role != "cp" && m.Role != "ui" {
			continue
		}
		key, container := "control", "youeye-control"
		if m.Role == "ui" {
			key, container = "ui", "youeye-ui"
		}
		p := filepath.Join(f.root, container, "package.json")
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(map[string]string{"version": m.BuildVersion})
		if err := os.WriteFile(p, raw, 0600); err != nil {
			t.Fatal(err)
		}
		versions[container] = p
		if err := update.WriteProvenance(key, update.ProvenanceEntry{Version: m.BuildVersion, Source: m.Source, Branch: m.Branch, Tag: m.Tag, ArtifactSHA256: m.Artifact.SHA256}); err != nil {
			t.Fatal(err)
		}
	}
	firstDeployPackageVersion = func(container, _ string) string {
		raw, _ := os.ReadFile(versions[container])
		var p struct{ Version string }
		_ = json.Unmarshal(raw, &p)
		return p.Version
	}
	checks := map[string]string{}
	observe := func() {
		checks = map[string]string{}
		addFirstDeployReleaseSetChecks(f.image, func(name, status, _ string) { checks[name] = status })
	}
	observe()
	for _, name := range []string{"System core provenance", "Server interface provenance", "YouEye interface provenance"} {
		if checks[name] != "pass" {
			t.Fatalf("actual firstdeploy health %s: %+v", name, checks)
		}
	}
	ui, ok := update.GetProvenance("ui")
	if !ok {
		t.Fatal("missing UI fixture")
	}
	ui.Source = f.release.Source
	if err := update.WriteProvenance("ui", ui); err != nil {
		t.Fatal(err)
	}
	observe()
	if checks["YouEye interface provenance"] != "fail" {
		t.Fatal("relabeled installed source passed health")
	}
}
