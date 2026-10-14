package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeCoreQuiesceRetainsIntentAndReconcilesWithoutRestartingWriters(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	data := t.TempDir()
	meta := filepath.Join(data, "app-notes", "install.json")
	if err := atomicWrite(meta, []byte(`{"appId":"notes","containers":[{"containerName":"app-notes"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	barrier := CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}
	if err := barrier.Begin(j); err != nil {
		t.Fatal(err)
	}
	type instance struct {
		Name            string                       `json:"name"`
		Status          string                       `json:"status"`
		Config          map[string]string            `json:"config"`
		ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
	}
	rows := map[string]*instance{}
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-caddy", "youeye-pihole", "youeye-postgres", "app-notes"} {
		status, autostart := "Running", "true"
		if name == "app-notes" {
			status, autostart = "Stopped", "false"
		}
		rows[name] = &instance{ExpandedDevices: map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}, Name: name, Status: status, Config: map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": autostart}}
	}
	stops, holds, effects := 0, 0, 0
	p := NativeCoreCheckpoint{Root: m.Root, DataRoot: data, StatePath: filepath.Join(data, "state.json"), Bridge: "incusbr0", IngressPorts: []uint16{80, 443, 3000, 3001}, MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }}
	p.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		switch program {
		case "zfs":
			return []byte("pool/data\t" + data), nil
		case "nft":
			if args[0] == "--json" {
				return []byte(`{"nftables":[]}`), nil
			}
			effects++
			raw, err := os.ReadFile(args[1])
			if err != nil {
				return nil, err
			}
			if !strings.Contains(string(raw), "tcp dport { 80, 443, 3000, 3001 } drop") {
				t.Fatal("missing ingress closure")
			}
			return nil, nil
		case "incus":
			switch args[0] {
			case "list":
				var list []*instance
				for _, r := range rows {
					list = append(list, r)
				}
				return json.Marshal(list)
			case "query":
				return json.Marshal(rows[strings.TrimPrefix(args[1], "/1.0/instances/")])
			case "config":
				effects++
				rows[args[2]].Config[args[3]] = args[4]
				return nil, nil
			case "stop":
				effects++
				if rows[args[1]].Status != "Running" {
					t.Fatal("repeated stop or changed original stopped intent")
				}
				rows[args[1]].Status = "Stopped"
				stops++
				return nil, nil
			case "exec":
				if rows[args[1]].Status != "Running" {
					t.Fatal("executed code in stopped container")
				}
				if args[1] != "youeye-postgres" {
					effects++
					if strings.Contains(strings.Join(args, " "), "core-update-hold.json") {
						holds++
					}
					return nil, nil
				}
				query := args[len(args)-1]
				if strings.Contains(query, "pg_stat_activity") {
					return []byte("0"), nil
				}
				if strings.Contains(query, "pg_database_size") {
					return []byte(`[{"name":"youeye","owner":"youeye","size_bytes":1000},{"name":"youeye_ui","owner":"youeye","size_bytes":1000}]`), nil
				}
				if strings.Contains(query, "FROM pg_tables") {
					return []byte(`[]`), nil
				}
				return []byte("unchanged security fixture"), nil
			}
		}
		return nil, fmt.Errorf("unexpected native fixture command")
	}
	if _, err := p.Quiesce(context.Background(), j); err == nil || effects != 0 {
		t.Fatal("quiesced without active coordinator step", effects, err)
	}
	j.Phase = "applying"
	j.Steps[0].State = "succeeded"
	j.Steps[0].Evidence = "verified members"
	j.Steps[1].State = "started"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	record, err := p.Quiesce(context.Background(), j)
	if err != nil || record.Phase != "quiesced" || stops != 4 || holds != 2 {
		t.Fatal(record.Phase, stops, holds, err)
	}
	for _, c := range record.Inventory.Containers {
		if c.Name == "app-notes" && (c.Running || c.Autostart == nil || *c.Autostart != "false") {
			t.Fatal("lost original app stopped intent")
		}
	}
	again, err := p.Quiesce(context.Background(), j)
	if err != nil || again.Phase != "quiesced" || stops != 4 || holds != 2 {
		t.Fatal("quiesce replay restarted/re-stopped writers", stops, holds, err)
	}
	before := effects
	p.MachineObservation = func() (CoreMachineIdentity, error) {
		machine := j.Previous.Machine
		machine.ParentDiskID = "another-disk"
		return machine, nil
	}
	if _, err := p.Quiesce(context.Background(), j); err == nil || effects != before {
		t.Fatal("effects continued on another machine", effects, before, err)
	}
}

func TestCoreIngressRefusesForeignMaintenanceTable(t *testing.T) {
	p := NativeCoreCheckpoint{Root: t.TempDir(), Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
		if program != "nft" || args[0] != "--json" {
			t.Fatal("mutated foreign ingress")
		}
		return []byte(`{"nftables":[{"table":{"family":"inet","name":"youeye_core_gate","comment":"foreign-owner"}}]}`), nil
	}}
	if err := p.CloseIngress(context.Background(), CoreCheckpointInventory{RequestID: "request", ManifestSHA256: strings.Repeat("a", 64), Bridge: "incusbr0", IngressPorts: []uint16{80}}); err == nil {
		t.Fatal("adopted foreign table")
	}
}
