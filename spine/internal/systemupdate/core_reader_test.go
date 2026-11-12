package systemupdate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func coreReaderFixture(t *testing.T) (CoreManager, string, string) {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	parts := map[string][]byte{"youeye": []byte("original Stable reader")}
	var member *releasecache.CoreMember
	for i := range target.Members {
		if target.Members[i].Role == "spine" {
			member = &target.Members[i]
		}
	}
	member.BuildVersion = target.Version
	member.Artifact = releasecache.CoreBlob{Name: "spine-linux-amd64", SHA256: checksum(parts["youeye"]), SizeBytes: int64(len(parts["youeye"]))}
	raw, _ := json.Marshal(target)
	digest := checksum(raw)
	parts["core-release.json"] = raw
	file, err := m.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	for name, raw := range parts {
		if err := os.WriteFile(filepath.Join(filepath.Dir(file), name), raw, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return m, file, digest
}

func coreReaderTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[path] = checksum(raw)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCoreReaderVerificationLeavesTransactionAndBootstrapAbsent(t *testing.T) {
	m, file, digest := coreReaderFixture(t)
	before := coreReaderTree(t, m.Root)
	for range 2 {
		if err := m.VerifyBootstrapReader(file, digest); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reader verification created a transaction: %v", err)
	}
	if _, err := m.readBootstrap(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reader verification registered a coordinator: %v", err)
	}
	if after := coreReaderTree(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("reader verification changed protected state")
	}
	if err := m.VerifyBootstrapReader(file, strings.Repeat("f", 64)); err == nil {
		t.Fatal("accepted a different reviewed manifest")
	}
	if err := m.VerifyBootstrapReader(filepath.Join(t.TempDir(), "youeye"), digest); err == nil {
		t.Fatal("accepted an unrelated reader path")
	}
}

func TestCoreReaderRejectsChangedInputsAndUnsafePaths(t *testing.T) {
	for _, name := range []string{"youeye", "core-release.json"} {
		t.Run(name, func(t *testing.T) {
			m, file, digest := coreReaderFixture(t)
			if err := os.WriteFile(filepath.Join(filepath.Dir(file), name), []byte("changed bytes"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := m.VerifyBootstrapReader(file, digest); err == nil {
				t.Fatal("accepted changed input")
			}
		})
	}
	t.Run("writable directory", func(t *testing.T) {
		m, file, digest := coreReaderFixture(t)
		if err := os.Chmod(filepath.Dir(file), 0777); err != nil {
			t.Fatal(err)
		}
		if err := m.VerifyBootstrapReader(file, digest); err == nil {
			t.Fatal("accepted a writable envelope directory")
		}
	})
	t.Run("symlink directory", func(t *testing.T) {
		m, file, digest := coreReaderFixture(t)
		directory := filepath.Dir(file)
		if err := os.Rename(directory, directory+"-elsewhere"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(directory+"-elsewhere", directory); err != nil {
			t.Fatal(err)
		}
		if err := m.VerifyBootstrapReader(file, digest); err == nil {
			t.Fatal("accepted a symlink envelope directory")
		}
	})
}
