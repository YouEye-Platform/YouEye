package systemupdate

import (
	"encoding/json"
	"fmt"
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

// An uninstall that deleted an app's containers but could not finish leaves `cleanupPending`; the app's missing
// containers must not block a System update, while an ordinary installed app's missing container still does.
func TestCoreCheckpointAllowsMissingContainersOfCleanupPendingApps(t *testing.T) {
	root := t.TempDir()
	p := NativeCoreCheckpoint{DataRoot: root}
	write := func(app, extra string) {
		t.Helper()
		body := `{"appId":"` + app + `","containers":[{"containerName":"app-` + app + `"}],"lifecycleOperation":{"state":"completed"}` + extra + `}`
		if err := atomicWrite(filepath.Join(root, "app-"+app, "install.json"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("sonarr", `,"cleanupPending":true`)
	owned, _, err := p.installedOwners()
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole"} {
		rows = append(rows, map[string]any{"expanded_devices": map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}, "name": name, "status": "Running", "config": map[string]string{"volatile.uuid": "fixture-" + name}})
	}
	raw, _ := json.Marshal(rows)
	if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err != nil {
		t.Fatalf("cleanup-pending app without containers blocked the checkpoint: %v", err)
	}
	// Still owned: if the container is there after all, it is checked like any other.
	withSonarr := append(rows, map[string]any{"name": "app-sonarr", "status": "Running", "config": map[string]string{"volatile.uuid": "fixture-sonarr"}})
	raw, _ = json.Marshal(withSonarr)
	if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err != nil {
		t.Fatalf("cleanup-pending app container treated as foreign: %v", err)
	}
	write("sonarr", "")
	owned, _, err = p.installedOwners()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(rows)
	if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err == nil {
		t.Fatal("installed app with a missing container admitted")
	}
}

// A keep-data uninstall leaves stopped `ye-retained-*` root copies recorded in retained.json. They are owned
// (optional) app data, so a System update after an ordinary uninstall is not refused as foreign.
func TestCoreCheckpointOwnsRetainedAppRoots(t *testing.T) {
	root := t.TempDir()
	p := NativeCoreCheckpoint{DataRoot: root}
	retained := "ye-retained-" + strings.Repeat("a", 32) + "-0"
	writeRetained := func(body string) {
		t.Helper()
		if err := atomicWrite(filepath.Join(root, "app-sonarr", "retained.json"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	record := `{"appId":"sonarr","containers":[{"containerName":"app-sonarr"}],"retainedRoots":{"schemaVersion":1,"state":"ready","roots":[{"sourceName":"app-sonarr","retainedName":"` + retained + `","ownerId":"o","pool":"default"}]}}`
	writeRetained(record)
	owned, digest, err := p.installedOwners()
	if err != nil {
		t.Fatal(err)
	}
	if required, ok := owned[retained]; !ok || required {
		t.Fatalf("retained root not owned as optional: %v", owned)
	}
	if _, ok := owned["app-sonarr"]; ok {
		t.Fatal("uninstalled source container still required")
	}
	var rows []map[string]any
	for _, name := range []string{"youeye-control", "youeye-ui", "youeye-postgres", "youeye-caddy", "youeye-pihole"} {
		rows = append(rows, map[string]any{"expanded_devices": map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}}, "name": name, "status": "Running", "config": map[string]string{"volatile.uuid": "fixture-" + name}})
	}
	raw, _ := json.Marshal(rows)
	if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err != nil {
		t.Fatalf("absent retained root blocked the checkpoint: %v", err)
	}
	raw, _ = json.Marshal(append(rows, map[string]any{"name": retained, "status": "Stopped", "config": map[string]string{"volatile.uuid": "fixture-retained", "boot.autostart": "false"}}))
	containers, err := coreCheckpointContainers(raw, owned, "owned-snapshot")
	if err != nil {
		t.Fatalf("retained root treated as foreign: %v", err)
	}
	for _, c := range containers {
		if c.Name == retained && (c.Running || c.Snapshot != "" || c.Autostart == nil || *c.Autostart != "false") {
			t.Fatalf("retained root power intent not recorded as stopped: %+v", c)
		}
	}
	// An unrelated stopped instance is still foreign.
	raw, _ = json.Marshal(append(rows, map[string]any{"name": "ye-retained-" + strings.Repeat("b", 32) + "-0", "status": "Stopped", "config": map[string]string{"volatile.uuid": "fixture-other"}}))
	if _, err := coreCheckpointContainers(raw, owned, "owned-snapshot"); err == nil {
		t.Fatal("unrecorded retained-looking instance admitted")
	}
	// The record is part of the application inventory digest.
	writeRetained(strings.Replace(record, `"ready"`, `"adopted"`, 1))
	if _, changed, err := p.installedOwners(); err != nil || changed == digest {
		t.Fatal("retained record change not reflected in the inventory digest", err)
	}
	for _, invalid := range []string{
		strings.Replace(record, `"appId":"sonarr"`, `"appId":"radarr"`, 1),
		strings.Replace(record, retained, "youeye-control", 1),
		`{"appId":"sonarr"}`,
		`not json`,
	} {
		writeRetained(invalid)
		if _, _, err := p.installedOwners(); err == nil {
			t.Fatalf("invalid retained record admitted: %s", invalid)
		}
	}
	// A retained name that collides with another app's container is ambiguous.
	writeRetained(record)
	if err := atomicWrite(filepath.Join(root, "app-radarr", "install.json"), []byte(`{"appId":"radarr","containers":[{"containerName":"`+retained+`"}],"lifecycleOperation":{"state":"completed"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.installedOwners(); err == nil {
		t.Fatal("ambiguous retained ownership admitted")
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

func TestCoreCheckpointPreflightRefusalIsADefiniteFailure(t *testing.T) {
	observed := coreCheckpointPreflightFailure(fmt.Errorf("installed application container is missing"))
	if observed.State != "failed" || validateNativeResult(observed) != nil {
		t.Fatalf("preflight refusal must be a valid definite failure: %+v %v", observed, validateNativeResult(observed))
	}
	if !strings.Contains(observed.Evidence, "installed application container is missing") {
		t.Fatal(observed.Evidence)
	}
}
