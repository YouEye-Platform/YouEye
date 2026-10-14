package systemupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreCapacityDoesNotAddSharedFreeBytesOrWaitForDowntime(t *testing.T) {
	for _, mode := range []string{"enough", "pool-short", "data-short", "linked-data", "unsupported-db"} {
		t.Run(mode, func(t *testing.T) {
			p, j, _, _ := rootCheckpointFixture(t)
			record, err := p.Read(j)
			if err != nil {
				t.Fatal(err)
			}
			archive, digest := corePayloadFixture(t)
			index, err := IndexCorePayload(archive, digest)
			if err != nil {
				t.Fatal(err)
			}
			native := p.Capture
			sizeReads := 0
			p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
				if program == "incus" && args[0] == "exec" {
					if !strings.Contains(args[len(args)-1], "pg_database_size") {
						t.Fatal("capacity preflight required writer closure or private security rows")
					}
					sizeReads++
					if mode == "unsupported-db" {
						return []byte(`[{"name":"youeye","owner":"foreign","size_bytes":1048576},{"name":"youeye_ui","owner":"youeye","size_bytes":1048576}]`), nil
					}
					return []byte(`[{"name":"youeye","owner":"youeye","size_bytes":1048576},{"name":"youeye_ui","owner":"youeye","size_bytes":1048576}]`), nil
				}
				if mode == "pool-short" && program == "incus" && strings.HasSuffix(args[len(args)-1], "/resources") {
					return []byte(fmt.Sprintf(`{"space":{"total":%d,"used":0}}`, 700<<20)), nil
				}
				return native(ctx, program, args...)
			}
			p.AvailableDataBytes = func(string) (uint64, error) {
				if mode == "data-short" {
					return 700 << 20, nil
				}
				return 1 << 40, nil
			}
			if mode == "linked-data" {
				if err = os.Mkdir(filepath.Join(p.DataRoot, "ui-data"), 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.Symlink(t.TempDir(), filepath.Join(p.DataRoot, "ui-data", "outside")); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "pool-short" {
				if err = p.CheckRootCapacity(context.Background(), record.Inventory, 1<<20); err != nil {
					t.Fatal("fixture should fit roots alone", err)
				}
			}
			required, err := p.CheckCompleteCapacity(context.Background(), record.Inventory, []CorePayloadIndex{index, index})
			if (err == nil) != (mode == "enough") {
				t.Fatal(required, err)
			}
			if sizeReads != 1 {
				t.Fatal("missing current pre-maintenance size observation")
			}
			if mode == "enough" && required < 768<<20 {
				t.Fatal("omitted shared database/restore budget", required)
			}
		})
	}
}
