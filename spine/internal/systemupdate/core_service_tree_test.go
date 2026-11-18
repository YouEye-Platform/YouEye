package systemupdate

import (
	"archive/tar"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func coreServiceTreeFixture(t *testing.T) (*os.File, *os.File, CoreServiceStage, CorePayloadIndex, CorePayloadIndex) {
	t.Helper()
	oldArchive, oldHash := corePayloadFixture(t)
	nextArchive, nextHash := corePayloadFixture(t, tar.Header{Name: "new-module.js", Typeflag: tar.TypeReg, Mode: 0644})
	old, err := IndexCorePayload(oldArchive, oldHash)
	if err != nil {
		t.Fatal(err)
	}
	next, err := IndexCorePayload(nextArchive, nextHash)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err = os.Mkdir(filepath.Join(root, "app"), 0755); err != nil {
		t.Fatal(err)
	}
	app, err := os.Open(filepath.Join(root, "app"))
	if err != nil {
		t.Fatal(err)
	}
	archive, err := os.Open(oldArchive)
	if err != nil {
		t.Fatal(err)
	}
	if err = extractCorePayload(context.Background(), archive, app, old, os.Geteuid(), os.Getegid()); err != nil {
		t.Fatal(err)
	}
	app.Close()
	archive.Close()
	if err = os.WriteFile(filepath.Join(root, "app", ".env"), []byte("CURRENT_FIXTURE=value\n"), 0600); err != nil {
		t.Fatal(err)
	}
	parent, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { parent.Close() })
	archive, err = os.Open(nextArchive)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { archive.Close() })
	r := CoreServiceStage{AppDir: "/opt/app", StageName: ".youeye-core-fixture", ArtifactSHA256: nextHash, PreviousSHA256: oldHash, Phase: "prepared"}
	return parent, archive, r, old, next
}

func TestCoreServiceTreeLostExchangeAcknowledgement(t *testing.T) {
	parent, archive, r, old, next := coreServiceTreeFixture(t)
	retained := r
	lose := true
	extractions := 0
	save := func(value CoreServiceStage) error {
		if value.Phase == "extracting" {
			extractions++
		}
		if value.Phase == "swapped" && lose {
			lose = false
			return errors.New("lost acknowledgement")
		}
		retained = value
		return nil
	}
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err == nil {
		t.Fatal("missing lost acknowledgement")
	}
	if retained.Phase != "exchange-requested" {
		t.Fatal(retained.Phase)
	}
	r = retained
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err != nil {
		t.Fatal(err)
	}
	if r.Phase != "swapped" || extractions != 1 {
		t.Fatal("replayed exchange/extraction", r.Phase, extractions)
	}
	if _, err := VerifyCorePayload(filepath.Join(parent.Name(), "app"), next, CorePayloadStrict); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyCorePayload(filepath.Join(parent.Name(), r.StageName), old, CorePayloadStrict); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(filepath.Join(parent.Name(), "app", ".env"))
	if err != nil || string(env) != "CURRENT_FIXTURE=value\n" {
		t.Fatal("current environment not preserved", err)
	}
}

