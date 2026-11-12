package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

func TestIndependentCopySourceQuiescenceReconcilesLostAcknowledgement(t *testing.T) {
	root := t.TempDir()
	m := CoreManager{Root: filepath.Join(root, "core")}
	b := CoreLifecycleBarrier{Root: filepath.Join(root, "apps")}
	request := CoreCopyRequest{RequestID: "copy-source", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: checksum([]byte("source")), ManifestSHA256: checksum([]byte("manifest"))}
	observe := func() (string, error) { return request.SourceHardware, nil }
	if err := b.BeginCopy(request, "source", observe); err != nil {
		t.Fatal(err)
	}
	resources := CopyResourceInventory{Schema: "youeye.copy-resources.v1", AppInventorySHA256: checksum([]byte("apps"))}
	states := map[string]string{}
	uuids := map[string]string{}
	boot := map[string]string{}
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole", "app-notes"} {
		running := name != "app-notes"
		resources.Containers = append(resources.Containers, CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: running})
		uuids[name] = "fixture-" + name
		states[name] = "Running"
		if !running {
			states[name] = "Stopped"
		}
	}
	payload, _ := json.Marshal(resources)
	resources.SHA256 = checksum(payload)
	if err := m.SaveCopySource(request, b, resources, json.RawMessage(`{"schema":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	commands := []string{}
	interrupt := true
	p := NativeCoreCheckpoint{Capture: func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program != "incus" {
			t.Fatal("unexpected program")
		}
		if args[0] == "list" {
			var rows []any
			for name, state := range states {
				rows = append(rows, map[string]any{"name": name, "status": state, "config": map[string]string{"volatile.uuid": uuids[name], "boot.autostart": boot[name]}})
			}
			return json.Marshal(rows)
		}
		if args[0] == "config" {
			if args[1] == "unset" {
				delete(boot, args[2])
			} else {
				boot[args[2]] = args[4]
			}
			return nil, nil
		}
		commands = append(commands, args[0]+":"+args[1])
		if args[0] == "stop" {
			if len(args) != 4 || args[2] != "--timeout" {
				t.Fatal("non-graceful stop")
			}
			states[args[1]] = "Stopped"
		} else if args[0] == "start" {
			states[args[1]] = "Running"
		} else {
			t.Fatal("unexpected mutation")
		}
		if interrupt {
			interrupt = false
			return nil, fmt.Errorf("lost fixture acknowledgement")
		}
		return nil, nil
	}}
	if err := m.SetCopySourceRuntime(context.Background(), request, b, p, false, observe); err == nil {
		t.Fatal("lost acknowledgement called success")
	}
	if err := m.SetCopySourceRuntime(context.Background(), request, b, p, false, observe); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 5 || commands[0] != "stop:youeye-control" {
		t.Fatal("replayed stop or missed writer", commands)
	}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		t.Fatal("quiescence not retained", err)
	}
	for name := range states {
		if boot[name] != "false" {
			t.Fatal("inherited autostart remains", name)
		}
	}
	if err = m.SetCopySourceRuntime(context.Background(), request, b, p, true, observe); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 10 || states["app-notes"] != "Stopped" || states["youeye-control"] != "Running" {
		t.Fatal("source runtime intent not restored", commands)
	}
	for name := range states {
		if boot[name] != "" {
			t.Fatal("source boot intent not restored", name)
		}
	}
	uuids["youeye-control"] = "replaced"
	if err = m.SetCopySourceRuntime(context.Background(), request, b, p, false, observe); err == nil {
		t.Fatal("quiesced a replacement container")
	}
}
