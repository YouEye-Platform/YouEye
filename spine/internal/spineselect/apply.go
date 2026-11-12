package spineselect

import (
	"context"
	"fmt"
	"time"
)

// TrialHooks restart the API service and check that the trial is healthy.
type TrialHooks struct {
	Restart func(ctx context.Context) error
	// Healthy returns nil once the restarted service runs entry and answers.
	Healthy func(ctx context.Context, e Entry) error
	Wait    time.Duration // health deadline, default 60 s
}

// ApplyTrial stages src as e, runs it as the slot's trial, and commits it when
// healthy within the deadline. Otherwise it aborts the trial and restarts the
// service on the slot's previous choice. The selection survives reboots.
func ApplyTrial(ctx context.Context, root, slot, src string, e Entry, hooks TrialHooks) error {
	host := ThisHost()
	if err := Compatible(e, host); err != nil {
		return err
	}
	if err := Stage(root, src, e); err != nil {
		return err
	}
	if err := BeginTrial(root, slot, e, host, time.Now()); err != nil {
		return err
	}
	fail := func(cause error) error {
		if err := Abort(root, slot, time.Now()); err != nil {
			return fmt.Errorf("%v; and the trial could not be aborted: %w", cause, err)
		}
		if err := hooks.Restart(ctx); err != nil {
			return fmt.Errorf("%v; restarting the previous Spine failed: %w", cause, err)
		}
		return fmt.Errorf("Spine %s did not become healthy and was rolled back: %w", e.Version, cause)
	}
	if err := hooks.Restart(ctx); err != nil {
		return fail(err)
	}
	wait := hooks.Wait
	if wait == 0 {
		wait = 60 * time.Second
	}
	deadline := time.Now().Add(wait)
	var last error
	for {
		if last = hooks.Healthy(ctx, e); last == nil {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return fail(last)
		}
		time.Sleep(2 * time.Second)
	}
	return Commit(root, slot, e.SHA256, time.Now())
}
