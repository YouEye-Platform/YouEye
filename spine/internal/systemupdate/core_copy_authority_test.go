package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestIndependentCopyRuntimeAuthorityRetainsGeneratedValuesAfterInterruption(t *testing.T) {
	selection, root := copyFixture(t)
	m := CoreManager{Root: filepath.Join(root, "core")}
	receipt, err := m.Initialize(context.Background(), selection, checksum(selection.Raw), func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return CoreMachineIdentity{InstallIDRef: "install:source", DeviceIDRef: "device:source", ParentDiskID: "disk:source", StatePartUUID: "state", DataPartUUID: "data"}, "fixture", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := CoreCopyRequest{RequestID: "copy-runtime", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256}
	actual := request.SourceHardware
	observe := func() (string, error) { return actual, nil }
	b := CoreLifecycleBarrier{Root: filepath.Join(root, "apps")}
	if err = b.BeginCopy(request, "source", observe); err != nil {
		t.Fatal(err)
	}
	dataRoot := filepath.Join(root, "data")
	privateJournal := filepath.Join(dataRoot, "state", "independent-copies", "prior.json")
	if err = os.MkdirAll(filepath.Dir(privateJournal), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(privateJournal, []byte("synthetic inherited source password"), 0600); err != nil {
		t.Fatal(err)
	}
	containers := map[string][]byte{}
	original := map[string]string{}
	for _, f := range copyAuthorityTargets(dataRoot) {
		value := "synthetic-source-secret"
		if strings.HasSuffix(f.Path, ".env") {
			value = "JWT_SECRET=source-ui-jwt\nDATABASE_URL=postgresql://youeye:synthetic-source-db@youeye-postgres.internal:5432/youeye_ui\n"
		}
		if f.Container == "youeye-pointer" {
			value = "JWT_SECRET=source-pointer-jwt\nENCRYPTION_SECRET=source-pointer-encryption\nDATABASE_URL=postgresql://youeye:synthetic-source-db@youeye-postgres.internal:5432/pointer\n"
		}
		if strings.HasSuffix(f.Path, ".service") {
			value = "[Service]\nEnvironment=JWT_SECRET=source-cp-jwt\nEnvironment=TEST_ADMIN_SECRET=source-deploy\nExecStart=/usr/bin/node /opt/app/server.js\n"
		}
		original[f.Container+f.Path] = value
		if f.Container != "" {
			containers[f.Container+f.Path] = []byte(value)
			continue
		}
		if err = os.MkdirAll(filepath.Dir(f.Path), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(f.Path, []byte(value), f.Mode); err != nil {
			t.Fatal(err)
		}
	}
	resources := CopyResourceInventory{Schema: "youeye.copy-resources.v1", AppInventorySHA256: checksum([]byte("apps"))}
	var rows []any
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole", "youeye-pointer"} {
		resources.Containers = append(resources.Containers, CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: true})
		rows = append(rows, map[string]any{"name": name, "status": "Stopped", "config": map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": "false"}})
	}
	interrupt := true
	p := NativeCoreCheckpoint{DataRoot: dataRoot, Capture: func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program != "incus" {
			t.Fatal("unexpected program")
		}
		if args[0] == "list" {
			return json.Marshal(rows)
		}
		if args[0] != "file" {
			t.Fatal("unexpected command")
		}
		if args[1] == "pull" {
			raw, ok := containers[args[2]]
			if !ok {
				return nil, fmt.Errorf("fixture absent")
			}
			return raw, nil
		}
		if args[1] == "push" {
			raw, e := os.ReadFile(args[len(args)-2])
			if e != nil {
				return nil, e
			}
			containers[args[len(args)-1]] = raw
			if interrupt {
				interrupt = false
				return nil, fmt.Errorf("lost fixture acknowledgement")
			}
			return nil, nil
		}
		t.Fatal("unexpected file operation")
		return nil, nil
	}}
	resources.RuntimeAuthoritySHA256, err = inspectCopyRuntimeAuthority(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(resources)
	resources.SHA256 = checksum(raw)
	if err = m.SaveCopySource(request, b, resources, json.RawMessage(`{"schema":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	source, err := m.ReadCopySource(request)
	if err != nil {
		t.Fatal(err)
	}
	source.Quiesced = true
	raw, _ = json.Marshal(source)
	if err = atomicWrite(filepath.Join(m.Root, "copy-source.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	actual = request.DestinationHardware
	if err = b.BeginCopy(request, "destination", observe); err != nil {
		t.Fatal(err)
	}
	if err = m.BeginIndependentCopy(request, observe); err != nil {
		t.Fatal(err)
	}
	if err = m.PrepareIndependentCopyRuntimeAuthority(context.Background(), request, b, p, observe); err == nil {
		t.Fatal("lost acknowledgement was success")
	}
	first, _ := os.ReadFile(filepath.Join(dataRoot, "config/cli-token"))
	if err = m.PrepareIndependentCopyRuntimeAuthority(context.Background(), request, b, p, observe); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(dataRoot, "config/cli-token"))
	if _, err = os.Lstat(privateJournal); !os.IsNotExist(err) {
		t.Fatal("inherited private copy journal survived", err)
	}
	// Later destination platform journals must survive a repeated host phase.
	if err = os.MkdirAll(filepath.Dir(privateJournal), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(privateJournal, []byte("current destination journal"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = m.PrepareIndependentCopyRuntimeAuthority(context.Background(), request, b, p, observe); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(privateJournal); err != nil || string(raw) != "current destination journal" {
		t.Fatal("retry removed current journal", err)
	}
	if string(first) != string(second) || string(second) == original[filepath.Join(dataRoot, "config/cli-token")] {
		t.Fatal("retry regenerated or retained inherited authority")
	}
	for _, file := range copyAuthorityTargets(dataRoot) {
		current, e := readCopyAuthorityFile(context.Background(), p, file)
		if e != nil || string(current) == original[file.Container+file.Path] {
			t.Fatal("inherited authority remained", file.Container, file.Path, e)
		}
	}
	if !strings.Contains(string(containers["youeye-ui/etc/youeye-ui.env"]), "@youeye-postgres.internal:5432/youeye_ui") {
		t.Fatal("ordinary configuration changed")
	}
	containers["youeye-control/etc/youeye/cli-token"] = []byte("unrelated-new-authority")
	if err = m.PrepareIndependentCopyRuntimeAuthority(context.Background(), request, b, p, observe); err == nil {
		t.Fatal("overwrote unrelated authority on replay")
	}
}

func TestIndependentCopyCredentialDeclarationRejectsAmbiguity(t *testing.T) {
	for _, raw := range []string{"[Service]\n", "Environment=JWT_SECRET=\n", "Environment=JWT_SECRET=one\nEnvironment=JWT_SECRET=two\n"} {
		if _, err := replaceCopyEnvironment(raw, "Environment=", map[string]string{"JWT_SECRET": "fresh"}); err == nil {
			t.Fatal("accepted ambiguous credential")
		}
	}
}
