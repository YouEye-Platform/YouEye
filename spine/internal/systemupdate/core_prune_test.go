package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// pruneWorld is a box for the pruning tests: Incus snapshots, ZFS snapshots
// with their holds, and everything a System update writes on State and Data.
type pruneWorld struct {
	t         *testing.T
	m         CoreManager
	r         NativeCoreRuntime
	target    releasecache.CoreRelease
	snapshots map[string]map[string]map[string]string // container -> snapshot -> config
	zfs       map[string]string                       // dataset@snapshot -> owner property
	holds     map[string]bool
	deletes   []string
}

func newPruneWorld(t *testing.T) *pruneWorld {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	r, _ := nativeRuntimeFixture(t, m)
	w := &pruneWorld{t: t, m: m, target: target, snapshots: map[string]map[string]map[string]string{"youeye-control": {}, "youeye-ui": {}}, zfs: map[string]string{}, holds: map[string]bool{}}
	capture := func(_ context.Context, program string, args ...string) ([]byte, error) {
		line := program + " " + strings.Join(args, " ")
		switch {
		case line == "incus list --format=json":
			list := []map[string]any{}
			for name := range w.snapshots {
				list = append(list, map[string]any{"name": name, "status": "Running", "config": map[string]string{"volatile.uuid": "uuid-" + name}})
			}
			return json.Marshal(list)
		case program == "incus" && args[0] == "query" && strings.HasSuffix(args[1], "/snapshots?recursion=1"):
			name := strings.TrimSuffix(strings.TrimPrefix(args[1], "/1.0/instances/"), "/snapshots?recursion=1")
			list := []map[string]any{}
			for snapshot, config := range w.snapshots[name] {
				list = append(list, map[string]any{"name": snapshot, "config": config})
			}
			return json.Marshal(list)
		case program == "incus" && len(args) == 4 && args[0] == "snapshot" && args[1] == "delete":
			w.deletes = append(w.deletes, line)
			delete(w.snapshots[args[2]], args[3])
			return nil, fmt.Errorf("fixture lost delete acknowledgement")
		case program == "zfs" && args[0] == "list":
			out := ""
			for name, owner := range w.zfs {
				if strings.HasPrefix(name, args[len(args)-1]+"@") {
					out += name + "\t4242\t" + owner + "\n"
				}
			}
			return []byte(out), nil
		case program == "zfs" && args[0] == "release" && len(args) == 3:
			w.deletes = append(w.deletes, line)
			delete(w.holds, args[2])
			return nil, nil
		case program == "zfs" && args[0] == "destroy" && len(args) == 2:
			w.deletes = append(w.deletes, line)
			if w.holds[args[1]] {
				return nil, fmt.Errorf("dataset is busy")
			}
			delete(w.zfs, args[1])
			return nil, nil
		}
		t.Fatalf("unexpected native command: %s", line)
		return nil, nil
	}
	r.Checkpoint.Capture, r.Services.Checkpoint.Capture = capture, capture
	w.r = r
	return w
}

