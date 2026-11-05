package cmd

import (
	"fmt"
	"os"
	"sync"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The bridge is an explicitly selected API adapter, not an installed payload or
// update coordinator. It keeps all transaction effects behind the owner's
// ordinary Stage request and hands native actions to the original signed reader.
type coreAPIReaderBridge struct {
	managedLease func()
	executable   string
	digest       string
	mu           sync.Mutex
}

func newCoreAPIReaderBridge(executable, digest string) (*coreAPIReaderBridge, error) {
	if executable == "" && digest == "" {
		return nil, nil
	}
	if os.Geteuid() != 0 {
		return nil, fmt.Errorf("a reader bridge requires root")
	}
	b := &coreAPIReaderBridge{executable: executable, digest: digest}
	if err := b.verify(digest); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *coreAPIReaderBridge) verify(digest string) error {
	if digest != b.digest {
		return fmt.Errorf("System selection differs from the selected reader bridge")
	}
	return (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).VerifyBootstrapReader(b.executable, digest, systemupdate.CoreDevelopmentTrustPath)
}

// Call only after native preparation and the current-request identity check.
// Completed/replayed historical deliveries never register a new coordinator.
func (b *coreAPIReaderBridge) bindStage(action string, j systemupdate.CoreJournal, complete bool,
	register func(string, string, string) (string, error), override func(string) error) (bool, error) {
	if action != "stage" || complete || coreAPIReaderTerminal(j) {
		return false, nil
	}
	if j.ManifestSHA256 != b.digest {
		return false, fmt.Errorf("prepared System differs from the selected reader bridge")
	}
	executable, err := register(j.RequestID, j.ManifestSHA256, b.executable)
	if err != nil {
		return false, err
	}
	if executable != b.executable {
		return false, fmt.Errorf("registered System reader changed")
	}
	if err := override(executable); err != nil {
		return false, err
	}
	return true, nil
}

// A terminal graph can still need maintenance-release reconciliation. It must
// not install a new coordinator merely because that cleanup is unfinished.
func coreAPIReaderTerminal(j systemupdate.CoreJournal) bool {
	return j.Phase == "committed" || j.Phase == "cancelled" || j.Phase == "rolled-back"
}
