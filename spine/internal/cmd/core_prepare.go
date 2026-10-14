package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// A retry reads its accepted frozen request before contacting a moving channel.
// Authority for subsequent effects is still checked by the native coordinator.
func prepareCoreRequest(ctx context.Context, m systemupdate.CoreManager, request, digest string) (systemupdate.CoreJournal, error) {
	j, err := m.ReadRequest(request)
	if err == nil {
		if j.ManifestSHA256 != digest {
			return j, fmt.Errorf("request is bound to a different manifest")
		}
		return j, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return j, err
	}
	policy, err := currentCoreSelection()
	if err != nil {
		return j, err
	}
	selected, _, actual, err := systemupdate.ResolveCoreRelease(ctx, systemupdate.ReleaseHTTPClient(), policy, systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return j, err
	}
	if actual != digest {
		return j, fmt.Errorf("System selection changed; review its exact new digest")
	}
	return m.PrepareSigned(ctx, request, selected, digest, systemupdate.CoreDevelopmentTrustPath)
}
