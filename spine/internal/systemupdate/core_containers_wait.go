package systemupdate

import (
	"context"
	"fmt"
	"time"
)

// An update may be started while the box is still starting: Incus brings the
// core containers up some time after the API answers, and Spine starts Pi-hole
// later still. Two waits cover that. Both only read.

// coreVerifiedContainers are the containers whose installed trees
// verify-members walks. The walk refuses a container that is not running.
var coreVerifiedContainers = []string{"youeye-control", "youeye-ui"}

// coreContainersStartWait bounds how long the coordinator waits for
// coreVerifiedContainers before it launches verify-members. The wait is the
// action's admission (NativeCoreExecutor.Start): it ends before the launch is
// recorded, so a wait that ends first leaves a request that `resume` admits
// again and `cancel` ends, never an action with an unknown outcome.
var (
	coreContainersStartWait = 5 * time.Minute
	coreContainersStartPoll = 2 * time.Second
)

// coreContainersNotRunningError is the journal's error after that wait ended
// first.
const coreContainersNotRunningError = "The Control Panel and dashboard containers (youeye-control, youeye-ui) were not running, so the update has changed nothing; resume this request once they run"

// waitCoreContainersRunning returns once Incus reports every one of
// coreVerifiedContainers running. Any failed observation (Incus not answering
// yet, a container still stopped) is waited out. When the wait or the caller's
// context ends first, the error wraps the context's, which the executor
// records as a retryable admission.
func waitCoreContainersRunning(ctx context.Context, observe func(context.Context, string) (int, error)) error {
	ctx, cancel := context.WithTimeout(ctx, coreContainersStartWait)
	defer cancel()
	for {
		waiting := ""
		for _, name := range coreVerifiedContainers {
			if _, err := observe(ctx, name); err != nil {
				waiting = name
				break
			}
		}
		if waiting == "" {
			return nil
		}
		timer := time.NewTimer(coreContainersStartPoll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("core container %s is not running: %w", waiting, ctx.Err())
		case <-timer.C:
		}
	}
}

// coreSettledHealthWait bounds how long the final health check of a request
// without apply steps (a promotion of the installed build, or the installed
// release itself) is repeated. Such a request stops, starts and waits for no
// service, so right after a boot its check can run before the Control Panel
// listens or before every platform container runs.
var (
	coreSettledHealthWait = 3 * time.Minute
	coreSettledHealthPoll = 5 * time.Second
)

// waitCoreSettledHealth repeats a read-only health check until it passes or
// coreSettledHealthWait has passed, and returns the last answer. It is what
// `resume` does for this step (Observe runs the same check again), done here
// so that a box that is still starting needs no resume. A check is never cut
// short by the bound, so the reason of a failure is the check's own.
func waitCoreSettledHealth(ctx context.Context, check func(context.Context) (string, error)) (string, error) {
	deadline := time.Now().Add(coreSettledHealthWait)
	for {
		evidence, err := check(ctx)
		if err == nil || ctx.Err() != nil || !time.Now().Before(deadline) {
			return evidence, err
		}
		timer := time.NewTimer(coreSettledHealthPoll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", err
		case <-timer.C:
		}
	}
}