// update runs one service update to the end and leaves what a real one leaves.
// end is "committed", "cancelled" or "prepared".
func (w *pruneWorld) update(n int, end string) CoreJournal {
	w.t.Helper()
	ctx := context.Background()
	target := w.target
	target.Sequence = uint64(200 + n)
	target.Members = append([]releasecache.CoreMember(nil), target.Members...)
	for i := range target.Members {
		if target.Members[i].Role == "cp" {
			target.Members[i].Artifact.SHA256 = strings.Repeat(fmt.Sprint(n), 64)
		}
	}
	raw, _ := json.Marshal(target)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		w.t.Fatal(err)
	}
	request := fmt.Sprintf("update-%d", n)
	j, err := w.m.Prepare(ctx, request, raw, digest)
	if err != nil {
		w.t.Fatal(err)
	}
	// Downloaded files and the payload index of the new Control Panel.
	if err := atomicWrite(filepath.Join(w.r.Cache.Root, "lock"), nil, 0600); err != nil {
		w.t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(w.r.Cache.Root, "blobs", strings.Repeat(fmt.Sprint(n), 64)), filepath.Join(w.m.Root, "payloads", strings.Repeat(fmt.Sprint(n), 64)+".json")} {
		if err := atomicWrite(path, []byte("fixture"), 0600); err != nil {
			w.t.Fatal(err)
		}
	}
	if end == "prepared" {
		return j
	}
	if end == "cancelled" {
		if j, err = w.m.Cancel(ctx, request); err != nil || j.Phase != "cancelled" {
			w.t.Fatal(j.Phase, err)
		}
		return j
	}
	if j, err = w.m.Advance(ctx, request, false); err != nil || j.Phase != "committed" {
		w.t.Fatal(j.Phase, err)
	}
	snapshot := coreCheckpointSnapshot(request)
	inventory := CoreCheckpointInventory{RequestID: request, ManifestSHA256: j.ManifestSHA256, Machine: j.Previous.Machine, Bridge: "incusbr0", IngressPorts: []uint16{80, 443}}
	record := NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Phase: "captured", CompletionState: "released"}
	for _, name := range []string{"app-memos", "youeye-control", "youeye-ui"} {
		c := CoreCheckpointContainer{Name: name, UUID: "uuid-" + name, Running: true}
		if name != "app-memos" {
			c.Snapshot = snapshot
			w.snapshots[name][snapshot] = map[string]string{"user.youeye.core-request": request, "volatile.uuid": c.UUID}
			record.Roots = append(record.Roots, CoreRootCheckpoint{Container: name, Snapshot: snapshot, State: "captured"})
		}
		inventory.Containers = append(inventory.Containers, c)
	}
	record.Inventory = inventory
	for _, dataset := range []string{"default/data", "default/incus-state"} {
		w.zfs[dataset+"@"+snapshot], w.holds[dataset+"@"+snapshot] = coreSnapshotOwner(inventory), true
		record.FileSnapshots = append(record.FileSnapshots, CoreFilesCheckpoint{Dataset: dataset, Snapshot: snapshot, State: "captured", GUID: "4242", Held: true})
	}
	if err := w.r.Checkpoint.saveRecord(record); err != nil {
		w.t.Fatal(err)
	}
	archive, err := w.r.Checkpoint.databaseArchivePath(j, "youeye")
	if err != nil {
		w.t.Fatal(err)
	}
	if err := atomicWrite(archive, []byte("dump"), 0600); err != nil {
		w.t.Fatal(err)
	}
	executor := NativeCoreExecutor{Root: w.m.Root}
	for _, step := range j.Steps {
		if err := atomicWrite(executor.actionPath(step), []byte("{}"), 0600); err != nil {
			w.t.Fatal(err)
		}
		if err := atomicWrite(w.r.Runner.path(j, step), []byte("{}"), 0600); err != nil {
			w.t.Fatal(err)
		}
	}
	unit := fmt.Sprintf("youeye-core-control-%x.service", sha256.Sum256([]byte(request+"\x00delivery")))
	receipt, _ := json.Marshal(CoreControlReceipt{Schema: "youeye.core-control.v1", RequestID: request, CommandID: "delivery", ManifestSHA256: j.ManifestSHA256, Unit: unit, Executable: "/usr/local/bin/youeye"})
	if err := atomicWrite(filepath.Join(w.m.Root, "controllers", unit+".json"), receipt, 0600); err != nil {
		w.t.Fatal(err)
	}
	return j
}

// left lists the requests (by number) that still have each kind of leftover.
func (w *pruneWorld) left(upTo int) map[string][]int {
	out := map[string][]int{}
	for n := 1; n <= upTo; n++ {
		request := fmt.Sprintf("update-%d", n)
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(request)))
		snapshot := coreCheckpointSnapshot(request)
		if _, ok := w.snapshots["youeye-control"][snapshot]; ok {
			out["root"] = append(out["root"], n)
		}
		if _, ok := w.zfs["default/data@"+snapshot]; ok {
			out["zfs"] = append(out["zfs"], n)
		}
		for kind, path := range map[string]string{
			"dump":    filepath.Join(w.r.Checkpoint.DataRoot, "state", "core-checkpoints", hash),
			"record":  filepath.Join(w.m.Root, "checkpoints", hash),
			"journal": w.m.requestPath(request),
			"blob":    filepath.Join(w.r.Cache.Root, "blobs", strings.Repeat(fmt.Sprint(n), 64)),
			"index":   filepath.Join(w.m.Root, "payloads", strings.Repeat(fmt.Sprint(n), 64)+".json"),
			"control": filepath.Join(w.m.Root, "controllers", fmt.Sprintf("youeye-core-control-%x.service.json", sha256.Sum256([]byte(request+"\x00delivery")))),
			"action":  NativeCoreExecutor{Root: w.m.Root}.actionPath(CoreStep{RequestID: request + "/checkpoint"}),
		} {
			if _, err := os.Lstat(path); err == nil {
				out[kind] = append(out[kind], n)
			}
		}
	}
	for _, list := range out {
		sort.Ints(list)
	}
	return out
}

