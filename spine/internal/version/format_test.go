package version

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// sharedVectors mirrors testdata/vectors.json. The same file is consumed by the
// control-panel and ui vitest suites so the three implementations cannot drift.
type sharedVectors struct {
	Compare []struct {
		A, B   string
		Result int
	} `json:"compare"`
	Format []struct {
		Input   string
		Display string
		Tag     string
	} `json:"format"`
	Valid []struct {
		Input string
		Valid bool
	} `json:"valid"`
}

func loadVectors(t *testing.T) sharedVectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors.json: %v", err)
	}
	var v sharedVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parse vectors.json: %v", err)
	}
	return v
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}

func TestVectorsCompare(t *testing.T) {
	for _, c := range loadVectors(t).Compare {
		got := sign(CompareVersions(c.A, c.B))
		if got != c.Result {
			t.Errorf("CompareVersions(%q, %q) sign = %d, want %d", c.A, c.B, got, c.Result)
		}
	}
}

func TestVectorsFormat(t *testing.T) {
	for _, c := range loadVectors(t).Format {
		if got := FormatVersion(c.Input); got != c.Display {
			t.Errorf("FormatVersion(%q) = %q, want %q", c.Input, got, c.Display)
		}
		if got := FormatVersionTag(c.Input); got != c.Tag {
			t.Errorf("FormatVersionTag(%q) = %q, want %q", c.Input, got, c.Tag)
		}
	}
}

func TestVectorsValid(t *testing.T) {
	for _, c := range loadVectors(t).Valid {
		_, err := ParseVersionStrict(c.Input)
		if (err == nil) != c.Valid {
			t.Errorf("ParseVersionStrict(%q) accepted = %v, want %v (err=%v)", c.Input, err == nil, c.Valid, err)
		}
	}
}

func TestFormatVersionExtra(t *testing.T) {
	tests := []struct{ in, want string }{
		{"0.5.0.0.0.0.0.0.0", "0.5"},
		{"", "0"},
		{"v", "0"},
		{"1.0.0.0", "1"},
		{"0.0.0", "0"},
		{"0.5.11.0.0.0.10", "0.5.11.0.0.0.10"},
	}
	for _, tt := range tests {
		if got := FormatVersion(tt.in); got != tt.want {
			t.Errorf("FormatVersion(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestFormatVersionTagExtra(t *testing.T) {
	tests := []struct{ in, want string }{
		{"0.5.11.1.0", "0.5.11.1"},
		{"1", "1.0.0"},
		{"0.6", "0.6.0"},
		{"0.5.11.0.0.0.1", "0.5.11.0.0.0.1"},
	}
	for _, tt := range tests {
		if got := FormatVersionTag(tt.in); got != tt.want {
			t.Errorf("FormatVersionTag(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestParseVersionStrictExtra(t *testing.T) {
	valid := []string{"0", "0.5.10", "v0.5.10", "1.2.3.4.5.6.7.8.9.10", "01.2.3"}
	for _, v := range valid {
		if _, err := ParseVersionStrict(v); err != nil {
			t.Errorf("ParseVersionStrict(%q) unexpected error: %v", v, err)
		}
	}
	invalid := []string{"", "v", "0..5", "0.5.x", "0.5.10-rc1", "1.2.3.4.5.6.7.8.9.10.11", ".5", "5."}
	for _, v := range invalid {
		if _, err := ParseVersionStrict(v); err == nil {
			t.Errorf("ParseVersionStrict(%q) expected error, got nil", v)
		}
	}
}
