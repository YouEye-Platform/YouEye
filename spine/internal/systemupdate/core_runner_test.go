package systemupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type coreRunnerFixture struct {
	runner     CoreSystemdRunner
	journal    CoreJournal
	step       CoreStep
	properties map[string]string
	starts     int
	boot       string
	launch     func() error
}

func newCoreRunnerFixture(t *testing.T, action ...string) *coreRunnerFixture {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	j.Phase = "applying"
	index := 0
	if len(action) > 0 {
		selected := action[0]
		if strings.HasPrefix(selected, "recovery-") {
			selected = "checkpoint"
		}
		for i := range j.Steps {
			if j.Steps[i].Name == selected {
				index = i
				break
			}
			j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture previous action"
		}
	}
	j.Steps[index].State = "started"
	step := j.Steps[index]
	if len(action) > 0 && strings.HasPrefix(action[0], "recovery-") {
		j.Phase = "recovering"
		found := false
		for _, name := range coreRecoveryNames(j) {
			next := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
			if name == action[0] {
				next.State, found = "started", true
				step = next
			} else if !found {
				next.State, next.Evidence = "succeeded", "fixture previous recovery action"
			}
			j.RecoverySteps = append(j.RecoverySteps, next)
		}
	}
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	f := &coreRunnerFixture{journal: j, step: step, boot: "11111111-1111-1111-1111-111111111111"}
	f.runner = CoreSystemdRunner{Root: m.Root, Executable: "/usr/local/bin/youeye", BootID: func() (string, error) { return f.boot, nil }}
	unit := f.runner.unit(j, f.step)
	f.properties = map[string]string{"Id": unit, "LoadState": "not-found"}
	f.runner.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && len(args) == 3 && args[0] == "show" && args[2] == unit {
			var raw strings.Builder
			for k, v := range f.properties {
				fmt.Fprintf(&raw, "%s=%s\n", k, v)
			}
			return []byte(raw.String()), nil
		}
		if program == "systemd-run" {
			f.starts++
			command := strings.Join(args, " ")
			for _, expected := range []string{"--unit=" + unit, "--service-type=exec", "--remain-after-exit", "--property=KillMode=control-group", "--property=Restart=no", "--manifest-sha256 " + j.ManifestSHA256, "--request " + j.RequestID, "--action " + f.step.Name} {
				if !strings.Contains(command, expected) {
					t.Fatal("runner lost scope", expected)
				}
			}
			if strings.Contains(command, "--collect") || strings.Contains(command, "--wait") {
				t.Fatal("runner must retain detached service")
			}
			f.properties = map[string]string{"Id": unit, "LoadState": "loaded", "ActiveState": "active", "SubState": "running", "Description": coreRunnerDescription(unit), "Transient": "yes", "KillMode": "control-group", "RemainAfterExit": "yes", "Type": "exec", "User": "root", "WorkingDirectory": "", "RootDirectory": "", "RootImage": "", "Restart": "no", "MainPID": strconv.Itoa(os.Getpid()), "InvocationID": strings.Repeat("a", 32)}
			if f.launch != nil {
				return nil, f.launch()
			}
			return nil, nil
		}
		return nil, fmt.Errorf("unexpected runner command")
	}
	t.Setenv("INVOCATION_ID", strings.Repeat("a", 32))
	return f
}

func TestCoreRunnerLostLaunchAcknowledgementDoesNotRelaunch(t *testing.T) {
	f := newCoreRunnerFixture(t)
	f.launch = func() error { return fmt.Errorf("lost systemd acknowledgement") }
	got, err := f.runner.Start(context.Background(), f.journal, f.step)
	if err != nil || got.State != "unknown" || f.starts != 1 {
		t.Fatal(got, err, f.starts)
	}
	got, err = f.runner.Start(context.Background(), f.journal, f.step)
	if err != nil || got.State != "running" || f.starts != 1 {
		t.Fatal(got, err, f.starts)
	}
	if err = f.runner.AuthorizeLiveFence(context.Background(), f.journal, f.step); err != nil {
		t.Fatal("exact owned runner not recoverable", err)
	}
	f.properties["Description"] = "foreign action"
	if err = f.runner.AuthorizeLiveFence(context.Background(), f.journal, f.step); err == nil {
		t.Fatal("foreign runner admitted for termination")
	}
	f.properties["Description"] = coreRunnerDescription(f.runner.unit(f.journal, f.step))
	f.properties["MainPID"] = "0"
	f.properties["SubState"] = "exited"
	f.properties["Result"] = "success"
	got, err = f.runner.Observe(context.Background(), f.journal, f.step)
	if err != nil || got.State != "unknown" {
		t.Fatal("unit exit is not effect acceptance", got, err)
	}
	f.properties["LoadState"] = "not-found"
	got, err = f.runner.Start(context.Background(), f.journal, f.step)
	if err != nil || got.State != "unknown" || f.starts != 1 {
		t.Fatal("missing unit caused replay", got, err, f.starts)
	}
}

