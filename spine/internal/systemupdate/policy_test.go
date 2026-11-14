package systemupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleasePolicyStrictValidation(t *testing.T) {
	digest := strings.Repeat("c", 64)
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable","core_manifest_sha256":"`+digest+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadReleasePolicy(path)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Repository != "https://github.com/YouEye-Platform/YouEye" || policy.Channel != "stable" {
		t.Fatalf("unexpected policy: %+v", policy)
	}
	for _, channel := range []string{"dev", "alpha", "beta", "stable"} {
		p := policy
		p.Channel = channel
		if err := p.Validate(); err != nil {
			t.Fatalf("channel %s rejected: %v", channel, err)
		}
	}
	for name, change := range map[string]func(*ReleasePolicy){
		"no core digest":           func(p *ReleasePolicy) { p.CoreManifestSHA256 = "" },
		"upper-case digest":        func(p *ReleasePolicy) { p.CoreManifestSHA256 = strings.Repeat("C", 64) },
		"unknown channel":          func(p *ReleasePolicy) { p.Channel = "main" },
		"empty channel":            func(p *ReleasePolicy) { p.Channel = "" },
		"non-canonical repository": func(p *ReleasePolicy) { p.Repository = "https://GitHub.com/YouEye-Platform/YouEye.git" },
		"http repository":          func(p *ReleasePolicy) { p.Repository = "http://github.com/YouEye-Platform/YouEye" },
		"bad service selection":    func(p *ReleasePolicy) { p.ServiceSelection = "latest" },
		"wrong schema":             func(p *ReleasePolicy) { p.Schema = "youeye.release-policy.v0" },
	} {
		p := policy
		change(&p)
		if err := p.Validate(); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	saved := filepath.Join(t.TempDir(), "saved.json")
	policy.Channel = "beta"
	if err := SaveReleasePolicy(saved, policy); err != nil {
		t.Fatal(err)
	}
	if again, err := LoadReleasePolicy(saved); err != nil || again != policy {
		t.Fatal(again, err)
	}
	// A key a newer Spine added is read past and kept on rewrite.
	newer := `{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable","core_manifest_sha256":"` + digest + `","mirror":"https://m.test"}`
	if err := os.WriteFile(path, []byte(newer), 0600); err != nil {
		t.Fatal(err)
	}
	read, err := LoadReleasePolicy(path)
	if err != nil {
		t.Fatal(err)
	}
	read.Channel = "beta"
	if err := SaveReleasePolicy(path, read); err != nil {
		t.Fatal(err)
	}
	if kept, _ := os.ReadFile(path); !strings.Contains(string(kept), `"mirror": "https://m.test"`) || !strings.Contains(string(kept), `"channel": "beta"`) {
		t.Fatalf("rewrite lost a newer key: %s", kept)
	}
	for _, raw := range []string{
		`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","core_manifest_sha256":"` + digest + `"}`,
	} {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadReleasePolicy(path); err == nil {
			t.Fatal("release policy without its required fields was accepted", raw)
		}
	}
}
