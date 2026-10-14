package systemupdate

import (
	"errors"
	"fmt"
	"os"
)

// RequireLegacyUpdateAllowed is checked by component mutators before effects.
// An invalid installed receipt is a recovery problem, never a legacy fallback.
func RequireLegacyUpdateAllowed(root string) error {
	_, err := (CoreManager{Root: root}).ReadReceipt()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("installed core receipt requires recovery: %w", err)
	}
	return fmt.Errorf("this installation uses one signed System release; update the complete core selection")
}