func TestCoreRunnerRootDirectoryObservation(t *testing.T) {
	for _, field := range []string{"WorkingDirectory", "RootDirectory", "RootImage"} {
		for _, value := range []string{"missing", "/foreign"} {
			t.Run(field+"/"+value, func(t *testing.T) {
				f := newCoreRunnerFixture(t)
				if _, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil {
					t.Fatal(err)
				}
				if value == "missing" {
					delete(f.properties, field)
				} else {
					f.properties[field] = value
				}
				if _, err := f.runner.Observe(context.Background(), f.journal, f.step); err == nil {
					t.Fatal("accepted missing or foreign root evidence")
				}
				if f.starts != 1 {
					t.Fatal("observation replayed launch")
				}
			})
		}
	}
	f := newCoreRunnerFixture(t)
	if got, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil || got.State != "running" {
		t.Fatal("normalized root rejected", got, err)
	}
	f.properties["WorkingDirectory"] = "/"
	if got, err := f.runner.Observe(context.Background(), f.journal, f.step); err != nil || got.State != "running" {
		t.Fatal("explicit root rejected", got, err)
	}
}

func TestCoreRunnerFastChildCompletionSurvivesLostLauncherAndReboot(t *testing.T) {
	f := newCoreRunnerFixture(t)
	effects := 0
	authorize := func(context.Context, CoreJournal, CoreStep) error { return nil }
	execute := func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		effects++
		return CoreActionObservation{State: "succeeded", Evidence: "exact fixture effect readback"}, nil
	}
	f.launch = func() error {
		got, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute)
		if err != nil || got.State != "succeeded" {
			t.Fatal(got, err)
		}
		return fmt.Errorf("lost acknowledgement after completed child")
	}
	_, _ = f.runner.Start(context.Background(), f.journal, f.step)
	got, err := f.runner.Observe(context.Background(), f.journal, f.step)
	if err != nil || got.State != "succeeded" || effects != 1 {
		t.Fatal(got, err, effects)
	}
	if _, err = f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute); err != nil || effects != 1 {
		t.Fatal("child replayed", err, effects)
	}
	f.boot = "22222222-2222-2222-2222-222222222222"
	f.properties["LoadState"] = "not-found"
	got, err = f.runner.Observe(context.Background(), f.journal, f.step)
	if err != nil || got.State != "succeeded" {
		t.Fatal("lost durable child result after reboot", got, err)
	}
}

func TestCoreRunnerRejectsUnownedUnitInvocationAndPendingGraph(t *testing.T) {
	f := newCoreRunnerFixture(t)
	f.properties["LoadState"] = "loaded"
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err == nil || f.starts != 0 {
		t.Fatal("adopted foreign unit")
	}
	f.properties["LoadState"] = "not-found"
	f.journal.Steps[0].State = "pending"
	if err := (CoreManager{Root: f.runner.Root}).saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err == nil || f.starts != 0 {
		t.Fatal("launched before coordinator intent")
	}
	f.journal.Steps[0].State = "started"
	if err := (CoreManager{Root: f.runner.Root}).saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	f.properties["InvocationID"] = strings.Repeat("b", 32)
	if _, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, func(context.Context, CoreJournal, CoreStep) error { return nil }, func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		t.Fatal("foreign child executed")
		return CoreActionObservation{}, nil
	}); err == nil {
		t.Fatal("foreign invocation accepted")
	}
}

func TestCoreRunnerUnknownChildNeverReexecutes(t *testing.T) {
	f := newCoreRunnerFixture(t)
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	effects := 0
	authorize := func(context.Context, CoreJournal, CoreStep) error { return nil }
	execute := func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error) {
		effects++
		return CoreActionObservation{}, fmt.Errorf("lost effect acknowledgement")
	}
	if _, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute); err == nil || effects != 1 {
		t.Fatal(err, effects)
	}
	if _, err := f.runner.RunAction(context.Background(), f.journal.RequestID, f.step.Name, f.journal.ManifestSHA256, authorize, execute); err == nil || effects != 1 {
		t.Fatal("uncertain child replayed", err, effects)
	}
}

