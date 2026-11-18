package systemupdate

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"testing"
)

// stageTreeFixture gives a finished-or-not System request, two "containers" (directories of this machine, reached
// through this process's own root, as a container is reached through its init's) and the fake `incus exec … rm`.
type stageTreeFixture struct {
	t        *testing.T
	m        CoreManager
	e        *coreTestExecutor
	j        CoreJournal
	s        NativeCoreServices
	barrier  CoreLifecycleBarrier
	roots    map[string]string // container -> its "/"
	stopped  map[string]bool
	commands [][]string
	failRm   bool
	during   func() // runs while the removal command does
}

func newStageTreeFixture(t *testing.T) *stageTreeFixture {
	t.Helper()
	m, e, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	f := &stageTreeFixture{t: t, m: m, e: e, j: j, roots: map[string]string{}, stopped: map[string]bool{}}
	data := t.TempDir()
	f.barrier = CoreLifecycleBarrier{Root: filepath.Join(data, "state", "app-updates")}
	for _, container := range []string{"youeye-control", "youeye-ui"} {
		f.roots[container] = t.TempDir()
	}
	checkpoint := NativeCoreCheckpoint{Root: m.Root, DataRoot: data}
	checkpoint.Capture = func(_ context.Context, program string, args ...string) ([]byte, error) {
		f.commands = append(f.commands, append([]string{program}, args...))
		prefix := []string{"exec", "", "--mode=non-interactive", "--", "rm", "-rf", "--one-file-system", "--"}
		if program != "incus" || len(args) <= len(prefix) {
			t.Fatalf("unexpected command %s %v", program, args)
		}
		prefix[1] = args[1]
		if !reflect.DeepEqual(args[:len(prefix)], prefix) || f.roots[args[1]] == "" {
			t.Fatalf("unexpected command %s %v", program, args)
		}
		if f.during != nil {
			f.during()
		}
		if f.failRm {
			return nil, fmt.Errorf("fixture: the command failed")
		}
		for _, target := range args[len(prefix):] {
			// The fixture's containers are directories of this machine, so the path the container is given is
			// the path here: always a stage name next to that container's application directory.
			if !coreStageTreeName.MatchString(filepath.Base(target)) || filepath.Dir(target) != filepath.Join(f.roots[args[1]], "opt") {
				t.Fatalf("removal outside the stage names: %s", target)
			}
			if err := os.RemoveAll(target); err != nil {
				t.Fatal(err)
			}
		}
		return nil, nil
	}
	f.s = NativeCoreServices{Checkpoint: checkpoint}
	return f
}

func (f *stageTreeFixture) observe(_ context.Context, container string) (int, error) {
	if f.stopped[container] {
		return 0, fmt.Errorf("core container is not running")
	}
	return os.Getpid(), nil
}

