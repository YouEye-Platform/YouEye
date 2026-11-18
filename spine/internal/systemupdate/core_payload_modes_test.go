package systemupdate

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

// corePayloadTreeFixture extracts a small standalone tree: server.js, a
// directory with two files and a symlink, and the Next.js server directory.
func corePayloadTreeFixture(t *testing.T) (string, CorePayloadIndex) {
	t.Helper()
	archive, digest := corePayloadFixture(t,
		tar.Header{Name: "lib/a.js", Typeflag: tar.TypeReg, Mode: 0644},
		tar.Header{Name: "lib/b.js", Typeflag: tar.TypeReg, Mode: 0644},
		tar.Header{Name: "entry", Typeflag: tar.TypeSymlink, Linkname: "lib/a.js"},
		tar.Header{Name: ".next/server/app/page.js", Typeflag: tar.TypeReg, Mode: 0644})
	index, err := IndexCorePayload(archive, digest)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	dir, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	file, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = extractCorePayload(context.Background(), file, dir, index, os.Geteuid(), os.Getegid()); err != nil {
		t.Fatal(err)
	}
	return root, index
}

func mustPayload(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Record mode is for a tree the request did not write: nothing it holds is an
// error. Strict mode refuses a changed or missing shipped file and nothing else.
func TestCorePayloadRecordNeverFailsAndStrictFailsOnChangedOrMissingOnly(t *testing.T) {
	for _, test := range []struct {
		name                         string
		change                       func(t *testing.T, root string)
		unrecorded, changed, missing int
		reason                       string
	}{
		{name: "clean", change: func(*testing.T, string) {}},
		{name: "unrecorded-file", unrecorded: 1, change: func(t *testing.T, root string) {
			mustPayload(t, os.WriteFile(filepath.Join(root, "owner.js"), []byte("overlay"), 0755))
		}},
		{name: "unrecorded-tree", unrecorded: 4, change: func(t *testing.T, root string) {
			mustPayload(t, os.MkdirAll(filepath.Join(root, "node_modules/extra/deep"), 0755))
			mustPayload(t, os.WriteFile(filepath.Join(root, "node_modules/extra/deep/index.js"), nil, 0644))
		}},
		{name: "unrecorded-special", unrecorded: 3, change: func(t *testing.T, root string) {
			mustPayload(t, os.Symlink("/etc/passwd", filepath.Join(root, "lib/link")))
			mustPayload(t, syscall.Mkfifo(filepath.Join(root, "pipe"), 0600))
			mustPayload(t, os.WriteFile(filepath.Join(root, "setuid"), nil, 0644))
			mustPayload(t, os.Chmod(filepath.Join(root, "setuid"), 0755|os.ModeSetuid))
		}},
		{name: "changed-bytes", changed: 1, reason: "changed-bytes", change: func(t *testing.T, root string) {
			// Same size: only the hash can tell.
			mustPayload(t, os.WriteFile(filepath.Join(root, "server.js"), []byte("console.log('SIGNED executable');\n"), 0644))
		}},
		{name: "changed-size", changed: 1, reason: "changed-bytes", change: func(t *testing.T, root string) {
			mustPayload(t, os.WriteFile(filepath.Join(root, "lib/a.js"), []byte("x"), 0644))
		}},
		{name: "changed-mode", changed: 1, reason: "changed-mode", change: func(t *testing.T, root string) {
			mustPayload(t, os.Chmod(filepath.Join(root, "server.js"), 0755))
		}},
		{name: "changed-directory-mode", changed: 1, reason: "changed-mode", change: func(t *testing.T, root string) {
			mustPayload(t, os.Chmod(filepath.Join(root, "lib"), 0700))
		}},
		{name: "changed-link", changed: 1, reason: "changed-link", change: func(t *testing.T, root string) {
			mustPayload(t, os.Remove(filepath.Join(root, "entry")))
			mustPayload(t, os.Symlink("lib/b.js", filepath.Join(root, "entry")))
		}},
		{name: "file-became-link", changed: 1, reason: "invalid-type-or-link", change: func(t *testing.T, root string) {
			mustPayload(t, os.Remove(filepath.Join(root, "server.js")))
			mustPayload(t, os.Symlink("lib/a.js", filepath.Join(root, "server.js")))
		}},
		{name: "file-became-fifo", changed: 1, reason: "invalid-type-or-link", change: func(t *testing.T, root string) {
			mustPayload(t, os.Remove(filepath.Join(root, "server.js")))
			mustPayload(t, syscall.Mkfifo(filepath.Join(root, "server.js"), 0644))
		}},
		{name: "directory-became-link", changed: 1, missing: 2, reason: "invalid-type-or-link", change: func(t *testing.T, root string) {
			other := t.TempDir()
			mustPayload(t, os.Rename(filepath.Join(root, "lib"), filepath.Join(other, "lib")))
			mustPayload(t, os.Symlink(filepath.Join(other, "lib"), filepath.Join(root, "lib")))
		}},
		{name: "missing-file", missing: 1, change: func(t *testing.T, root string) {
			mustPayload(t, os.Remove(filepath.Join(root, "lib/b.js")))
		}},
		{name: "missing-tree", missing: 3, change: func(t *testing.T, root string) {
			mustPayload(t, os.RemoveAll(filepath.Join(root, "lib")))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, index := corePayloadTreeFixture(t)
			test.change(t, root)
			observe := func(context.Context, string) (int, error) { return os.Getpid(), nil }
			for _, check := range []struct {
				name   string
				verify func(CorePayloadMode) (CorePayloadFindings, error)
			}{
				{"tree", func(mode CorePayloadMode) (CorePayloadFindings, error) { return VerifyCorePayload(root, index, mode) }},
				{"container", func(mode CorePayloadMode) (CorePayloadFindings, error) {
					return verifyCoreContainerPayload(context.Background(), "fixture", root, index, mode, observe)
				}},
			} {
				found, err := check.verify(CorePayloadRecord)
				if err != nil {
					t.Fatalf("%s: record mode refused a difference: %v", check.name, err)
				}
				if found.Unrecorded != test.unrecorded || found.Changed != test.changed || found.Missing != test.missing {
					t.Fatalf("%s: counted %s, want %d unrecorded, %d changed, %d missing", check.name, found.Counts(), test.unrecorded, test.changed, test.missing)
				}
				if test.reason != "" && found.Reasons[test.reason] != test.changed {
					t.Fatalf("%s: reasons %v, want %s", check.name, found.Reasons, test.reason)
				}
				strict, err := check.verify(CorePayloadStrict)
				var differs *CorePayloadDifferenceError
				if wantErr := test.changed+test.missing > 0; wantErr != errors.As(err, &differs) || (!wantErr && err != nil) {
					t.Fatalf("%s: strict result %v for %s", check.name, err, found.Counts())
				}
				if strict.Unrecorded != found.Unrecorded || strict.Changed != found.Changed || strict.Missing != found.Missing {
					t.Fatalf("%s: modes counted differently: %s and %s", check.name, strict.Counts(), found.Counts())
				}
				if differs != nil && (strings.Contains(differs.Error(), root) || strings.Contains(differs.Error(), "server.js") || strings.Contains(differs.Error(), "lib")) {
					t.Fatalf("%s: a path reached the durable error text: %v", check.name, differs)
				}
			}
		})
	}
}

// The running service writes these. No check looks inside, in either mode.
func TestCorePayloadRuntimeDirectoriesAreSkippedInEveryMode(t *testing.T) {
	root, index := corePayloadTreeFixture(t)
	cache := filepath.Join(root, ".next/server/route-cache/APP_ROUTE/adb2ea08/$")
	mustPayload(t, os.MkdirAll(cache, 0755))
	// What one GET /favicon.ico leaves behind on Next.js 16.4, and worse.
	mustPayload(t, os.WriteFile(filepath.Join(cache, "favicon.ico.body"), []byte("icon"), 0644))
	mustPayload(t, os.WriteFile(filepath.Join(cache, "favicon.ico.meta"), []byte("{}"), 0644))
	mustPayload(t, os.WriteFile(filepath.Join(cache, "run.js"), []byte("code"), 0755))
	mustPayload(t, os.Symlink("/etc", filepath.Join(root, ".next/server/route-cache/link")))
	mustPayload(t, syscall.Mkfifo(filepath.Join(root, ".next/server/route-cache/pipe"), 0600))
	mustPayload(t, os.MkdirAll(filepath.Join(root, ".next/cache/images"), 0755))
	mustPayload(t, os.WriteFile(filepath.Join(root, ".next/cache/images/a.webp"), []byte("image"), 0644))
	mustPayload(t, os.WriteFile(filepath.Join(root, ".env"), []byte("SECRET=fixture\n"), 0600))
	for _, mode := range []CorePayloadMode{CorePayloadRecord, CorePayloadStrict} {
		found, err := VerifyCorePayload(root, index, mode)
		if err != nil || found.Unrecorded+found.Changed+found.Missing != 0 || found.Summary() != "verified" {
			t.Fatalf("runtime directories were inspected in mode %d: %s %v", mode, found.Counts(), err)
		}
	}
	// A route-cache that replaced itself with a link is still only runtime state.
	mustPayload(t, os.RemoveAll(filepath.Join(root, ".next/server/route-cache")))
	mustPayload(t, os.Symlink(t.TempDir(), filepath.Join(root, ".next/server/route-cache")))
	if found, err := VerifyCorePayload(root, index, CorePayloadStrict); err != nil || found.Unrecorded != 0 {
		t.Fatal("linked runtime directory inspected", found.Counts(), err)
	}
	// Only these names are runtime state: a sibling is an ordinary extra file.
	mustPayload(t, os.WriteFile(filepath.Join(root, ".next/server/route-cache.js"), nil, 0644))
	mustPayload(t, os.WriteFile(filepath.Join(root, ".env.local"), nil, 0600))
	if found, err := VerifyCorePayload(root, index, CorePayloadStrict); err != nil || found.Unrecorded != 2 {
		t.Fatal("siblings of runtime directories were skipped", found.Counts(), err)
	}
}

// The walk does not stop at the first difference, and what it reports to
// durable evidence never contains a path.
func TestCorePayloadWalkReportsEverything(t *testing.T) {
	root, index := corePayloadTreeFixture(t)
	mustPayload(t, os.WriteFile(filepath.Join(root, "a-first-overlay.js"), nil, 0644))
	mustPayload(t, os.WriteFile(filepath.Join(root, "lib/zz-overlay.js"), nil, 0644))
	mustPayload(t, os.WriteFile(filepath.Join(root, "server.js"), []byte("console.log('tampered executable');\n"), 0644))
	mustPayload(t, os.Chmod(filepath.Join(root, "lib/a.js"), 0600))
	mustPayload(t, os.Remove(filepath.Join(root, "lib/b.js")))
	mustPayload(t, os.Remove(filepath.Join(root, ".next/server/app/page.js")))
	found, err := VerifyCorePayload(root, index, CorePayloadRecord)
	if err != nil {
		t.Fatal(err)
	}
	if found.Unrecorded != 2 || found.Changed != 2 || found.Missing != 2 || found.Reasons["changed-bytes"] != 1 || found.Reasons["changed-mode"] != 1 {
		t.Fatalf("%+v", found)
	}
	if got, want := found.Counts(), "2 unrecorded, 2 changed, 2 missing (changed-bytes 1, changed-mode 1)"; got != want {
		t.Fatalf("counts %q, want %q", got, want)
	}
	if got, want := found.Summary(), "modified (2 changed, 2 missing), 2 extra files"; got != want {
		t.Fatalf("summary %q, want %q", got, want)
	}
	sample := map[string]string{}
	for _, p := range found.Paths {
		sample[p.Path] = p.Reason
	}
	for name, reason := range map[string]string{"a-first-overlay.js": "unrecorded-path", "lib/zz-overlay.js": "unrecorded-path", "server.js": "changed-bytes", "lib/a.js": "changed-mode", "lib/b.js": "missing-path", ".next/server/app/page.js": "missing-path"} {
		if sample[name] != reason {
			t.Fatalf("operator sample lacks %s (%s): %v", name, reason, found.Paths)
		}
	}
	evidence := coreVerifyMembersEvidence(map[string]CorePayloadFindings{"cp": found, "ui": {}})
	if want := "complete scoped membership/cache and previous running host verified; installed cp differs: 2 unrecorded, 2 changed, 2 missing (changed-bytes 1, changed-mode 1); installed ui verified; continuing"; evidence != want {
		t.Fatalf("evidence %q", evidence)
	}
	for name := range sample {
		if strings.Contains(evidence, name) {
			t.Fatal("a raw path reached the journal evidence", name)
		}
	}
	if clean := coreVerifyMembersEvidence(map[string]CorePayloadFindings{"cp": {}, "ui": {}}); clean != "complete scoped membership/cache and previous running host/static payloads verified" {
		t.Fatal(clean)
	}
	if only := (CorePayloadFindings{Unrecorded: 1}).Summary(); only != "verified, 1 extra file" {
		t.Fatal(only)
	}
}

// A huge directory that we did not ship cannot hold the walk.
func TestCorePayloadUnrecordedWalkIsBounded(t *testing.T) {
	old := corePayloadUnrecordedLimit
	corePayloadUnrecordedLimit = 25
	t.Cleanup(func() { corePayloadUnrecordedLimit = old })
	root, index := corePayloadTreeFixture(t)
	mustPayload(t, os.MkdirAll(filepath.Join(root, "foreign/deep"), 0755))
	for i := 0; i < 60; i++ {
		mustPayload(t, os.WriteFile(filepath.Join(root, "foreign/deep", fmt.Sprintf("f%03d", i)), nil, 0644))
	}
	mustPayload(t, os.Remove(filepath.Join(root, "lib/b.js")))
	found, err := VerifyCorePayload(root, index, CorePayloadRecord)
	if err != nil || !found.UnrecordedCapped || found.Unrecorded != 25 || found.Missing != 1 || len(found.Paths) > corePayloadSampleLimit {
		t.Fatalf("%+v %v", found, err)
	}
	if !strings.HasPrefix(found.Counts(), "at least 25 unrecorded, 0 changed, 1 missing") || found.Summary() != "modified (0 changed, 1 missing), at least 25 extra files" {
		t.Fatal(found.Counts(), found.Summary())
	}
	// A bottomless directory is not followed to the bottom either.
	corePayloadUnrecordedLimit = old
	root, index = corePayloadTreeFixture(t)
	deep := filepath.Join(root, "foreign")
	for i := 0; i < corePayloadUnrecordedDepth+20; i++ {
		deep = filepath.Join(deep, "d")
	}
	mustPayload(t, os.MkdirAll(deep, 0755))
	found, err = VerifyCorePayload(root, index, CorePayloadStrict)
	if err != nil || !found.UnrecordedCapped || found.Unrecorded != corePayloadUnrecordedDepth+1 || found.Differs() {
		t.Fatalf("%+v %v", found, err)
	}
}

func TestCoreArchiveRejectsRuntimeDirectories(t *testing.T) {
	for _, name := range []string{".next/server/route-cache", ".next/server/route-cache/APP_ROUTE/owner/$/manifest.webmanifest.body", ".next/server/route-cache/code.js", ".next/cache/x", ".env"} {
		archive, digest := corePayloadFixture(t, tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644})
		if _, err := IndexCorePayload(archive, digest); err == nil {
			t.Fatalf("archive accepted runtime path %s", name)
		}
	}
	// A saved index with such a path is not a valid index either.
	archive, digest := corePayloadFixture(t)
	index, err := IndexCorePayload(archive, digest)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range []CorePayloadEntry{{Path: ".next", Kind: "directory", Mode: 0755}, {Path: ".next/server", Kind: "directory", Mode: 0755}, {Path: ".next/server/route-cache", Kind: "directory", Mode: 0755}} {
		index.Entries = append(index.Entries, e)
	}
	if index.Validate() == nil {
		t.Fatal("index accepted a runtime directory")
	}
}

