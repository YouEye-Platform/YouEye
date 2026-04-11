// Package util provides common utilities for Spine commands.
package util

import "fmt"

// LogStep prints a numbered step in the installation process.
func LogStep(step int, total int, msg string) {
	fmt.Printf("\n[%d/%d] %s\n", step, total, msg)
}

// LogSubStep prints a sub-step with an arrow indicator.
func LogSubStep(msg string) {
	fmt.Printf("  → %s\n", msg)
}

// LogSuccess prints a success message with a checkmark.
func LogSuccess(msg string) {
	fmt.Printf("  ✓ %s\n", msg)
}

// LogError prints an error message with an X indicator.
func LogError(msg string) {
	fmt.Printf("  ✗ %s\n", msg)
}

// LogWarning prints a warning message with a warning indicator.
func LogWarning(msg string) {
	fmt.Printf("  ⚠ %s\n", msg)
}

// LogDebug prints a debug message.
func LogDebug(msg string) {
	fmt.Printf("  [debug] %s\n", msg)
}
