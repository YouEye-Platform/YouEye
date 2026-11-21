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
	runner := systemupdate.CoreControlRunner{Root: systemupdate.CoreStatePath, Executable: coreBakedExecutable}
	actions := systemupdate.CoreSystemdRunner{Root: systemupdate.CoreStatePath, Executable: coreBakedExecutable}
	return &systemupdate.CoreContinuationWatchdog{
		Root: systemupdate.CoreStatePath, Lifecycle: systemupdate.CoreAppLifecycleRoot, Idle: coreWatchdogIdle,
		Coordinating: func() (bool, error) { return systemupdate.CoreCommandRunning("/proc") },
		Start:        runner.Start, Delivered: runner.Delivered, Forget: runner.Forget,
		ChildGone: actions.ChildGone, ChildLingering: actions.ChildLingering,
	}
}

// startCoreContinuationWatchdog runs in the API service (the selected Spine).
// See systemupdate.CoreContinuationWatchdog for what it does and when.
//
// The first look happens here, before the API socket exists: the idle time of
// a request that was already there (after a boot, or after a restart of this
// service by a Spine step) counts from the start of the service.
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
