package systemupdate

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

type CopyDiskObservation struct {
	Hardware   string
	Manifest   appliance.Manifest
	Partitions appliance.PartitionContract
}
type copyIdentityJournal struct {
	Schema          string                     `json:"schema"`
	Request         CoreCopyRequest            `json:"request"`
	Source          appliance.StateRecord      `json:"source"`
	Destination     appliance.StateRecord      `json:"destination"`
	SourceData      appliance.DataSchemaRecord `json:"source_data"`
	DestinationData appliance.DataSchemaRecord `json:"destination_data"`
}

// PrepareIndependentCopyIdentity changes only the destination's installation
// references and paired data ownership record. Ordinary data, users, grants,
// schema versions, slots and signed release bytes remain intact. The caller
// holds the platform copy lifecycle reservation and network quarantine; observe
// must discover actual mounted partition/hardware identity on this destination.
// The durable pair permits replay after either individual atomic write.
func (m CoreManager) PrepareIndependentCopyIdentity(request CoreCopyRequest, statePath, dataPath string, observe func() (CopyDiskObservation, error)) (CoreMachineIdentity, error) {
	if err := request.Validate(); err != nil {
		return CoreMachineIdentity{}, err
	}
	if observe == nil || !filepath.IsAbs(statePath) || !filepath.IsAbs(dataPath) || statePath == dataPath {
		return CoreMachineIdentity{}, fmt.Errorf("native copy disk observation and distinct absolute state paths required")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return CoreMachineIdentity{}, err
	}
	defer unlock()
	observed, err := observe()
	if err != nil {
		return CoreMachineIdentity{}, err
	}
	if observed.Hardware != request.DestinationHardware {
		return CoreMachineIdentity{}, fmt.Errorf("copy destination hardware changed")
	}
	copyJournal, err := m.readCopy()
	if err != nil || copyJournal.Request != request || copyJournal.Phase != "verifying" {
		return CoreMachineIdentity{}, fmt.Errorf("verified-copy admission must own this exact destination before identity preparation")
	}
	source, err := m.ReadReceipt()
	if err != nil || CoreReceiptDigest(source) != request.SourceReceiptSHA256 {
		return CoreMachineIdentity{}, fmt.Errorf("copy source receipt changed before identity preparation")
	}
	path := filepath.Join(m.Root, "copy-identity.json")
	var j copyIdentityJournal
	raw, err := ReadCoreState(path, 4<<20)
	if err == nil {
		if err = json.Unmarshal(raw, &j); err != nil {
			return CoreMachineIdentity{}, err
		}
		if j.Schema != "youeye.copy-identity.v1" || j.Request.Validate() != nil {
			return CoreMachineIdentity{}, fmt.Errorf("invalid copy identity journal")
		}
		if j.Request != request {
			var prior CoreCopyJournal
			previous, readErr := ReadCoreState(filepath.Join(m.Root, "copy-history", j.Request.RequestID+".json"), 4<<20)
			if readErr != nil || json.Unmarshal(previous, &prior) != nil || prior.Request != j.Request || prior.Phase != "committed" || prior.Request.DestinationHardware != request.SourceHardware || copyMachine(j.Destination) != source.Machine {
				return CoreMachineIdentity{}, fmt.Errorf("different identity preparation owns this destination")
			}
			if err = atomicWrite(filepath.Join(m.Root, "copy-history", j.Request.RequestID+"-identity.json"), raw, 0600); err != nil {
				return CoreMachineIdentity{}, err
			}
			err = os.ErrNotExist
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		before, err := appliance.LoadState(statePath)
		if err != nil {
			return CoreMachineIdentity{}, err
		}
		data, err := appliance.LoadDataSchema(dataPath)
		if err != nil {
			return CoreMachineIdentity{}, err
		}
		if copyMachine(before) != source.Machine || data.InstallIDRef != before.InstallIDRef || data.SchemaVersion != before.DataSchemaVersion || before.Lifecycle != appliance.LifecycleConfigured || before.Transaction != (appliance.TransactionState{}) || before.Slots.Candidate != "" {
			return CoreMachineIdentity{}, fmt.Errorf("source copy state/data contract is unfinished or inconsistent")
		}
		next := before
		next.InstallIDRef, err = newCopyReference("install")
		if err != nil {
			return CoreMachineIdentity{}, err
		}
		next.DeviceIDRef, err = newCopyReference("device")
		if err != nil {
			return CoreMachineIdentity{}, err
		}
		// Full cold copies preserve partition UUIDs. A destination with different
		// partitions needs an explicit storage migration, never implicit adoption.
		next.ParentDiskID = appliance.DiskReference(observed.Partitions)
		if err = appliance.ValidateStateContract(observed.Manifest, next, observed.Partitions); err != nil {
			return CoreMachineIdentity{}, err
		}
		nextData := data
		nextData.InstallIDRef = next.InstallIDRef
		j = copyIdentityJournal{Schema: "youeye.copy-identity.v1", Request: request, Source: before, Destination: next, SourceData: data, DestinationData: nextData}
		raw, err = json.Marshal(j)
		if err != nil {
			return CoreMachineIdentity{}, err
		}
		if err = atomicWrite(path, raw, 0600); err != nil {
			return CoreMachineIdentity{}, err
		}
	} else if err != nil {
		return CoreMachineIdentity{}, err
	} else if err = json.Unmarshal(raw, &j); err != nil {
		return CoreMachineIdentity{}, err
	}
	if j.Schema != "youeye.copy-identity.v1" || j.Request != request || copyMachine(j.Source) != source.Machine || j.SourceData.InstallIDRef != j.Source.InstallIDRef || j.DestinationData.InstallIDRef != j.Destination.InstallIDRef || j.DestinationData.SchemaVersion != j.SourceData.SchemaVersion {
		return CoreMachineIdentity{}, fmt.Errorf("copy identity journal differs from frozen source")
	}
	allowed := j.Source
	allowed.InstallIDRef = j.Destination.InstallIDRef
	allowed.DeviceIDRef = j.Destination.DeviceIDRef
	allowed.ParentDiskID = j.Destination.ParentDiskID
	if !reflect.DeepEqual(allowed, j.Destination) || j.Source.InstallIDRef == j.Destination.InstallIDRef || j.Source.DeviceIDRef == j.Destination.DeviceIDRef {
		return CoreMachineIdentity{}, fmt.Errorf("copy identity journal changes preserved source data")
	}
	if err = appliance.ValidateStateContract(observed.Manifest, j.Destination, observed.Partitions); err != nil {
		return CoreMachineIdentity{}, err
	}
	current, err := appliance.LoadState(statePath)
	if err != nil {
		return CoreMachineIdentity{}, err
	}
	data, err := appliance.LoadDataSchema(dataPath)
	if err != nil {
		return CoreMachineIdentity{}, err
	}
	if current != j.Source && current != j.Destination {
		return CoreMachineIdentity{}, fmt.Errorf("destination state changed outside copy preparation")
	}
	if data != j.SourceData && data != j.DestinationData {
		return CoreMachineIdentity{}, fmt.Errorf("destination data ownership changed outside copy preparation")
	}
	if current != j.Destination {
		if err = appliance.WriteStateAtomic(statePath, j.Destination); err != nil {
			return CoreMachineIdentity{}, err
		}
	}
	if data != j.DestinationData {
		if err = appliance.WriteDataSchemaAtomic(dataPath, j.DestinationData); err != nil {
			return CoreMachineIdentity{}, err
		}
	}
	return copyMachine(j.Destination), nil
}
func copyMachine(s appliance.StateRecord) CoreMachineIdentity {
	return CoreMachineIdentity{InstallIDRef: s.InstallIDRef, DeviceIDRef: s.DeviceIDRef, ParentDiskID: s.ParentDiskID, StatePartUUID: s.StatePartUUID, DataPartUUID: s.DataPartUUID}
}

// Read-only counterpart used by final acceptance. The preparation journal is
// compared to actual mounted state/data and the current discovered disk layout.
func (m CoreManager) VerifyIndependentCopyIdentity(request CoreCopyRequest, statePath, dataPath string, observed CopyDiskObservation) (CoreMachineIdentity, error) {
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy-identity.json"), 4<<20)
	var j copyIdentityJournal
	if err != nil || json.Unmarshal(raw, &j) != nil || j.Schema != "youeye.copy-identity.v1" || j.Request != request || observed.Hardware != request.DestinationHardware {
		return CoreMachineIdentity{}, fmt.Errorf("copy identity evidence differs")
	}
	state, err := appliance.LoadState(statePath)
	if err != nil || state != j.Destination {
		return CoreMachineIdentity{}, fmt.Errorf("prepared copy state changed")
	}
	data, err := appliance.LoadDataSchema(dataPath)
	if err != nil || data != j.DestinationData || data.InstallIDRef != state.InstallIDRef {
		return CoreMachineIdentity{}, fmt.Errorf("prepared copy data ownership changed")
	}
	if err = appliance.ValidateStateContract(observed.Manifest, state, observed.Partitions); err != nil {
		return CoreMachineIdentity{}, err
	}
	if state.InstallIDRef == j.Source.InstallIDRef || state.DeviceIDRef == j.Source.DeviceIDRef {
		return CoreMachineIdentity{}, fmt.Errorf("copy retained source installation identity")
	}
	return copyMachine(state), nil
}
func newCopyReference(kind string) (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%x", kind, raw[:]), nil
}
