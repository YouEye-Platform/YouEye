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

	"github.com/youeye-platform/YouEye/releasecache"
)

// CorePruneResult says what PruneFinished removed and what it kept.
type CorePruneResult struct {
	// Kept: the requests whose checkpoint and receipts stay (the current
	// request and the last good checkpoint).
	Kept []string `json:"kept"`
	// Pruned: the finished requests it removed something of.
	Pruned []string `json:"pruned"`
	// RootSnapshots are Incus snapshots of youeye-control and youeye-ui,
	// FileSnapshots held ZFS snapshots, Archives directories of SQL dumps,
	// Receipts files and directories on State, Blobs cached release files and
	// PayloadIndexes file lists of service payloads.
	RootSnapshots  int `json:"container_snapshots"`
	FileSnapshots  int `json:"file_snapshots"`
	Archives       int `json:"database_archive_sets"`
	Receipts       int `json:"receipts"`
	Blobs          int `json:"cached_release_files"`
	PayloadIndexes int `json:"payload_indexes"`
	// Left: what could not be removed or identified; it is tried again after
	// the next request.
	Left []string `json:"left,omitempty"`
	// Skipped: why nothing was looked at ("" when it ran).
	Skipped string `json:"skipped,omitempty"`
}

func (r CorePruneResult) removed() int {
	return r.RootSnapshots + r.FileSnapshots + r.Archives + r.Receipts + r.Blobs + r.PayloadIndexes
}

// Changed: something was removed, or something is left for the next time.
func (r CorePruneResult) Changed() bool { return r.removed() > 0 || len(r.Left) > 0 }

// String is the one line the coordinator logs.
func (r CorePruneResult) String() string {
	if r.Skipped != "" {
		return "nothing pruned: " + r.Skipped
	}
	line := fmt.Sprintf("pruned %d finished request(s): %d container snapshot(s), %d file snapshot(s), %d database archive set(s), %d receipt(s), %d cached release file(s), %d payload index(es)",
		len(r.Pruned), r.RootSnapshots, r.FileSnapshots, r.Archives, r.Receipts, r.Blobs, r.PayloadIndexes)
	if len(r.Kept) > 0 {
		line += "; kept the checkpoint of " + strings.Join(r.Kept, ", ")
	}
	if len(r.Left) > 0 {
		line += "; left for the next time: " + strings.Join(r.Left, "; ")
	}
	return line
}

// PruneFinished removes what finished System updates left behind. Without it
// every update kept two Incus root snapshots (youeye-control, youeye-ui), a
// held ZFS snapshot of each platform dataset, the SQL dumps under
// state/core-checkpoints/ on Data, its downloaded release files in the cache
// and its receipts on State, for ever.
//
// What stays:
//
//   - everything of the current request (the journal), whatever its phase;
//   - the last good checkpoint: of all committed requests whose checkpoint was
//     captured completely, the one that installed the newest release (by line
//     and sequence, never by a clock). After an ordinary update that is the
//     current request. After a promotion, a cancelled or a rolled-back request
//     (none of which leaves a good checkpoint of its own) it is an earlier one;
//   - every request's journal (requests/) and release document (targets/):
//     they keep a repeated request ID from ever becoming a new update, and are
//     a few kilobytes each;
//   - the cached files and payload indexes of the installed release and of the
//     current request's target and previous release.
//
// It runs only while nothing owns the platform: the current request has ended
// (committed, cancelled or rolled back), no System or copy reservation exists
// and the coordinator lock is free. Only one request can be unfinished at a
// time and that is the current one, so no in-flight request and no request
// that can still be rolled back loses anything: a request that needs recovery,
// is recovering or waits for a restart keeps every checkpoint on the box.
//
// It holds the coordinator lock for one finished request at a time (deleting
// its snapshots can take a minute) and lets go of it in between. Whoever finds
// the lock busy is told that it is the pruning (ErrCorePruning) and leaves a
// request to yield (lock.wanted beside the lock); the pruning looks for it
// after every request and ends its run there, so a System update that the
// owner starts, or cancels, meanwhile waits for one request at most. What is
// left is removed by the next run. Until 0.6.15 the lock was held for the
// whole run, up to 30 minutes on a box with many old checkpoints, and staging
// answered "core update is already running"; and a first cut of the gap let go
// of the lock for less than a millisecond, which a waiter that tries twice a
// second never met. Every hold decides again from what is on the box: what to
// keep is never carried over a moment in which a request could have started.
// When one has, the rest waits for the next run.
//
// Every snapshot is identified from the request's own checkpoint record and
// checked for this request's ownership mark before it is deleted; a snapshot
// that cannot be read or does not carry the mark is left, with its record, and
// reported. Best effort: no error changes anything about a request.
func (r NativeCoreRuntime) PruneFinished(ctx context.Context) CorePruneResult {
	var out CorePruneResult
	tried := map[string]bool{}
	m := CoreManager{Root: r.Root}
	for first := true; r.pruneNext(ctx, &out, tried, first); first = false {
		if ctx.Err() != nil {
			out.Left = append(out.Left, "the rest (the time for pruning ended)")
			break
		}
		if m.pruneYieldAsked() {
			out.Left = append(out.Left, "the rest (a System update or cancel is waiting for the coordinator)")
			break
		}
	}
	sort.Strings(out.Pruned)
	return out
}

