package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreHealthPowerPreservesStoppedGuestsAndNeverRepeatsUncertainStarts(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		for _, mode := range []string{"normal", "lost-after", "lost-before"} {
			t.Run(fmt.Sprint(recovery)+mode, func(t *testing.T) {
				ctx := context.Background()
				m, _, target := coreJournalFixture(t)
				j := prepareCoreFixture(t, m, target)
				for i := range j.Steps {
					j.Steps[i].State = "succeeded"
					j.Steps[i].Evidence = "fixture"
					if j.Steps[i].Name == "authenticated-health" {
						j.Steps[i].State = "started"
						j.Steps[i].Evidence = ""
					}
				}
				j.Phase = "applying"
				phase := "captured"
				if recovery {
					j.Phase = "recovering"
					phase = "paired-restored"
					for _, name := range coreRecoveryNames(j) {
						step := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"}
						if name == "recovery-health" {
							step.State = "started"
							step.Evidence = ""
						}
						j.RecoverySteps = append(j.RecoverySteps, step)
					}
				}
				if err := m.saveCore(&j); err != nil {
					t.Fatal(err)
				}
				data := t.TempDir()
				p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
				if err := (CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}).Begin(j); err != nil {
					t.Fatal(err)
				}
				type row struct {
					Name   string            `json:"name"`
					Status string            `json:"status"`
					Config map[string]string `json:"config"`
				}
				rows := map[string]*row{}
				starts := map[string]int{}
				inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}}
				_, inventory.AppInventorySHA256, _ = p.installedOwners()
				for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole", "youeye-pointer"} {
					c := CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: name != "youeye-pointer"}
					inventory.Containers = append(inventory.Containers, c)
					status := "Stopped"
					if name == "youeye-control" || name == "youeye-ui" || name == "youeye-postgres" {
						status = "Running"
					}
					rows[name] = &row{Name: name, Status: status, Config: map[string]string{"volatile.uuid": c.UUID, "user.youeye.core-request": j.RequestID, "boot.autostart": "false"}}
				}
				record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: phase}
				if recovery {
					record.PowerRestores = []CorePowerRestore{{Name: "youeye-caddy", UUID: "fixture-youeye-caddy", State: "running"}}
				}
				if err := p.saveRecord(record); err != nil {
					t.Fatal(err)
				}
				p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
					if program != "incus" {
						t.Fatal("unexpected effect", program)
					}
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
					case "start":
						name := args[1]
						starts[name]++
						if name == "youeye-pointer" {
							t.Fatal("originally stopped guest booted")
						}
						if mode != "lost-before" {
							rows[name].Status = "Running"
						}
						if mode != "normal" {
							return nil, fmt.Errorf("fixture lost start")
						}
						return nil, nil
					}
					t.Fatal("unexpected native power action", args)
					return nil, nil
				}
				err := p.PrepareHealth(ctx, j.RequestID, recovery, false)
				if (err != nil) != (mode == "lost-before") {
					t.Fatal(mode, err)
				}
				err = p.PrepareHealth(ctx, j.RequestID, recovery, true)
				if (err != nil) != (mode == "lost-before") || starts["youeye-caddy"] != 1 || starts["youeye-pointer"] != 0 {
					t.Fatal("power effect replayed or uncertainty accepted", err, starts)
				}
				if rows["youeye-caddy"].Config["user.youeye.core-request"] != j.RequestID || rows["youeye-caddy"].Config["boot.autostart"] != "false" {
					t.Fatal("health startup released maintenance")
				}
			})
		}
	}
}

func TestCoreRecoveryObservesOldHostDNSWithoutInventingAStart(t *testing.T) {
	for _, mode := range []string{"recovered-dns", "forward", "host-not-recovered", "no-host-transition", "other-container", "originally-stopped", "foreign-owner", "changed-uuid", "changed-autostart", "observe-without-receipt"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			m, _, target := coreJournalFixture(t)
			if mode != "no-host-transition" {
				for i := range target.Members {
					if target.Members[i].Role == "spine" {
						target.Members[i].Artifact.SHA256 = strings.Repeat("f", 64)
					}
				}
			}
			j := prepareCoreFixture(t, m, target)
			j.Phase = "recovering"
			for _, name := range coreRecoveryNames(j) {
				s := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"}
				if name == "recovery-health" {
					s.State, s.Evidence = "started", ""
				}
				j.RecoverySteps = append(j.RecoverySteps, s)
			}
			recovery, phase := true, "paired-restored"
			if mode == "forward" {
				recovery, phase, j.Phase, j.RecoverySteps = false, "captured", "applying", nil
				for i := range j.Steps {
					if j.Steps[i].Name == "authenticated-health" {
						j.Steps[i].State = "started"
					} else if j.Steps[i].Name != "commit-host" {
						j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture"
					}
				}
			}
			if mode == "host-not-recovered" {
				// A valid graph whose host action is still running cannot admit health.
				for i := range j.RecoverySteps {
					if j.RecoverySteps[i].Name == "recovery-host" {
						j.RecoverySteps[i].State, j.RecoverySteps[i].Evidence = "started", ""
					} else if j.RecoverySteps[i].Name == "recovery-health" {
						j.RecoverySteps[i].State = "pending"
					}
				}
			}
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Read(); err != nil {
				t.Fatal("invalid power fixture", err)
			}
			data := t.TempDir()
			p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
			if err := (CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}).Begin(j); err != nil {
				t.Fatal(err)
			}
			name := "youeye-pihole"
			if mode == "other-container" {
				name = "app-example"
			}
			c := CoreCheckpointContainer{Name: name, UUID: "fixture-dns", Running: mode != "originally-stopped"}
			inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}, Containers: []CoreCheckpointContainer{c}}
			_, inventory.AppInventorySHA256, _ = p.installedOwners()
			record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: phase}
			if err := p.saveRecord(record); err != nil {
				t.Fatal(err)
			}
			config := map[string]string{"volatile.uuid": c.UUID, "user.youeye.core-request": j.RequestID, "boot.autostart": "false"}
			switch mode {
			case "foreign-owner":
				config["user.youeye.core-request"] = "another-request"
			case "changed-uuid":
				config["volatile.uuid"] = "replacement"
			case "changed-autostart":
				config["boot.autostart"] = "true"
			}
			row := map[string]any{"name": name, "status": "Running", "config": config}
			p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
				if program != "incus" {
					t.Fatalf("unexpected command: %s", program)
				}
				if args[0] == "list" {
					return json.Marshal([]any{row})
				}
				if args[0] == "query" {
					if args[1] == "/1.0/operations?recursion=1" {
						return []byte(coreProviderResponse(`{}`)), nil
					}
					return json.Marshal(row)
				}
				t.Fatalf("observation must not start, stop or modify a container: %v", args)
				return nil, nil
			}
			err := p.PrepareHealth(ctx, j.RequestID, recovery, mode == "observe-without-receipt")
			if mode != "recovered-dns" {
				if err == nil {
					t.Fatal("unowned or unverified running instance accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := p.Read(j)
			if err != nil || len(got.RecoveryPowerRestores) != 1 || got.RecoveryPowerRestores[0].State != "observed-running" {
				t.Fatalf("missing truthful observation: %+v, %v", got.RecoveryPowerRestores, err)
			}
			if err := p.PrepareHealth(ctx, j.RequestID, true, true); err != nil {
				t.Fatal("retained observation did not reconcile", err)
			}
		})
	}
}
