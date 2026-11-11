package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
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
)

type mixedCoreDeploymentFixture struct {
	image        appliance.Manifest
	release      releasecache.CoreRelease
	policy       systemupdate.ReleasePolicy
	root, binary string
}

func mixedCoreHash(raw []byte) string { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

func newMixedCoreDeploymentFixture(t *testing.T) *mixedCoreDeploymentFixture {
	t.Helper()
	f := &mixedCoreDeploymentFixture{root: t.TempDir()}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	f.release, _, err = releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	f.release.Version, f.release.Tag = "0.5.65", "youeye-v0.5.65"
	for i := range f.release.Members {
		m := &f.release.Members[i]
		m.BuildVersion, m.Tag = "0.5.65", "youeye-v0.5.65"
		if m.Role == "cp" || m.Role == "ui" {
			m.Source = "https://forge.example.test/team/YouEye"
			if m.Role == "cp" {
				m.BuildVersion = "0.5.65-alpha.4"
			} else {
				m.BuildVersion = "0.5.65-dev.1"
				m.Branch = "dev"
			}
			m.Tag = "youeye-v" + m.BuildVersion
		}
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, m.BuildInputs} {
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
	oldPolicy, oldChannels, oldExecutable, oldCfg, oldVersion, oldReader := deploymentPolicyPath, channels.ConfigPath, applianceExecutablePath, cfg, Version, coreInstalledReaderHost
	t.Cleanup(func() {
		deploymentPolicyPath, channels.ConfigPath, applianceExecutablePath, cfg, Version = oldPolicy, oldChannels, oldExecutable, oldCfg, oldVersion
		coreInstalledReaderHost = oldReader
	})
	deploymentPolicyPath = filepath.Join(f.root, "release-policy.json")
	channels.ConfigPath = filepath.Join(f.root, "youeye.yaml")
	applianceExecutablePath = func() (string, error) { return f.binary, nil }
	coreInstalledReaderHost = func() coreInstalledReaderObserver {
		return coreInstalledReaderObserver{Root: f.root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return coreBakedExecutable, nil }, CurrentSHA256: func() (string, error) { raw, e := os.ReadFile(f.binary); return mixedCoreHash(raw), e }}
	}
	cfg = config.Default()
	cfg.Releases.RepoURL = f.release.Source
	Version = "0.5.65"
	if err := (&channels.Config{Default: channels.Channel{Source: f.release.Source, Branch: "main", Fallback: []string{}}}).Save(); err != nil {
		t.Fatal(err)
	}
	f.writeSelection(t)
	return f
}

func (f *mixedCoreDeploymentFixture) writeSelection(t *testing.T) {
	t.Helper()
	var spine releasecache.CoreMember
	for _, m := range f.release.Members {
		if m.Role == "spine" {
			spine = m
		}
	}
	raw, err := json.Marshal(f.release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "core-release.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	f.policy = systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: f.release.Tag, ManifestSHA256: strings.Repeat("b", 64), CoreManifestSHA256: mixedCoreHash(raw), Freshness: "require-current"}
	policyRaw, _ := json.Marshal(f.policy)
	if err := os.WriteFile(deploymentPolicyPath, policyRaw, 0600); err != nil {
		t.Fatal(err)
	}
	f.image = appliance.Manifest{ImageVersion: "0.5.65", SourceCommit: f.release.SourceCommit, ReleaseSet: &appliance.ReleaseSet{Source: f.release.Source, Branch: "main", Fallback: []string{}, Spine: appliance.ComponentRelease{Version: spine.BuildVersion, Tag: spine.Tag, SourceCommit: spine.SourceCommit, ArtifactSHA256: spine.Artifact.SHA256}}}
	for _, m := range f.release.Members {
		c := appliance.ComponentRelease{Version: m.BuildVersion, Tag: m.Tag, SourceCommit: m.SourceCommit, ArtifactSHA256: m.Artifact.SHA256}
		if m.Role == "cp" {
			f.image.ReleaseSet.ControlPanel = c
		}
		if m.Role == "ui" {
			f.image.ReleaseSet.UI = c
		}
	}
}

func TestMixedCoreFirstDeploymentPreservesOriginalServiceSources(t *testing.T) {
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
		t.Fatal("Core was projected into a misleading image release set")
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

func TestMixedCoreDeploymentRejectsChangedSelectionBeforePins(t *testing.T) {
	for _, name := range []string{"changed document", "foreign source", "missing document"} {
		t.Run(name, func(t *testing.T) {
			f := newMixedCoreDeploymentFixture(t)
			p := filepath.Join(f.root, "core-release.json")
			switch name {
			case "changed document":
				raw, _ := os.ReadFile(p)
				raw = bytes.Replace(raw, []byte(`"sequence":2`), []byte(`"sequence":3`), 1)
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "foreign source":
				raw, _ := os.ReadFile(p)
				raw = bytes.ReplaceAll(raw, []byte("https://forge.example.test/team/YouEye"), []byte("https://foreign.example.test/team/YouEye"))
				if err := os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing document":
				if err := os.Remove(p); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(channels.ConfigPath)
			if _, err := selectApplianceServices(f.image); err == nil {
				t.Fatal("changed selection admitted")
			}
			after, _ := os.ReadFile(channels.ConfigPath)
			if !bytes.Equal(before, after) {
				t.Fatal("rejected selection changed channels")
			}
		})
	}
}

func TestMixedCoreDeploymentPreservesOwnerChoicesAndRejectsTupleDrift(t *testing.T) {
	for _, name := range []string{"foreign owner source with same pin", "owner branch", "owner fallback", "foreign installation seed"} {
		t.Run(name, func(t *testing.T) {
			f := newMixedCoreDeploymentFixture(t)
			c, err := channels.Load()
			if err != nil {
				t.Fatal(err)
			}
			cp := f.image.ReleaseSet.ControlPanel
			switch name {
			case "foreign owner source with same pin":
				c.Control = channels.Channel{Source: f.release.Source, Branch: "main", Tag: cp.Tag, ArtifactSHA256: cp.ArtifactSHA256, Fallback: []string{}}
			case "owner branch":
				c.Control = channels.Channel{Branch: "Owner/Choice"}
			case "owner fallback":
				c.Control = channels.Channel{Fallback: []string{"Owner/Fallback"}}
			case "foreign installation seed":
				c.Control = channels.Channel{Source: "https://foreign.example.test/team/YouEye", Branch: "main", Tag: cp.Tag, ArtifactSHA256: cp.ArtifactSHA256, PinOrigin: "installation", Fallback: []string{}}
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
	for _, name := range []string{"source", "branch", "tag", "hash", "fallback"} {
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
			}
			if err = c.Save(); err != nil {
				t.Fatal(err)
			}
			if err = verifyApplianceReleaseSet(f.image, GetConfig()); err == nil {
				t.Fatal("changed tuple accepted")
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
