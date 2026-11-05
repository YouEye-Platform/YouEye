package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var managedCoreAPISubmit sync.Mutex

func managedCoreReader(r systemupdate.NativeCoreRuntime) systemupdate.CoreReaderReadiness {
	return systemupdate.CoreReaderReadiness{Manager: systemupdate.CoreManager{Root: r.Root}, Cache: r.Cache, Checkpoint: r.Checkpoint}
}
func acquireCoreReader(ctx context.Context, r systemupdate.NativeCoreRuntime, selected systemupdate.CoreHostSelection, release releasecache.CoreRelease, digest string, installed systemupdate.CoreReceipt) (*systemupdate.CoreReaderReady, error) {
	if !systemupdate.CoreReaderEligible(release, installed) {
		return nil, nil
	}
	ready, err := managedCoreReader(r).Acquire(ctx, selected, digest)
	if errors.Is(err, systemupdate.ErrCoreReaderUnsupported) {
		return nil, nil
	} // Explicit legacy/manual reader path remains available.
	if err != nil {
		return nil, err
	}
	return &ready, nil
}

// The managed bridge is read for this operation, not captured when API starts.
// An accepted historical Stage never discovers/acquires a new reader or repeats
// registration. Existing native bootstrap authority owns all continuation.
func (o coreAPIOperations) stageReader(ctx context.Context, request systemupdate.CoreManager, digest, requestID string) (*coreAPIReaderBridge, error) {
	if o.reader != nil {
		if err := o.reader.verify(digest); err != nil {
			return nil, err
		}
		return o.reader, nil
	}
	j, err := request.ReadRequest(requestID)
	if err == nil && (request.TransactionComplete(j) || coreAPIReaderTerminal(j)) {
		return nil, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if registered, err := request.BootstrapExecutable(systemupdate.CoreDevelopmentTrustPath); err != nil {
		return nil, err
	} else if registered != "" {
		return nil, nil
	}
	runtime, err := installedCoreRuntime()
	if err != nil {
		return nil, err
	}
	var selected systemupdate.CoreHostSelection
	var target releasecache.CoreRelease
	var actual string
	if j.RequestID != "" {
		selected, target, err = request.Selection(j.ManifestSHA256, systemupdate.CoreDevelopmentTrustPath)
		actual = j.ManifestSHA256
	} else {
		policy, e := currentCoreSelection()
		if e != nil {
			return nil, e
		}
		selected, target, actual, err = systemupdate.ResolveCoreReleaseWithMetadata(ctx, runtime.Cache.Client, policy, systemupdate.CoreDevelopmentTrustPath, runtime.Cache.Root)
	}
	if err != nil {
		return nil, err
	}
	if actual != digest {
		return nil, fmt.Errorf("System selection changed before Stage")
	}
	installed, err := request.ReadReceipt()
	if err != nil {
		return nil, err
	}
	if !systemupdate.CoreReaderEligible(target, installed) {
		return nil, nil
	}
	store := managedCoreReader(runtime)
	lease, err := store.Lease()
	if err != nil {
		return nil, err
	}
	ready, err := store.Current(selected, digest)
	if errors.Is(err, os.ErrNotExist) {
		lease()
		return nil, fmt.Errorf("selected signed reader is not ready; check the current System selection first")
	}
	if err != nil {
		lease()
		return nil, err
	}
	return &coreAPIReaderBridge{executable: ready.Executable, digest: ready.ManifestSHA256, managedLease: lease}, nil
}

func init() {
	parent := &cobra.Command{Use: "reader", Short: "Inspect or acquire the current signed reader without creating an update request"}
	for _, action := range []string{"status", "acquire"} {
		action := action
		parent.AddCommand(&cobra.Command{Use: action, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
			runtime, err := installedCoreRuntime()
			if err != nil {
				return err
			}
			store := managedCoreReader(runtime)
			policy, err := currentCoreSelection()
			if err != nil {
				return err
			}
			selected, release, digest, err := systemupdate.ResolveCoreReleaseWithMetadata(cmd.Context(), runtime.Cache.Client, policy, systemupdate.CoreDevelopmentTrustPath, runtime.Cache.Root)
			if err != nil {
				return err
			}
			installed, err := (systemupdate.CoreManager{Root: runtime.Root}).ReadReceipt()
			if err != nil {
				return err
			}
			if action == "status" {
				if !systemupdate.CoreReaderEligible(release, installed) {
					return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"state": "not-required", "manifest_sha256": digest})
				}
				ready, err := store.Current(selected, digest)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(ready)
			}
			ready, err := acquireCoreReader(cmd.Context(), runtime, selected, release, digest, installed)
			if err != nil {
				return err
			}
			if ready == nil {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"state": "not-required-or-legacy", "manifest_sha256": digest})
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(ready)
		}})
	}
	coreUpdateCmd.AddCommand(parent)
}