// leave records the stage receipt of a request's member and puts an old tree under its stage name.
func (f *stageTreeFixture) leave(request, role string) string {
	f.t.Helper()
	container := "youeye-control"
	if role == "ui" {
		container = "youeye-ui"
	}
	// The receipt names the application directory as the container sees it. This fixture's containers are
	// directories, so the "container path" is the path on this machine.
	appDir := filepath.Join(f.roots[container], "opt", "app")
	stage := CoreServiceStage{Schema: "youeye.core-service-stage.v1", RequestID: request, ManifestSHA256: f.j.ManifestSHA256, Role: role, ContainerUUID: "fixture-" + container,
		AppDir: appDir, ArtifactSHA256: strings.Repeat("e", 64), PreviousSHA256: strings.Repeat("c", 64), Phase: "swapped",
		StageName: fmt.Sprintf(".youeye-core-%x", sha256.Sum256([]byte(request+"\x00"+role)))}
	if err := f.s.saveStage(stage); err != nil {
		f.t.Fatal(err)
	}
	old := filepath.Join(filepath.Dir(appDir), stage.StageName)
	for _, dir := range []string{appDir, filepath.Join(old, ".next", "server")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, file := range []string{filepath.Join(appDir, "server.js"), filepath.Join(old, "server.js"), filepath.Join(old, ".next", "server", "page.js")} {
		if err := os.WriteFile(file, []byte("fixture"), 0644); err != nil {
			f.t.Fatal(err)
		}
	}
	return old
}

func (f *stageTreeFixture) remove() []string {
	return f.s.removeFinishedStageTrees(context.Background(), f.observe)
}

func (f *stageTreeFixture) setPhase(phase string) {
	f.t.Helper()
	j, err := f.m.Read()
	if err != nil {
		f.t.Fatal(err)
	}
	j.Phase = phase
	j.RecoverySteps = nil
	if phase == "recovering" || phase == "rolled-back" {
		for _, name := range coreRecoveryNames(j) {
			step := CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: "pending"}
			if phase == "rolled-back" {
				step.State, step.Evidence = "succeeded", "fixture"
			}
			j.RecoverySteps = append(j.RecoverySteps, step)
		}
	}
	if err := f.m.saveCore(&j); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.m.Read(); err != nil {
		f.t.Fatalf("fixture journal in phase %s is not valid: %v", phase, err)
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// The rule: the old trees of a request go once the request has ended, and never before.
func TestCoreStageTreesAreRemovedOnlyAfterTheRequestEnded(t *testing.T) {
	for _, phase := range []string{"prepared", "applying", "needs-recovery", "recovering", "cancelling"} {
		t.Run("kept while "+phase, func(t *testing.T) {
			f := newStageTreeFixture(t)
			trees := []string{f.leave(f.j.RequestID, "cp"), f.leave(f.j.RequestID, "ui"), f.leave("update-0", "cp")}
			f.setPhase(phase)
			if removed := f.remove(); len(removed) != 0 || len(f.commands) != 0 {
				t.Fatalf("removal ran during %s: %v %v", phase, removed, f.commands)
			}
			for _, tree := range trees {
				if !exists(filepath.Join(tree, "server.js")) {
					t.Fatalf("%s lost during %s", tree, phase)
				}
			}
		})
	}
	for _, phase := range []string{"committed", "rolled-back", "cancelled"} {
		t.Run("removed after "+phase, func(t *testing.T) {
			f := newStageTreeFixture(t)
			trees := []string{f.leave(f.j.RequestID, "cp"), f.leave(f.j.RequestID, "ui"), f.leave("update-0", "cp"), f.leave("update-0", "ui")}
			switch phase {
			case "committed":
				if j, err := f.m.Advance(context.Background(), f.j.RequestID, false); err != nil || j.Phase != "committed" {
					t.Fatal(j.Phase, err)
				}
			case "cancelled":
				if j, err := f.m.Cancel(context.Background(), f.j.RequestID); err != nil || j.Phase != "cancelled" {
					t.Fatal(j.Phase, err)
				}
			default:
				f.setPhase(phase)
			}
			removed := f.remove()
			sort.Strings(removed)
			var want []string
			for _, tree := range trees {
				container := "youeye-control"
				if strings.HasPrefix(tree, f.roots["youeye-ui"]) {
					container = "youeye-ui"
				}
				want = append(want, container+":"+tree)
				if exists(tree) {
					t.Fatalf("%s left after the request was %s", tree, phase)
				}
			}
			sort.Strings(want)
			if !reflect.DeepEqual(removed, want) || len(f.commands) != 2 {
				t.Fatalf("removed %v with %d commands, want %v with one command per container", removed, len(f.commands), want)
			}
			for _, container := range []string{"youeye-control", "youeye-ui"} {
				if !exists(filepath.Join(f.roots[container], "opt", "app", "server.js")) {
					t.Fatal("the installed tree was touched in", container)
				}
			}
			// Nothing left: the next call (host maintenance, every day) runs no command at all.
			f.commands = nil
			if removed := f.remove(); len(removed) != 0 || len(f.commands) != 0 {
				t.Fatalf("a clean box still ran %v", f.commands)
			}
		})
	}
}

func TestCoreStageTreeRemovalIsNarrow(t *testing.T) {
	f := newStageTreeFixture(t)
	mine := f.leave(f.j.RequestID, "cp")
	if j, err := f.m.Advance(context.Background(), f.j.RequestID, false); err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	opt := filepath.Dir(mine)

	// The lifecycle hold of the finished request is still in place (its release failed): wait.
	if err := f.barrier.Begin(f.j); err != nil {
		t.Fatal(err)
	}
	if removed := f.remove(); len(removed) != 0 || len(f.commands) != 0 || !exists(mine) {
		t.Fatalf("removal ran under a lifecycle reservation: %v", removed)
	}
	if err := os.Remove(filepath.Join(f.barrier.Root, "core-reservation.json")); err != nil {
		t.Fatal(err)
	}

	// A stopped container is not started, and nothing is claimed.
	f.stopped["youeye-control"] = true
	if removed := f.remove(); len(removed) != 0 || len(f.commands) != 0 || !exists(mine) {
		t.Fatalf("removal reached a stopped container: %v %v", removed, f.commands)
	}
	f.stopped["youeye-control"] = false

	// A command that fails removes nothing and reports nothing.
	f.failRm = true
	if removed := f.remove(); len(removed) != 0 || len(f.commands) != 1 || !exists(mine) {
		t.Fatalf("a failed command was reported as a removal: %v", removed)
	}
	f.failRm, f.commands = false, nil

	// Only names that a retained receipt derives are removed: not a directory that merely looks like one, not
	// another dot directory, not a link under a stage name, and not through a receipt that names something else.
	stranger := filepath.Join(opt, ".youeye-core-"+strings.Repeat("0", 64))
	other := filepath.Join(opt, ".cache")
	for _, dir := range []string{stranger, other} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	linked := f.leave("update-linked", "cp")
	if err := os.RemoveAll(linked); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(opt, "app"), linked); err != nil {
		t.Fatal(err)
	}
	forged := CoreServiceStage{Schema: "youeye.core-service-stage.v1", RequestID: "update-forged", ManifestSHA256: f.j.ManifestSHA256, Role: "cp", ContainerUUID: "fixture",
		AppDir: filepath.Join(opt, "app"), ArtifactSHA256: strings.Repeat("e", 64), PreviousSHA256: strings.Repeat("c", 64), Phase: "swapped", StageName: ".cache"}
	if err := f.s.saveStage(forged); err != nil {
		t.Fatal(err)
	}
	removed := f.remove()
	if !reflect.DeepEqual(removed, []string{"youeye-control:" + mine}) || exists(mine) {
		t.Fatalf("removed %v, want only %s", removed, mine)
	}
	for _, kept := range []string{stranger, other, linked, filepath.Join(opt, "app", "server.js")} {
		if !exists(kept) {
			t.Fatalf("%s was removed", kept)
		}
	}
}

// The removal is ordinary lifecycle work: it stays out while a System admission is closing the gate, and a
// checkpoint that starts while it runs waits for it, as for an app operation.
func TestCoreStageTreeRemovalHoldsOrdinaryAdmission(t *testing.T) {
	f := newStageTreeFixture(t)
	mine := f.leave(f.j.RequestID, "cp")
	if j, err := f.m.Advance(context.Background(), f.j.RequestID, false); err != nil || j.Phase != "committed" {
		t.Fatal(j.Phase, err)
	}
	gate, err := f.barrier.lockFile(context.Background(), "core-admission.flock", syscall.LOCK_EX, false)
	if err != nil {
		t.Fatal(err)
	}
	if removed := f.remove(); len(removed) != 0 || len(f.commands) != 0 || !exists(mine) {
		t.Fatalf("removal overtook a System admission: %v", removed)
	}
	gate()
	held := false
	f.during = func() {
		if unlock, err := f.barrier.lockFile(context.Background(), "core-lifecycle.flock", syscall.LOCK_EX, false); err == nil {
			unlock()
		} else {
			held = true
		}
	}
	if removed := f.remove(); len(removed) != 1 || exists(mine) || !held {
		t.Fatalf("removed %v, lifecycle admission held during the command: %v", removed, held)
	}
	unlock, err := f.barrier.lockFile(context.Background(), "core-lifecycle.flock", syscall.LOCK_EX, false)
	if err != nil {
		t.Fatal("removal kept the lifecycle admission:", err)
	}
	unlock()
}