func (w *pruneWorld) expect(upTo int, want map[string][]int) {
	w.t.Helper()
	got := w.left(upTo)
	for _, kind := range []string{"root", "zfs", "dump", "record", "journal", "blob", "index", "control", "action"} {
		if fmt.Sprint(got[kind]) != fmt.Sprint(want[kind]) {
			w.t.Fatalf("%s left for requests %v, want %v (all: %v)", kind, got[kind], want[kind], got)
		}
	}
}

// Three System updates in a row: after each, only the last good checkpoint is
// left (the Incus snapshots, the held ZFS snapshots, the SQL dumps) and the
// receipts, cached files and payload indexes of earlier requests are gone. The
// journals stay. Before 0.6.15 nothing was ever removed.
func TestCorePruneKeepsOnlyTheLastGoodCheckpoint(t *testing.T) {
	w := newPruneWorld(t)
	ctx := context.Background()
	w.update(1, "committed")
	first := w.r.PruneFinished(ctx)
	if first.Skipped != "" || first.removed() != 0 || fmt.Sprint(first.Kept) != "[update-1]" {
		t.Fatalf("the only checkpoint was touched: %+v", first)
	}
	w.expect(1, map[string][]int{"root": {1}, "zfs": {1}, "dump": {1}, "record": {1}, "blob": {1}, "index": {1}, "control": {1}, "action": {1}})
	w.update(2, "committed")
	w.update(3, "committed")
	result := w.r.PruneFinished(ctx)
	if result.Skipped != "" || len(result.Left) != 0 || fmt.Sprint(result.Pruned) != "[update-1 update-2]" || fmt.Sprint(result.Kept) != "[update-3]" ||
		result.RootSnapshots != 4 || result.FileSnapshots != 4 || result.Archives != 2 || result.Blobs != 1 || result.PayloadIndexes != 1 {
		t.Fatalf("prune after three updates: %+v", result)
	}
	// The cached files of the installed release (3) and of the current request's previous release (2) stay.
	w.expect(3, map[string][]int{"root": {3}, "zfs": {3}, "dump": {3}, "record": {3}, "journal": {1, 2}, "blob": {2, 3}, "index": {2, 3}, "control": {3}, "action": {3}})
	if !strings.Contains(result.String(), "pruned 2 finished request(s): 4 container snapshot(s), 4 file snapshot(s), 2 database archive set(s)") || !strings.Contains(result.String(), "kept the checkpoint of update-3") {
		t.Fatal(result.String())
	}
	// Again: nothing left to do, and no native command for requests that are done.
	w.deletes = nil
	if again := w.r.PruneFinished(ctx); again.removed() != 0 || len(w.deletes) != 0 {
		t.Fatalf("a second prune removed something: %+v %v", again, w.deletes)
	}
	// A repeated old request ID is still the old request.
	if old, err := w.m.ReadRequest("update-1"); err != nil || old.Phase != "committed" {
		t.Fatal("a pruned request lost its journal", err)
	}
}

