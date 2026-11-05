package main

import (
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/cmd"
)

func main() {
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
