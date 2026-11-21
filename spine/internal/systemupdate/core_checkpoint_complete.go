package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

// ReleaseCompleted restores the frozen autostart settings and the owned
// ingress/lifecycle holds, after the shared commit or full recovery is durable.
// It never restores data or accepts health.
//
// Power: a finished request's containers normally run already (the health step
// started them). After a reboot or power cut between the commit and this
// release they do not: every held container has boot.autostart=false, so the
// boot left them stopped, the Control Panel included. The release therefore
// starts each container that ran at the checkpoint and is stopped now, once
// its own settings are back (startCompletedPower). A container that cannot be
// started, and one that runs although it was stopped at the checkpoint, never
// keeps the box closed: the request is finished, and what holds remain protect
// nothing. The Control Panel's monitor looks after such a container afterwards.
//
// Once the release has ended, old checkpoints are pruned (PruneCheckpoints).
func (p NativeCoreCheckpoint) ReleaseCompleted(ctx context.Context, request string) (string, error) {
	// A health check or another short-lived exec can overlap either observation.
	// Retry the whole reconciliation so identity, ownership and power intent are
	// revalidated after waiting. Unknown state and all other errors fail closed.
	// The bound covers a release after a restart, which starts every container
	// that ran at the checkpoint, one after the other.
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		evidence, err := p.releaseCompletedOnce(ctx, request)
		if !errors.Is(err, errCoreProviderUnsettled) {
			return evidence, err
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", fmt.Errorf("platform release still waiting for provider settlement: %w", ctx.Err())
		case <-timer.C:
		}
	}
}