func TestCoreServiceTreeInterruptedExtractionAndForeignStage(t *testing.T) {
	for _, mode := range []string{"extracting", "foreign-stage", "damaged-after-swap"} {
		t.Run(mode, func(t *testing.T) {
			parent, archive, r, old, next := coreServiceTreeFixture(t)
			save := func(CoreServiceStage) error { return nil }
			switch mode {
			case "extracting":
				r.Phase = "extracting"
			case "foreign-stage":
				if err := os.Mkdir(filepath.Join(parent.Name(), r.StageName), 0700); err != nil {
					t.Fatal(err)
				}
			case "damaged-after-swap":
				// The application directory now holds the tree this request wrote:
				// a changed shipped file there is refused.
				if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(parent.Name(), "app", "new-module.js"), []byte("tampered"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err == nil {
				t.Fatal("unsafe repeat accepted")
			}
		})
	}
}

// modifyInstalledTree leaves the installed tree as an owner, a browser or a
// broken disk might: a file we did not ship, a changed file, a missing file.
func modifyInstalledTree(t *testing.T, app string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(app, "owner.js"), []byte("overlay"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(app, ".next/server/route-cache/APP_ROUTE"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, ".next/server/route-cache/APP_ROUTE/favicon.body"), []byte("icon"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "server.js"), []byte("tampered"), 0644); err != nil {
		t.Fatal(err)
	}
}

// The installed tree is about to be replaced: whatever it holds, the update
// stages over it, and the tree it wrote is exact.
func TestCoreServiceTreeReplacesAModifiedInstalledTree(t *testing.T) {
	parent, archive, r, old, next := coreServiceTreeFixture(t)
	app := filepath.Join(parent.Name(), "app")
	modifyInstalledTree(t, app)
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, func(CoreServiceStage) error { return nil }); err != nil {
		t.Fatal("a modified installed tree refused its own replacement:", err)
	}
	if r.Phase != "swapped" {
		t.Fatal(r.Phase)
	}
	if found, err := VerifyCorePayload(app, next, CorePayloadStrict); err != nil || found.Unrecorded != 0 {
		t.Fatal("the written tree is not exactly the next payload", found, err)
	}
	// The old tree is kept as it was under the stage name.
	if raw, err := os.ReadFile(filepath.Join(parent.Name(), r.StageName, "owner.js")); err != nil || string(raw) != "overlay" {
		t.Fatal("old tree not retained", err)
	}
	// Extra files in the written tree are counted, never refused: the running
	// service may add some before the next check.
	if err := os.WriteFile(filepath.Join(app, "added-later.js"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, func(CoreServiceStage) error { return nil }); err != nil {
		t.Fatal("an extra file in the written tree was refused:", err)
	}
}

// With the old side unchecked, "the exchange happened" rests on the tree this
// request wrote. Each state after a lost acknowledgement must end with the
// application directory holding exactly next, without a second extraction.
func TestCoreServiceTreeLostAcknowledgementWithModifiedOldTree(t *testing.T) {
	for _, state := range []string{"exchanged", "not-exchanged", "old-holds-next", "old-holds-next-not-exchanged", "both-damaged"} {
		t.Run(state, func(t *testing.T) {
			parent, archive, r, old, next := coreServiceTreeFixture(t)
			app, stage := filepath.Join(parent.Name(), "app"), filepath.Join(parent.Name(), r.StageName)
			modifyInstalledTree(t, app)
			if state == "old-holds-next" || state == "old-holds-next-not-exchanged" {
				// An old tree that happens to hold every file of next, unchanged
				// (old and next differ only in new-module.js), plus its own extras.
				if err := os.WriteFile(filepath.Join(app, "server.js"), []byte("console.log('signed executable');\n"), 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(app, "new-module.js"), nil, 0644); err != nil {
					t.Fatal(err)
				}
				if found, err := VerifyCorePayload(app, next, CorePayloadStrict); err != nil || found.Unrecorded == 0 {
					t.Fatal("fixture: old tree should pass strict against next with extras", found, err)
				}
			}
			retained := r
			extractions, exchangeSaved := 0, false
			save := func(value CoreServiceStage) error {
				if value.Phase == "extracting" {
					extractions++
				}
				if value.Phase == "exchange-requested" {
					exchangeSaved = true
					retained = value
					if state == "not-exchanged" || state == "old-holds-next-not-exchanged" {
						return errors.New("lost before the exchange")
					}
					return nil
				}
				if value.Phase == "swapped" && exchangeSaved {
					exchangeSaved = false
					return errors.New("lost acknowledgement")
				}
				retained = value
				return nil
			}
			if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err == nil {
				t.Fatal("missing lost acknowledgement")
			}
			if retained.Phase != "exchange-requested" {
				t.Fatal(retained.Phase)
			}
			if state == "both-damaged" {
				for _, dir := range []string{app, stage} {
					if err := os.WriteFile(filepath.Join(dir, "new-module.js"), []byte("damaged"), 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			r = retained
			err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, func(value CoreServiceStage) error {
				if value.Phase == "extracting" {
					extractions++
				}
				retained = value
				return nil
			})
			if state == "both-damaged" {
				if err == nil || retained.Phase == "swapped" {
					t.Fatal("neither tree is next, yet the swap was accepted", err)
				}
				return
			}
			if err != nil || r.Phase != "swapped" || extractions != 1 {
				t.Fatal("reconciliation failed or replayed the extraction", err, r.Phase, extractions)
			}
			found, err := VerifyCorePayload(app, next, CorePayloadStrict)
			if err != nil {
				t.Fatal("application directory is not next after reconciliation", err)
			}
			// The freshly extracted tree, not the old one, is what runs: no
			// owner overlay survives in the application directory.
			if found.Unrecorded != 0 {
				t.Fatal("the old tree was taken for the swapped one", found.Counts())
			}
			if _, err := os.Stat(filepath.Join(stage, "owner.js")); err != nil {
				t.Fatal("old tree is not under the stage name", err)
			}
			env, err := os.ReadFile(filepath.Join(app, ".env"))
			if err != nil || string(env) != "CURRENT_FIXTURE=value\n" {
				t.Fatal("current environment not preserved", err)
			}
		})
	}
}

// Decision 4: a reused member is reused as it is, whatever it holds.
func TestCoreServiceTreeReusedMember(t *testing.T) {
	for _, modified := range []bool{false, true} {
		parent, archive, r, old, _ := coreServiceTreeFixture(t)
		r.ArtifactSHA256 = old.ArtifactSHA256
		if modified {
			modifyInstalledTree(t, filepath.Join(parent.Name(), "app"))
			if err := os.Remove(filepath.Join(parent.Name(), "app", "server.js")); err != nil {
				t.Fatal(err)
			}
		}
		if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, old, func(CoreServiceStage) error { return nil }); err != nil {
			t.Fatal("reused member refused; modified:", modified, err)
		}
		if r.Phase != "reused" || coreStagePayloadMode(r) != CorePayloadRecord {
			t.Fatal(r.Phase)
		}
		if _, err := os.Stat(filepath.Join(parent.Name(), r.StageName)); !os.IsNotExist(err) {
			t.Fatal("replaced reused member")
		}
		if modified {
			if _, err := os.Stat(filepath.Join(parent.Name(), "app", "owner.js")); err != nil {
				t.Fatal("reused member was changed", err)
			}
		}
	}
	// It still has to be there.
	parent, archive, r, old, _ := coreServiceTreeFixture(t)
	r.ArtifactSHA256 = old.ArtifactSHA256
	if err := os.RemoveAll(filepath.Join(parent.Name(), "app")); err != nil {
		t.Fatal(err)
	}
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, old, func(CoreServiceStage) error { return nil }); err == nil {
		t.Fatal("a missing application directory was reused")
	}
}