// pruneNext takes the coordinator lock once, decides what stays and removes
// what one finished request left (one that is not in tried), or, when none is
// left, the cached files no release on the box needs. It reports whether it
// should be called again. first is the first hold of a run: only that one
// says what was kept, what could not be read and why nothing was looked at.
func (r NativeCoreRuntime) pruneNext(ctx context.Context, out *CorePruneResult, tried map[string]bool, first bool) bool {
	m := CoreManager{Root: r.Root}
	stop := func(why string) bool {
		if first {
			out.Skipped = why
		} else {
			out.Left = append(out.Left, "the rest ("+why+")")
		}
		return false
	}
	if !r.Services.coreNoUnfinishedRequest() {
		return stop("a System request is unfinished or the platform is reserved")
	}
	// The hold carries the mark that tells others what it is.
	unlock, err := m.lockCoreForPrune(first)
	if err != nil {
		return stop("the coordinator is at work")
	}
	defer unlock()
	// Read again under the lock: nothing can start now.
	if !r.Services.coreNoUnfinishedRequest() {
		return stop("a System request is unfinished or the platform is reserved")
	}
	receipt, err := m.ReadReceipt()
	if err != nil {
		return stop("the installed release cannot be read")
	}
	current, err := m.Read()
	hasCurrent := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return stop("the current request cannot be read")
	}
	finished := []CoreJournal{}
	entries, err := os.ReadDir(filepath.Join(m.Root, "requests"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return stop("the retained requests cannot be listed")
	}
	left := func(what string) {
		if first {
			out.Left = append(out.Left, what)
		}
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		j, err := m.readRetainedForPrune(entry.Name())
		if err != nil {
			left("an unreadable retained request")
			continue
		}
		if hasCurrent && j.RequestID == current.RequestID {
			continue
		}
		// Only the current request can be unfinished. A retained one that says
		// otherwise is not understood, and nothing of it is touched.
		if j.Phase != "committed" && j.Phase != "cancelled" && j.Phase != "rolled-back" {
			left("a retained request that never ended")
			continue
		}
		finished = append(finished, j)
	}
	// The last good checkpoint.
	good := func(j CoreJournal) bool {
		if j.Phase != "committed" || j.NoOp || j.MetadataOnly {
			return false
		}
		record, err := r.Checkpoint.Read(j)
		return err == nil && record.Phase == "captured"
	}
	best := -1
	for i, j := range finished {
		if good(j) && (best < 0 || releasecache.CompareReleases(j.Target.Key(), finished[best].Target.Key()) > 0) {
			best = i
		}
	}
	if hasCurrent {
		if good(current) && (best < 0 || releasecache.CompareReleases(current.Target.Key(), finished[best].Target.Key()) >= 0) {
			best = -1 // the current request's checkpoint is the last good one
		}
	}
	if first {
		if hasCurrent {
			out.Kept = append(out.Kept, current.RequestID)
		}
		if best >= 0 {
			out.Kept = append(out.Kept, finished[best].RequestID)
		}
	}
	for i, j := range finished {
		if i == best || tried[j.RequestID] {
			continue
		}
		tried[j.RequestID] = true
		before := out.removed()
		r.pruneRequest(ctx, j, out)
		if out.removed() != before {
			out.Pruned = append(out.Pruned, j.RequestID)
		}
		return true
	}
	// Cached release files and payload indexes of releases that are neither
	// installed nor part of the current request.
	blobs, indexes := map[string]bool{}, map[string]bool{}
	releases := []releasecache.CoreRelease{receipt.Release}
	if hasCurrent {
		releases = append(releases, current.Target, current.Previous.Release)
	}
	for _, release := range releases {
		for _, member := range release.Members {
			for _, blob := range member.Blobs() {
				blobs[blob.SHA256] = true
			}
			indexes[member.Artifact.SHA256] = true
		}
	}
	out.Blobs += r.pruneCache(blobs, out)
	out.PayloadIndexes += pruneNamedFiles(filepath.Join(m.Root, "payloads"), ".json", indexes)
	return false
}

