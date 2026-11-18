package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

var coreStageTreeName = regexp.MustCompile(`^\.youeye-core-[0-9a-f]{64}$`)

// coreStageTreeBatch bounds the paths of one removal command.
const coreStageTreeBatch = 32

// RemoveFinishedStageTrees deletes the old service trees that finished requests
// left in youeye-control and youeye-ui. Replacing a member exchanges the
// application directory with the staged tree, so the old tree stays next to it
// under the request's stage name (.youeye-core-<sha256(request, role)>). Nothing
// reads it after the exchange: recovery restores the container root snapshots,
// which also drops the stage directory of the request being rolled back.
//
// It acts only while no System request is unfinished: the journal is absent or
// committed, cancelled or rolled back, and no System or copy reservation holds
// the platform. A request that is prepared, applying, awaiting a restart, in
// needs-recovery, recovering or cancelling keeps every directory. The names
// come from the retained stage receipts, never from a listing, and a request
// identity is never reused, so a request that starts while this runs cannot own
// any of them. While it removes, it holds the shared lifecycle admission that
// app, container and backup work holds, so a checkpoint waits for it like for
// any ordinary operation. A container that is not running is left for the next
// call; none is started. Best effort: the returned list says what was removed,
// and no error changes anything about a request.
func (s NativeCoreServices) RemoveFinishedStageTrees(ctx context.Context) []string {
	return s.removeFinishedStageTrees(ctx, nativeCoreContainerPID)
}

// coreNoUnfinishedRequest: nothing owns the platform lifecycle and the current
// request, if any, has ended. Unreadable state counts as unfinished.
func (s NativeCoreServices) coreNoUnfinishedRequest() bool {
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err == nil && j.Phase != "committed" && j.Phase != "cancelled" && j.Phase != "rolled-back" {
		return false
	}
	// An independent copy that is being prepared owns this installation, as it does for the coordinator.
	if copy, err := m.readCopy(); (err == nil && copy.Phase != "committed") || (err != nil && !errors.Is(err, os.ErrNotExist)) {
		return false
	}
	barrier := CoreLifecycleBarrier{Root: filepath.Join(s.Checkpoint.DataRoot, "state", "app-updates")}
	if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	_, err = barrier.ReadCopy()
	return errors.Is(err, os.ErrNotExist)
}

type coreStageTree struct{ container, appDir, name string }

func (t coreStageTree) path() string { return path.Join(path.Dir(t.appDir), t.name) }

// finishedStageTrees lists the stage directories named by retained receipts.
// Every field is checked against the name the request and role derive.
func (s NativeCoreServices) finishedStageTrees() []coreStageTree {
	root := filepath.Join(s.Checkpoint.Root, "services")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var trees []coreStageTree
	for _, entry := range entries {
		if !entry.IsDir() || len(entry.Name()) != 64 || !isLowerHex(entry.Name()) {
			continue
		}
		for _, role := range []string{"cp", "ui"} {
			raw, err := ReadCoreState(filepath.Join(root, entry.Name(), role+".json"), 64<<10)
			if err != nil {
				continue
			}
			var stage CoreServiceStage
			if json.Unmarshal(raw, &stage) != nil || stage.Schema != "youeye.core-service-stage.v1" || stage.Role != role || !coreRequestPattern.MatchString(stage.RequestID) {
				continue
			}
			if entry.Name() != fmt.Sprintf("%x", sha256.Sum256([]byte(stage.RequestID))) || stage.StageName != fmt.Sprintf(".youeye-core-%x", sha256.Sum256([]byte(stage.RequestID+"\x00"+role))) || !coreStageTreeName.MatchString(stage.StageName) {
				continue
			}
			if !path.IsAbs(stage.AppDir) || path.Clean(stage.AppDir) != stage.AppDir || stage.AppDir == "/" || strings.ContainsAny(stage.AppDir, "\x00\r\n\\") {
				continue
			}
			container := "youeye-control"
			if role == "ui" {
				container = "youeye-ui"
			}
			trees = append(trees, coreStageTree{container: container, appDir: stage.AppDir, name: stage.StageName})
		}
	}
	sort.Slice(trees, func(a, b int) bool {
		if trees[a].container != trees[b].container {
			return trees[a].container < trees[b].container
		}
		return trees[a].name < trees[b].name
	})
	return trees
}

// coreStageTreesPresent returns the trees that exist as real directories in
// the running container. It only reads, through descriptors anchored to the
// container's init process. It reports false when the container cannot be
// observed (it is stopped, or Incus does not answer).
func coreStageTreesPresent(ctx context.Context, container string, trees []coreStageTree, observe func(context.Context, string) (int, error)) ([]coreStageTree, bool) {
	if len(trees) == 0 {
		return nil, true
	}
	pid, err := observe(ctx, container)
	if err != nil {
		return nil, false
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return nil, false
	}
	defer root.Close()
	var present []coreStageTree
	for _, tree := range trees {
		// The parent of the application directory, opened without following links.
		parent, _, err := corePayloadParent(root, strings.TrimPrefix(tree.appDir, "/"))
		if err != nil {
			continue
		}
		var stat unix.Stat_t
		err = unix.Fstatat(int(parent.Fd()), tree.name, &stat, unix.AT_SYMLINK_NOFOLLOW)
		parent.Close()
		if err == nil && stat.Mode&unix.S_IFMT == unix.S_IFDIR {
			present = append(present, tree)
		}
	}
	return present, true
}

func (s NativeCoreServices) removeFinishedStageTrees(ctx context.Context, observe func(context.Context, string) (int, error)) []string {
	if !filepath.IsAbs(s.Checkpoint.Root) || !filepath.IsAbs(s.Checkpoint.DataRoot) || !s.coreNoUnfinishedRequest() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer cancel()
	byContainer := map[string][]coreStageTree{}
	for _, tree := range s.finishedStageTrees() {
		byContainer[tree.container] = append(byContainer[tree.container], tree)
	}
	removed := []string{}
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	for _, container := range []string{"youeye-control", "youeye-ui"} {
		present, _ := coreStageTreesPresent(ctx, container, byContainer[container], observe)
		if len(present) > 0 && release == nil {
			// Ordinary work: refused while a System update or a copy owns the lifecycle, and a System
			// admission that starts now waits until this is done.
			lease, err := (CoreLifecycleBarrier{Root: filepath.Join(s.Checkpoint.DataRoot, "state", "app-updates")}).AdmitOrdinary()
			if err != nil {
				return removed
			}
			release = lease
		}
		for len(present) > 0 {
			batch := present
			if len(batch) > coreStageTreeBatch {
				batch = batch[:coreStageTreeBatch]
			}
			present = present[len(batch):]
			// Checked again before every command: a request that started meanwhile
			// is about to stop these containers, and nothing here is urgent.
			if ctx.Err() != nil || !s.coreNoUnfinishedRequest() {
				return removed
			}
			args := []string{"exec", container, "--mode=non-interactive", "--", "rm", "-rf", "--one-file-system", "--"}
			for _, tree := range batch {
				args = append(args, tree.path())
			}
			// The postcondition decides, not the command's acknowledgement.
			_, _ = s.Checkpoint.capture(ctx, "incus", args...)
			still, observed := coreStageTreesPresent(ctx, container, batch, observe)
			if !observed {
				break // the container went away; the next call looks again
			}
			left := map[string]bool{}
			for _, tree := range still {
				left[tree.name] = true
			}
			for _, tree := range batch {
				if !left[tree.name] {
					removed = append(removed, container+":"+tree.path())
				}
			}
		}
	}
	return removed
}
