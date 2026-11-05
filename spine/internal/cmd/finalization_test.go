package cmd

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fakeFinalizationOps struct {
	bridgeCalls  int
	cliCalls     int
	serviceCalls int
	persistCalls int
	verifyCalls  int
	failOnceAt   string
}

func (f *fakeFinalizationOps) maybeFail(step string) error {
	if f.failOnceAt == step {
		f.failOnceAt = ""
		return errors.New("simulated interruption")
	}
	return nil
}

func (f *fakeFinalizationOps) ProvisionBridgeToken() error {
	f.bridgeCalls++
	return f.maybeFail("bridge")
}

func (f *fakeFinalizationOps) ProvisionCLIToken() error {
	f.cliCalls++
	return f.maybeFail("cli")
}

func (f *fakeFinalizationOps) EnableService() error {
	f.serviceCalls++
	return f.maybeFail("service")
}

func (f *fakeFinalizationOps) PersistHostIP(string) error {
	f.persistCalls++
	return f.maybeFail("host-ip")
}

func (f *fakeFinalizationOps) Verify(string) error {
	f.verifyCalls++
	return f.maybeFail("verify")
}

func TestDeploymentFinalizationResumesAfterInterruptedStep(t *testing.T) {
	ops := &fakeFinalizationOps{failOnceAt: "cli"}
	if err := runDeploymentFinalization(ops, "192.0.2.30"); err == nil || !strings.Contains(err.Error(), "CLI token") {
		t.Fatalf("first run error = %v, want CLI token interruption", err)
	}
	if err := runDeploymentFinalization(ops, "192.0.2.30"); err != nil {
		t.Fatalf("resumed finalization failed: %v", err)
	}
	if ops.bridgeCalls != 2 || ops.cliCalls != 2 {
		t.Fatalf("resume did not safely repeat idempotent earlier steps: bridge=%d cli=%d", ops.bridgeCalls, ops.cliCalls)
	}
	if ops.serviceCalls != 1 || ops.persistCalls != 1 || ops.verifyCalls != 1 {
		t.Fatalf("remaining invariants were not completed: service=%d persist=%d verify=%d",
			ops.serviceCalls, ops.persistCalls, ops.verifyCalls)
	}
}

func TestDeploymentFinalizationIsSafeToRunTwice(t *testing.T) {
	ops := &fakeFinalizationOps{}
	for run := 0; run < 2; run++ {
		if err := runDeploymentFinalization(ops, "192.0.2.31"); err != nil {
			t.Fatalf("finalization run %d failed: %v", run+1, err)
		}
	}
	if ops.bridgeCalls != 2 || ops.cliCalls != 2 || ops.serviceCalls != 2 || ops.persistCalls != 2 || ops.verifyCalls != 2 {
		t.Fatalf("duplicate finalization skipped or duplicated an unexpected subset: %+v", ops)
	}
}

func TestDeploymentFinalizationFailsAtEveryRequiredInvariant(t *testing.T) {
	for _, step := range []string{"bridge", "cli", "service", "host-ip", "verify"} {
		t.Run(step, func(t *testing.T) {
			ops := &fakeFinalizationOps{failOnceAt: step}
			if err := runDeploymentFinalization(ops, "192.0.2.32"); err == nil {
				t.Fatalf("required %s invariant was swallowed", step)
			}
		})
	}
}

func TestReapDetachedProcessRemovesExitedChild(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	done := reapDetachedProcess(cmd)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("wait for child: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("detached child was not reaped")
	}
	if _, err := os.Stat("/proc/" + strconv.Itoa(pid)); !os.IsNotExist(err) {
		t.Fatalf("reaped child still has a proc entry: %v", err)
	}
}

func TestProcessStateRecognizesZombie(t *testing.T) {
	for _, tc := range []struct {
		status string
		want   string
	}{
		{"Name:\tyoueye\nState:\tS (sleeping)\n", "S"},
		{"Name:\tyoueye\nState:\tZ (zombie)\n", "Z"},
		{"Name:\tyoueye\n", ""},
	} {
		if got := processState([]byte(tc.status)); got != tc.want {
			t.Errorf("processState(%q) = %q, want %q", tc.status, got, tc.want)
		}
	}
}

func TestYouEyeAPIServerCommandLineIdentity(t *testing.T) {
	for _, tc := range []struct {
		name        string
		commandLine string
		want        bool
	}{
		{"youeye", "/usr/local/bin/youeye\x00api\x00serve\x00", true},
		{"legacy spine", "/usr/local/bin/spine\x00api\x00serve\x00", true},
		{"wrong subcommand", "/usr/local/bin/youeye\x00deploy\x00", false},
		{"unrelated process", "/usr/bin/sleep\x0030\x00", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isYouEyeAPIServerCommandLine([]byte(tc.commandLine)); got != tc.want {
				t.Fatalf("identity = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestShouldStopDetachedAPIProtectsSystemdManagedProcess(t *testing.T) {
	if shouldStopDetachedAPI(4242, 4242) {
		t.Fatal("systemd-managed API process was classified as detached")
	}
	if !shouldStopDetachedAPI(4242, 4343) {
		t.Fatal("independent API process was not classified as detached")
	}
	if !shouldStopDetachedAPI(4242, 0) {
		t.Fatal("API process was protected without a managed service PID")
	}
}
