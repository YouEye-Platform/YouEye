package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

const (
	// coreWatchdogIdle: how long a request that holds the platform must have
	// stayed in one journal state, with no System update command running,
	// before its continuation is started again. A live coordinator starts the
	// next step within seconds.
	coreWatchdogIdle     = 5 * time.Minute
	coreWatchdogInterval = time.Minute
)

func newCoreContinuationWatchdog() *systemupdate.CoreContinuationWatchdog {
	return &systemupdate.CoreContinuationWatchdog{
		Root: systemupdate.CoreStatePath, Lifecycle: systemupdate.CoreAppLifecycleRoot, Idle: coreWatchdogIdle,
		Coordinating: func() (bool, error) { return systemupdate.CoreCommandRunning("/proc") },
		Start:        systemupdate.CoreControlRunner{Root: systemupdate.CoreStatePath, Executable: coreBakedExecutable}.Start,
	}
}

// startCoreContinuationWatchdog runs in the API service (the selected Spine).
// See systemupdate.CoreContinuationWatchdog for what it does and when.
//
// The first look happens here, before the API socket exists. What it finds is
// the journal state from before this service, which the watchdog never acts
// on. It must not be later: a Spine step restarts this service and is recorded
// as succeeded once the API answers, and the state written then is the one a
// continuation lost at the hand-over leaves.
func startCoreContinuationWatchdog() {
	watchdog := newCoreContinuationWatchdog()
	checkCoreContinuation(watchdog)
	go func() {
		for {
			time.Sleep(coreWatchdogInterval)
			checkCoreContinuation(watchdog)
		}
	}()
}

// checkCoreContinuation never takes the API service down with it.
func checkCoreContinuation(watchdog *systemupdate.CoreContinuationWatchdog) {
	defer func() {
		if r := recover(); r != nil {
			util.LogError(fmt.Sprintf("System update watchdog: %v", r))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command, err := watchdog.Check(ctx)
	if command == "" {
		return
	}
	if err != nil {
		util.LogError("System update watchdog: " + watchdog.Why() + "; starting its continuation again failed: " + err.Error())
		return
	}
	util.LogSuccess("System update watchdog: " + watchdog.Why() + "; started its continuation again (" + command + ")")
}
