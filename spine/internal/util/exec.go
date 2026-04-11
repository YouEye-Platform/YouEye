// Package util provides common utilities for Spine commands.
package util

import (
	"os"
	"os/exec"
)

// RunCmd executes a command with stdout/stderr connected to the terminal.
func RunCmd(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// RunCmdQuiet executes a command silently, discarding output.
func RunCmdQuiet(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	return cmd.Run()
}

// RunCmdCapture executes a command and returns combined stdout/stderr output.
func RunCmdCapture(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// RunIncusExec executes a command inside an Incus container.
func RunIncusExec(container string, command ...string) error {
	args := append([]string{"exec", container, "--"}, command...)
	return RunCmd("incus", args...)
}