// What verify-members found is acceptance evidence. It survives a lost
// acknowledgement and is never produced by running the action a second time.
func TestCoreVerifyMembersDifferencesPersistWithoutReplay(t *testing.T) {
	f := newCoreRunnerFixture(t)
	calls := 0
	evidence := coreVerifyMembersEvidence(map[string]CorePayloadFindings{"cp": {Unrecorded: 3, Changed: 1, Reasons: map[string]int{"changed-bytes": 1}}, "ui": {}})
	execute := func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		calls++
		return coreActionPassed(evidence, nil)
	}
	authorize := func(context.Context, CoreJournal, CoreStep) error { return nil }
	f.launch = func() error {
		out, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute)
		if err != nil || out.State != "succeeded" {
			t.Fatal(out, err)
		}
		return fmt.Errorf("lost acknowledgement")
	}
	_, _ = f.runner.Start(context.Background(), f.journal, f.step)
	out, err := f.runner.Observe(context.Background(), f.journal, f.step)
	if err != nil || out.State != "succeeded" || out.Evidence != evidence || !strings.Contains(out.Evidence, "installed cp differs: 3 unrecorded, 1 changed, 0 missing (changed-bytes 1); installed ui verified; continuing") {
		t.Fatal(out, err)
	}
	again, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute)
	if err != nil || again != out || calls != 1 {
		t.Fatal("replayed verification", again, err, calls)
	}
}

