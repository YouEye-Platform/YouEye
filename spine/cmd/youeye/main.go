package main

import (
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/cmd"
	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
)

func main() {
	// On an appliance the baked binary is the seed and launcher: ordinary
	// commands continue in the Spine selected for the booted slot.
	spineselect.MaybeDelegate(appliance.ManifestPath, appliance.SystemSlotFromKernelCommandLine)
	if err := cmd.Execute(); err != nil {
		code := 1
		if exitErr, ok := err.(interface{ ExitCode() int }); ok {
			code = exitErr.ExitCode()
		}
		if err.Error() != "" {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
		os.Exit(code)
	}
}