func (p NativeCoreCheckpoint) releaseCompletedOnce(ctx context.Context, request string) (string, error) {
	m := CoreManager{Root: p.Root}
	unlock, err := m.lockCore()
	if err != nil {
		return "", err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil || j.RequestID != request {
		return "", fmt.Errorf("exact completed core request required")
	}
	receipt, err := m.ReadReceipt()
	if err != nil {
		return "", err
	}
	recovered := j.Phase == "rolled-back"
	complete := j.Phase == "committed" && receipt.ManifestSHA256 == j.ManifestSHA256 && reflect.DeepEqual(receipt.Release, j.Target) && receipt.Machine == j.Previous.Machine
	if recovered {
		complete = reflect.DeepEqual(receipt, j.Previous)
	}
	if !complete {
		return "", fmt.Errorf("native platform cannot reopen before durable complete acceptance")
	}
	if j.NoOp || j.MetadataOnly {
		return "verified unchanged payloads have no checkpoint or maintenance to release", nil
	}
	record, err := p.Read(j)
	if err != nil {
		return "", err
	}
	if record.CompletionState == "released" {
		return "retained exact platform release receipt", nil
	}
	if record.CompletionState != "" && record.CompletionState != "releasing" && record.CompletionState != "ready" {
		return "", fmt.Errorf("unknown platform release state")
	}
	if (!recovered && record.Phase != "captured") || (recovered && record.Phase != "paired-restored" && record.Phase != "aborted-unapplied") {
		return "", fmt.Errorf("paired checkpoint outcome is incomplete")
	}
	barrier := CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}
	reservation, reservationErr := barrier.Read()
	if record.CompletionState == "ready" && errors.Is(reservationErr, os.ErrNotExist) {
		// All native postconditions were durable before admission was released.
		// Ordinary work may already have started; do not reset its current settings.
		record.CompletionState = "released"
		return "platform release reconciled after lost final acknowledgement", p.saveRecord(record)
	}
	if reservationErr != nil || reservation.RequestID != j.RequestID || reservation.ManifestSHA256 != j.ManifestSHA256 {
		return "", fmt.Errorf("platform release lost its exact maintenance ownership")
	}
	machine, err := p.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return "", fmt.Errorf("platform release machine changed")
	}
	// The shared database carries no hold and no changed setting. Should a
	// boot have left it stopped, start it: the identity check below wants it.
	for _, c := range record.Inventory.Containers {
		if c.Name == "youeye-postgres" && c.Running {
			if actual, err := p.completionContainer(ctx, c); err == nil && actual.Status == "Stopped" {
				_, _ = p.capture(ctx, "incus", "start", c.Name)
			}
		}
	}
	if err = p.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return "", err
	}
	_, digest, err := p.installedOwners()
	if err != nil || digest != record.Inventory.AppInventorySHA256 {
		return "", fmt.Errorf("application ownership changed before platform release")
	}
	if err = p.requireProviderSettled(ctx); err != nil {
		return "", err
	}
	// Verify all identities and ownership before any setting changes. Power is
	// not a condition: see ReleaseCompleted.
	for _, c := range record.Inventory.Containers {
		actual, err := p.completionContainer(ctx, c)
		if err != nil {
			return "", err
		}
		if c.Name == "youeye-postgres" {
			continue
		}
		owner := actual.Config["user.youeye.core-request"]
		if owner != j.RequestID && !(record.CompletionState != "" && owner == "" && coreOriginalAutostart(actual.Config, c)) {
			return "", fmt.Errorf("container power hold is not owned by this release")
		}
		if !coreOriginalAutostart(actual.Config, c) && actual.Config["boot.autostart"] != "false" {
			return "", fmt.Errorf("autostart changed outside the owned maintenance transition")
		}
	}
	if record.CompletionState == "" {
		record.CompletionState = "releasing"
		if err = p.saveRecord(record); err != nil {
			return "", err
		}
	}
	for _, c := range record.Inventory.Containers {
		if c.Name == "youeye-postgres" {
			continue
		}
		actual, err := p.completionContainer(ctx, c)
		if err != nil {
			return "", err
		}
		owner := actual.Config["user.youeye.core-request"]
		if owner == "" && coreOriginalAutostart(actual.Config, c) {
			continue
		}
		if owner != j.RequestID {
			return "", fmt.Errorf("foreign power ownership cannot be cleared")
		}
		if !coreOriginalAutostart(actual.Config, c) {
			args := []string{"config", "unset", c.Name, "boot.autostart"}
			if c.Autostart != nil {
				args = []string{"config", "set", c.Name, "boot.autostart", *c.Autostart}
			}
			_, ackErr := p.capture(ctx, "incus", args...)
			actual, err = p.completionContainer(ctx, c)
			if err != nil || !coreOriginalAutostart(actual.Config, c) {
				return "", fmt.Errorf("original autostart restoration requires reconciliation")
			}
			_ = ackErr // exact postcondition, not the command acknowledgement, decides
		}
		_, ackErr := p.capture(ctx, "incus", "config", "unset", c.Name, "user.youeye.core-request")
		actual, err = p.completionContainer(ctx, c)
		if err != nil || actual.Config["user.youeye.core-request"] != "" || !coreOriginalAutostart(actual.Config, c) {
			return "", fmt.Errorf("owned power hold release requires reconciliation")
		}
		_ = ackErr
	}
	started, stopped, err := p.startCompletedPower(ctx, record.Inventory)
	if err != nil {
		return "", err
	}
	for _, c := range record.Inventory.Containers {
		actual, err := p.completionContainer(ctx, c)
		if err != nil || (c.Name != "youeye-postgres" && (actual.Config["user.youeye.core-request"] != "" || !coreOriginalAutostart(actual.Config, c))) {
			return "", fmt.Errorf("platform release postconditions changed before reopening")
		}
	}
	if err = p.requireProviderSettled(ctx); err != nil {
		return "", err
	}
	if err = p.openCompletedIngress(ctx, record.Inventory); err != nil {
		return "", err
	}
	record.CompletionState = "ready"
	if err = p.saveRecord(record); err != nil {
		return "", err
	}
	if recovered {
		err = barrier.ReleaseRecovered(m, request)
	} else {
		err = barrier.ReleaseCommitted(m, request)
	}
	if err != nil {
		return "", err
	}
	record.CompletionState = "released"
	evidence := "original power settings restored and exact ingress/lifecycle holds released"
	if len(started) > 0 {
		evidence += "; started after a restart: " + strings.Join(started, ", ")
	}
	if len(stopped) > 0 {
		evidence += "; could not be started: " + strings.Join(stopped, ", ")
	}
	return evidence, p.saveRecord(record)
}