// readRetainedForPrune reads a retained request journal for pruning only. A
// journal is retained (requests/) when the next request is prepared, which
// Prepare refuses unless it has ended, and its file name is the digest of its
// request ID. That, the schema and the identities are checked here. The
// release document it names is not: a journal written by an earlier Spine,
// whose document today's reader may refuse or which is gone, must not keep its
// snapshots for ever. Nothing read this way is ever advanced or resumed.
func (m CoreManager) readRetainedForPrune(name string) (CoreJournal, error) {
	var j CoreJournal
	raw, err := ReadCoreState(filepath.Join(m.Root, "requests", name), 4<<20)
	if err != nil {
		return j, err
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		return j, err
	}
	if j.Schema != CoreJournalSchema || !coreRequestPattern.MatchString(j.RequestID) || !validSHA256(j.ManifestSHA256) || name != filepath.Base(m.requestPath(j.RequestID)) {
		return j, fmt.Errorf("invalid retained core journal")
	}
	for _, steps := range [][]CoreStep{j.Steps, j.RecoverySteps} {
		for _, step := range steps {
			if !coreContainerName.MatchString(step.Name) || step.RequestID != j.RequestID+"/"+step.Name {
				return j, fmt.Errorf("invalid retained core journal step")
			}
		}
	}
	return j, nil
}

// pruneRequest removes one finished request's snapshots, archives and
// receipts. The checkpoint record goes last and only when every snapshot it
// names is gone: it is the only place that names them.
func (r NativeCoreRuntime) pruneRequest(ctx context.Context, j CoreJournal, out *CorePruneResult) {
	p := r.Checkpoint
	// A reservation that still names the request means its release has not
	// ended, whatever its journal says.
	if reservation, err := (CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}).Read(); !errors.Is(err, os.ErrNotExist) && (err != nil || reservation.RequestID == j.RequestID) {
		out.Left = append(out.Left, "a request that still holds the platform")
		return
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(j.RequestID)))
	recordDir := filepath.Dir(p.recordPath(j.RequestID))
	snapshotsGone := true
	if _, err := os.Lstat(recordDir); err == nil {
		record, err := p.Read(j)
		if err != nil {
			// Unreadable: its snapshots cannot be named. Keep the directory.
			snapshotsGone = false
			out.Left = append(out.Left, "a checkpoint record that cannot be read")
		} else {
			for _, c := range record.Inventory.Containers {
				if c.Snapshot == "" {
					continue
				}
				removed, err := p.pruneRootSnapshot(ctx, j, c)
				if err != nil {
					snapshotsGone = false
					out.Left = append(out.Left, "a container snapshot of "+c.Name)
				} else if removed {
					out.RootSnapshots++
				}
			}
			for _, file := range record.FileSnapshots {
				removed, err := p.pruneFilesSnapshot(ctx, record.Inventory, file)
				if err != nil {
					snapshotsGone = false
					out.Left = append(out.Left, "a file snapshot of "+file.Dataset)
				} else if removed {
					out.FileSnapshots++
				}
			}
		}
		if snapshotsGone && removeOwnedTree(recordDir) {
			out.Receipts++
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		snapshotsGone = false
	}
	// The SQL dumps are files under a directory named by the request alone.
	if filepath.IsAbs(p.DataRoot) && removeOwnedTree(filepath.Join(p.DataRoot, "state", "core-checkpoints", hash)) {
		out.Archives++
	}
	// Receipts of the request's actions, their runner units and its continuations.
	executor := NativeCoreExecutor{Root: r.Root}
	for _, steps := range [][]CoreStep{j.Steps, j.RecoverySteps} {
		for _, step := range steps {
			action := executor.actionPath(step)
			for _, path := range []string{action, action + ".lock"} {
				if os.Remove(path) == nil {
					out.Receipts++
				}
			}
			if removeOwnedTree(filepath.Join(r.Root, "runners", r.Runner.unit(j, step))) {
				out.Receipts++
			}
		}
	}
	controllers := filepath.Join(r.Root, "controllers")
	entries, _ := os.ReadDir(controllers)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "youeye-core-control-") || !strings.HasSuffix(name, ".service.json") {
			continue
		}
		var receipt CoreControlReceipt
		raw, err := ReadCoreState(filepath.Join(controllers, name), 16384)
		if err != nil || json.Unmarshal(raw, &receipt) != nil || receipt.RequestID != j.RequestID || receipt.Unit+".json" != name {
			continue
		}
		for _, path := range []string{filepath.Join(controllers, name), filepath.Join(controllers, name+".lock")} {
			if os.Remove(path) == nil {
				out.Receipts++
			}
		}
	}
}