// What an unfinished or reserved request needs is never pruned, and the last
// good checkpoint survives requests that leave none of their own.
func TestCorePruneNeverTouchesWhatARequestMayNeed(t *testing.T) {
	ctx := context.Background()
	all := map[string][]int{"root": {1, 2}, "zfs": {1, 2}, "dump": {1, 2}, "record": {1, 2}, "journal": {1}, "blob": {1, 2}, "index": {1, 2}, "control": {1, 2}, "action": {1, 2}}

	// A request is staged (prepared, awaiting a restart, applying, needing recovery): nothing is pruned.
	w := newPruneWorld(t)
	w.update(1, "committed")
	w.update(2, "committed")
	w.update(3, "prepared")
	if result := w.r.PruneFinished(ctx); result.Skipped == "" || result.removed() != 0 {
		t.Fatalf("pruned beside an unfinished request: %+v", result)
	}
	all["journal"], all["blob"], all["index"] = []int{1, 2}, []int{1, 2, 3}, []int{1, 2, 3}
	w.expect(3, all)

	// The platform is reserved (a release that has not ended, an independent copy): nothing is pruned.
	w = newPruneWorld(t)
	j1 := w.update(1, "committed")
	w.update(2, "committed")
	barrier := CoreLifecycleBarrier{Root: filepath.Join(w.r.Checkpoint.DataRoot, "state", "app-updates")}
	if err := barrier.Begin(j1); err != nil {
		t.Fatal(err)
	}
	if result := w.r.PruneFinished(ctx); result.Skipped == "" || result.removed() != 0 {
		t.Fatalf("pruned while the platform was reserved: %+v", result)
	}

	// The coordinator is at work.
	w = newPruneWorld(t)
	w.update(1, "committed")
	w.update(2, "committed")
	unlock, err := w.m.lockCore()
	if err != nil {
		t.Fatal(err)
	}
	if result := w.r.PruneFinished(ctx); result.Skipped == "" || result.removed() != 0 {
		t.Fatalf("pruned beside a coordinator: %+v", result)
	}
	unlock()

	// A cancelled request leaves no checkpoint: the last good one (2) stays, the older one (1) goes.
	w = newPruneWorld(t)
	w.update(1, "committed")
	w.update(2, "committed")
	w.update(3, "cancelled")
	result := w.r.PruneFinished(ctx)
	if result.Skipped != "" || fmt.Sprint(result.Kept) != "[update-3 update-2]" || fmt.Sprint(result.Pruned) != "[update-1]" {
		t.Fatalf("prune after a cancelled request: %+v", result)
	}
	w.expect(3, map[string][]int{"root": {2}, "zfs": {2}, "dump": {2}, "record": {2}, "journal": {1, 2}, "blob": {2, 3}, "index": {2, 3}, "control": {2}, "action": {2}})
}

