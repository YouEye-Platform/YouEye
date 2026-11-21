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

// A power cut between the commit and the release: the boot left every held
// container stopped (boot.autostart=false), the Control Panel included, and
// the ingress gate is gone with the old kernel. The release must finish by
// itself: start what ran at the checkpoint, restore the settings and drop the
// reservation. Before 0.6.15 it refused with "original container power intent
// has not been restored" and the box stayed closed until a console repair.
func TestCoreCompletionFinishesAfterAPowerCut(t *testing.T) {
	for _, tc := range []struct {
		name       string
		noStart    string // a container whose start has no effect
		extra      string // a container stopped at the checkpoint that runs now
		postgresUp bool
	}{
		{name: "everything stopped", postgresUp: true},
		{name: "the database is stopped too"},
		{name: "one app cannot be started", noStart: "youeye-caddy", postgresUp: true},
		{name: "a stopped app was started by hand", extra: "youeye-pointer", postgresUp: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
			yes := "true"
			// Apps sort before the core containers, as in a real inventory.
			for _, name := range []string{"app-memos", "youeye-caddy", "youeye-control", "youeye-pointer", "youeye-postgres", "youeye-ui"} {
				c := CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: name != "youeye-pointer", Autostart: &yes}
				inventory.Containers = append(inventory.Containers, c)
				config := map[string]string{"volatile.uuid": c.UUID, "boot.autostart": "false", "user.youeye.core-request": j.RequestID}
				status := "Stopped"
				if name == "youeye-postgres" {
					config = map[string]string{"volatile.uuid": c.UUID, "boot.autostart": "true"}
					if tc.postgresUp {
						status = "Running"
					}
				}
				if name == tc.extra {
					status = "Running"
				}
				rows[name] = &row{Name: name, Status: status, Config: config}
			}
			if err := p.saveRecord(NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "captured"}); err != nil {
				t.Fatal(err)
			}
			starts := []string{}
			p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
				if program == "nft" && args[0] == "--json" {
					return []byte(`{"nftables":[]}`), nil
				}
				if program == "incus" {
					switch args[0] {
					case "list":
						list := []*row{}
						for _, r := range rows {
							list = append(list, r)
						}
						return json.Marshal(list)
					case "query":
						if args[1] == "/1.0/operations?recursion=1" {
							return []byte(coreProviderResponse(`{}`)), nil
						}
						return json.Marshal(rows[strings.TrimPrefix(args[1], "/1.0/instances/")])
					case "config":
						if args[1] == "unset" {
							delete(rows[args[2]].Config, args[3])
						} else {
							rows[args[2]].Config[args[3]] = args[4]
						}
						return nil, nil
					case "start":
						starts = append(starts, args[1])
						if args[1] == tc.noStart {
							return nil, fmt.Errorf("fixture: the container does not start")
						}
						rows[args[1]].Status = "Running"
						return nil, fmt.Errorf("fixture lost start acknowledgement")
					}
				}
				t.Fatalf("unexpected native effect %s %v", program, args)
				return nil, nil
			}
			var err error
			if j, err = m.Advance(ctx, j.RequestID, false); err != nil || j.Phase != "committed" {
				t.Fatal(j.Phase, err)
			}
			evidence, err := p.ReleaseCompleted(ctx, j.RequestID)
			if err != nil {
				t.Fatalf("a committed request was not released after a power cut: %v", err)
			}
			if _, err = barrier.Read(); !os.IsNotExist(err) {
				t.Fatal("lifecycle not released", err)
			}
			if record, err := p.Read(j); err != nil || record.CompletionState != "released" {
				t.Fatal(record.CompletionState, err)
			}
			for _, c := range inventory.Containers {
				r := rows[c.Name]
				if c.Name != "youeye-postgres" && (!coreOriginalAutostart(r.Config, c) || r.Config["user.youeye.core-request"] != "") {
					t.Fatal("original setting not restored", c.Name)
				}
				want := c.Running && c.Name != tc.noStart || c.Name == tc.extra
				if (r.Status == "Running") != want {
					t.Fatalf("%s is %s after the release", c.Name, r.Status)
				}
			}
			for _, name := range starts {
				if name == "youeye-pointer" {
					t.Fatal("a container that was stopped at the checkpoint was started")
				}
			}
			core := []string{}
			for _, name := range starts {
				if name != "youeye-postgres" {
					core = append(core, name)
				}
			}
			if len(core) < 2 || core[0] != "youeye-control" || core[1] != "youeye-ui" {
				t.Fatalf("the Control Panel and the dashboard are not started first: %v", starts)
			}
			if !strings.Contains(evidence, "started after a restart: youeye-control, youeye-ui") {
				t.Fatal(evidence)
			}
			if (tc.noStart != "") != strings.Contains(evidence, "could not be started: "+tc.noStart) {
				t.Fatal(evidence)
			}
			// A second run (the watchdog, a person) changes nothing.
			before := len(starts)
			if _, err = p.ReleaseCompleted(ctx, j.RequestID); err != nil || len(starts) != before {
				t.Fatal("the release ran twice", err, starts)
			}
		})
	}
}
