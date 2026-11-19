package spineselect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// selectThenCommit leaves the slot as an image update followed by a Spine
// update does: first is what the image update selected, then current ran as a
// trial and was committed, so first is the slot's previous Spine.
func selectThenCommit(t *testing.T, root, slot string, first, current Entry) {
	t.Helper()
	if err := Select(root, slot, first, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := BeginTrial(root, slot, current, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Commit(root, slot, current.SHA256, testNow); err != nil {
		t.Fatal(err)
	}
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

	// Rollback swaps current and previous.
	if err := Rollback(root, "A", testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != one.SHA256 || digestOf(got.Previous) != two.SHA256 {
		t.Fatalf("rollback: %+v", got)
	}

	// Select (an image update wrote the slot) leaves the slot with its
	// release's Spine alone: no trial, and no previous of the image before.
	if err := BeginTrial(root, "A", two, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Select(root, "A", three, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != three.SHA256 || got.Previous != nil || got.Trial != nil {
		t.Fatalf("select over current: %+v", got)
	}
	if err := Rollback(root, "A", testNow); err == nil || !strings.Contains(err.Error(), "no previous Spine") {
		t.Fatalf("rolled back to a Spine of the image before: %v", err)
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
	selectThenCommit(t, root, "A", one, two)
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
	selectThenCommit(t, root, "A", prev, cur)
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

// Another slot's Spine may have written fields or entries this one doesn't
// know: one bad entry is skipped, and a rewrite keeps the unknown fields.
func TestSelectionToleratesNewerContent(t *testing.T) {
	root := t.TempDir()
	sha := strings.Repeat("a", 64)
	raw := `{"schema":"youeye.spine-selection.v1","updated_at":"2026-11-14T00:00:00Z","future":{"x":1},"slots":{
	 "A":{"current":{"sha256":"` + sha + `","version":"0.6.5-dev.1","helper_contract":1,"disk_layout":1,"pinned":true},"trial":{"sha256":"bad"}},
	 "C":{"current":{"sha256":"` + sha + `"}}}}`
	if err := os.WriteFile(filepath.Join(root, selectionFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if s.Slots["A"] == nil || s.Slots["A"].Current == nil || s.Slots["A"].Trial != nil || s.Slots["C"] != nil {
		t.Fatalf("bad entries not skipped: %+v", s.Slots)
	}
	if err := Save(root, s, time.Now()); err != nil {
		t.Fatal(err)
	}
	kept, _ := os.ReadFile(filepath.Join(root, selectionFile))
	if !strings.Contains(string(kept), `"future"`) || !strings.Contains(string(kept), `"pinned": true`) {
		t.Fatalf("rewrite lost newer fields: %s", kept)
	}
	// What this Spine couldn't read stays for the Spine that wrote it.
	if !strings.Contains(string(kept), `"sha256": "bad"`) || !strings.Contains(string(kept), `"C"`) {
		t.Fatalf("rewrite erased entries it could not read: %s", kept)
	}
}

// An image update may bring a Spine with another helper contract: selecting it
// for the written slot must not be judged by the running Spine's contract.
func TestSelectForTargetSlotIgnoresRunningHelperContract(t *testing.T) {
	root := t.TempDir()
	e := Entry{SHA256: strings.Repeat("c", 64), Version: "0.6.6-dev.1", HelperContract: HelperContract + 1, DiskLayout: DiskLayout}
	src := filepath.Join(t.TempDir(), "youeye")
	if err := os.WriteFile(src, []byte("spine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Select(root, "B", e, ThisHost(), time.Now()); err == nil {
		t.Fatal("running contract should refuse a different helper contract")
	}
	if err := Select(root, "B", e, TargetSlotHost(e), time.Now()); err != nil && !strings.Contains(err.Error(), "payload") && !strings.Contains(err.Error(), "digest") && !strings.Contains(err.Error(), "no such file") {
		t.Fatalf("target slot host refused the new contract: %v", err)
	}
	other := e
	other.DiskLayout = DiskLayout + 1
	if err := Select(root, "B", other, TargetSlotHost(other), time.Now()); err == nil || !strings.Contains(err.Error(), "disk layout") {
		t.Fatalf("disk layout must still be checked: %v", err)
	}
}

// entry0611 is a selection entry as a Spine up to 0.6.11 reads it: it skips an
// entry whose version is empty.
type entry0611 struct {
	SHA256         string `json:"sha256"`
	Version        string `json:"version"`
	HelperContract int    `json:"helper_contract"`
	DiskLayout     int    `json:"disk_layout"`
}

// The selection record is shared by both slots, and the other slot may hold a
// Spine up to 0.6.11. This Spine writes what that one needs (a version, never
// empty) and adds the line and git tree; it reads entries without them.
func TestSelectionIsReadableByOlderAndNewerSpines(t *testing.T) {
	root := t.TempDir()
	old := staged(t, root, "spine 0.6.11", "0.6.11-dev.5")
	if err := Select(root, "A", old, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	next := staged(t, root, "spine 0.6.12", "0.6.12-dev.3")
	next.Line, next.SourceTree = "0.6.12", strings.Repeat("c", 40)
	if err := Select(root, "B", next, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, selectionFile))
	if err != nil {
		t.Fatal(err)
	}
	var older struct {
		Slots map[string]map[string]entry0611 `json:"slots"`
	}
	if err := json.Unmarshal(raw, &older); err != nil {
		t.Fatal(err)
	}
	for slot, want := range map[string]Entry{"A": old, "B": next} {
		got := older.Slots[slot]["current"]
		if got.SHA256 != want.SHA256 || got.Version == "" || got.Version != want.Version || got.HelperContract <= 0 || got.DiskLayout <= 0 {
			t.Fatalf("a 0.6.11 Spine skips slot %s: %+v", slot, got)
		}
	}
	if a, b := slotOf(t, root, "A").Current, slotOf(t, root, "B").Current; a.Line != "" || a.SourceTree != "" || a.DescribedSHA256 != "" || b.Line != "0.6.12" || b.SourceTree != strings.Repeat("c", 40) || b.DescribedSHA256 != b.SHA256 {
		t.Fatalf("entries read back wrongly: %+v %+v", a, b)
	}
	// The slot keeps running the entry whatever its description says: the
	// digest alone identifies it.
	if res, err := Resolve(root, "B", ThisHost(), false, testNow); err != nil || res.Entry == nil || res.Entry.SHA256 != next.SHA256 {
		t.Fatalf("resolve: %+v %v", res, err)
	}
}

// An older Spine that replaces an entry (it stages the other slot for an image
// update, or rolls back) keeps the keys it does not know where they were. The
// line and tree of the binary that was there must not pass for the new one's.
func TestSelectionDropsADescriptionOfAnotherBinary(t *testing.T) {
	root := t.TempDir()
	first := staged(t, root, "spine 0.6.12", "0.6.12-dev.3")
	first.Line, first.SourceTree = "0.6.12", strings.Repeat("c", 40)
	if err := Select(root, "B", first, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	second := staged(t, root, "spine 0.6.12 again", "0.6.12-dev.4")
	raw, err := os.ReadFile(filepath.Join(root, selectionFile))
	if err != nil {
		t.Fatal(err)
	}
	// What jsonkeep leaves when a 0.6.11 Spine writes another entry there: its
	// own fields are new, the keys it does not know stay.
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	current := record["slots"].(map[string]any)["B"].(map[string]any)["current"].(map[string]any)
	current["sha256"], current["version"] = second.SHA256, second.Version
	if current["line"] != "0.6.12" || current["described_sha256"] != first.SHA256 {
		t.Fatalf("fixture: %v", current)
	}
	replaced, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(root, selectionFile), replaced, 0o600); err != nil {
		t.Fatal(err)
	}
	got := slotOf(t, root, "B").Current
	if got == nil || got.SHA256 != second.SHA256 || got.Version != "0.6.12-dev.4" || got.Line != "" || got.SourceTree != "" || got.DescribedSHA256 != "" {
		t.Fatalf("another binary's description was kept: %+v", got)
	}
	// Rewriting the record clears it on disk too.
	s, _ := Load(root)
	if err := Save(root, s, testNow); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(root, selectionFile)); strings.Contains(string(raw), `"line"`) || strings.Contains(string(raw), "described_sha256") || strings.Contains(string(raw), "source_tree") {
		t.Fatalf("stale description left on State: %s", raw)
	}
}

// An image update writes a slot whose record still names the Spine of the
// image that was there (0.6.12 → 0.6.13 writes slot A, last booted with
// 0.6.11). That Spine must not stay as the slot's previous: it would run on
// the new image when the release's Spine cannot, or on `youeye spine
// rollback`, and it does not read what the new release writes. The fallback
// of the written slot is the seed of its own image.
func TestSelectLeavesNoSpineOfTheImageBefore(t *testing.T) {
	root := t.TempDir()
	older := staged(t, root, "spine 0.6.10", "0.6.10-dev.2")
	old := staged(t, root, "spine 0.6.11", "0.6.11-dev.5")
	stone := staged(t, root, "spine 0.6.12", "0.6.12-dev.3")
	next := staged(t, root, "spine 0.6.13", "0.6.13")
	// Slot A as a 0.6.11 box left it: its Spine, the one before it, and keys
	// and an entry of some other Spine that this one does not read.
	selectThenCommit(t, root, "A", older, old)
	selectThenCommit(t, root, "B", old, stone)
	raw, err := os.ReadFile(filepath.Join(root, selectionFile))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	record["future"] = map[string]any{"x": 1}
	for _, name := range []string{"A", "B"} {
		slot := record["slots"].(map[string]any)[name].(map[string]any)
		slot["current"].(map[string]any)["pinned"] = true
		slot["trial"] = map[string]any{"sha256": "unreadable-" + name}
	}
	raw, _ = json.Marshal(record)
	if err := os.WriteFile(filepath.Join(root, selectionFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	// The 0.6.12 Spine on slot B stages the 0.6.13 image into slot A.
	if err := Select(root, "A", next, TargetSlotHost(next), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != next.SHA256 || got.Previous != nil || got.Trial != nil {
		t.Fatalf("slot A after the image update: %+v", got)
	}
	raw, _ = os.ReadFile(filepath.Join(root, selectionFile))
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	a := record["slots"].(map[string]any)["A"].(map[string]any)
	if len(a) != 1 || a["current"].(map[string]any)["pinned"] != nil || strings.Contains(string(raw), "unreadable-A") {
		t.Fatalf("slot A kept something of the image before: %s", raw)
	}
	// The rest of the record is untouched: the running slot, and what other
	// Spines wrote outside slot A.
	if got := slotOf(t, root, "B"); digestOf(got.Current) != stone.SHA256 || digestOf(got.Previous) != old.SHA256 {
		t.Fatalf("slot B changed: %+v", got)
	}
	if record["future"] == nil || !strings.Contains(string(raw), "unreadable-B") || record["slots"].(map[string]any)["B"].(map[string]any)["current"].(map[string]any)["pinned"] != true {
		t.Fatalf("the image update dropped another Spine's content outside slot A: %s", raw)
	}

	// On slot A the 0.6.11 Spine is no Spine the slot may run.
	seed := strings.Repeat("5", 64)
	if err := Running(root, "A", old.SHA256, seed); err == nil {
		t.Fatal("the Spine of the image before still counts as slot A's")
	}
	// `youeye spine rollback` says there is nothing to go back to.
	if err := Rollback(root, "A", testNow); err == nil || !strings.Contains(err.Error(), "no previous Spine") {
		t.Fatalf("rollback on the written slot: %v", err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != next.SHA256 {
		t.Fatalf("a refused rollback changed the slot: %+v", got)
	}
	// The release's Spine cannot run (its payload is damaged): the seed of the
	// new image runs, not the 0.6.11 Spine, whose payload is still on State.
	if err := os.WriteFile(PayloadPath(root, next.SHA256), []byte("damaged"), 0o500); err != nil {
		if err = os.Remove(PayloadPath(root, next.SHA256)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Verify(root, old, ThisHost()); err != nil {
		t.Fatalf("fixture: the older payload should still verify: %v", err)
	}
	res, err := Resolve(root, "A", ThisHost(), true, testNow)
	if err != nil || res.Role != "seed" || res.Path != "" || res.Entry != nil || len(res.Skipped) != 1 {
		t.Fatalf("broken release Spine on the written slot: %+v %v", res, err)
	}

	// Staging the same release again (a retry after a failed boot) leaves the
	// slot the same; a Spine update on the slot later has a previous again.
	next2 := staged(t, root, "spine 0.6.13 again", "0.6.13")
	if err := Select(root, "A", next2, TargetSlotHost(next2), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Select(root, "A", next2, TargetSlotHost(next2), testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != next2.SHA256 || got.Previous != nil {
		t.Fatalf("restaged slot: %+v", got)
	}
	later := staged(t, root, "spine 0.6.14", "0.6.14")
	if err := BeginTrial(root, "A", later, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	if err := Commit(root, "A", later.SHA256, testNow); err != nil {
		t.Fatal(err)
	}
	if err := Rollback(root, "A", testNow); err != nil {
		t.Fatal(err)
	}
	if got := slotOf(t, root, "A"); digestOf(got.Current) != next2.SHA256 || digestOf(got.Previous) != later.SHA256 {
		t.Fatalf("rollback after a Spine update on the slot: %+v", got)
	}
}

// `youeye spine status` and the Spine API name every Spine by its line. The
// record keeps the stored names (a 0.6.11 Spine in the other slot reads them).
func TestReportShowsLinesNotStoredNames(t *testing.T) {
	root := t.TempDir()
	old := staged(t, root, "spine 0.6.11", "0.6.11-dev.5")
	stone := staged(t, root, "spine 0.6.12", "0.6.12-dev.3")
	stone.Line = "0.6.12"
	selectThenCommit(t, root, "A", old, stone)
	hand := staged(t, root, "spine by hand", "my-test-spine")
	if err := BeginTrial(root, "A", hand, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	clean := staged(t, root, "spine 0.6.13", "0.6.13")
	if err := Select(root, "B", clean, ThisHost(), testNow); err != nil {
		t.Fatal(err)
	}
	stored, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Resolve(root, "A", ThisHost(), false, testNow)
	if err != nil || res.Entry == nil {
		t.Fatal(res, err)
	}
	report := Report{Slot: "A", Seed: Seed{Path: BakedPath, SHA256: strings.Repeat("5", 64), Version: "0.6.7-dev.1"}, Running: res, Selection: stored.Slots, Host: ThisHost()}
	shown := report.Shown()
	a, b := shown.Selection["A"], shown.Selection["B"]
	if shown.Seed.Version != "0.6.7" || a.Current.Version != "0.6.12" || a.Previous.Version != "0.6.11" || a.Trial.Version != "my-test-spine" || b.Current.Version != "0.6.13" || shown.Running.Entry.Version != "my-test-spine" {
		t.Fatalf("shown: seed %+v A %+v %+v %+v B %+v running %+v", shown.Seed, a.Current, a.Previous, a.Trial, b.Current, shown.Running.Entry)
	}
	if a.Current.SHA256 != stone.SHA256 || a.Previous.SHA256 != old.SHA256 || shown.Slot != "A" || shown.Running.Role != "trial" {
		t.Fatalf("shown changed more than the names: %+v", shown)
	}
	raw, err := json.Marshal(shown)
	if err != nil || strings.Contains(string(raw), "-dev.") {
		t.Fatalf("a build name is printed: %s %v", raw, err)
	}
	// Showing changes neither the report it was made from nor the record.
	if report.Seed.Version != "0.6.7-dev.1" || stored.Slots["A"].Previous.Version != "0.6.11-dev.5" || report.Running.Entry.Version != "my-test-spine" {
		t.Fatalf("Shown changed its source: %+v", report)
	}
	if got := slotOf(t, root, "A"); got.Current.Version != "0.6.12-dev.3" || got.Previous.Version != "0.6.11-dev.5" {
		t.Fatalf("record changed: %+v", got)
	}
	// Messages about a Spine name its line and digest, not the stored name.
	if err := os.Remove(PayloadPath(root, old.SHA256)); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(root, old, ThisHost()); err == nil || strings.Contains(err.Error(), "-dev.") || !strings.Contains(err.Error(), "0.6.11 (sha256 "+old.SHA256[:12]+")") {
		t.Fatalf("message: %v", err)
	}
}
