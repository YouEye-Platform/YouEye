package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// ObserveInstalled reports what the installed box holds: "verified" (with or
// without extra files), "modified" (a shipped file is changed or missing) or
// that it could not be observed. It walks in record mode: it is a report about
// a tree nobody is writing, and callers decide what a "modified" box may do.
func (coreAPIOperations) ObserveInstalled(ctx context.Context, receipt systemupdate.CoreReceipt) systemupdate.CoreInstalledObservation {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	return m.ObserveInstalled(ctx, receipt, func(ctx context.Context, receipt systemupdate.CoreReceipt) ([]systemupdate.CoreInstalledMember, error) {
		runtime, err := installedCoreRuntime()
		if err != nil {
			return nil, err
		}
		return runtime.Services.VerifyInstalled(ctx, receipt, systemupdate.CorePayloadRecord, func(ctx context.Context, receipt systemupdate.CoreReceipt) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			_, image, err := applianceRuntime()
			if err != nil || image == nil {
				return fmt.Errorf("running immutable image unavailable")
			}
			if err = systemupdate.BindCoreImage(receipt.Release, *image); err != nil {
				return err
			}
			executable, err := coreInstalledExecutable()
			if err != nil {
				return err
			}
			return verifyRunningSpine(executable)
		})
	})
}
