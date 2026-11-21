package backup

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// shortStepTimes makes the step's waits short for a test.
func shortStepTimes(t *testing.T, ceiling, stopGrace, abandonWait time.Duration) {
	t.Helper()
	previousCeiling, previousGrace, previousAbandon := stepCeiling, stepStopGrace, stepAbandonWait
	stepCeiling, stepStopGrace, stepAbandonWait = ceiling, stopGrace, abandonWait
	t.Cleanup(func() { stepCeiling, stepStopGrace, stepAbandonWait = previousCeiling, previousGrace, previousAbandon })
}

// hangingCommand is a shell command that writes its PID to a file and then hangs.
func hangingCommand(t *testing.T, script string) (pidFile string, args []string) {
	t.Helper()
	pidFile = filepath.Join(t.TempDir(), "pid")
	return pidFile, []string{"-c", "echo $$ > " + pidFile + "; " + script}
}

func waitForPID(t *testing.T, pidFile string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the command did not start")
	return 0
}

func assertGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process %d still runs", pid)
}

// A command that hangs (incus with a hung incusd, restic on a stalled drive) ends when the request does.
func TestStepCommandEndsWhenTheRequestEnds(t *testing.T) {
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	request, hangUp := context.WithCancel(context.Background())
	ctx, cancel := stepContext(request)
	defer cancel()
	pidFile, args := hangingCommand(t, "exec sleep 600")
	type result struct {
		err error
	}
	done := make(chan result, 1)
	started := time.Now()
	go func() {
		_, err := runStep(ctx, "sh", args...)
		done <- result{err}
	}()
	pid := waitForPID(t, pidFile)
	hangUp()
	select {
	case r := <-done:
		if r.err == nil || !strings.Contains(r.err.Error(), "the request ended") {
			t.Fatalf("error = %v, want one that says the request ended", r.err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("the hanging command was not ended by the cancelled request")
	}
	if time.Since(started) > 4*time.Second {
		t.Fatalf("ending took %s", time.Since(started))
	}
	assertGone(t, pid)
}

// With a caller that stays, the ceiling ends it.
func TestStepCommandEndsAtTheCeiling(t *testing.T) {
	shortStepTimes(t, 300*time.Millisecond, 5*time.Second, 5*time.Second)
	ctx, cancel := stepContext(context.Background())
	defer cancel()
	pidFile, args := hangingCommand(t, "exec sleep 600")
	started := time.Now()
	_, err := runStep(ctx, "sh", args...)
	if err == nil || !strings.Contains(err.Error(), "longer than its time limit") {
		t.Fatalf("error = %v, want one that names the time limit", err)
	}
	if elapsed := time.Since(started); elapsed < 300*time.Millisecond || elapsed > 4*time.Second {
		t.Fatalf("ended after %s, want about the 300 ms ceiling", elapsed)
	}
	assertGone(t, waitForPID(t, pidFile))
	if stepEnded(context.Background()) != nil {
		t.Fatal("a context that has not ended must not read as ended")
	}
}

// A command that ignores SIGTERM is killed after the grace time, and a child that keeps its output pipe open
// does not hold the step.
func TestStepCommandThatIgnoresTermIsKilled(t *testing.T) {
	shortStepTimes(t, 200*time.Millisecond, 300*time.Millisecond, 5*time.Second)
	ctx, cancel := stepContext(context.Background())
	defer cancel()
	pidFile, args := hangingCommand(t, "trap '' TERM; sleep 20 & wait; sleep 20")
	started := time.Now()
	_, err := runStep(ctx, "sh", args...)
	if err == nil {
		t.Fatal("a killed command must be an error")
	}
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond || elapsed > 4*time.Second {
		t.Fatalf("ended after %s, want the ceiling plus the grace time", elapsed)
	}
	assertGone(t, waitForPID(t, pidFile))
}

// A command that cannot be killed (stuck in the kernel on a dead drive) is left behind: the step still answers.
func TestStepAnswersWhenTheCommandCannotBeKilled(t *testing.T) {
	shortStepTimes(t, 200*time.Millisecond, 100*time.Millisecond, 200*time.Millisecond)
	ctx, cancel := stepContext(context.Background())
	defer cancel()
	cmd := stepCommand(ctx, "sleep", "3")
	cmd.Cancel = func() error { return nil } // the signal does nothing
	cmd.WaitDelay = 0                        // and nothing kills it
	started := time.Now()
	_, err := stepOutput(ctx, cmd, false)
	if err == nil || !strings.Contains(err.Error(), "left behind") {
		t.Fatalf("error = %v, want one that says the command was left behind", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("answered after %s, before the command's own end at 3 s is wanted", elapsed)
	}
}

// A command that ends well under a live context gives its output and no error; a cleanup has its own limit.
func TestStepCommandOutputAndCleanupLimit(t *testing.T) {
	ctx, cancel := stepContext(context.Background())
	defer cancel()
	output, err := runStep(ctx, "sh", "-c", "echo out; echo err >&2")
	if err != nil || string(output) != "out\nerr\n" {
		t.Fatalf("output = %q, err = %v", output, err)
	}
	stdout, err := stepOutput(ctx, stepCommand(ctx, "sh", "-c", "echo out; echo err >&2"), true)
	if err != nil || string(stdout) != "out\n" {
		t.Fatalf("stdout = %q, err = %v", stdout, err)
	}
	previous := stepCleanupLimit
	stepCleanupLimit = 200 * time.Millisecond
	defer func() { stepCleanupLimit = previous }()
	started := time.Now()
	cleanup := &stepCleanup{}
	defer cleanup.done()
	cleanup.run("sleep", "600")
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("a hanging cleanup took %s", elapsed)
	}
}

// However many commands a failed step's cleanup runs, together they end at one deadline.
func TestStepCleanupSharesOneDeadline(t *testing.T) {
	shortStepTimes(t, time.Hour, 5*time.Second, 5*time.Second)
	previousLimit, previousTotal := stepCleanupLimit, stepCleanupTotal
	stepCleanupLimit, stepCleanupTotal = 400*time.Millisecond, 600*time.Millisecond
	defer func() { stepCleanupLimit, stepCleanupTotal = previousLimit, previousTotal }()
	cleanup := &stepCleanup{}
	defer cleanup.done()
	started := time.Now()
	for range 10 {
		cleanup.run("sleep", "600")
	}
	if elapsed := time.Since(started); elapsed < 600*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("ten hanging cleanup commands took %s, want about the 600 ms they share", elapsed)
	}
	if cleanup.succeeds("true") {
		t.Fatal("a command after the shared deadline must not read as a yes")
	}
}
