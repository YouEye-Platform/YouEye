package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"
)

const CoreAppLifecycleRoot = "/var/lib/youeye/state/app-updates"

type CoreLifecycleReservation struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// CoreLifecycleBarrier shares a kernel flock with CP's app/backup/container
// admission. The exclusive lock waits for ordinary work to settle; the durable
// reservation then keeps new work excluded across process loss and reboot.
type CoreLifecycleBarrier struct{ Root string }

func (b CoreLifecycleBarrier) lock() (func(), error) {
	return b.lockMode(syscall.LOCK_EX)
}

func (b CoreLifecycleBarrier) lockMode(mode int) (func(), error) {
	return b.lockFile(context.Background(), "core-lifecycle.flock", mode, false)
}

// The admission gate is held only while acquiring the lifecycle lease. An
// exclusive waiter closes it before draining existing readers, so background
// reconciliation cannot continually overtake a System checkpoint.
func (b CoreLifecycleBarrier) lockFile(ctx context.Context, name string, mode int, wait bool) (func(), error) {
	if !filepath.IsAbs(b.Root) {
		return nil, fmt.Errorf("absolute app lifecycle root required")
	}
	if err := os.MkdirAll(b.Root, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(b.Root)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("unsafe app lifecycle directory")
	}
	fd, err := syscall.Open(filepath.Join(b.Root, name), syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "core-lifecycle.flock")
	info, err = f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	stat, ok = info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() != 0 || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() {
		f.Close()
		return nil, fmt.Errorf("unsafe app lifecycle lock")
	}
	for {
		if err := ctx.Err(); err != nil {
			f.Close()
			return nil, err
		}
		err = syscall.Flock(fd, mode|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !wait || (!errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN)) {
			f.Close()
			return nil, fmt.Errorf("active app lifecycle work must settle before System activation: %w", err)
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			f.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	current, err := os.Lstat(filepath.Join(b.Root, name))
	if err != nil || !os.SameFile(info, current) {
		f.Close()
		return nil, fmt.Errorf("app lifecycle lock changed during admission")
	}
	return func() { _ = syscall.Flock(fd, syscall.LOCK_UN); _ = f.Close() }, nil
}

// AdmitOrdinary is the native counterpart of CP's shared admission. Hold the
// returned lease through the entire asynchronous operation, including cleanup.
func (b CoreLifecycleBarrier) AdmitOrdinary() (func(), error) {
	gate, err := b.lockFile(context.Background(), "core-admission.flock", syscall.LOCK_SH, false)
	if err != nil {
		return nil, err
	}
	defer gate()
	release, err := b.lockMode(syscall.LOCK_SH)
	if err != nil {
		return nil, err
	}
	_, err = b.Read()
	if !errors.Is(err, os.ErrNotExist) {
		release()
		return nil, fmt.Errorf("System update or recovery owns the platform lifecycle")
	}
	return release, nil
}

func (b CoreLifecycleBarrier) Read() (CoreLifecycleReservation, error) {
	var r CoreLifecycleReservation
	raw, err := ReadCoreState(filepath.Join(b.Root, "core-reservation.json"), 4096)
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, err
	}
	if r.Schema != "youeye.core-lifecycle.v1" || !coreRequestPattern.MatchString(r.RequestID) || !validSHA256(r.ManifestSHA256) {
		return r, fmt.Errorf("invalid System lifecycle reservation")
	}
	return r, nil
}

func (b CoreLifecycleBarrier) Begin(j CoreJournal) error {
	return b.begin(context.Background(), j, false, nil)
}

// BeginContext bounds native admission even if its caller has no deadline.
// Authorization is repeated under exclusive admission, immediately before the
// durable reservation. Cancellation never clears another owner's reservation.
func (b CoreLifecycleBarrier) BeginContext(ctx context.Context, j CoreJournal, authorize func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return b.begin(ctx, j, true, authorize)
}

func (b CoreLifecycleBarrier) begin(ctx context.Context, j CoreJournal, wait bool, authorize func(context.Context) error) error {
	if !coreRequestPattern.MatchString(j.RequestID) || !validSHA256(j.ManifestSHA256) {
		return fmt.Errorf("exact core lifecycle identity required")
	}
	gate, err := b.lockFile(ctx, "core-admission.flock", syscall.LOCK_EX, wait)
	if err != nil {
		return err
	}
	defer gate()
	unlock, err := b.lockFile(ctx, "core-lifecycle.flock", syscall.LOCK_EX, wait)
	if err != nil {
		return err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if authorize != nil {
		if err := authorize(ctx); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	want := CoreLifecycleReservation{Schema: "youeye.core-lifecycle.v1", RequestID: j.RequestID, ManifestSHA256: j.ManifestSHA256}
	old, err := b.Read()
	if err == nil {
		if old != want {
			return fmt.Errorf("another System transaction owns the platform lifecycle")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := b.checkNativeMaintenance(); err != nil {
		return err
	}
	// No app process may be active now. Unfinished durable receipts still
	// reserve their data, even after a crash released every OS lock.
	entries, err := os.ReadDir(filepath.Join(b.Root, "operations"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := ReadCoreState(filepath.Join(b.Root, "operations", entry.Name()), 4<<20)
		if err != nil {
			return err
		}
		var record struct {
			Schema          string `json:"schema"`
			Phase           string `json:"phase"`
			CleanupComplete bool   `json:"cleanupComplete"`
			Commit          *struct {
				VerifiedAt string `json:"verifiedAt"`
			} `json:"commit"`
			RollbackVerifiedAt string `json:"rollbackVerifiedAt"`
		}
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record.Schema != "youeye.app-update.v1" || !record.CleanupComplete || record.Phase != "cleanup" || ((record.Commit == nil || record.Commit.VerifiedAt == "") && record.RollbackVerifiedAt == "") {
			return fmt.Errorf("unfinished app update must complete recovery before System activation")
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := json.Marshal(want)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(b.Root, "core-reservation.json"), raw, 0600)
}

func (b CoreLifecycleBarrier) checkNativeMaintenance() error {
	// Interrupted container changes remain owned after their process disappears.
	dir := filepath.Join(filepath.Dir(b.Root), "container-maintenance", "operations")
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := ReadCoreState(filepath.Join(dir, entry.Name()), 1<<20)
		if err != nil {
			return err
		}
		var r struct {
			Schema      string `json:"schema"`
			State       string `json:"state"`
			CompletedAt string `json:"completedAt"`
		}
		if json.Unmarshal(raw, &r) != nil || r.Schema != "youeye.container-maintenance/1" || r.State != "completed" || r.CompletedAt == "" {
			return fmt.Errorf("unfinished container maintenance must be reconciled before System activation")
		}
	}
	// The native backup pipeline holds shared admission while live. Its durable
	// nonterminal/failed status must also be reconciled after process loss.
	raw, err := ReadCoreState(filepath.Join(filepath.Dir(filepath.Dir(b.Root)), "backup-status.json"), 1<<20)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var status struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &status) != nil || (status.Status != "idle" && status.Status != "completed") {
		return fmt.Errorf("native backup requires settlement before System activation")
	}
	return nil
}

// ReleaseCommitted accepts only the coordinator's exact independently read
// committed receipt. No PID expiry or force flag can release a reservation.
func (b CoreLifecycleBarrier) ReleaseCommitted(m CoreManager, requestID string) error {
	return b.releaseCompleted(m, requestID, false)
}

// ReleaseRecovered never clears the hold merely because rollback was requested.
// Native paired restore, host recovery and authenticated health must all pass,
// and the exact previous machine receipt must remain installed.
func (b CoreLifecycleBarrier) ReleaseRecovered(m CoreManager, requestID string) error {
	return b.releaseCompleted(m, requestID, true)
}

func (b CoreLifecycleBarrier) releaseCompleted(m CoreManager, requestID string, recovered bool) error {
	unlock, err := b.lock()
	if err != nil {
		return err
	}
	defer unlock()
	r, err := b.Read()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	j, err := m.Read()
	if err != nil {
		return err
	}
	receipt, err := m.ReadReceipt()
	if err != nil {
		return err
	}
	complete := j.Phase == "committed" && receipt.ManifestSHA256 == j.ManifestSHA256 && receipt.Machine == j.Previous.Machine
	if recovered {
		complete = j.Phase == "rolled-back" && reflect.DeepEqual(receipt, j.Previous)
	}
	if r.RequestID != requestID || j.RequestID != requestID || r.ManifestSHA256 != j.ManifestSHA256 || !complete {
		return fmt.Errorf("System lifecycle is not verifiably committed")
	}
	if err := os.Remove(filepath.Join(b.Root, "core-reservation.json")); err != nil {
		return err
	}
	return syncDirectory(b.Root)
}
