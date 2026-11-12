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