// Snapshots are deleted only with the request's own mark; what cannot be
// deleted keeps its record and is tried again.
func TestCorePruneLeavesForeignAndBusySnapshots(t *testing.T) {
	ctx := context.Background()
	w := newPruneWorld(t)
	w.update(1, "committed")
	w.update(2, "committed")
	snapshot := coreCheckpointSnapshot("update-1")
	w.snapshots["youeye-control"][snapshot]["user.youeye.core-request"] = "someone-else"
	w.zfs["default/data@"+snapshot] = "another-owner"
	result := w.r.PruneFinished(ctx)
	if len(result.Left) != 2 || result.RootSnapshots != 1 || result.FileSnapshots != 1 {
		t.Fatalf("foreign snapshots: %+v", result)
	}
	if _, ok := w.snapshots["youeye-control"][snapshot]; !ok {
		t.Fatal("a snapshot without the request's mark was deleted")
	}
	if _, ok := w.zfs["default/data@"+snapshot]; !ok {
		t.Fatal("a ZFS snapshot of another owner was destroyed")
	}
	for _, line := range w.deletes {
		if strings.Contains(line, "youeye-control "+snapshot) || strings.Contains(line, "default/data@"+snapshot) {
			t.Fatalf("a foreign snapshot was acted on: %s", line)
		}
	}
	// The record stays (it names what is left); the dumps and receipts are gone.
	w.expect(2, map[string][]int{"root": {1, 2}, "zfs": {1, 2}, "dump": {2}, "record": {1, 2}, "journal": {1}, "blob": {1, 2}, "index": {1, 2}, "control": {2}, "action": {2}})
	// Once they carry the mark again, the next prune finishes the job.
	w.snapshots["youeye-control"][snapshot]["user.youeye.core-request"] = "update-1"
	w.zfs["default/data@"+snapshot] = w.zfs["default/incus-state@"+coreCheckpointSnapshot("update-2")]
	_ = w.r.PruneFinished(ctx)
	if _, ok := w.snapshots["youeye-control"][snapshot]; !ok {
		// the ZFS owner is another request's: still foreign, so the record stays
		w.expect(2, map[string][]int{"root": {2}, "zfs": {1, 2}, "dump": {2}, "record": {1, 2}, "journal": {1}, "blob": {1, 2}, "index": {1, 2}, "control": {2}, "action": {2}})
	} else {
		t.Fatal("the snapshot was not deleted on the second try")
	}

	// A journal retained by an earlier Spine, whose release document is gone, is still pruned.
	w = newPruneWorld(t)
	j1 := w.update(1, "committed")
	w.update(2, "committed")
	if err := os.Remove(filepath.Join(w.m.Root, "targets", j1.ManifestSHA256+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.m.ReadRequest("update-1"); err == nil {
		t.Fatal("fixture: the retained journal still reads")
	}
	if result := w.r.PruneFinished(ctx); len(result.Left) != 0 || fmt.Sprint(result.Pruned) != "[update-1]" {
		t.Fatalf("a request of an earlier Spine was not pruned: %+v", result)
	}
	w.expect(2, map[string][]int{"root": {2}, "zfs": {2}, "dump": {2}, "record": {2}, "journal": {1}, "blob": {1, 2}, "index": {1, 2}, "control": {2}, "action": {2}})
}

// Pruning holds the coordinator lock for one finished request at a time, and
// whoever finds it busy is told that it is the pruning. Until 0.6.15 one hold
// covered the whole run (up to 30 minutes on a box with many old checkpoints)
// and staging or cancelling an update answered "core update is already
// running".
func TestCorePruneHoldsTheCoordinatorLockForOneRequestAtATime(t *testing.T) {
	ctx := context.Background()
	w := newPruneWorld(t)
	for n := 1; n <= 4; n++ {
		w.update(n, "committed")
	}
	lockFile := filepath.Join(w.m.Root, "lock")
	// While a request is pruned the lock is busy, and the refusal says why.
	refusals := 0
	capture := w.r.Checkpoint.Capture
	w.r.Checkpoint.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "incus" && args[0] == "snapshot" {
			refusals++
			if _, err := w.m.lockCore(); !errors.Is(err, ErrCorePruning) || strings.Contains(err.Error(), "already running") {
				t.Errorf("the lock during pruning: %v", err)
			}
			if _, err := w.m.Cancel(ctx, "update-4"); !errors.Is(err, ErrCorePruning) {
				t.Errorf("a cancel during pruning: %v", err)
			}
		}
		return capture(ctx, program, args...)
	}
	var out CorePruneResult
	tried := map[string]bool{}
	if more := w.r.pruneNext(ctx, &out, tried, true); !more || len(tried) != 1 || len(out.Pruned) != 1 || out.RootSnapshots != 2 || refusals != 2 {
		t.Fatalf("the first hold: more=%v tried=%v refusals=%d %+v", more, tried, refusals, out)
	}
	// Between two requests the lock is free and carries no mark.
	unlock, err := w.m.lockCore()
	if err != nil {
		t.Fatalf("the lock is held between two requests: %v", err)
	}
	unlock()
	if raw, err := os.ReadFile(lockFile); err != nil || len(raw) != 0 {
		t.Fatalf("the lock file between two requests: %q %v", raw, err)
	}
	// The owner stages an update in that moment: the rest waits for the next run.
	w.update(5, "prepared")
	before := len(w.deletes)
	if more := w.r.pruneNext(ctx, &out, tried, false); more || len(w.deletes) != before || len(out.Pruned) != 1 || out.Skipped != "" ||
		len(out.Left) != 1 || !strings.Contains(out.Left[0], "a System request is unfinished") {
		t.Fatalf("pruning went on beside a new request: more=%v %+v", more, out)
	}
	// A whole run does the same in as many holds as it takes, until somebody wants the lock: whoever found the
	// pruning holding it has left a request to yield, and the run ends after the request it was removing. Until
	// 0.6.15 the next hold followed within a millisecond, and a waiter that looks twice a second never got in.
	if j, err := w.m.Cancel(ctx, "update-5"); err != nil || j.Phase != "cancelled" {
		t.Fatal(j.Phase, err)
	}
	refusals = 0
	result := w.r.PruneFinished(ctx)
	if result.Skipped != "" || len(result.Pruned) != 1 || refusals != 2 || len(result.Left) != 1 || !strings.Contains(result.Left[0], "is waiting for the coordinator") {
		t.Fatalf("a run with a waiter: refusals=%d %+v", refusals, result)
	}
	if !w.m.pruneYieldAsked() {
		t.Fatal("the waiter left no request to yield")
	}
	// The waiter gets in, and its request to yield goes with that.
	unlock, err = w.m.lockCore()
	if err != nil {
		t.Fatalf("the waiter after the pruning yielded: %v", err)
	}
	unlock()
	if w.m.pruneYieldAsked() {
		t.Fatal("the request to yield outlived the waiter's turn")
	}
	// A waiter that gave up left its request: the next run forgets it and removes the rest.
	if err := os.WriteFile(w.m.pruneYieldPath(), []byte("wanted\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w.r.Checkpoint.Capture = capture
	result = w.r.PruneFinished(ctx)
	if result.Skipped != "" || len(result.Left) != 0 || len(result.Pruned) < 1 || w.m.pruneYieldAsked() {
		t.Fatalf("the run after a waiter that gave up: %+v", result)
	}
	if len(w.snapshots["youeye-control"]) != 1 || len(w.snapshots["youeye-ui"]) != 1 {
		t.Fatalf("snapshots left: %v", w.snapshots)
	}
	// Two prunings beside each other do not ask each other to yield.
	held, err := w.m.lockCoreForPrune(true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.m.lockCoreForPrune(true); !errors.Is(err, ErrCorePruning) || w.m.pruneYieldAsked() {
		t.Fatalf("a second pruning: %v, asked to yield: %v", err, w.m.pruneYieldAsked())
	}
	held()

	// A lock that somebody else holds is "already running", as before, even over a mark that a killed
	// pruning left; and the next holder clears that mark.
	if err := os.WriteFile(lockFile, []byte(corePruningMark), 0600); err != nil {
		t.Fatal(err)
	}
	unlock, err = w.m.lockCore()
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(lockFile); len(raw) != 0 {
		t.Fatalf("a stale pruning mark outlived the next holder: %q", raw)
	}
	if _, err := w.m.lockCore(); err == nil || errors.Is(err, ErrCorePruning) || !strings.Contains(err.Error(), "core update is already running") {
		t.Fatalf("a coordinator's lock: %v", err)
	}
	if skipped := w.r.PruneFinished(ctx); skipped.Skipped != "the coordinator is at work" {
		t.Fatalf("pruning beside a coordinator: %+v", skipped)
	}
	unlock()
}

// The pruning writes its mark right after it has taken the lock. Whoever finds the lock busy in that moment reads
// an empty file: it looks again instead of answering "core update is already running" (0.6.15).
func TestCoreLockLooksAgainAtAHeldLockWithoutAMark(t *testing.T) {
	m := CoreManager{Root: t.TempDir()}
	lockFile := filepath.Join(m.Root, "lock")
	f, err := os.OpenFile(lockFile, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	pause := coreLockLookPause
	coreLockLookPause = 20 * time.Millisecond
	defer func() { coreLockLookPause = pause }()
	marked := make(chan struct{})
	go func() {
		defer close(marked)
		time.Sleep(30 * time.Millisecond)
		_, _ = f.WriteAt([]byte(corePruningMark), 0)
	}()
	_, err = m.lockCore()
	<-marked
	if !errors.Is(err, ErrCorePruning) {
		t.Fatalf("a lock whose holder had not written its mark yet: %v", err)
	}
	if !m.pruneYieldAsked() {
		t.Fatal("no request to yield")
	}
	// A holder that never writes one is a coordinator.
	if err := f.Truncate(0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.lockCore(); err == nil || errors.Is(err, ErrCorePruning) || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a coordinator's lock: %v", err)
	}
}
