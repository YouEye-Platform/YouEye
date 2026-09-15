package update

import (
	"os"
	"path/filepath"
	"testing"
)

func withProvenanceDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	oldDir := provenanceDir
	provenanceDir = dir
	t.Cleanup(func() { provenanceDir = oldDir })
}

func TestProvenanceRoundTrip(t *testing.T) {
	withProvenanceDir(t)

	if _, ok := GetProvenance("spine"); ok {
		t.Fatal("expected no provenance initially")
	}

	err := WriteProvenance("spine", ProvenanceEntry{
		Version: "0.5.11", Tag: "spine-v0.5.11", Branch: "main",
		Source: "https://github.com/YouEye-Platform/YouEye",
	})
	if err != nil {
		t.Fatal(err)
	}

	got, ok := GetProvenance("spine")
	if !ok {
		t.Fatal("provenance missing after write")
	}
	if got.Version != "0.5.11" || got.Branch != "main" || got.Tag != "spine-v0.5.11" {
		t.Errorf("provenance = %+v", got)
	}
	if got.UpdatedAt == "" {
		t.Error("UpdatedAt not set")
	}
}

func TestProvenanceMergesComponents(t *testing.T) {
	withProvenanceDir(t)

	WriteProvenance("spine", ProvenanceEntry{Version: "0.5.11", Branch: "main"})
	WriteProvenance("control", ProvenanceEntry{Version: "0.5.11", Branch: "f-x"})

	all := ReadProvenance()
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}
	if all["control"].Branch != "f-x" {
		t.Errorf("control branch = %q", all["control"].Branch)
	}
	// Overwrite one component; the other survives.
	WriteProvenance("spine", ProvenanceEntry{Version: "0.5.12", Branch: "main"})
	all = ReadProvenance()
	if all["spine"].Version != "0.5.12" || all["control"].Version != "0.5.11" {
		t.Errorf("merge failed: %+v", all)
	}
}

func TestProvenanceCorruptFile(t *testing.T) {
	withProvenanceDir(t)
	if err := os.WriteFile(filepath.Join(provenanceDir, provenanceFile), []byte("{not json"), 0644); err != nil {
		t.Fatal(err)
	}
	if got := ReadProvenance(); len(got) != 0 {
		t.Errorf("corrupt file should yield empty map, got %+v", got)
	}
}

// The CP writes ui provenance to core-versions.json (same dir/shape).
// GetProvenance must fall back to it for components spine doesn't install.
func TestGetProvenanceCPFallback(t *testing.T) {
	dir := t.TempDir()
	defer SetProvenanceDir(dir)()

	cp := `{"ui": {"version": "0.5.3", "tag": "ui-v0.5.3", "branch": "main", "source": "https://github.com/YouEye-Platform/YouEye", "updated_at": "2026-07-04T10:14:40.515Z"}}`
	if err := os.WriteFile(filepath.Join(dir, "core-versions.json"), []byte(cp), 0644); err != nil {
		t.Fatal(err)
	}

	e, ok := GetProvenance("ui")
	if !ok || e.Version != "0.5.3" || e.Branch != "main" {
		t.Fatalf("ui provenance not read from core-versions.json: %+v ok=%v", e, ok)
	}

	// Spine's own file wins when both have an entry.
	if err := WriteProvenance("ui", ProvenanceEntry{Version: "9.9.9", Tag: "ui-v9.9.9", Branch: "f-x", Source: "s"}); err != nil {
		t.Fatal(err)
	}
	e, _ = GetProvenance("ui")
	if e.Version != "9.9.9" {
		t.Fatalf("spine-owned entry should win, got %+v", e)
	}
}
