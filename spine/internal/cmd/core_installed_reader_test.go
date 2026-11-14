package cmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func installedReaderFixture(t *testing.T) (coreInstalledReaderObserver, string) {
	t.Helper()
	root := t.TempDir()
	external := "/var/lib/youeye-state/other/youeye"
	for path, raw := range map[string][]byte{coreBakedExecutable: []byte("unchanged canonical baked Spine"), external: []byte("unregistered external Spine")} {
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0755); err != nil {
			t.Fatal(err)
		}
	}
	o := coreInstalledReaderObserver{Root: root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return coreBakedExecutable, nil }}
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	return o, external
}

func TestInstalledReaderUnregisteredBakedAndUnknownSelf(t *testing.T) {
	o, external := installedReaderFixture(t)
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.ReaderClass != "baked" {
		t.Fatal(got, err)
	}
	o.CurrentExecutable = func() (string, error) { return external, nil }
	if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
		t.Fatal("unregistered external executable accepted")
	}
}

func TestInstalledReaderHostWrapperUsesVerifiedObservation(t *testing.T) {
	o, _ := installedReaderFixture(t)
	previous := coreInstalledReaderHost
	coreInstalledReaderHost = func() coreInstalledReaderObserver { return o }
	t.Cleanup(func() { coreInstalledReaderHost = previous })
	path, err := coreInstalledExecutable()
	if err != nil || path != o.path(coreBakedExecutable) {
		t.Fatal(path, err)
	}
}
