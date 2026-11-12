package spineselect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

var testNow = time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)

// staged writes a fake Spine binary with the given content, stages it under
// root and returns its entry.
func staged(t *testing.T, root, content, version string) Entry {
	t.Helper()
	e, src := source(t, content, version)
	if err := Stage(root, src, e); err != nil {
		t.Fatal(err)
	}
	return e
}

// source writes a fake Spine binary outside root and returns its entry.
func source(t *testing.T, content, version string) (Entry, string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "youeye")
	if err := os.WriteFile(src, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(content))
	return Entry{SHA256: hex.EncodeToString(sum[:]), Version: version, HelperContract: HelperContract, DiskLayout: DiskLayout}, src
}

func slotOf(t *testing.T, root, name string) *Slot {
	t.Helper()
	s, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if s.Slots[name] == nil {
		return &Slot{}
	}
	return s.Slots[name]
}

func digestOf(e *Entry) string {
	if e == nil {
		return ""
	}
	return e.SHA256
}

func TestDiskLayoutMatchesAppliance(t *testing.T) {
	if DiskLayout != appliance.CurrentDiskLayout {
		t.Fatalf("spineselect.DiskLayout = %d, appliance.CurrentDiskLayout = %d", DiskLayout, appliance.CurrentDiskLayout)
	}
}

func TestMissingRecordRunsSeed(t *testing.T) {
	root := t.TempDir()
	if _, err := Load(root); !errors.Is(err, ErrNoSelection) {
		t.Fatalf("Load without record = %v, want ErrNoSelection", err)
	}
	res, err := Resolve(root, "A", ThisHost(), true, testNow)
	if err != nil || res.Role != "seed" || res.Path != "" {
		t.Fatalf("no record: %+v %v", res, err)
	}
}

