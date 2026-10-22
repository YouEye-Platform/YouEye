package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoreCompletionRestoresExactSettingsAndReconcilesLostAcknowledgements(t *testing.T) {
	for _, busyAt := range []int{0, 1, 2, 3, 4} {
		t.Run(fmt.Sprintf("transient-operation-at-check-%d", busyAt), func(t *testing.T) {
			testCoreCompletion(t, busyAt)
		})
	}
}

func testCoreCompletion(t *testing.T, busyAt int) {
	ctx := context.Background()
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	data := t.TempDir()
	barrier := CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}
	if err := barrier.Begin(j); err != nil {
		t.Fatal(err)
	}
	p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
	type row struct {
		Name   string            `json:"name"`
		Status string            `json:"status"`
		Config map[string]string `json:"config"`
	}
	rows := map[string]*row{}
	inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}}
	_, inventory.AppInventorySHA256, _ = p.installedOwners()
	yes, no := "true", "false"
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-caddy", "youeye-pihole", "youeye-postgres", "youeye-pointer"} {
		c := CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: true, Autostart: &yes}
		if name == "youeye-pointer" {
			c.Running = false
			c.Autostart = &no
		}
		if name == "youeye-caddy" {
			c.Autostart = nil
		}
		inventory.Containers = append(inventory.Containers, c)
		status := "Running"
		if !c.Running {
			status = "Stopped"
		}
		config := map[string]string{"volatile.uuid": c.UUID, "boot.autostart": "false", "user.youeye.core-request": j.RequestID}
		if name == "youeye-postgres" {
			delete(config, "user.youeye.core-request")
			config["boot.autostart"] = "true"
		}
		rows[name] = &row{Name: name, Status: status, Config: config}
	}
	if err := p.saveRecord(NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "captured"}); err != nil {
		t.Fatal(err)
	}
	gate := "youeye-core:" + fmt.Sprintf("%x", sha256.Sum256([]byte(j.RequestID)))
	effects := 0
	lose := true
	p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		if program == "nft" {
			if args[0] == "--json" {
				if gate == "" {
					return []byte(`{"nftables":[]}`), nil
				}
				return json.Marshal(map[string]any{"nftables": []any{map[string]any{"table": map[string]string{"family": "inet", "name": "youeye_core_gate", "comment": gate}}}})
			}
			if strings.Join(args, " ") == "delete table inet youeye_core_gate" {
				effects++
				gate = ""
				return nil, fmt.Errorf("fixture lost delete acknowledgement")
			}
		}
		if program == "incus" {
			if args[0] == "list" {
				list := []*row{}
				for _, r := range rows {
					list = append(list, r)
				}
				return json.Marshal(list)
			}
			if args[0] == "query" {
				if args[1] == "/1.0/operations?recursion=1" {
					return []byte(coreProviderResponse(`{}`)), nil
				}
				return json.Marshal(rows[strings.TrimPrefix(args[1], "/1.0/instances/")])
			}
			if args[0] == "config" {
				effects++
				r := rows[args[2]]
				if args[1] == "unset" {
					delete(r.Config, args[3])
				} else if args[1] == "set" {
					r.Config[args[3]] = args[4]
				} else {
					t.Fatal("unexpected config operation")
				}
				if lose {
					lose = false
					return nil, fmt.Errorf("fixture lost settings acknowledgement")
				}
				return nil, nil
			}
		}
		t.Fatalf("unexpected native effect %s %v", program, args)
		return nil, nil
	}
	if _, err := p.ReleaseCompleted(ctx, j.RequestID); err == nil || effects != 0 {
		t.Fatal("uncommitted platform reopened", err, effects)
	}
	var err error
	j, err = m.Advance(ctx, j.RequestID, false)
	if err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	rows["youeye-pointer"].Status = "Running"
	if _, err = p.ReleaseCompleted(ctx, j.RequestID); err == nil || effects != 0 {
		t.Fatal("original stopped intent ignored", err, effects)
	}
	rows["youeye-pointer"].Status = "Stopped"
	rows["youeye-control"].Config["user.youeye.core-request"] = "foreign"
	if _, err = p.ReleaseCompleted(ctx, j.RequestID); err == nil || effects != 0 {
		t.Fatal("foreign container hold cleared", err, effects)
	}
	rows["youeye-control"].Config["user.youeye.core-request"] = j.RequestID
	gate = "foreign"
	if _, err = p.ReleaseCompleted(ctx, j.RequestID); err == nil {
		t.Fatal("foreign ingress deleted")
	}
	if gate != "foreign" {
		t.Fatal("foreign nft table changed")
	}
	gate = "youeye-core:" + fmt.Sprintf("%x", sha256.Sum256([]byte(j.RequestID)))
	native := p.Capture
	checks := 0
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "query" && args[1] == "/1.0/operations?recursion=1" {
			checks++
			if busyAt == 4 {
				return []byte(`{}`), nil
			}
			if checks == busyAt || busyAt == 3 {
				if _, err := barrier.Read(); err != nil || gate == "" {
					t.Fatal("maintenance released before operation settled", err)
				}
				return []byte(coreProviderResponse(`{"running":[{"id":"transient-exec","class":"websocket","status_code":103}]}`)), nil
			}
		}
		return native(ctx, program, args...)
	}
	if busyAt >= 3 {
		bounded, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
		_, err := p.ReleaseCompleted(bounded, j.RequestID)
		cancel()
		if err == nil || (busyAt == 3 && !errors.Is(err, context.DeadlineExceeded)) {
			t.Fatal("unsafe or unbounded release", err)
		}
		if _, err := barrier.Read(); err != nil || gate == "" {
			t.Fatal("failed wait released maintenance", err)
		}
		busyAt = 0 // Explicit continuation of the same committed request.
	}
	if evidence, err := p.ReleaseCompleted(ctx, j.RequestID); err != nil || evidence == "" {
		t.Fatal(evidence, err)
	}
	if gate != "" {
		t.Fatal("ingress still closed")
	}
	if _, err = barrier.Read(); !os.IsNotExist(err) {
		t.Fatal("lifecycle not released", err)
	}
	for _, c := range inventory.Containers {
		if !coreOriginalAutostart(rows[c.Name].Config, c) || rows[c.Name].Config["user.youeye.core-request"] != "" {
			t.Fatal("original setting not preserved", c.Name)
		}
	}
	record, err := p.Read(j)
	if err != nil || record.CompletionState != "released" {
		t.Fatal(record.CompletionState, err)
	}
	// A lost final receipt must not reset owner settings after admission reopened.
	record.CompletionState = "ready"
	if err = p.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	rows["youeye-pointer"].Config["boot.autostart"] = "true"
	before := effects
	if _, err = p.ReleaseCompleted(ctx, j.RequestID); err != nil || effects != before || rows["youeye-pointer"].Config["boot.autostart"] != "true" {
		t.Fatal("replayed release after owner work resumed", err)
	}
}
