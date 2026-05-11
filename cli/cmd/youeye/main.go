package main

import (
	"os"

	"git.byka.wtf/potemsla/YouEye/cli/internal/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		os.Exit(1)
	}
}
