package systemupdate

import (
	"context"
	"fmt"
)

// RestoreRoots restores only the two retained core service roots. It does not
// recreate containers, alter app roots or release power/ingress holds. A lost
// provider acknowledgement remains uncertain; successful command receipt and
// exact stopped identity are both required before recording completion.
func (p NativeCoreCheckpoint) RestoreRoots(ctx context.Context, j CoreJournal) (NativeCoreCheckpointRecord, error) {
	record, err := p.Read(j)
	if err != nil {
		return record, err
	}
	if record.Phase != "files-restored" && record.Phase != "restoring-roots" && record.Phase != "paired-restored" {
		return record, fmt.Errorf("paired database and file restoration required before roots")
	}
	if err := p.requirePairedRecovery(ctx, j, record); err != nil {
		return record, err
	}
	record.Phase = "restoring-roots"
	if err := p.saveRecord(record); err != nil {
		return record, err
	}
	for i := range record.Roots {
		root := &record.Roots[i]
		if root.RestoreState == "restored" {
			continue
		}
		if root.RestoreState != "" {
			return record, fmt.Errorf("root restore outcome is uncertain; replay refused")
		}
		if err := p.requirePairedRecovery(ctx, j, record); err != nil {
			return record, err
		}
		root.RestoreState = "requested"
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
		if _, err := p.capture(ctx, "incus", "snapshot", "restore", root.Container, root.Snapshot); err != nil {
			return record, err
		}
		if err := p.requirePairedRecovery(ctx, j, record); err != nil {
			return record, err
		}
		root.RestoreState = "restored"
		if err := p.saveRecord(record); err != nil {
			return record, err
		}
	}
	record.Phase = "paired-restored"
	return record, p.saveRecord(record)
}
