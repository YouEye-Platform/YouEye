package systemupdate

import (
	"archive/tar"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCorePayloadHostExtraction(t *testing.T) {
	archive, digest := corePayloadFixture(t,
		tar.Header{Name: "lib/module.js", Typeflag: tar.TypeReg, Mode: 0640},
		tar.Header{Name: "entry", Typeflag: tar.TypeSymlink, Linkname: "lib/module.js"},
		tar.Header{Name: "copy", Typeflag: tar.TypeLink, Linkname: "server.js"})
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
	if err = VerifyCorePayload(root, index); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filepath.Join(root, "server.js"))
	if err != nil {
		t.Fatal(err)
	}
	linked, err := os.Stat(filepath.Join(root, "copy"))
	if err != nil || !os.SameFile(before, linked) {
		t.Fatal("lost hardlink identity", err)
	}
	dir2, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir2.Close()
	if err = extractCorePayload(context.Background(), file, dir2, index, os.Geteuid(), os.Getegid()); err == nil {
		t.Fatal("overwrote a previous extraction")
	}
}

func TestCorePayloadExtractionRefusesUntrustedInput(t *testing.T) {
	for _, change := range []string{"digest", "index", "existing-link", "canceled"} {
		t.Run(change, func(t *testing.T) {
			archive, digest := corePayloadFixture(t)
			index, err := IndexCorePayload(archive, digest)
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch change {
			case "digest":
				index.ArtifactSHA256 = checksum([]byte("different"))
			case "index":
				index.Entries[0].SHA256 = checksum([]byte("different"))
			case "existing-link":
				if err = os.Symlink(t.TempDir(), filepath.Join(root, "server.js")); err != nil {
					t.Fatal(err)
				}
			case "canceled":
				cancel()
			}
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
			if err = extractCorePayload(ctx, file, dir, index, os.Geteuid(), os.Getegid()); err == nil {
				t.Fatal("unsafe extraction passed")
			}
		})
	}
}
