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
)

// Fence settles native children, closes ingress, preserves original power
// intent, stops the exact owned writers, and observes provider/SQL settlement.
// It never cancels someone else's Incus operation or restores any data.
func (p NativeCoreCheckpoint) Fence(ctx context.Context, request string, runner CoreSystemdRunner) (string, error) {
	m := CoreManager{Root: p.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "recovering" || runner.Root != p.Root {
		return "", fmt.Errorf("exact active native recovery required")
	}
	active := false
	for _, step := range j.RecoverySteps {
		if step.Name == "recovery-fence" && step.State == "started" {
			active = true
		}
	}
	if !active {
		return "", fmt.Errorf("recovery fence is not active")
	}
	installed, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(installed, j.Previous) {
		return "", fmt.Errorf("recovery commitment changed")
	}
	children, err := runner.SettleApplyChildren(ctx, request)
	if err != nil {
		return "", err
	}
	// If checkpoint admission itself failed, reacquire the ordinary lifecycle
	// lease through its normal admission path. Never bypass unfinished app work.
	barrier := CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}
	if err = barrier.Begin(j); err != nil {
		return "", err
	}
	machine, err := p.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return "", fmt.Errorf("recovery machine changed")
	}
	record, err := p.Read(j)
	if errors.Is(err, os.ErrNotExist) && coreCheckpointUnapplied(j) {
		// Quiesce always freezes this inventory before its first effect. A
		// missing record is admissible only when no payload action was started,
		// the old executor is excluded, and Inspect finds no maintenance owner.
		inventory, inspectErr := p.Inspect(ctx, j)
		if inspectErr != nil {
			return "", inspectErr
		}
		record = NativeCoreCheckpointRecord{Schema: "youeye.core-checkpoint.v1", Inventory: inventory, Phase: "prepared"}
		if err = p.saveRecord(record); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	if err = p.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return "", err
	}
	_, digest, err := p.installedOwners()
	if err != nil || digest != record.Inventory.AppInventorySHA256 {
		return "", fmt.Errorf("recovery application inventory changed")
	}
	if err = p.closeCheckpointWriters(ctx, j, record.Inventory); err != nil {
		return "", err
	}
	if err = p.requireProviderSettled(ctx); err != nil {
		return "", err
	}
	if err = p.requireClosedDatabaseWriters(ctx); err != nil {
		return "", err
	}
	if err = p.verifyContainerIdentities(ctx, record.Inventory, true); err != nil {
		return "", err
	}
	if err = p.requireProviderSettled(ctx); err != nil {
		return "", err
	}
	// Hash private inventory observations, never include provider metadata,
	// database rows or command errors in user-visible action evidence.
	observed, _ := json.Marshal(record.Inventory)
	return fmt.Sprintf("owned native children, ingress hold, exact stopped writers, settled Incus operations and closed SQL writers; observation %x; children %x", sha256.Sum256(observed), sha256.Sum256([]byte(children))), nil
}

func (p NativeCoreCheckpoint) requireProviderSettled(ctx context.Context) error {
	// Incus query suppresses an empty metadata object unless --raw is used.
	// Require the successful API envelope rather than accepting blank output.
	raw, err := p.capture(ctx, "incus", "query", "/1.0/operations?recursion=1", "--raw")
	if err != nil {
		return err
	}
	var response struct {
		Type       string          `json:"type"`
		StatusCode int             `json:"status_code"`
		ErrorCode  *int            `json:"error_code"`
		Error      string          `json:"error"`
		Metadata   json.RawMessage `json:"metadata"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Type != "sync" || response.StatusCode != 200 || response.ErrorCode == nil || *response.ErrorCode != 0 || response.Error != "" {
		return fmt.Errorf("native provider settlement response is unreadable")
	}
	var groups map[string][]struct {
		ID         string `json:"id"`
		Class      string `json:"class"`
		StatusCode int    `json:"status_code"`
	}
	if json.Unmarshal(response.Metadata, &groups) != nil || groups == nil {
		return fmt.Errorf("native provider settlement is unreadable")
	}
	seen := map[string]bool{}
	for _, operations := range groups {
		for _, operation := range operations {
			if operation.ID == "" || seen[operation.ID] {
				return fmt.Errorf("ambiguous native provider operation")
			}
			seen[operation.ID] = true
			switch operation.Class {
			case "token": // Enrollment tokens do not execute writers.
				continue
			case "task", "websocket":
			default:
				return fmt.Errorf("unknown native provider operation class")
			}
			switch operation.StatusCode {
			case 200, 400, 401: // Incus Success, Failure, Cancelled.
			default:
				return fmt.Errorf("native provider operation remains unsettled")
			}
		}
	}
	return nil
}
