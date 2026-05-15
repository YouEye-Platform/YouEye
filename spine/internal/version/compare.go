// Package version provides semantic version comparison for YouEye.
// It handles both 3-digit (x.y.z) and 4-digit (x.y.z.w) version strings,
// comparing each segment numerically rather than lexicographically.
package version

import (
	"strconv"
	"strings"
)

// CompareVersions compares two version strings semantically.
// Returns -1 if a < b, 0 if a == b, 1 if a > b.
// Supports both 3-digit (x.y.z) and 4-digit (x.y.z.w) versions.
// Missing segments are treated as 0 (e.g., "1.2.3" == "1.2.3.0").
func CompareVersions(a, b string) int {
	aParts := splitVersion(a)
	bParts := splitVersion(b)

	// Normalize lengths — compare up to the longer of the two
	maxLen := len(aParts)
	if len(bParts) > maxLen {
		maxLen = len(bParts)
	}

	for i := 0; i < maxLen; i++ {
		aVal := 0
		bVal := 0
		if i < len(aParts) {
			aVal = aParts[i]
		}
		if i < len(bParts) {
			bVal = bParts[i]
		}

		if aVal < bVal {
			return -1
		}
		if aVal > bVal {
			return 1
		}
	}

	return 0
}

// IsNewer returns true if candidate is a newer version than current.
func IsNewer(candidate, current string) bool {
	return CompareVersions(candidate, current) > 0
}

// SortVersionsDesc sorts a slice of version strings in descending order (newest first).
func SortVersionsDesc(versions []string) {
	// Simple insertion sort — release lists are small
	for i := 1; i < len(versions); i++ {
		for j := i; j > 0 && CompareVersions(versions[j], versions[j-1]) > 0; j-- {
			versions[j], versions[j-1] = versions[j-1], versions[j]
		}
	}
}

// splitVersion splits a version string by "." and converts each segment to an integer.
// Non-numeric segments are treated as 0.
func splitVersion(v string) []int {
	// Strip leading "v" if present
	v = strings.TrimPrefix(v, "v")

	parts := strings.Split(v, ".")
	result := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			n = 0
		}
		result[i] = n
	}
	return result
}