// startCompletedPower starts every container that ran at the checkpoint and is
// stopped now (see ReleaseCompleted), the Control Panel and the dashboard
// first. It returns the names it started and the names that still do not run.
// The container's state after the command decides, not the command's answer.
// Only an unreadable or replaced container is an error.
func (p NativeCoreCheckpoint) startCompletedPower(ctx context.Context, inventory CoreCheckpointInventory) (started, stopped []string, err error) {
	order := []CoreCheckpointContainer{}
	for _, first := range []bool{true, false} {
		for _, c := range inventory.Containers {
			if c.Running && (c.Name == "youeye-control" || c.Name == "youeye-ui") == first {
				order = append(order, c)
			}
		}
	}
	for _, c := range order {
		actual, err := p.completionContainer(ctx, c)
		if err != nil {
			return started, stopped, err
		}
		if actual.Status == "Running" {
			continue
		}
		_, _ = p.capture(ctx, "incus", "start", c.Name)
		actual, err = p.completionContainer(ctx, c)
		if err != nil {
			return started, stopped, err
		}
		if actual.Status == "Running" {
			started = append(started, c.Name)
		} else {
			stopped = append(stopped, c.Name)
		}
	}
	return started, stopped, nil
}

type coreCompletionContainer struct {
	Devices map[string]map[string]string `json:"devices"`
	Status  string                       `json:"status"`
	Config  map[string]string            `json:"config"`
}

func (p NativeCoreCheckpoint) completionContainer(ctx context.Context, c CoreCheckpointContainer) (coreCompletionContainer, error) {
	var actual coreCompletionContainer
	raw, err := p.capture(ctx, "incus", "query", "/1.0/instances/"+c.Name)
	if err != nil || json.Unmarshal(raw, &actual) != nil || actual.Config["volatile.uuid"] != c.UUID || (actual.Status != "Running" && actual.Status != "Stopped") {
		return actual, fmt.Errorf("completed container identity or power state changed")
	}
	return actual, nil
}
func coreOriginalAutostart(config map[string]string, c CoreCheckpointContainer) bool {
	value, present := config["boot.autostart"]
	if c.Autostart == nil {
		return !present
	}
	return present && value == *c.Autostart
}
func (p NativeCoreCheckpoint) openCompletedIngress(ctx context.Context, inventory CoreCheckpointInventory) error {
	expected := "youeye-core:" + fmt.Sprintf("%x", sha256.Sum256([]byte(inventory.RequestID)))
	present := func() (bool, error) {
		raw, err := p.capture(ctx, "nft", "--json", "list", "tables")
		if err != nil {
			return false, err
		}
		var tables struct {
			NFTables []struct {
				Table *struct {
					Family  string `json:"family"`
					Name    string `json:"name"`
					Comment string `json:"comment"`
				} `json:"table"`
			} `json:"nftables"`
		}
		if json.Unmarshal(raw, &tables) != nil || tables.NFTables == nil {
			return false, fmt.Errorf("ingress ownership unreadable")
		}
		found := false
		for _, item := range tables.NFTables {
			if item.Table != nil && item.Table.Family == "inet" && item.Table.Name == "youeye_core_gate" {
				if found || item.Table.Comment != expected {
					return false, fmt.Errorf("foreign ingress maintenance cannot be removed")
				}
				found = true
			}
		}
		return found, nil
	}
	found, err := present()
	if err != nil || !found {
		return err
	}
	_, ackErr := p.capture(ctx, "nft", "delete", "table", "inet", "youeye_core_gate")
	found, err = present()
	if err != nil || found {
		return fmt.Errorf("ingress release requires positive readback")
	}
	_ = ackErr
	return nil
}
