package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/update"
)

func withChannelConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "youeye.yaml")
	old := channels.ConfigPath
	channels.ConfigPath = p
	t.Cleanup(func() { channels.ConfigPath = old })
	return p
}

func TestParseFallback(t *testing.T) {
	tests := []struct {
		in       string
		wantNil  bool
		wantLen  int
		wantErr  bool
		wantHead string
	}{
		{"none", false, 0, false, ""},
		{"", false, 0, false, ""},
		{"main", false, 1, false, "main"},
		{"main,dev", false, 2, false, "main"},
		{" main , dev ", false, 2, false, "main"},
		{"bad/slash", false, 0, true, ""},
	}
	for _, tt := range tests {
		got, err := parseFallback(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("parseFallback(%q) err=%v wantErr=%v", tt.in, err, tt.wantErr)
			continue
		}
		if tt.wantErr {
			continue
		}
		if got == nil {
			t.Errorf("parseFallback(%q) returned nil (want non-nil, disabled or chain)", tt.in)
			continue
		}
		if len(got) != tt.wantLen {
			t.Errorf("parseFallback(%q) len=%d want=%d", tt.in, len(got), tt.wantLen)
		}
		if tt.wantHead != "" && got[0] != tt.wantHead {
			t.Errorf("parseFallback(%q)[0]=%q want=%q", tt.in, got[0], tt.wantHead)
		}
	}
}

func TestNormalizeComponent(t *testing.T) {
	ok := []string{"default", "spine", "control", "ui", "app:wiki"}
	for _, c := range ok {
		if _, err := normalizeComponent(c); err != nil {
			t.Errorf("normalizeComponent(%q) unexpected err: %v", c, err)
		}
	}
	bad := []string{"App", "app:", "unknown", "spine2"}
	for _, c := range bad {
		if _, err := normalizeComponent(c); err == nil {
			t.Errorf("normalizeComponent(%q) should fail", c)
		}
	}
}

func TestSetBranchMapsToDefaultChannel(t *testing.T) {
	p := withChannelConfig(t)
	if err := setBranch("sebastian"); err != nil {
		t.Fatal(err)
	}
	c, err := channels.Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DefaultBranch() != "sebastian" {
		t.Errorf("default branch = %q, want sebastian", c.DefaultBranch())
	}
	// release_branch mirror written.
	raw, _ := os.ReadFile(p)
	if !contains(raw, "release_branch: sebastian") {
		t.Errorf("release_branch mirror missing:\n%s", raw)
	}

	// Reset back to main.
	if err := setBranch(""); err != nil {
		t.Fatal(err)
	}
	c2, _ := channels.Load()
	if c2.DefaultBranch() != "main" {
		t.Errorf("branch reset failed, got %q", c2.DefaultBranch())
	}
}

func TestDecideUpdate(t *testing.T) {
	restore := update.SetProvenanceDir(t.TempDir())
	defer restore()

	// No provenance → treated as same-branch: install only when newer.
	if d := decideUpdate("spine", "0.5.11", "0.5.12", "main", false); !d.proceed || d.isSwitch {
		t.Errorf("no-provenance newer: %+v, want proceed", d)
	}
	if d := decideUpdate("spine", "0.5.11", "0.5.11", "main", false); d.proceed {
		t.Errorf("no-provenance same version: %+v, want no proceed", d)
	}

	// Same branch, older candidate → do not proceed.
	update.WriteProvenance("spine", update.ProvenanceEntry{Version: "0.5.11", Branch: "main"})
	if d := decideUpdate("spine", "0.5.11", "0.5.10", "main", false); d.proceed {
		t.Errorf("same-branch older: %+v, want no proceed", d)
	}

	// Different branch, lower version, assumeYes → proceed as switch (downgrade).
	update.WriteProvenance("spine", update.ProvenanceEntry{Version: "0.5.11.0.0.0.5", Branch: "f-x"})
	d := decideUpdate("spine", "0.5.11.0.0.0.5", "0.5.11", "main", true)
	if !d.proceed || !d.isSwitch {
		t.Errorf("switch downgrade with -y: %+v, want proceed+switch", d)
	}

	// Different branch, newer version, assumeYes → proceed as switch (upgrade).
	d = decideUpdate("spine", "0.5.11", "0.5.12", "main", true)
	if !d.proceed || !d.isSwitch {
		t.Errorf("switch upgrade with -y: %+v, want proceed+switch", d)
	}

	// Different branch, newer candidate, NO -y → plain update, no prompt.
	// This is fallback overtaking a branch install (main newer than the
	// installed feature line) — must never block on confirmation.
	d = decideUpdate("spine", "0.5.11.0.0.0.5", "0.5.12", "main", false)
	if !d.proceed || !d.isSwitch {
		t.Errorf("fallback overtake without -y: %+v, want proceed without prompt", d)
	}
}

func contains(b []byte, s string) bool {
	return len(b) >= len(s) && (indexOf(string(b), s) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
