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
							return []byte(`{}`), nil
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
