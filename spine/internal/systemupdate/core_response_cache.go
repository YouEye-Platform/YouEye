package systemupdate

import (
	"errors"
	"fmt"
	"strings"
)

const coreResponseCacheRoot = ".next/server/route-cache"
const coreManifestRoute = ".next/server/app/manifest.webmanifest/route.js"

// Next's response-cache owner is SHA-256("/manifest.webmanifest/route").
const coreManifestCacheOwner = coreResponseCacheRoot + "/APP_ROUTE/34ed36d6db35fbd1331104b4f001db6d5ff9aae7c5571d365de1b5f496f21575"
const coreManifestCacheKey = coreManifestCacheOwner + "/$/manifest.webmanifest"

// Only the deployed static manifest handler's response data is permitted. This
// is not a general .next/server exclusion. New cached routes require review.
func coreResponseCacheKind(name string, enabled bool) string {
	if !enabled {
		return ""
	}
	switch name {
	case coreResponseCacheRoot, coreResponseCacheRoot + "/APP_ROUTE", coreManifestCacheOwner, coreManifestCacheOwner + "/$":
		return "directory"
	case coreManifestCacheKey + ".body", coreManifestCacheKey + ".meta":
		return "file"
	}
	return ""
}

func coreHasManifestRoute(index CorePayloadIndex) bool {
	for _, e := range index.Entries {
		if e.Path == coreManifestRoute && e.Kind == "file" {
			return true
		}
	}
	return false
}

func coreResponseCachePath(name string) bool {
	return name == coreResponseCacheRoot || strings.HasPrefix(name, coreResponseCacheRoot+"/")
}

// No raw path or filesystem/provider error reaches the durable diagnostic.
type corePayloadObservationError struct{ Reason, PathClass string }

func (e *corePayloadObservationError) Error() string {
	return "installed payload: " + e.Reason + " (" + e.PathClass + ")"
}
func corePayloadDiagnostic(err error, name string) error {
	if err == nil {
		return nil
	}
	var existing *corePayloadObservationError
	if errors.As(err, &existing) {
		return err
	}
	reason := ""
	switch err.Error() {
	case "installed core contains an unrecorded path":
		reason = "unrecorded-path"
	case "installed core mode changed", "invalid manifest response cache mode":
		reason = "changed-mode"
	case "installed core bytes changed":
		reason = "changed-bytes"
	case "installed core is missing recorded paths":
		reason = "missing-path"
	case "installed core link changed":
		reason = "changed-link"
	case "installed core directory changed", "installed core file changed", "invalid manifest response cache file", "invalid manifest response cache directory":
		reason = "invalid-type-or-link"
	}
	if reason == "" {
		return err
	}
	class := "signed-payload"
	if coreResponseCachePath(name) {
		class = "manifest-response-cache"
	}
	return &corePayloadObservationError{Reason: reason, PathClass: class}
}
func corePayloadVerificationFailure(role string, err error) (CoreActionObservation, bool) {
	var diagnostic *corePayloadObservationError
	if (role != "cp" && role != "ui") || !errors.As(err, &diagnostic) {
		return CoreActionObservation{}, false
	}
	return CoreActionObservation{State: "failed", Stage: "execute", Code: "native_action_failed", EffectState: "started", Evidence: fmt.Sprintf("verify-members: %s %s: %s; installed payload verification failed before activation", role, diagnostic.PathClass, diagnostic.Reason)}, true
}

// coreCheckpointPreflightRefused marks a checkpoint that ended in its read-only preflight. It is set only below,
// before Quiesce is called, so it proves that no ingress gate, power hold, stop or snapshot was made.
const coreCheckpointPreflightRefused = "checkpoint_preflight_refused"

// coreCheckpointPreflightFailure turns a refused checkpoint preflight into a definite failure with no effect. The
// preflight only reads; the lifecycle reservation taken at admission is its one effect. "unknown" here would hold
// the box in needs-recovery for good (an unknown step is never re-run), and paired recovery would run the same
// refused inspection in its fence. The coordinator instead ends the request through verified cancellation, which
// also releases the reservation (CoreManager.Cancel, NativeCoreRuntime's CancelPreparationAction).
func coreCheckpointPreflightFailure(err error) CoreActionObservation {
	msg := err.Error()
	if len(msg) > 1024 {
		msg = msg[:1024] + "…"
	}
	return CoreActionObservation{State: "failed", Stage: "execute", Code: coreCheckpointPreflightRefused, EffectState: "not-started",
		Evidence: "checkpoint preflight refused before any writer was stopped: " + msg}
}
