package channels

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/config"
)

func testCfg() *config.Config {
	cfg := config.Default()
	cfg.Releases.RepoURL = "https://github.com/YouEye-Platform/YouEye"
	return cfg
}

// withConfigFile points ConfigPath at a temp file seeded with content.
func withConfigFile(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "youeye.yaml")
	if content != "" {
		if err := os.WriteFile(p, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	old := ConfigPath
	ConfigPath = p
	t.Cleanup(func() { ConfigPath = old })
	return p
}

func TestEffectiveDefaults(t *testing.T) {
	withConfigFile(t, "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	eff := c.Effective(ComponentSpine, testCfg())
	if eff.Source != "https://github.com/YouEye-Platform/YouEye" {
		t.Errorf("source = %q", eff.Source)
	}
	if eff.Branch != "main" {
		t.Errorf("branch = %q, want main", eff.Branch)
	}
	if !reflect.DeepEqual(eff.Fallback, []string{"main"}) {
		t.Errorf("fallback = %v, want [main]", eff.Fallback)
	}
}

func TestEffectiveOverrideMerge(t *testing.T) {
	withConfigFile(t, "")
	c, _ := Load()
	// Spine overrides only branch + disables fallback; source inherits default.
	if err := c.SetChannel(ComponentSpine, Channel{Branch: "f-x", Fallback: []string{}}); err != nil {
		t.Fatal(err)
	}
	eff := c.Effective(ComponentSpine, testCfg())
	if eff.Branch != "f-x" {
		t.Errorf("branch = %q", eff.Branch)
	}
	if eff.Fallback == nil || len(eff.Fallback) != 0 {
		t.Errorf("fallback = %v, want disabled (non-nil empty)", eff.Fallback)
	}
	if eff.Source != "https://github.com/YouEye-Platform/YouEye" {
		t.Errorf("source inherit failed: %q", eff.Source)
	}
	// UI has no override → full defaults.
	ui := c.Effective(ComponentUI, testCfg())
	if ui.Branch != "main" || !reflect.DeepEqual(ui.Fallback, []string{"main"}) {
		t.Errorf("ui effective = %+v", ui)
	}
}

func TestFallbackInheritVsDisable(t *testing.T) {
	withConfigFile(t, "")
	c, _ := Load()
	// Default fallback is a chain; spine inherits (nil), control disables.
	c.Default = Channel{Branch: "main", Fallback: []string{"main", "dev"}}
	c.SetChannel(ComponentSpine, Channel{Branch: "f-a"}) // Fallback nil → inherit
	c.SetChannel(ComponentControl, Channel{Branch: "f-b", Fallback: []string{}})

	spine := c.Effective(ComponentSpine, testCfg())
	if !reflect.DeepEqual(spine.Fallback, []string{"main", "dev"}) {
		t.Errorf("spine inherited fallback = %v", spine.Fallback)
	}
	ctrl := c.Effective(ComponentControl, testCfg())
	if ctrl.Fallback == nil || len(ctrl.Fallback) != 0 {
		t.Errorf("control fallback = %v, want disabled", ctrl.Fallback)
	}
}

func TestMigrationFromReleaseBranch(t *testing.T) {
	withConfigFile(t, "release_branch: sebastian\nsetup_completed: true\n")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Default.Branch != "sebastian" {
		t.Errorf("migration seeded default.branch = %q, want sebastian", c.Default.Branch)
	}
	eff := c.Effective(ComponentDefault, testCfg())
	if eff.Branch != "sebastian" {
		t.Errorf("effective default branch = %q", eff.Branch)
	}
}

func TestSavePreservesUnrelatedKeys(t *testing.T) {
	p := withConfigFile(t, "site_name: MySite\ndomain: example.test\nsetup_completed: true\nrelease_branch: old\nextra:\n  foo: bar\n")
	c, _ := Load()
	c.SetChannel(ComponentSpine, Channel{Branch: "f-x"})
	c.Default = Channel{Branch: "dev", Fallback: []string{"main"}}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	for _, want := range []string{"site_name: MySite", "domain: example.test", "setup_completed: true", "foo: bar", "release_channels:", "release_branch: dev"} {
		if !strings.Contains(s, want) {
			t.Errorf("saved config missing %q\n---\n%s", want, s)
		}
	}
}

func TestSaveMirrorsDefaultBranch(t *testing.T) {
	p := withConfigFile(t, "release_branch: old\n")
	c, _ := Load()
	c.Default = Channel{Branch: "main", Fallback: []string{"main"}}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	// main mirrors to empty release_branch.
	if strings.Contains(string(data), "release_branch: old") {
		t.Errorf("release_branch mirror not updated:\n%s", string(data))
	}
}

func TestRoundTripDisabledFallback(t *testing.T) {
	p := withConfigFile(t, "")
	c, _ := Load()
	c.SetChannel(ComponentSpine, Channel{Branch: "f-hold", Fallback: []string{}})
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p)
	if !strings.Contains(string(raw), "fallback: []") {
		t.Errorf("disabled fallback not persisted as []:\n%s", string(raw))
	}
	// Reload and confirm the disabled state survives (non-nil empty).
	c2, _ := Load()
	spineOv, ok := c2.override(ComponentSpine)
	if !ok {
		t.Fatal("spine override missing after reload")
	}
	if spineOv.Fallback == nil || len(spineOv.Fallback) != 0 {
		t.Errorf("reloaded fallback = %v, want disabled (non-nil empty)", spineOv.Fallback)
	}
}

func TestResetAndResetAll(t *testing.T) {
	withConfigFile(t, "")
	c, _ := Load()
	c.SetChannel(ComponentSpine, Channel{Branch: "f-x"})
	c.SetChannel("app:wiki", Channel{Branch: "f-y", Source: "https://forgejo.example.test/apps/Wiki"})
	if got := c.ConfiguredComponents(); len(got) != 2 {
		t.Fatalf("configured = %v", got)
	}
	c.ResetChannel(ComponentSpine)
	if !c.Spine.IsZero() {
		t.Errorf("spine not reset")
	}
	c.ResetAll()
	if len(c.ConfiguredComponents()) != 0 {
		t.Errorf("reset all left overrides: %v", c.ConfiguredComponents())
	}
	if c.Default.Branch != "main" {
		t.Errorf("default not reset to main")
	}
}

func TestValidateChannel(t *testing.T) {
	bad := []Channel{
		{Branch: "Feature/Slash"},
		{Branch: "up CASE space"},
		{Source: "ftp://x/y"},
		{Source: "not a url with spaces"},
		{Fallback: []string{"ok", "bad/one"}},
	}
	for _, ch := range bad {
		if err := ValidateChannel(ch); err == nil {
			t.Errorf("ValidateChannel(%+v) should fail", ch)
		}
	}
	good := []Channel{
		{Branch: "f-x"},
		{Branch: "MAIN"}, // normalized to lowercase — valid charset
		{Source: "https://github.com/YouEye-Platform/YouEye", Branch: "dev"},
		{Fallback: []string{"main", "dev"}},
		{}, // empty is fine
	}
	for _, ch := range good {
		if err := ValidateChannel(ch); err != nil {
			t.Errorf("ValidateChannel(%+v) unexpected error: %v", ch, err)
		}
	}
}

func TestNormalizeBranch(t *testing.T) {
	if got, _ := NormalizeBranch("F-Slug"); got != "f-slug" {
		t.Errorf("NormalizeBranch lowercase = %q", got)
	}
	if _, err := NormalizeBranch("has space"); err == nil {
		t.Error("space should be rejected")
	}
	if _, err := NormalizeBranch("p-proj/f-sub"); err == nil {
		t.Error("slash should be rejected")
	}
}

func TestAppChannel(t *testing.T) {
	withConfigFile(t, "")
	c, _ := Load()
	c.SetChannel("app:wiki", Channel{Source: "https://forgejo.example.test/apps/Wiki", Branch: "f-drawer"})
	eff := c.Effective("app:wiki", testCfg())
	if eff.Source != "https://forgejo.example.test/apps/Wiki" || eff.Branch != "f-drawer" {
		t.Errorf("app channel effective = %+v", eff)
	}
	// Unknown app → default channel.
	other := c.Effective("app:search", testCfg())
	if other.Branch != "main" {
		t.Errorf("unknown app effective branch = %q", other.Branch)
	}
}

func TestExactTagAndDigestRoundTrip(t *testing.T) {
	digest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	p := withConfigFile(t, "release_channels:\n  default: { source: https://git.example.test/o/r, branch: dev, fallback: [] }\n  control: { tag: cp-dev-v1.2.3, artifact_sha256: "+digest+" }\n")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	eff := c.Effective(ComponentControl, config.Default())
	if eff.Tag != "cp-dev-v1.2.3" || eff.ArtifactSHA256 != digest || eff.Fallback == nil || len(eff.Fallback) != 0 {
		t.Fatalf("unexpected exact channel: %+v", eff)
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"tag: cp-dev-v1.2.3", "artifact_sha256: " + digest, "fallback: []"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("saved exact channel missing %q:\n%s", want, raw)
		}
	}
}

func TestValidateChannelRequiresTagForDigest(t *testing.T) {
	if err := ValidateChannel(Channel{ArtifactSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); err == nil {
		t.Fatal("digest without exact tag was accepted")
	}
}
