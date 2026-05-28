package main

import (
	"fmt"
	"os"

	"git.potemk.in/potemsla/YouEye/spine/internal/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
