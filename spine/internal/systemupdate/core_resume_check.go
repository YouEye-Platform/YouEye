package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// CheckResume answers, for a request that waits between two steps, whether this
// Spine's continuation (`update core resume`) would get as far as its next
// step. It does, in the same order, what Advance does before its first write:
//
//   - what the core lock refuses (an independent copy owns the installation),
//     without taking the lock;
//   - the journal and its frozen target, which must be this request;
//   - the phase and graph that Advance accepts;
//   - the executor's authorisation of the request, which reads the lifecycle
//     reservation, the machine, the committed receipt, both frozen releases and
//     their compatibility with State and Data.
//
// It only reads. It does not take the core lock (taking it creates the state
// directory and the lock file, and would make a coordinator that advances at
// that moment fail), it observes no action and starts none, and it records
// nothing. Because observing a started action is not free of effects for every
// executor, it answers only between steps: a request with a started or failed
// step, or in any phase but `applying`, is refused even where `resume` would
// continue it.
//
// It returns the journal it judged.
func (m CoreManager) CheckResume(ctx context.Context, requestID string) (CoreJournal, error) {
	if m.Executor == nil {
		return CoreJournal{}, fmt.Errorf("native lifecycle executor required")
	}
	if !filepath.IsAbs(m.Root) {
		return CoreJournal{}, fmt.Errorf("core updater requires an absolute protected state directory")
	}
	// The same refusals as lockCore, by reading alone.
	if m.Root == CoreStatePath {
		if _, err := (CoreLifecycleBarrier{Root: CoreAppLifecycleRoot}).ReadCopy(); !errors.Is(err, os.ErrNotExist) {
			return CoreJournal{}, fmt.Errorf("independent copy owns the platform lifecycle")
		}
	}
	copy, err := m.readCopy()
	if (err == nil && copy.Phase != "committed") || (err != nil && !errors.Is(err, os.ErrNotExist)) {
		return CoreJournal{}, fmt.Errorf("independent copy preparation owns this installation")
	}
	j, err := m.Read()
	if err != nil {
		return j, err
	}
	if j.RequestID != requestID {
		return j, fmt.Errorf("exact core update request ID required")
	}
	if j.Phase != "applying" {
		return j, fmt.Errorf("the request is %s, not between two steps of an update", j.Phase)
	}
	if len(j.RecoverySteps) > 0 {
		return j, fmt.Errorf("core recovery owns this request; its original apply graph cannot resume")
	}
	for _, step := range j.Steps {
		if step.State == "started" || step.State == "failed" {
			return j, fmt.Errorf("%s is %s; the request is not between two steps", step.Name, step.State)
		}
	}
	if err := ctx.Err(); err != nil {
		return j, err
	}
	if err := m.Executor.Authorize(ctx, j, j.ActivationRequested); err != nil {
		return j, err
	}
	return j, nil
}
