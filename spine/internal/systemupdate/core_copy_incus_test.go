package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestIndependentCopyIncusLostServerAcknowledgementAndForeignTrust(t *testing.T) {
	selection, root := copyFixture(t)
	m := CoreManager{Root: filepath.Join(root, "core")}
	receipt, err := m.Initialize(context.Background(), selection, checksum(selection.Raw), func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return CoreMachineIdentity{InstallIDRef: "install:source", DeviceIDRef: "device:source", ParentDiskID: "disk:source", StatePartUUID: "state", DataPartUUID: "data"}, "fixture", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := CoreCopyRequest{RequestID: "copy-incus", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256}
	actual := request.SourceHardware
	observe := func() (string, error) { return actual, nil }
	b := CoreLifecycleBarrier{Root: filepath.Join(root, "apps")}
	if err = b.BeginCopy(request, "source", observe); err != nil {
		t.Fatal(err)
	}
	dataRoot := filepath.Join(root, "data")
	if err = os.MkdirAll(filepath.Join(dataRoot, "incus-client"), 0700); err != nil {
		t.Fatal(err)
	}
	server, _, err := newCopyTLSCertificate("fixture-server", false)
	if err != nil {
		t.Fatal(err)
	}
	client, key, err := newCopyTLSCertificate("fixture-client", true)
	if err != nil {
		t.Fatal(err)
	}
	oldServer, _ := copyCertificateFingerprint([]byte(server))
	oldClient, _ := copyCertificateFingerprint([]byte(client))
	for file, value := range map[string]string{"cp.crt": client, "cp.key": key} {
		if err = os.WriteFile(filepath.Join(dataRoot, "incus-client", file), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	containerFiles := map[string]string{"youeye-control/etc/youeye/incus-client.crt": client, "youeye-control/etc/youeye/incus-client.key": key}
	trustSet := map[string]bool{oldClient: true}
	resources := CopyResourceInventory{Schema: "youeye.copy-resources.v1", AppInventorySHA256: checksum([]byte("apps"))}
	var rows []any
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole", "youeye-pointer"} {
		resources.Containers = append(resources.Containers, CoreCheckpointContainer{Name: name, UUID: "fixture-" + name, Running: true})
		rows = append(rows, map[string]any{"name": name, "status": "Stopped", "config": map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": "false"}})
	}
	updates := 0
	p := NativeCoreCheckpoint{DataRoot: dataRoot, Capture: func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program != "incus" {
			t.Fatal("unexpected program")
		}
		switch args[0] {
		case "info":
			return json.Marshal(map[string]any{"config": map[string]string{}, "environment": map[string]any{"server_clustered": false, "server_certificate": server}})
		case "list":
			return json.Marshal(rows)
		case "file":
			if args[1] == "pull" {
				value, ok := containerFiles[args[2]]
				if !ok {
					return nil, fmt.Errorf("missing fixture")
				}
				return []byte(value), nil
			}
			if args[1] == "push" {
				raw, e := os.ReadFile(args[len(args)-2])
				containerFiles[args[len(args)-1]] = string(raw)
				return nil, e
			}
		case "config":
			if args[2] == "list" {
				var values []any
				for fingerprint := range trustSet {
					values = append(values, map[string]any{"fingerprint": fingerprint, "type": "client", "restricted": false})
				}
				return json.Marshal(values)
			}
			if args[2] == "add-certificate" {
				raw, e := os.ReadFile(args[3])
				if e != nil {
					return nil, e
				}
				fingerprint, e := copyCertificateFingerprint(raw)
				trustSet[fingerprint] = true
				return nil, e
			}
			if args[2] == "remove" {
				delete(trustSet, args[3])
				return nil, nil
			}
		case "admin":
			if args[2] == "--help" {
				return []byte("fixture capability"), nil
			}
			raw, e := os.ReadFile(args[2])
			if e != nil {
				return nil, e
			}
			server = string(raw)
			updates++
			if updates == 1 {
				return nil, fmt.Errorf("lost fixture acknowledgement")
			}
			return nil, nil
		}
		t.Fatal("unexpected command", args)
		return nil, nil
	}}
	resources.IncusAuthority, err = p.InspectCopyIncusAuthority(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	trustSet[checksum([]byte("foreign"))] = true
	if _, err = p.InspectCopyIncusAuthority(context.Background()); err == nil {
		t.Fatal("accepted foreign client trust")
	}
	delete(trustSet, checksum([]byte("foreign")))
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
	if err = m.PrepareIndependentCopyIncus(context.Background(), request, b, p, observe); err == nil {
		t.Fatal("lost acknowledgement called success")
	}
	newServer, _ := copyCertificateFingerprint([]byte(server))
	if newServer == oldServer {
		t.Fatal("server identity did not change")
	}
	if err = m.PrepareIndependentCopyIncus(context.Background(), request, b, p, observe); err != nil {
		t.Fatal(err)
	}
	if updates != 1 || trustSet[oldClient] || len(trustSet) != 1 {
		t.Fatal("replayed certificate update or retained source trust")
	}
	newAuthority, err := p.InspectCopyIncusAuthority(context.Background())
	if err != nil || newAuthority.ClientFingerprint == oldClient || newAuthority.ServerFingerprint != newServer {
		t.Fatal("independent authority not converged", err)
	}
	if err = m.PrepareIndependentCopyIncus(context.Background(), request, b, p, observe); err != nil || updates != 1 {
		t.Fatal("completed preparation did not reconcile", err)
	}
}