func TestSlotsAreIndependent(t *testing.T) {
	root := t.TempDir()
	a := staged(t, root, "spine A", "1.0.0-dev.1")
	if err := Select(root, "A", a, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if res, err := Resolve(root, "A", ThisHost(), false, testNow); err != nil || res.Role != "current" || res.Path != PayloadPath(root, a.SHA256) {
		t.Fatalf("slot A: %+v %v", res, err)
	}
	if res, err := Resolve(root, "B", ThisHost(), false, testNow); err != nil || res.Role != "seed" || res.Path != "" {
		t.Fatalf("slot B without record must run its seed: %+v %v", res, err)
	}
	b := staged(t, root, "spine B", "1.0.0-dev.2")
	if err := BeginTrial(root, "B", b, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Commit(root, "B", b.SHA256, testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != a.SHA256 || got.Previous != nil || got.Trial != nil {
		t.Fatalf("slot B changes touched slot A: %+v", got)
	}
	if err := UseSeed(root, "B", testNow); err != nil {
		t.Fatal(err)
	}
	if res, _ := Resolve(root, "A", ThisHost(), false, testNow); res.Role != "current" {
		t.Fatalf("UseSeed on B changed A: %+v", res)
	}
	if res, _ := Resolve(root, "B", ThisHost(), false, testNow); res.Role != "seed" {
		t.Fatalf("UseSeed on B: %+v", res)
	}
	if err := Select(root, "C", a, ThisHost(), testNow); err == nil {
		t.Fatal("selected an unknown slot")
	}
	if err := BeginTrial(root, "", a, ThisHost(), testNow); err == nil {
		t.Fatal("began a trial on an unknown slot")
	}
}

func TestTrialStartsAreCountedAndAbandoned(t *testing.T) {
	root := t.TempDir()
	cur := staged(t, root, "current", "1.0.0-dev.1")
	if err := Select(root, "A", cur, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	trial := staged(t, root, "trial", "1.0.0-dev.2")
	if err := BeginTrial(root, "A", trial, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	// Read-only resolution does not count.
	if res, err := Resolve(root, "A", ThisHost(), false, testNow); err != nil || res.Role != "trial" {
		t.Fatalf("trial: %+v %v", res, err)
	}
	if got := slotOf(t, root, "A").Trial.TrialStarts; got != 0 {
		t.Fatalf("read-only resolve counted a start: %d", got)
	}
	for i := 1; i <= MaxTrialStarts; i++ {
		res, err := Resolve(root, "A", ThisHost(), true, testNow)
		if err != nil || res.Role != "trial" || res.Path != PayloadPath(root, trial.SHA256) {
			t.Fatalf("start %d: %+v %v", i, res, err)
		}
		if got := slotOf(t, root, "A").Trial.TrialStarts; got != i {
			t.Fatalf("start %d recorded %d", i, got)
		}
	}
	res, err := Resolve(root, "A", ThisHost(), true, testNow)
	if err != nil || res.Role != "current" || res.Path != PayloadPath(root, cur.SHA256) || len(res.Skipped) != 1 || !strings.Contains(res.Skipped[0], "abandoned") {
		t.Fatalf("trial not abandoned after %d starts: %+v %v", MaxTrialStarts, res, err)
	}
	if got := slotOf(t, root, "A"); got.Trial != nil || digestOf(got.Current) != cur.SHA256 {
		t.Fatalf("abandoned trial still recorded: %+v", got)
	}
}

func TestCommitAbortSelectRollbackUseSeed(t *testing.T) {
	root := t.TempDir()
	one := staged(t, root, "one", "1.0.0-dev.1")
	two := staged(t, root, "two", "1.0.0-dev.2")
	three := staged(t, root, "three", "1.0.0-dev.3")

	if err := Commit(root, "A", one.SHA256, testNow); err == nil {
		t.Fatal("committed without a record")
	}
	if err := Abort(root, "A", testNow); err != nil {
		t.Fatalf("abort without a record: %v", err)
	}
	if err := Select(root, "A", one, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != one.SHA256 || got.Previous != nil {
		t.Fatalf("select: %+v", got)
	}

	// Commit moves current to previous.
	if err := BeginTrial(root, "A", two, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Commit(root, "A", three.SHA256, testNow); err == nil {
		t.Fatal("committed a digest that is not the trial")
	}
	if err := Commit(root, "A", two.SHA256, testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != two.SHA256 || digestOf(got.Previous) != one.SHA256 || got.Trial != nil || got.Current.TrialStarts != 0 {
		t.Fatalf("commit: %+v", got)
	}

	// Abort keeps current and previous.
	if err := BeginTrial(root, "A", three, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Abort(root, "A", testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); got.Trial != nil || digestOf(got.Current) != two.SHA256 || digestOf(got.Previous) != one.SHA256 {
		t.Fatalf("abort: %+v", got)
	}

	// Select replaces current directly, clears a trial.
	if err := BeginTrial(root, "A", one, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Select(root, "A", three, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != three.SHA256 || digestOf(got.Previous) != two.SHA256 || got.Trial != nil {
		t.Fatalf("select over current: %+v", got)
	}
	// Selecting the current again keeps previous.
	if err := Select(root, "A", three, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Previous) != two.SHA256 {
		t.Fatalf("reselect lost previous: %+v", got)
	}

	// Rollback swaps current and previous.
	if err := Rollback(root, "A", testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != two.SHA256 || digestOf(got.Previous) != three.SHA256 {
		t.Fatalf("rollback: %+v", got)
	}
	if err := Rollback(root, "B", testNow); err == nil {
		t.Fatal("rolled back a slot without a previous Spine")
	}

	// UseSeed clears the slot.
	if err := UseSeed(root, "A", testNow); err != nil {
		t.Fatal(err)
	}
	if res, err := Resolve(root, "A", ThisHost(), false, testNow); err != nil || res.Role != "seed" {
		t.Fatalf("use-seed: %+v %v", res, err)
	}
	if err := Rollback(root, "A", testNow); err == nil {
		t.Fatal("rolled back a slot running its seed")
	}
}

func TestVerifyRefusesUnsafeOrIncompatiblePayloads(t *testing.T) {
	root := t.TempDir()
	e := staged(t, root, "verified", "1.0.0-dev.1")
	if path, err := Verify(root, e, ThisHost()); err != nil || path != PayloadPath(root, e.SHA256) {
		t.Fatalf("valid payload: %q %v", path, err)
	}
	for name, host := range map[string]Host{
		"disk layout":     {DiskLayout: DiskLayout + 1, HelperContract: HelperContract},
		"helper contract": {DiskLayout: DiskLayout, HelperContract: HelperContract + 1},
	} {
		if _, err := Verify(root, e, host); err == nil {
			t.Fatalf("accepted incompatible %s", name)
		}
	}
	wrongLayout := e
	wrongLayout.DiskLayout = DiskLayout + 1
	if _, err := Verify(root, wrongLayout, ThisHost()); err == nil {
		t.Fatal("accepted an entry for another disk layout")
	}
	wrongHelper := e
	wrongHelper.HelperContract = HelperContract + 1
	if _, err := Verify(root, wrongHelper, ThisHost()); err == nil {
		t.Fatal("accepted an entry for another helper contract")
	}
	if err := Select(root, "A", wrongHelper, ThisHost(), testNow); err == nil {
		t.Fatal("selected an incompatible entry")
	}

	path := PayloadPath(root, e.SHA256)
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(root, e, ThisHost()); err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("digest mismatch: %v", err)
	}

	g := staged(t, root, "group writable", "1.0.0-dev.2")
	if err := os.Chmod(PayloadPath(root, g.SHA256), 0o570); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(root, g, ThisHost()); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("group-writable payload: %v", err)
	}

	missing, _ := source(t, "never staged", "1.0.0-dev.3")
	if _, err := Verify(root, missing, ThisHost()); err == nil {
		t.Fatal("accepted a missing payload")
	}
	bad := e
	bad.SHA256 = "not-a-digest"
	if _, err := Verify(root, bad, ThisHost()); err == nil {
		t.Fatal("accepted an invalid digest")
	}
}

func TestStageRefusesDigestMismatch(t *testing.T) {
	root := t.TempDir()
	e, src := source(t, "real", "1.0.0-dev.1")
	e.SHA256 = strings.Repeat("a", 64)
	if err := Stage(root, src, e); err == nil {
		t.Fatal("staged a binary under another digest")
	}
	if _, err := os.Stat(PayloadPath(root, e.SHA256)); !os.IsNotExist(err) {
		t.Fatalf("mismatched payload left behind: %v", err)
	}
}

func TestResolveSkipsBrokenCurrentForPrevious(t *testing.T) {
	root := t.TempDir()
	one := staged(t, root, "one", "1.0.0-dev.1")
	two := staged(t, root, "two", "1.0.0-dev.2")
	for _, e := range []Entry{one, two} {
		if err := Select(root, "A", e, ThisHost(), testNow); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(PayloadPath(root, two.SHA256)); err != nil {
		t.Fatal(err)
	}
	res, err := Resolve(root, "A", ThisHost(), false, testNow)
	if err != nil || res.Role != "previous" || res.Path != PayloadPath(root, one.SHA256) || len(res.Skipped) != 1 {
		t.Fatalf("broken current: %+v %v", res, err)
	}
}

func TestRunning(t *testing.T) {
	root := t.TempDir()
	seed := strings.Repeat("5", 64)
	if err := Running(root, "A", seed, seed); err != nil {
		t.Fatalf("seed without a record: %v", err)
	}
	other := strings.Repeat("7", 64)
	if err := Running(root, "A", other, seed); err == nil {
		t.Fatal("accepted an unselected Spine without a record")
	}
	cur := staged(t, root, "current", "1.0.0-dev.1")
	prev := staged(t, root, "previous", "1.0.0-dev.0")
	trial := staged(t, root, "trial", "1.0.0-dev.2")
	if err := Select(root, "A", prev, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Select(root, "A", cur, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := BeginTrial(root, "A", trial, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{seed, cur.SHA256, prev.SHA256, trial.SHA256} {
		if err := Running(root, "A", d, seed); err != nil {
			t.Fatalf("refused %s: %v", d, err)
		}
	}
	if err := Running(root, "A", other, seed); err == nil {
		t.Fatal("accepted an unselected Spine")
	}
	if err := Running(root, "B", cur.SHA256, seed); err == nil {
		t.Fatal("accepted slot A's selection on slot B")
	}
}

func TestSeedOnly(t *testing.T) {
	for _, args := range [][]string{
		{"youeye"},
		{"youeye", "recovery", "status"},
		{"youeye", "version"},
		{"youeye", "--help"},
		{"youeye", "spine", "status"},
		{"youeye", "appliance", "prepare", "state"},
	} {
		if !SeedOnly(args) {
			t.Fatalf("%v must run in the seed", args)
		}
	}
	for _, args := range [][]string{
		{"youeye", "api", "serve"},
		{"youeye", "appliance", "health"},
		{"youeye", "appliance"},
		{"youeye", "boot", "first-deploy"},
	} {
		if SeedOnly(args) {
			t.Fatalf("%v must be delegated", args)
		}
	}
}

func TestDecide(t *testing.T) {
	root := t.TempDir()
	trial := staged(t, root, "trial", "1.0.0-dev.2")
	if err := BeginTrial(root, "A", trial, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	base := LaunchConfig{Args: []string{"youeye", "api", "serve"}, Executable: BakedPath, Appliance: true, Slot: "A", Root: root, Host: ThisHost(), Now: testNow}
	for name, mutate := range map[string]func(*LaunchConfig){
		"seed-only command":   func(c *LaunchConfig) { c.Args = []string{"youeye", "spine", "status"} },
		"prepare":             func(c *LaunchConfig) { c.Args = []string{"youeye", "appliance", "prepare"} },
		"not an appliance":    func(c *LaunchConfig) { c.Appliance = false },
		"already delegated":   func(c *LaunchConfig) { c.Delegated = true },
		"selected executable": func(c *LaunchConfig) { c.Executable = PayloadPath(root, trial.SHA256) },
		"development binary":  func(c *LaunchConfig) { c.Executable = "/tmp/youeye" },
		"unknown slot":        func(c *LaunchConfig) { c.Slot = "" },
	} {
		c := base
		mutate(&c)
		if path, _ := Decide(c); path != "" {
			t.Fatalf("%s delegated to %q", name, path)
		}
	}
	if got := slotOf(t, root, "A").Trial.TrialStarts; got != 0 {
		t.Fatalf("non-delegating decisions counted %d trial starts", got)
	}

	// A valid trial: other commands read it without counting.
	c := base
	c.Args = []string{"youeye", "appliance", "health"}
	if path, notes := Decide(c); path != PayloadPath(root, trial.SHA256) || len(notes) != 0 {
		t.Fatalf("trial for health: %q %v", path, notes)
	}
	if got := slotOf(t, root, "A").Trial.TrialStarts; got != 0 {
		t.Fatalf("non-serve command counted a trial start: %d", got)
	}
	// The API service start counts.
	c.Executable = BakedPath + "/"
	c.Args = base.Args
	if path, _ := Decide(c); path != PayloadPath(root, trial.SHA256) {
		t.Fatalf("trial for api serve: %q", path)
	}
	if got := slotOf(t, root, "A").Trial.TrialStarts; got != 1 {
		t.Fatalf("api serve recorded %d trial starts, want 1", got)
	}
	// Slot B has no record: it runs its seed.
	c.Slot = "B"
	if path, _ := Decide(c); path != "" {
		t.Fatalf("slot B delegated to %q", path)
	}
}

type fakeHooks struct {
	restarts, checks int
	restartErr       []error
	healthyAfter     int // healthy from this check on; 0 = never
}

func (f *fakeHooks) hooks(wait time.Duration) TrialHooks {
	return TrialHooks{
		Restart: func(context.Context) error {
			f.restarts++
			if len(f.restartErr) >= f.restarts {
				return f.restartErr[f.restarts-1]
			}
			return nil
		},
		Healthy: func(context.Context, Entry) error {
			f.checks++
			if f.healthyAfter > 0 && f.checks >= f.healthyAfter {
				return nil
			}
			return errors.New("not healthy yet")
		},
		Wait: wait,
	}
}

func TestApplyTrialCommitsWhenHealthy(t *testing.T) {
	root := t.TempDir()
	cur := staged(t, root, "current", "1.0.0-dev.1")
	if err := Select(root, "A", cur, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	next, src := source(t, "next", "1.0.0-dev.2")
	f := &fakeHooks{healthyAfter: 1}
	if err := ApplyTrial(context.Background(), root, "A", src, next, f.hooks(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if f.restarts != 1 || f.checks != 1 {
		t.Fatalf("restarts=%d checks=%d", f.restarts, f.checks)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != next.SHA256 || digestOf(got.Previous) != cur.SHA256 || got.Trial != nil {
		t.Fatalf("healthy trial not committed: %+v", got)
	}
}

func TestApplyTrialAbortsWhenNeverHealthy(t *testing.T) {
	root := t.TempDir()
	cur := staged(t, root, "current", "1.0.0-dev.1")
	if err := Select(root, "A", cur, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	next, src := source(t, "next", "1.0.0-dev.2")
	f := &fakeHooks{}
	err := ApplyTrial(context.Background(), root, "A", src, next, f.hooks(time.Nanosecond))
	if err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("unhealthy trial: %v", err)
	}
	if f.restarts != 2 {
		t.Fatalf("restarts = %d, want 2 (trial, then previous)", f.restarts)
	}
	if got := slotOf(t, root, "A"); got.Trial != nil || digestOf(got.Current) != cur.SHA256 || got.Previous != nil {
		t.Fatalf("unhealthy trial not aborted: %+v", got)
	}
}

func TestApplyTrialRestartError(t *testing.T) {
	root := t.TempDir()
	next, src := source(t, "next", "1.0.0-dev.2")
	f := &fakeHooks{restartErr: []error{errors.New("systemctl failed")}, healthyAfter: 1}
	err := ApplyTrial(context.Background(), root, "A", src, next, f.hooks(time.Minute))
	if err == nil || !strings.Contains(err.Error(), "systemctl failed") {
		t.Fatalf("restart error: %v", err)
	}
	if f.restarts != 2 || f.checks != 0 {
		t.Fatalf("restarts=%d checks=%d, want 2 and 0", f.restarts, f.checks)
	}
	if res, _ := Resolve(root, "A", ThisHost(), false, testNow); res.Role != "seed" {
		t.Fatalf("failed trial still selected: %+v", res)
	}
	// Both restarts failing is reported too.
	f = &fakeHooks{restartErr: []error{errors.New("first"), errors.New("second")}}
	if err := ApplyTrial(context.Background(), root, "A", src, next, f.hooks(time.Minute)); err == nil || !strings.Contains(err.Error(), "restarting the previous Spine failed") {
		t.Fatalf("double restart failure: %v", err)
	}
}

func TestApplyTrialRefusesIncompatibleEntry(t *testing.T) {
	root := t.TempDir()
	next, src := source(t, "next", "1.0.0-dev.2")
	next.HelperContract++
	f := &fakeHooks{healthyAfter: 1}
	if err := ApplyTrial(context.Background(), root, "A", src, next, f.hooks(time.Minute)); err == nil {
		t.Fatal("applied an incompatible Spine")
	}
	if f.restarts != 0 {
		t.Fatal("restarted for an incompatible Spine")
	}
}
