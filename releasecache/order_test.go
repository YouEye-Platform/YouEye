package releasecache

import (
	"encoding/json"
	"os"
	"testing"
)

// The vectors are shared with the Control Panel
// (control-panel/tests/version-vectors.spec.ts): both must order alike.
func TestReleaseOrderVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/release-order.json")
	if err != nil {
		t.Fatal(err)
	}
	type side struct {
		Version  string `json:"version"`
		Build    string `json:"build"`
		Sequence int64  `json:"sequence"`
	}
	var vectors struct {
		Schema  string `json:"schema"`
		Compare []struct {
			Name string `json:"name"`
			A    side   `json:"a"`
			B    side   `json:"b"`
			Want int    `json:"want"`
		} `json:"compare"`
		MinimumRelease []struct {
			Name      string `json:"name"`
			Installed string `json:"installed"`
			Minimum   string `json:"minimum"`
			OK        bool   `json:"ok"`
		} `json:"minimum_release"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Schema != "youeye.release-order-vectors" || len(vectors.Compare) == 0 || len(vectors.MinimumRelease) == 0 {
		t.Fatalf("unexpected vector file %q", vectors.Schema)
	}
	for _, c := range vectors.Compare {
		a, errA := KeyOfVersion(c.A.Version, c.A.Sequence)
		b, errB := KeyOfVersion(c.B.Version, c.B.Sequence)
		if errA != nil || errB != nil {
			t.Errorf("%s: %v %v", c.Name, errA, errB)
			continue
		}
		if got := CompareReleases(a, b); got != c.Want {
			t.Errorf("%s: got %d, want %d", c.Name, got, c.Want)
		}
		if got := CompareReleases(b, a); got != -c.Want {
			t.Errorf("%s (reversed): got %d, want %d", c.Name, got, -c.Want)
		}
	}
	for _, c := range vectors.MinimumRelease {
		if got := MinimumReleaseMet(c.Installed, c.Minimum); got != c.OK {
			t.Errorf("%s: got %v, want %v", c.Name, got, c.OK)
		}
	}
}

func TestReleaseKeysAndLines(t *testing.T) {
	for version, line := range map[string]string{"0.6.13": "0.6.13", "0.6.13-dev.5": "0.6.13", "0.6.13-alpha.1": "0.6.13", "10.20.30-beta.2": "10.20.30"} {
		if got, ok := LineOfVersion(version); !ok || got != line {
			t.Errorf("line of %s: %q %v", version, got, ok)
		}
	}
	for _, bad := range []string{"", "0.6", "v0.6.13", "0.6.13-dev", "0.6.13+build", "0.06.1", "0.6.13-DEV.1"} {
		if _, ok := LineOfVersion(bad); ok {
			t.Errorf("%q has a line", bad)
		}
		if _, err := KeyOfVersion(bad, 1); err == nil {
			t.Errorf("%q has a key", bad)
		}
		if MinimumReleaseMet(bad, "0.6.1") || MinimumReleaseMet("0.6.1", bad) {
			t.Errorf("%q passed a minimum", bad)
		}
	}
	for _, sequence := range []int64{0, -1, 9007199254740992} {
		if _, err := KeyOfVersion("0.6.13", sequence); err == nil {
			t.Errorf("sequence %d accepted", sequence)
		}
	}
	ordered := []string{"0.5.9", "0.6.0", "0.6.2", "0.6.10", "0.10.0", "1.0.0"}
	for i := 1; i < len(ordered); i++ {
		if CompareLines(ordered[i-1], ordered[i]) >= 0 || CompareLines(ordered[i], ordered[i-1]) <= 0 {
			t.Errorf("%s should sort before %s", ordered[i-1], ordered[i])
		}
	}
	// A release name is read as its line; a value that is no version sorts first.
	if CompareLines("0.6.13-dev.9", "0.6.13") != 0 || CompareLines("nonsense", "0.0.1") >= 0 || CompareLines("", "") != 0 {
		t.Error("line comparison of names or invalid values is wrong")
	}
	// An unknown key (no line) is older than every release: it never passes
	// for "already newer", and it is not a fresh install either.
	if CompareReleases(ReleaseKey{}, ReleaseKey{Line: "0.0.1", Sequence: 1}) >= 0 {
		t.Error("an empty key is not older than a release")
	}
}