func coreModeJournal(t *testing.T, change func(*releasecache.CoreRelease), edit func(*CoreJournal)) CoreJournal {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	previous, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	if change != nil {
		change(&target)
	}
	j := CoreJournal{Target: target, Previous: previous}
	if edit != nil {
		edit(&j)
	}
	return j
}

// Which mode the final health gate uses is decided by who wrote the tree.
// Together with the walk, this is every outcome the gate can have for a
// modified tree: it passes unless this request wrote that tree.
func TestCoreHealthIsStrictOnlyForATreeThisRequestWrote(t *testing.T) {
	sameMembers := func(r *releasecache.CoreRelease) {
		for i := range r.Members {
			if r.Members[i].Role == "cp" {
				r.Members[i].Artifact.SHA256 = strings.Repeat("c", 64)
			}
		}
	}
	for _, test := range []struct {
		name           string
		journal        CoreJournal
		recovery       bool
		cp, ui         CorePayloadMode
		modifiedPasses map[string]bool
	}{
		// The default fixture replaces CP and reuses UI.
		{name: "update", journal: coreModeJournal(t, nil, nil), cp: CorePayloadStrict, ui: CorePayloadRecord},
		{name: "recovery-health", journal: coreModeJournal(t, nil, nil), recovery: true, cp: CorePayloadRecord, ui: CorePayloadRecord},
		{name: "metadata-only", journal: coreModeJournal(t, sameMembers, func(j *CoreJournal) { j.MetadataOnly = true }), cp: CorePayloadRecord, ui: CorePayloadRecord},
		{name: "no-op", journal: coreModeJournal(t, sameMembers, func(j *CoreJournal) { j.NoOp = true }), cp: CorePayloadRecord, ui: CorePayloadRecord},
		{name: "spine-only", journal: coreModeJournal(t, func(r *releasecache.CoreRelease) {
			sameMembers(r)
			for i := range r.Members {
				if r.Members[i].Role == "spine" {
					r.Members[i].Artifact.SHA256 = strings.Repeat("9", 64)
				}
			}
		}, nil), cp: CorePayloadRecord, ui: CorePayloadRecord},
	} {
		t.Run(test.name, func(t *testing.T) {
			for role, want := range map[string]CorePayloadMode{"cp": test.cp, "ui": test.ui} {
				mode, err := coreHealthPayloadMode(test.journal, role, test.recovery)
				if err != nil || mode != want {
					t.Fatalf("%s: mode %d, want %d (%v)", role, mode, want, err)
				}
				// A modified tree: extra files, a changed file and a missing file.
				root, index := corePayloadTreeFixture(t)
				mustPayload(t, os.WriteFile(filepath.Join(root, "owner.js"), nil, 0644))
				mustPayload(t, os.WriteFile(filepath.Join(root, "server.js"), []byte("console.log('tampered executable');\n"), 0644))
				mustPayload(t, os.Remove(filepath.Join(root, "lib/b.js")))
				found, err := verifyCoreContainerPayload(context.Background(), "fixture", root, index, mode, func(context.Context, string) (int, error) { return os.Getpid(), nil })
				if (err == nil) != (want == CorePayloadRecord) {
					t.Fatalf("%s: modified tree in mode %d: %v", role, mode, err)
				}
				if err == nil {
					evidence := coreHealthPayloadEvidence("health", map[string]CorePayloadFindings{role: found})
					if evidence != "health; installed "+role+" differs: 1 unrecorded, 1 changed, 1 missing (changed-bytes 1)" {
						t.Fatal(evidence)
					}
				}
			}
		})
	}
	if _, err := coreHealthPayloadMode(CoreJournal{}, "cp", false); err == nil {
		t.Fatal("a journal without the member decided a mode")
	}
}

func TestCoreStageModeFollowsTheStageReceipt(t *testing.T) {
	a, b := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, test := range []struct {
		stage CoreServiceStage
		want  CorePayloadMode
	}{
		{CoreServiceStage{Phase: "swapped", ArtifactSHA256: b, PreviousSHA256: a}, CorePayloadStrict},
		{CoreServiceStage{Phase: "reused", ArtifactSHA256: a, PreviousSHA256: a}, CorePayloadRecord},
		{CoreServiceStage{Phase: "swapped", ArtifactSHA256: a, PreviousSHA256: a}, CorePayloadRecord},
		{CoreServiceStage{Phase: "staged", ArtifactSHA256: b, PreviousSHA256: a}, CorePayloadRecord},
		{CoreServiceStage{Phase: "recovered", ArtifactSHA256: a, PreviousSHA256: a}, CorePayloadRecord},
	} {
		if got := coreStagePayloadMode(test.stage); got != test.want {
			t.Fatalf("%+v: mode %d", test.stage, got)
		}
	}
}
