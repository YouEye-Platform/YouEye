package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCoreHeldBootReconcilesExactRunningIdentityWithoutReplay(t *testing.T) {
	for _, mode := range []string{"normal", "lost-after-start", "lost-before-start", "foreign-hold", "changed-condition"} {
		t.Run(mode, func(t *testing.T) {
			p, j, _, _ := databaseCheckpointFixture(t)
			if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
				t.Fatal(err)
			}
			native := p.Capture
			running, starts := false, 0
			p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
				if program == "incus" && len(args) == 2 && args[0] == "query" && args[1] == "/1.0/instances/youeye-control" {
					status := "Stopped"
					if running {
						status = "Running"
					}
					return json.Marshal(map[string]any{"status": status, "config": map[string]string{"volatile.uuid": "fixture-youeye-control", "user.youeye.core-request": j.RequestID, "boot.autostart": "false"}})
				}
				if program == "incus" && len(args) == 2 && args[0] == "start" {
					starts++
					if mode != "lost-before-start" {
						running = true
					}
					if strings.HasPrefix(mode, "lost-") {
						return nil, fmt.Errorf("lost start acknowledgement")
					}
					return nil, nil
				}
				return native(ctx, program, args...)
			}
			read := func(_ context.Context, name, path string, limit int64, modeBits uint32) ([]byte, error) {
				if name != "youeye-control" {
					t.Fatal("wrong core boot target")
				}
				if strings.HasSuffix(path, "core-update-hold.json") {
					request := j.RequestID
					if mode == "foreign-hold" {
						request = "another"
					}
					return json.Marshal(map[string]string{"request_id": request, "manifest_sha256": j.ManifestSHA256})
				}
				if mode == "changed-condition" {
					return []byte("changed"), nil
				}
				return []byte("[Unit]\nConditionPathExists=!/etc/youeye/core-update-hold.json\n"), nil
			}
			s := NativeCoreServices{Checkpoint: p}
			err := s.startHeldContainer(context.Background(), j, "cp", read)
			if (err == nil) != (mode == "normal") {
				t.Fatal(mode, err)
			}
			if mode == "foreign-hold" || mode == "changed-condition" {
				if starts != 0 {
					t.Fatal("booted without exact hold")
				}
				return
			}
			err = s.startHeldContainer(context.Background(), j, "cp", read)
			if mode == "lost-before-start" {
				if err == nil {
					t.Fatal("missing start inferred safe to retry")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if starts != 1 {
				t.Fatal("replayed boot", starts)
			}
		})
	}
}
