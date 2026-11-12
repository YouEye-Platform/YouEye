package systemupdate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreCheckpointInventoryRefusesForeignOrUnsettledWriters(t *testing.T) {
	root := t.TempDir()
	p := NativeCoreCheckpoint{DataRoot: root}
	meta := filepath.Join(root, "app-notes", "install.json")
	if err := atomicWrite(meta, []byte(`{"appId":"notes","containers":[{"containerName":"app-notes"}],"lifecycleOperation":{"state":"completed"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	owned, digest, err := p.installedOwners()
	if err != nil || !validSHA256(digest) {
		t.Fatal(err)
	}
	var rows []map[string]any
	for name := range owned {
		rows = append(rows, map[string]any{"expanded_devices": map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}, "name": name, "status": "Running", "config": map[string]string{"volatile.uuid": "fixture-" + name, "boot.autostart": "true", "environment.OWNER_SECRET": "private-fixture"}})
	}
	raw, _ := json.Marshal(rows)
	actual, err := coreCheckpointContainers(raw, owned, "owned-snapshot")
	if err != nil || len(actual) != len(rows) {
		t.Fatal(actual, err)
	}
	encoded, _ := json.Marshal(actual)
	if strings.Contains(string(encoded), "private-fixture") {
		t.Fatal("checkpoint receipt exposed provider configuration")
	}
	for _, mutation := range []func(){
		func() { rows[0]["name"] = "foreign" },
		func() { rows[0]["status"] = "Frozen" },
		func() { rows[0]["config"] = map[string]string{"volatile.uuid": ""} },
		func() {
			rows[0]["config"] = map[string]string{"volatile.uuid": "fixture", "user.youeye.update_operation": "unfinished"}
		},
	} {
		original := rows[0]
		copy := map[string]any{}
		for k, v := range original {
			copy[k] = v
		}
		rows[0] = copy
		mutation()
		raw, _ := json.Marshal(rows)
		if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err == nil {
			t.Fatal("unsafe writer inventory admitted")
		}
		rows[0] = original
	}
	if err := atomicWrite(meta, []byte(`{"appId":"notes","containers":[{"containerName":"app-notes"}],"lifecycleOperation":{"state":"partial"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.installedOwners(); err == nil {
		t.Fatal("interrupted app power action admitted")
	}
}

func TestCoreCheckpointFilesRequireCompleteOwnedDatasetCoverage(t *testing.T) {
	root := t.TempDir()
	p := NativeCoreCheckpoint{DataRoot: root}
	for _, name := range []string{"control", "config", "ui", "ui-data", "pointer"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	files, err := p.checkpointFileInventory("pool/data\t"+root, "owned-snapshot")
	if err != nil || len(files) != 5 {
		t.Fatal(files, err)
	}
	for _, f := range files {
		if !f.Present || f.Dataset != "pool/data" || f.Snapshot != "owned-snapshot" {
			t.Fatal(f)
		}
	}
	if _, err := p.checkpointFileInventory("pool/unrelated\t/foreign", "owned-snapshot"); err == nil {
		t.Fatal("uncovered owner files admitted")
	}
	if _, err := p.checkpointFileInventory("pool/data\t"+root+"\npool/nested\t"+filepath.Join(root, "ui-data", "nested"), "owned-snapshot"); err == nil {
		t.Fatal("nested dataset silently omitted")
	}
	if err := os.Remove(filepath.Join(root, "ui-data")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/foreign", filepath.Join(root, "ui-data")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.checkpointFileInventory("pool/data\t"+root, "owned-snapshot"); err == nil {
		t.Fatal("foreign symlink checkpointed")
	}
}
