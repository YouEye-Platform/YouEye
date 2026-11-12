package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

func TestCoreHealthDNSAddressRepair(t *testing.T) {
	for _, mode := range []string{"forward", "recovery", "reboot", "reboot-address", "reboot-after-repair", "reboot-unknown", "settled-repair", "unknown-forward", "unknown-recovery", "observe", "lost-binding-ack", "lost-start-ack", "lost-start-before", "foreign-owner", "changed-uuid", "custom-proxy", "originally-stopped", "provider-busy", "same-address-unknown"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			m, _, target := coreJournalFixture(t)
			j := prepareCoreFixture(t, m, target)
			recovery := mode == "reboot-address" || mode == "reboot-after-repair" || mode == "reboot-unknown" || mode == "reboot" || mode == "recovery" || mode == "settled-repair" || mode == "unknown-recovery" || mode == "lost-start-ack" || mode == "lost-start-before" || mode == "same-address-unknown"
			j.Phase = "applying"
			phase := "captured"
			for i := range j.Steps {
				j.Steps[i].State = "succeeded"
				j.Steps[i].Evidence = "fixture"
				if j.Steps[i].Name == "authenticated-health" {
					j.Steps[i].State = "started"
					j.Steps[i].Evidence = ""
				}
			}
			if recovery {
				j.Phase = "recovering"
				phase = "paired-restored"
				for _, name := range coreRecoveryNames(j) {
					s := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "succeeded", Evidence: "fixture"}
					if name == "recovery-health" {
						s.State = "started"
						s.Evidence = ""
					}
					j.RecoverySteps = append(j.RecoverySteps, s)
				}
			}
			if err := m.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			address := "192.0.2.11"
			p := NativeCoreCheckpoint{Root: m.Root, DataRoot: t.TempDir(), MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }, DNSHostAddress: func(context.Context) (string, error) { return address, nil }, allowDNSRepairStart: mode == "reboot-address" || mode == "reboot-after-repair" || mode == "settled-repair" || mode == "lost-start-ack" || mode == "lost-start-before" || mode == "same-address-unknown"}
			if err := (CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}).Begin(j); err != nil {
				t.Fatal(err)
			}
			c := CoreCheckpointContainer{Name: "youeye-pihole", UUID: "fixture-dns", Running: mode != "originally-stopped"}
			a := coreCompletionContainer{Status: "Stopped", Config: map[string]string{"volatile.uuid": c.UUID, "user.youeye.core-request": j.RequestID, "boot.autostart": "false"}, Devices: map[string]map[string]string{"proxy0": {"type": "proxy", "connect": "tcp:127.0.0.1:53", "listen": "tcp:192.0.2.37:53"}, "proxy1": {"type": "proxy", "connect": "udp:127.0.0.1:53", "listen": "udp:192.0.2.37:53"}}}
			if mode == "foreign-owner" {
				a.Config["user.youeye.core-request"] = "foreign"
			}
			if mode == "changed-uuid" {
				a.Config["volatile.uuid"] = "replacement"
			}
			if mode == "custom-proxy" {
				a.Devices["proxy0"]["connect"] = "tcp:127.0.0.1:54"
			}
			if mode == "same-address-unknown" || mode == "reboot-unknown" {
				a.Devices["proxy0"]["listen"] = "tcp:192.0.2.11:53"
				a.Devices["proxy1"]["listen"] = "udp:192.0.2.11:53"
			}
			inventory := CoreCheckpointInventory{RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}, Containers: []CoreCheckpointContainer{c}}
			_, inventory.AppInventorySHA256, _ = p.installedOwners()
			record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: phase}
			hasStart := mode == "reboot-after-repair" || mode == "reboot-unknown" || mode == "settled-repair" || mode == "unknown-forward" || mode == "unknown-recovery" || mode == "lost-start-ack" || mode == "lost-start-before" || mode == "same-address-unknown"
			if hasStart {
				start := []CorePowerRestore{{Name: c.Name, UUID: c.UUID, State: "requested"}}
				if recovery {
					record.RecoveryPowerRestores = start
				} else {
					record.PowerRestores = start
				}
			}
			if err := p.saveRecord(record); err != nil {
				t.Fatal(err)
			}
			starts, writes := 0, 0
			p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
				if program != "incus" {
					t.Fatal(program)
				}
				switch args[0] {
				case "list":
					return json.Marshal([]any{map[string]any{"name": c.Name, "status": a.Status, "config": a.Config}})
				case "query":
					if args[1] == "/1.0/operations?recursion=1" {
						if mode == "provider-busy" {
							return nil, fmt.Errorf("fixture unavailable")
						}
						return []byte(coreProviderResponse(`{}`)), nil
					}
					return json.Marshal(a)
				case "config":
					if len(args) != 7 || args[1] != "device" || args[2] != "set" || args[3] != c.Name || args[5] != "listen" {
						t.Fatal(args)
					}
					writes++
					a.Devices[args[4]]["listen"] = args[6]
					if mode == "lost-binding-ack" {
						return nil, fmt.Errorf("lost acknowledgement")
					}
					return nil, nil
				case "start":
					starts++
					if a.Devices["proxy0"]["listen"] != "tcp:"+address+":53" || a.Devices["proxy1"]["listen"] != "udp:"+address+":53" {
						t.Fatal("start before binding repair")
					}
					if mode != "lost-start-before" {
						a.Status = "Running"
					}
					if mode == "lost-start-ack" || mode == "lost-start-before" {
						return nil, fmt.Errorf("lost acknowledgement")
					}
					return nil, nil
				}
				t.Fatal(args)
				return nil, nil
			}
			if mode == "reboot-unknown" {
				p.recoveryPreviousBoot = "11111111-1111-1111-1111-111111111111"
				p.recoveryCurrentBoot = "22222222-2222-2222-2222-222222222222"
			}
			err := p.PrepareHealth(ctx, j.RequestID, recovery, mode == "observe")
			success := mode == "reboot-address" || mode == "reboot-after-repair" || mode == "reboot-unknown" || mode == "reboot" || mode == "forward" || mode == "recovery" || mode == "settled-repair" || mode == "lost-binding-ack" || mode == "lost-start-ack" || mode == "originally-stopped"
			if (err == nil) != success {
				t.Fatal(mode, err)
			}
			if !success && mode != "lost-start-before" && (starts != 0 || writes != 0) {
				t.Fatal("inadmissible mutation", starts, writes)
			}
			if mode == "reboot-unknown" {
				if starts != 1 || writes != 0 {
					t.Fatal("new-boot power restoration", starts, writes)
				}
				for _, observe := range []bool{true, false} {
					if err = p.PrepareHealth(ctx, j.RequestID, true, observe); err != nil {
						t.Fatal(err)
					}
				}
				if starts != 1 {
					t.Fatal("new-boot start replayed")
				}
				return
			}
			if mode == "originally-stopped" {
				if starts != 0 || writes != 0 {
					t.Fatal("originally stopped DNS mutated")
				}
				return
			}
			if success || mode == "lost-start-before" {
				if starts != 1 || writes != 2 {
					t.Fatal(starts, writes)
				}
				expectedStarts, expectedWrites, expectedBindings := 1, 2, 1
				if mode == "reboot" || mode == "reboot-address" || mode == "reboot-after-repair" {
					if mode == "reboot-address" {
						address = "192.0.2.12"
						expectedWrites = 4
						expectedBindings = 2
					}
					p.recoveryPreviousBoot = "11111111-1111-1111-1111-111111111111"
					p.recoveryCurrentBoot = "22222222-2222-2222-2222-222222222222"
					a.Status = "Stopped"
					if err = p.PrepareHealth(ctx, j.RequestID, true, false); err != nil {
						t.Fatal("new boot recovery", err)
					}
					expectedStarts = 2
				}
				for _, observe := range []bool{true, false} {
					err = p.PrepareHealth(ctx, j.RequestID, recovery, observe)
					if (err == nil) != (mode != "lost-start-before") {
						t.Fatal("reconciliation", err)
					}
				}
				if starts != expectedStarts || writes != expectedWrites {
					t.Fatal("replayed action", starts, writes)
				}
				got, err := p.Read(j)
				if err != nil || len(got.DNSBindings) != expectedBindings || got.DNSBindings[0].PreviousTCP != "tcp:192.0.2.37:53" || got.DNSBindings[0].PreviousStartRequested != hasStart {
					t.Fatal("repair provenance lost", got.DNSBindings, err)
				}
				if mode == "reboot-address" {
					original, _ := json.Marshal(got.DNSBindings)
					a.Status = "Stopped"
					// An acknowledged start that is now stopped still cannot be
					// replayed. Nor may an address change invent a same-boot start.
					for _, next := range []string{"192.0.2.12", "192.0.2.13"} {
						address = next
						if err = p.PrepareHealth(ctx, j.RequestID, true, false); err == nil {
							t.Fatal("same-boot replay admitted")
						}
					}
					if starts != 2 || writes != 4 {
						t.Fatal("same-boot effects", starts, writes)
					}
					p.recoveryCurrentBoot = "33333333-3333-3333-3333-333333333333"
					if err = p.PrepareHealth(ctx, j.RequestID, true, true); err == nil {
						t.Fatal("observation mutated new binding")
					}
					if starts != 2 || writes != 4 {
						t.Fatal("observation effects", starts, writes)
					}
					if err = p.PrepareHealth(ctx, j.RequestID, true, false); err != nil {
						t.Fatal("second cold boot", err)
					}
					got, err = p.Read(j)
					if err != nil || len(got.DNSBindings) != 3 || starts != 3 || writes != 6 {
						t.Fatal("second boot effects", err, starts, writes)
					}
					retained, _ := json.Marshal(got.DNSBindings[:2])
					if string(original) != string(retained) {
						t.Fatal("historical DNS receipts changed")
					}
				}
			}
		})
	}
}
