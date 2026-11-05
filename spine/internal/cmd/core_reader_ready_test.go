package cmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestManagedReaderOldRecordCannotPinCompletedOrCustomChecks(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	target, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "reader-ready.json"), []byte("stale/corrupt former reader state"), 0600); err != nil {
		t.Fatal(err)
	}
	runtime := systemupdate.NativeCoreRuntime{Root: root}
	installed := systemupdate.CoreReceipt{Release: target}
	if ready, err := acquireCoreReader(context.Background(), runtime, systemupdate.CoreHostSelection{}, target, "", installed); err != nil || ready != nil {
		t.Fatal("completed target pinned subsequent check to former reader", err)
	}
	target.Source = "https://forge.example/team/YouEye"
	if ready, err := acquireCoreReader(context.Background(), runtime, systemupdate.CoreHostSelection{}, target, "", installed); err != nil || ready != nil {
		t.Fatal("custom source borrowed official ready reader", err)
	}
}
