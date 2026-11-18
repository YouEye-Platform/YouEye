package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestARCCeiling(t *testing.T) {
	for _, c := range []struct{ ram, want uint64 }{
		{2 << 30, 512 << 20},      // floor
		{8 << 30, (8 << 30) / 10}, // 10 %
		{64 << 30, (64 << 30) / 10},
		{256 << 30, 16 << 30}, // ceiling
	} {
		if got := arcCeiling(c.ram); got != c.want {
			t.Fatalf("arcCeiling(%d) = %d, want %d", c.ram, got, c.want)
		}
	}
}

func TestApplyARCCeilingWritesOnlyWhenDifferent(t *testing.T) {
	dir := t.TempDir()
	parameter, meminfo := filepath.Join(dir, "zfs_arc_max"), filepath.Join(dir, "meminfo")
	if err := os.WriteFile(meminfo, []byte("MemTotal:        8118272 kB\nMemFree: 1 kB\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := applyARCCeiling(parameter, meminfo); err != nil {
		t.Fatal("absent ZFS parameter must be a no-op:", err)
	}
	if err := os.WriteFile(parameter, []byte("0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := applyARCCeiling(parameter, meminfo); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(parameter)
	if string(got) != "831311052\n" {
		t.Fatalf("zfs_arc_max = %q", got)
	}
	// An administrator's own ceiling is kept.
	if err := os.WriteFile(parameter, []byte("2147483648\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := applyARCCeiling(parameter, meminfo); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(parameter); string(got) != "2147483648\n" {
		t.Fatalf("administrator ceiling overwritten: %q", got)
	}
}

func TestSweepExecOutputRemovesOnlyOldExecFiles(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, "youeye-postgres", "exec-output")
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	old, fresh, other := filepath.Join(out, "exec_a.stdout"), filepath.Join(out, "exec_b.stderr"), filepath.Join(out, "keep.txt")
	for _, f := range []string{old, fresh, other} {
		if err := os.WriteFile(f, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-48 * time.Hour)
	for _, f := range []string{old, other} {
		if err := os.Chtimes(f, past, past); err != nil {
			t.Fatal(err)
		}
	}
	// A stopped container: no exec-output directory reachable.
	if err := os.MkdirAll(filepath.Join(root, "app-stopped"), 0700); err != nil {
		t.Fatal(err)
	}
	removed, err := sweepExecOutput(root, time.Now().Add(-execOutputMaxAge))
	if err != nil || removed != 1 {
		t.Fatal(removed, err)
	}
	for f, want := range map[string]bool{old: false, fresh: true, other: true} {
		if _, err := os.Stat(f); (err == nil) != want {
			t.Fatalf("%s present=%v", f, err == nil)
		}
	}
	if n, err := sweepExecOutput(filepath.Join(root, "missing"), time.Now()); n != 0 || err != nil {
		t.Fatal(n, err)
	}
}

func TestDisableIncusImageRefresh(t *testing.T) {
	var calls []string
	value, failures := "", 2
	config := func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if failures > 0 {
			failures--
			return "", errors.New("incus is not ready")
		}
		if args[0] == "set" {
			value = args[2]
			return "", nil
		}
		return value + "\n", nil
	}
	if err := disableIncusImageRefresh(config, 5, 0); err != nil || value != "0" {
		t.Fatalf("unset key after two failed attempts: value=%q err=%v calls=%v", value, err, calls)
	}
	calls = nil
	if err := disableIncusImageRefresh(config, 5, 0); err != nil || len(calls) != 1 {
		t.Fatalf("an already disabled refresh must only be read: err=%v calls=%v", err, calls)
	}
	failures = 99
	if err := disableIncusImageRefresh(config, 3, 0); err == nil {
		t.Fatal("an Incus that never answers must be reported")
	}
}

// Off an installed appliance (a development machine, the build server) the sweep of old service trees has no
// runtime to act on and does nothing.
func TestStageTreeSweepNeedsAnInstalledAppliance(t *testing.T) {
	if _, err := installedCoreRuntime(); err == nil {
		t.Skip("this machine is an installed appliance")
	}
	if removed := removeFinishedCoreStageTrees(); len(removed) != 0 {
		t.Fatalf("sweep acted without an installed appliance: %v", removed)
	}
}
