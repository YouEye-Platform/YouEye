package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordingApplianceCleanupOps struct {
	commands   []string
	kept       *bool
	stateReset bool
}

func (o *recordingApplianceCleanupOps) Containers() []containerInfo {
	return []containerInfo{{name: "app", running: true}}
}
func (o *recordingApplianceCleanupOps) Images() []string       { return []string{"image-fingerprint"} }
func (o *recordingApplianceCleanupOps) Networks() []string     { return []string{"eth0", "incusbr0"} }
func (o *recordingApplianceCleanupOps) StoragePools() []string { return []string{"default"} }
func (o *recordingApplianceCleanupOps) Run(name string, args ...string) error {
	o.commands = append(o.commands, name+" "+strings.Join(args, " "))
	return nil
}
func (o *recordingApplianceCleanupOps) ResetData(keep bool) error { o.kept = &keep; return nil }
func (o *recordingApplianceCleanupOps) ResetState() error         { o.stateReset = true; return nil }

func TestApplianceCleanupNeverTargetsImagePackagesUnitsPoolOrParentDisk(t *testing.T) {
	ops := &recordingApplianceCleanupOps{}
	if err := runApplianceCleanupWithOps(ops, true); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(ops.commands, "\n")
	for _, forbidden := range []string{"apt", "dpkg", "wipefs", "labelclear", "zpool destroy", "systemctl", "/dev/"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("forbidden appliance cleanup command %q in:\n%s", forbidden, joined)
		}
	}
	if ops.kept == nil || !*ops.kept || !ops.stateReset {
		t.Fatalf("keep/reset contract not applied: %+v", ops)
	}
	if strings.Contains(joined, "eth0") {
		if !strings.Contains(joined, "profile device remove default eth0") {
			t.Fatalf("only the default profile reference may target eth0: %s", joined)
		}
	}
	if strings.Contains(joined, "network delete incusbr0 --force") || strings.Contains(joined, "storage delete default --force") {
		t.Fatalf("cleanup used unsupported Incus delete flags: %s", joined)
	}
	if !strings.Contains(joined, "image delete image-fingerprint") {
		t.Fatalf("cleanup did not remove stale Incus image metadata: %s", joined)
	}
	if strings.Index(joined, "image delete image-fingerprint") > strings.Index(joined, "storage delete default") {
		t.Fatalf("image records must be removed before their backing pool: %s", joined)
	}
	if strings.Index(joined, "profile device remove default eth0") > strings.Index(joined, "network delete incusbr0") {
		t.Fatalf("default profile NIC reference must be removed before the network: %s", joined)
	}
}

func TestApplianceCleanupResetDataFlag(t *testing.T) {
	ops := &recordingApplianceCleanupOps{}
	if err := runApplianceCleanupWithOps(ops, false); err != nil {
		t.Fatal(err)
	}
	if ops.kept == nil || *ops.kept {
		t.Fatalf("expected reset-data path")
	}
}

func TestSeedFactoryApplianceConfigRestoresOnlySealedPublicBootstrap(t *testing.T) {
	root := t.TempDir()
	seeds := filepath.Join(root, "seeds")
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(seeds, 0o755); err != nil {
		t.Fatal(err)
	}
	fixtures := map[string]string{
		"config.yaml": "releases:\n  repo_url: https://forge.example/YouEye\n",
		"youeye.yaml": "release_branch: dev\nrelease_channels:\n  fallback: []\n",
	}
	for name, contents := range fixtures {
		if err := os.WriteFile(filepath.Join(seeds, name), []byte(contents), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	if err := seedFactoryApplianceConfig(seeds, data); err != nil {
		t.Fatal(err)
	}
	for name, contents := range fixtures {
		path := filepath.Join(data, "config", name)
		got, err := os.ReadFile(path)
		if err != nil || string(got) != contents {
			t.Fatalf("seed %s = %q, err=%v", name, got, err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat seed %s: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("seed %s mode = %v", name, info.Mode().Perm())
		}
	}
}

func TestSeedFactoryApplianceConfigRejectsNonRegularSeed(t *testing.T) {
	root := t.TempDir()
	seeds := filepath.Join(root, "seeds")
	if err := os.MkdirAll(seeds, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", filepath.Join(seeds, "config.yaml")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(seeds, "youeye.yaml"), []byte("release_branch: dev\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := seedFactoryApplianceConfig(seeds, filepath.Join(root, "data")); err == nil {
		t.Fatal("non-regular sealed config seed was accepted")
	}
}