// pruneRootSnapshot deletes the request's snapshot of one container. It
// reports false without an error when there is nothing to delete: the
// container is gone or was replaced (its snapshots went with it), or the
// snapshot is already deleted. A snapshot under the request's name that does
// not carry the request's mark is foreign: an error, and nothing is deleted.
func (p NativeCoreCheckpoint) pruneRootSnapshot(ctx context.Context, j CoreJournal, c CoreCheckpointContainer) (bool, error) {
	if !coreContainerName.MatchString(c.Name) || c.Snapshot != coreCheckpointSnapshot(j.RequestID) {
		return false, fmt.Errorf("checkpoint record names a foreign snapshot")
	}
	find := func() (bool, error) {
		raw, err := p.capture(ctx, "incus", "list", "--format=json")
		if err != nil {
			return false, err
		}
		var instances []struct {
			Name   string            `json:"name"`
			Config map[string]string `json:"config"`
		}
		if json.Unmarshal(raw, &instances) != nil {
			return false, fmt.Errorf("container inventory is unreadable")
		}
		present := false
		for _, instance := range instances {
			present = present || (instance.Name == c.Name && instance.Config["volatile.uuid"] == c.UUID)
		}
		if !present {
			return false, nil
		}
		raw, err = p.capture(ctx, "incus", "query", "/1.0/instances/"+c.Name+"/snapshots?recursion=1")
		if err != nil {
			return false, err
		}
		var snapshots []coreSnapshotObservation
		if json.Unmarshal(raw, &snapshots) != nil {
			return false, fmt.Errorf("root snapshot inventory is unreadable")
		}
		for _, snapshot := range snapshots {
			if snapshot.Name != c.Snapshot {
				continue
			}
			if snapshot.Config["user.youeye.core-request"] != j.RequestID || snapshot.Config["volatile.uuid"] != c.UUID {
				return false, fmt.Errorf("root snapshot is foreign")
			}
			return true, nil
		}
		return false, nil
	}
	exists, err := find()
	if err != nil || !exists {
		return false, err
	}
	_, _ = p.capture(ctx, "incus", "snapshot", "delete", c.Name, c.Snapshot)
	exists, err = find()
	if err != nil {
		return false, err
	}
	if exists {
		return false, fmt.Errorf("root snapshot was not deleted")
	}
	return true, nil
}

// pruneFilesSnapshot releases the request's hold on one ZFS snapshot and
// destroys it. The snapshot must carry the request's owner property
// (observeFilesSnapshot); an absent one is already gone.
func (p NativeCoreCheckpoint) pruneFilesSnapshot(ctx context.Context, inventory CoreCheckpointInventory, file CoreFilesCheckpoint) (bool, error) {
	_, exists, err := p.observeFilesSnapshot(ctx, inventory, file.Dataset, file.Snapshot)
	if err != nil || !exists {
		return false, err
	}
	name := file.Dataset + "@" + file.Snapshot
	// The hold's tag is the snapshot's name (holdFilesSnapshot). Releasing a
	// hold that is not there fails; the destroy decides.
	_, _ = p.capture(ctx, "zfs", "release", file.Snapshot, name)
	_, _ = p.capture(ctx, "zfs", "destroy", name)
	_, exists, err = p.observeFilesSnapshot(ctx, inventory, file.Dataset, file.Snapshot)
	if err != nil {
		return false, err
	}
	if exists {
		return false, fmt.Errorf("file snapshot was not destroyed")
	}
	return true, nil
}

// pruneCache removes cached release files that keep does not name. It takes
// the cache's own lock, so it never runs beside a download.
func (r NativeCoreRuntime) pruneCache(keep map[string]bool, out *CorePruneResult) int {
	if !filepath.IsAbs(r.Cache.Root) {
		return 0
	}
	lock, err := os.OpenFile(filepath.Join(r.Cache.Root, "lock"), os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return 0 // no cache yet
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		out.Left = append(out.Left, "the release cache (in use)")
		return 0
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return pruneNamedFiles(filepath.Join(r.Cache.Root, "blobs"), "", keep)
}

// pruneNamedFiles removes the regular files in dir whose name is a SHA-256
// (plus suffix) that keep does not hold. Anything else in dir is left.
func pruneNamedFiles(dir, suffix string, keep map[string]bool) int {
	removed := 0
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		digest, ok := strings.CutSuffix(entry.Name(), suffix)
		if !ok || !validSHA256(digest) || keep[digest] || !entry.Type().IsRegular() {
			continue
		}
		if os.Remove(filepath.Join(dir, entry.Name())) == nil {
			removed++
		}
	}
	return removed
}

// removeOwnedTree removes a directory that is a real directory (never through
// a link). It reports whether something was removed.
func removeOwnedTree(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	return os.RemoveAll(path) == nil
}