func TestCoreRunnerFenceSettlesOnlyOwnedUnitsAndAllDescendants(t *testing.T) {
	f := newCoreRunnerFixture(t)
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	f.runner.CgroupRoot = t.TempDir()
	groupFile := filepath.Join(f.runner.CgroupRoot, "system.slice", f.runner.unit(f.journal, f.step), "cgroup.events")
	if err := atomicWrite(groupFile, []byte("populated 1\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.SettleApplyChildren(context.Background(), f.journal.RequestID); err == nil {
		t.Fatal("settled outside recovery fence")
	}
	f.journal.Phase = "recovering"
	for _, name := range coreRecoveryNames(f.journal) {
		state := "pending"
		if name == "recovery-fence" {
			state = "started"
		}
		f.journal.RecoverySteps = append(f.journal.RecoverySteps, CoreStep{Name: name, RequestID: f.journal.RequestID + "/" + name, State: state})
	}
	if err := (CoreManager{Root: f.runner.Root}).saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	native := f.runner.Capture
	stops := 0
	f.runner.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && args[0] == "stop" {
			if len(args) != 2 || args[1] != f.runner.unit(f.journal, f.step) {
				t.Fatal("stopped unowned unit")
			}
			stops++
			f.properties["ActiveState"] = "inactive"
			f.properties["MainPID"] = "0"
			return nil, fmt.Errorf("lost stop acknowledgement")
		}
		return native(ctx, program, args...)
	}
	// A service can exit while grandchildren remain. The cgroup is authoritative.
	if _, err := f.runner.SettleApplyChildren(context.Background(), f.journal.RequestID); err == nil || stops != 1 {
		t.Fatal("accepted live descendants", err, stops)
	}
	if err := atomicWrite(groupFile, []byte("populated 0\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	evidence, err := f.runner.SettleApplyChildren(context.Background(), f.journal.RequestID)
	if err != nil || !strings.Contains(evidence, "owned-native-children-only") || stops != 1 {
		t.Fatal(evidence, err, stops)
	}
	// A held executor lease prevents racing a still-running launch/callback.
	unlock, err := (NativeCoreExecutor{Root: f.runner.Root}).lockAction(f.step)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.runner.SettleApplyChildren(context.Background(), f.journal.RequestID); err == nil {
		t.Fatal("fence raced executor lease")
	}
	unlock()
	f.properties["Description"] = "foreign maintenance"
	if _, err = f.runner.SettleApplyChildren(context.Background(), f.journal.RequestID); err == nil || stops != 1 {
		t.Fatal("fence stopped foreign unit", err, stops)
	}
}

func TestCorePreparationCancellationSettlesOnlyOwnedChildren(t *testing.T) {
	f := newCoreRunnerFixture(t)
	if _, err := f.runner.Start(context.Background(), f.journal, f.step); err != nil {
		t.Fatal(err)
	}
	f.runner.CgroupRoot = t.TempDir()
	groupFile := filepath.Join(f.runner.CgroupRoot, "system.slice", f.runner.unit(f.journal, f.step), "cgroup.events")
	if err := atomicWrite(groupFile, []byte("populated 1\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.runner.SettlePreparationChildren(context.Background(), f.journal.RequestID); err == nil {
		t.Fatal("settled outside recovery fence")
	}
	f.journal.Phase = "cancelling"
	f.journal.ActivationRequested = true
	if err := (CoreManager{Root: f.runner.Root}).saveCore(&f.journal); err != nil {
		t.Fatal(err)
	}
	native := f.runner.Capture
	stops := 0
	f.runner.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "systemctl" && args[0] == "stop" {
			if len(args) != 2 || args[1] != f.runner.unit(f.journal, f.step) {
				t.Fatal("stopped unowned unit")
			}
			stops++
			f.properties["ActiveState"] = "inactive"
			f.properties["MainPID"] = "0"
			return nil, fmt.Errorf("lost stop acknowledgement")
		}
		return native(ctx, program, args...)
	}
	// A service can exit while grandchildren remain. The cgroup is authoritative.
	if err := f.runner.SettlePreparationChildren(context.Background(), f.journal.RequestID); err == nil || stops != 1 {
		t.Fatal("accepted live descendants", err, stops)
	}
	if err := atomicWrite(groupFile, []byte("populated 0\nfrozen 0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	err := f.runner.SettlePreparationChildren(context.Background(), f.journal.RequestID)
	if err != nil || stops != 1 {
		t.Fatal(err, stops)
	}
	// A held executor lease prevents racing a still-running launch/callback.
	unlock, err := (NativeCoreExecutor{Root: f.runner.Root}).lockAction(f.step)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.runner.SettlePreparationChildren(context.Background(), f.journal.RequestID); err == nil {
		t.Fatal("fence raced executor lease")
	}
	unlock()
	f.properties["Description"] = "foreign maintenance"
	if err = f.runner.SettlePreparationChildren(context.Background(), f.journal.RequestID); err == nil || stops != 1 {
		t.Fatal("fence stopped foreign unit", err, stops)
	}
}
