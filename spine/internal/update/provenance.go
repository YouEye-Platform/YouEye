package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ProvenanceEntry records where an installed core component came from, so the
// updater can tell "update within my channel" from "channel switched".
type ProvenanceEntry struct {
	Version        string `json:"version"`
	Tag            string `json:"tag"`
	Branch         string `json:"branch"`
	Source         string `json:"source"`
	ArtifactSHA256 string `json:"artifact_sha256,omitempty"`
	UpdatedAt      string `json:"updated_at"`
}

// provenanceDir/provenanceFile locate core-provenance.json. Overridable in tests.
// cpProvenanceFile is the CP-written sibling (same shape) covering components
// whose updates CP executes (ui) — read-only from Spine's side.
var (
	provenanceDir    = "/var/lib/youeye/state"
	provenanceFile   = "core-provenance.json"
	cpProvenanceFile = "core-versions.json"
	provMu           sync.Mutex
)

func provenancePath() string {
	return filepath.Join(provenanceDir, provenanceFile)
}

// SetProvenanceDir overrides the provenance directory. Intended for tests in
// other packages that need to seed provenance; returns a restore func.
func SetProvenanceDir(dir string) func() {
	provMu.Lock()
	old := provenanceDir
	provenanceDir = dir
	provMu.Unlock()
	return func() {
		provMu.Lock()
		provenanceDir = old
		provMu.Unlock()
	}
}

// ReadProvenance returns the full provenance map (component → entry). A missing
// or unreadable file yields an empty map.
func ReadProvenance() map[string]ProvenanceEntry {
	provMu.Lock()
	defer provMu.Unlock()
	return readProvenanceLocked()
}

func readProvenanceLocked() map[string]ProvenanceEntry {
	out := map[string]ProvenanceEntry{}
	data, err := os.ReadFile(provenancePath())
	if err != nil {
		return out
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return map[string]ProvenanceEntry{}
	}
	return out
}

// GetProvenance returns the entry for a component and whether it was recorded.
// Spine's own file wins; the CP-written core-versions.json (ui) is consulted
// as a fallback so channel views cover CP-executed updates too.
func GetProvenance(component string) (ProvenanceEntry, bool) {
	if e, ok := ReadProvenance()[component]; ok {
		return e, ok
	}
	data, err := os.ReadFile(filepath.Join(provenanceDir, cpProvenanceFile))
	if err != nil {
		return ProvenanceEntry{}, false
	}
	cp := map[string]ProvenanceEntry{}
	if json.Unmarshal(data, &cp) != nil {
		return ProvenanceEntry{}, false
	}
	e, ok := cp[component]
	return e, ok
}

// WriteProvenance records the installed provenance for a single component,
// merging into the existing map and writing atomically (tmp + rename).
func WriteProvenance(component string, entry ProvenanceEntry) error {
	provMu.Lock()
	defer provMu.Unlock()

	all := readProvenanceLocked()
	if entry.UpdatedAt == "" {
		entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	all[component] = entry

	if err := os.MkdirAll(provenanceDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	tmp := provenancePath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, provenancePath())
}
