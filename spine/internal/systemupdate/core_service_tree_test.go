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
	if err := VerifyCorePayload(filepath.Join(parent.Name(), "app"), next); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCorePayload(filepath.Join(parent.Name(), r.StageName), old); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(filepath.Join(parent.Name(), "app", ".env"))
	if err != nil || string(env) != "CURRENT_FIXTURE=value\n" {
		t.Fatal("current environment not preserved", err)
	}
}

func TestCoreServiceTreeInterruptedExtractionAndForeignOverlay(t *testing.T) {
	for _, mode := range []string{"extracting", "foreign-stage", "overlay", "changed-after-swap"} {
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
			case "overlay":
				if err := os.WriteFile(filepath.Join(parent.Name(), "app", "owner.js"), nil, 0644); err != nil {
					t.Fatal(err)
				}
			case "changed-after-swap":
				if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(parent.Name(), "app", "owner.js"), nil, 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, next, save); err == nil {
				t.Fatal("unsafe repeat accepted")
			}
			if mode == "overlay" {
				if _, err := os.Stat(filepath.Join(parent.Name(), r.StageName)); !os.IsNotExist(err) {
					t.Fatal("created stage before rejecting overlay")
				}
			}
		})
	}
}

func TestCoreServiceTreeReusedMember(t *testing.T) {
	parent, archive, r, old, _ := coreServiceTreeFixture(t)
	r.ArtifactSHA256 = old.ArtifactSHA256
	if err := stageCoreServiceTree(context.Background(), parent, archive, &r, old, old, func(CoreServiceStage) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if r.Phase != "reused" {
		t.Fatal(r.Phase)
	}
	if _, err := os.Stat(filepath.Join(parent.Name(), r.StageName)); !os.IsNotExist(err) {
		t.Fatal("replaced reused member")
	}
}
