package systemupdate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCoreHostPayloadObservation(t *testing.T) {
	for _, change := range []string{"clean", "bytes", "extra", "mode", "special-mode", "missing", "symlink-file", "fifo", "linked-root", "process-changed", "canceled"} {
		t.Run(change, func(t *testing.T) {
			root := t.TempDir()
			body := []byte("signed executable")
			if err := os.WriteFile(filepath.Join(root, "server.js"), body, 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(root, "lib"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("../server.js", filepath.Join(root, "lib", "entry")); err != nil {
				t.Fatal(err)
			}
			index := CorePayloadIndex{Schema: "youeye.core-payload.v1", ArtifactSHA256: checksum(body), Entries: []CorePayloadEntry{
				{Path: "server.js", Kind: "file", Mode: 0644, Size: int64(len(body)), SHA256: checksum(body)},
				{Path: "lib", Kind: "directory", Mode: 0755}, {Path: "lib/entry", Kind: "symlink", Mode: 0777, Link: "../server.js"},
			}}
			// Runtime configuration remains private and outside executable identity.
			if err := os.WriteFile(filepath.Join(root, ".env"), []byte("fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var err error
			switch change {
			case "bytes":
				err = os.WriteFile(filepath.Join(root, "server.js"), []byte("modified content!"), 0644)
			case "extra":
				err = os.WriteFile(filepath.Join(root, "extra.js"), body, 0644)
			case "mode":
				err = os.Chmod(filepath.Join(root, "server.js"), 0755)
			case "special-mode":
				err = os.Chmod(filepath.Join(root, "server.js"), 0644|os.ModeSetuid)
			case "missing":
				err = os.Remove(filepath.Join(root, "server.js"))
			case "symlink-file":
				if err = os.Rename(filepath.Join(root, "server.js"), filepath.Join(root, ".env")); err == nil {
					err = os.Symlink(".env", filepath.Join(root, "server.js"))
				}
			case "fifo":
				if err = os.Remove(filepath.Join(root, "server.js")); err == nil {
					err = syscall.Mkfifo(filepath.Join(root, "server.js"), 0644)
				}
			case "linked-root":
				link := filepath.Join(t.TempDir(), "linked")
				err = os.Symlink(root, link)
				root = link
			case "canceled":
				cancel()
			}
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			observe := func(context.Context, string) (int, error) {
				calls++
				if change == "process-changed" && calls > 1 {
					return os.Getpid() + 1, nil
				}
				return os.Getpid(), nil
			}
			err = verifyCoreContainerPayload(ctx, "fixture", root, index, observe)
			if (err == nil) != (change == "clean") {
				t.Fatalf("result %v", err)
			}
		})
	}
}

func TestCorePayloadIndexProtectedRead(t *testing.T) {
	m := CoreManager{Root: t.TempDir()}
	archive, digest := corePayloadFixture(t)
	index, err := IndexCorePayload(archive, digest)
	if err != nil {
		t.Fatal(err)
	}
	if err = m.SavePayloadIndex(index); err != nil {
		t.Fatal(err)
	}
	if _, err = m.LoadPayloadIndex(digest); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(m.Root, "payloads", digest+".json")
	foreign := index
	foreign.ArtifactSHA256 = checksum([]byte("other"))
	raw, _ := json.Marshal(foreign)
	if err = os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = m.LoadPayloadIndex(digest); err == nil {
		t.Fatal("accepted another artifact's index")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(archive, file); err != nil {
		t.Fatal(err)
	}
	if _, err = m.LoadPayloadIndex(digest); err == nil {
		t.Fatal("followed index symlink")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = syscall.Mkfifo(file, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = ReadCoreState(file, 4096); err == nil {
		t.Fatal("accepted protected FIFO")
	}
	if _, err = ReadCoreState(archive, 1); err == nil {
		t.Fatal("accepted oversized state")
	}
}
