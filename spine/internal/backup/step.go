package backup

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// StepCeiling is the longest one backup or restore step of the API may run: the archive restore, the volume
// restore, the Incus prepare and import, and the drive store and import. The Control Panel waits for each of
// them while it holds the platform lifecycle lock and the backup operation lock, and the commands they run
// (tar, cp, incus, restic, openssl) have no end of their own: a hung incusd or a stalled drive kept the
// handler, and with it both locks, for ever. It matches the longest wait of a Control Panel restart
// (controlRestartMaxWait in internal/api) and is far longer than any real step.
const StepCeiling = 6 * time.Hour

var (
	// stepCeiling is StepCeiling; a test shortens it.
	stepCeiling = StepCeiling
	// stepStopGrace is how long a command gets to stop after SIGTERM before it is killed. restic removes its
	// repository lock on SIGTERM.
	stepStopGrace = 30 * time.Second
	// stepAbandonWait is how long a killed command is waited for. One stuck in the kernel (a read from a dead
	// drive) can ignore SIGKILL; the step then answers without it.
	stepAbandonWait = 30 * time.Second
	// stepCleanupLimit bounds a command that undoes part of a failed step. It runs after the step's context
	// has ended, so it gets a short one of its own.
	stepCleanupLimit = 2 * time.Minute
	// stepCleanupTotal bounds all the cleanup commands of one failed step together, however many objects it
	// has to undo: the Control Panel waits StepCeiling plus 15 minutes for the step's answer.
	stepCleanupTotal = 5 * time.Minute
	// mediaCommandLimit bounds one drive command (lsblk, mount, sync, wipefs, sgdisk …).
	mediaCommandLimit = 15 * time.Minute
	// mediaSlowCommandLimit bounds mkfs and umount, whose time grows with the drive (a large slow disk, or a
	// lot of unwritten data).
	mediaSlowCommandLimit = 60 * time.Minute
)

// mediaLimit is the limit of one drive command.
func mediaLimit(name string) time.Duration {
	if name == "umount" || strings.HasPrefix(name, "mkfs") {
		return mediaSlowCommandLimit
	}
	return mediaCommandLimit
}

// stepContext is the context one step's commands run under. It ends when the caller's does (the Control Panel
// hung up) or when StepCeiling passes.
func stepContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, stepCeiling)
}

// stepEnded says why a step's context ended; nil while it has not.
func stepEnded(ctx context.Context) error {
	switch {
	case ctx.Err() == nil:
		return nil
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("the step was stopped: it ran longer than its time limit")
	default:
		return fmt.Errorf("the step was stopped: the request ended")
	}
}

// stepCommand is a command that ends with ctx: SIGTERM first, SIGKILL after stepStopGrace.
func stepCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = stepStopGrace
	return cmd
}

// stepOutput runs a stepCommand made under ctx and returns its output (stdout and stderr, or stdout only). It
// always returns: at the latest stepStopGrace + stepAbandonWait after ctx ends, even when the command could not
// be killed. An error after ctx ended starts with the reason (stepEnded).
func stepOutput(ctx context.Context, cmd *exec.Cmd, stdoutOnly bool) ([]byte, error) {
	type result struct {
		output []byte
		err    error
	}
	done := make(chan result, 1)
	go func() {
		var r result
		if stdoutOnly {
			r.output, r.err = cmd.Output()
		} else {
			r.output, r.err = cmd.CombinedOutput()
		}
		done <- r
	}()
	finish := func(r result) ([]byte, error) {
		if ended := stepEnded(ctx); ended != nil && r.err != nil {
			return r.output, fmt.Errorf("%w (%v)", ended, r.err)
		}
		return r.output, r.err
	}
	select {
	case r := <-done:
		return finish(r)
	case <-ctx.Done():
	}
	timer := time.NewTimer(stepStopGrace + stepAbandonWait)
	defer timer.Stop()
	select {
	case r := <-done:
		return finish(r)
	case <-timer.C:
		return nil, fmt.Errorf("%w; %s could not be killed and was left behind", stepEnded(ctx), cmd.Path)
	}
}

// runStep runs one command of a step and returns its combined output.
func runStep(ctx context.Context, name string, args ...string) ([]byte, error) {
	return stepOutput(ctx, stepCommand(ctx, name, args...), false)
}

// stepCleanup runs the commands that undo part of a failed step. They run after the step's context has ended, so
// each gets stepCleanupLimit of its own, and all of one step together stepCleanupTotal, counted from the first.
type stepCleanup struct {
	ctx    context.Context
	cancel context.CancelFunc
}

func (c *stepCleanup) output(name string, args ...string) ([]byte, error) {
	if c.ctx == nil {
		c.ctx, c.cancel = context.WithTimeout(context.Background(), stepCleanupTotal)
	}
	ctx, cancel := context.WithTimeout(c.ctx, stepCleanupLimit)
	defer cancel()
	return runStep(ctx, name, args...)
}

// run runs one cleanup command, best effort.
func (c *stepCleanup) run(name string, args ...string) {
	_, _ = c.output(name, args...)
}

// succeeds runs a command that asks something (`incus … show`) and says whether it ended well.
func (c *stepCleanup) succeeds(name string, args ...string) bool {
	_, err := c.output(name, args...)
	return err == nil
}

// done frees the cleanup's timer.
func (c *stepCleanup) done() {
	if c.cancel != nil {
		c.cancel()
	}
}
