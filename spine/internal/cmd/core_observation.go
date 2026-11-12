package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func (coreAPIOperations) ObserveInstalled(ctx context.Context, receipt systemupdate.CoreReceipt) systemupdate.CoreInstalledObservation {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	m := systemupdate.CoreManager{Root: systemupdate.CoreStatePath}
	return m.ObserveInstalled(ctx, receipt, func(ctx context.Context, receipt systemupdate.CoreReceipt) error {
		runtime, err := installedCoreRuntime()
		if err != nil {
			return err
		}
		return runtime.Services.VerifyInstalled(ctx, receipt, func(ctx context.Context, receipt systemupdate.CoreReceipt) error {
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
			executable, _, err := coreInstalledExecutable()
			if err != nil {
				return err
			}
			return verifyRunningSpine(executable)
		})
	})
}
