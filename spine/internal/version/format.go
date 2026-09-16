package version

import (
	"fmt"
	"strconv"
	"strings"
)

// MaxSegments is the maximum number of dot-separated numeric segments a
// YouEye version may carry. Depth encodes the stability tier; beyond this the
// version is rejected by ParseVersionStrict and skipped by resolvers.
const MaxSegments = 10

// FormatVersion returns the canonical display form of a version: leading "v"
// stripped and trailing zero segments trimmed, keeping a minimum of 1 segment.
//
//	"0.5.0.0"   → "0.5"
//	"2.0.0"     → "2"
//	"0"         → "0"
//	"v0.5.10"   → "0.5.10"
//
// Non-numeric input is returned unchanged (minus a leading "v") — callers that
// need strict handling should use ParseVersionStrict first.
func FormatVersion(v string) string {
	return trimSegments(v, 1)
}

// FormatVersionTag returns the form used inside release tags: same trailing-zero
// trim as FormatVersion but keeping a minimum of 3 segments, zero-padded.
//
//	"0.5"          → "0.5.0"
//	"2"            → "2.0.0"
//	"0.5.11.1.0"   → "0.5.11.1"
//	"0.5.6.0.0.1"  → "0.5.6.0.0.1"
func FormatVersionTag(v string) string {
	return trimSegments(v, 3)
}

// trimSegments strips a leading "v", removes trailing zero segments, then pads
// up to minSegments with "0". Non-numeric segments abort trimming and the
// original (v-stripped) value is returned so we never corrupt unexpected input.
func trimSegments(v string, minSegments int) string {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		v = "0"
	}
	parts := strings.Split(v, ".")

	// Validate segments are numeric; if not, return input untouched.
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil {
			return v
		}
	}

	// Trim trailing zero segments, keeping at least one.
	last := len(parts)
	for last > 1 {
		n, _ := strconv.Atoi(parts[last-1])
		if n != 0 {
			break
		}
		last--
	}
	parts = parts[:last]

	// Pad up to the minimum.
	for len(parts) < minSegments {
		parts = append(parts, "0")
	}

	return strings.Join(parts, ".")
}

// ParseVersionStrict parses a version into its numeric segments, enforcing the
// grammar: an optional leading "v", then 1–MaxSegments dot-separated
// non-negative integers. Empty input, empty segments, non-numeric segments, and
// versions deeper than MaxSegments are rejected.
func ParseVersionStrict(v string) ([]int, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if raw == "" {
		return nil, fmt.Errorf("version is empty")
	}
	parts := strings.Split(raw, ".")
	if len(parts) > MaxSegments {
		return nil, fmt.Errorf("version has %d segments, maximum is %d", len(parts), MaxSegments)
	}
	out := make([]int, len(parts))
	for i, p := range parts {
		if p == "" {
			return nil, fmt.Errorf("version %q has an empty segment", v)
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, fmt.Errorf("version %q segment %q is not numeric", v, p)
		}
		if n < 0 {
			return nil, fmt.Errorf("version %q segment %q is negative", v, p)
		}
		out[i] = n
	}
	return out, nil
}
