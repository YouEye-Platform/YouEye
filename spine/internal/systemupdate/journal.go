package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func loadJournal(path string) (Journal, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Journal{}, err
	}
	var journal Journal
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&journal); err != nil {
		return Journal{}, fmt.Errorf("decode system update journal: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return Journal{}, errors.New("system update journal contains trailing JSON")
	}
	if err := journal.Validate(); err != nil {
		return Journal{}, err
	}
	return journal, nil
}

func (journal Journal) Validate() error {
	if journal.Schema != JournalSchema || journal.TransactionID == "" || !validSHA256(journal.ManifestSHA256) ||
		journal.CurrentImage == "" || journal.TargetImage == "" ||
		!validSlot(journal.ActiveSlot) || !validSlot(journal.CandidateSlot) ||
		journal.ActiveSlot == journal.CandidateSlot || journal.StartedAt == "" || journal.UpdatedAt == "" {
		return errors.New("system update journal is incomplete")
	}
	switch journal.Phase {
	case PhaseHealthy, PhaseAvailable, PhaseDownload, PhaseWriting, PhaseStaged, PhasePending, PhaseTrial, PhaseFailed, PhaseRollback:
	default:
		return fmt.Errorf("system update journal phase %q is invalid", journal.Phase)
	}
	if journal.TrialFailures < 0 || journal.TrialFailures > BootAttempts {
		return errors.New("system update trial failure count is invalid")
	}
	return nil
}

func writeJournal(path string, journal Journal) error {
	journal.Schema = JournalSchema
	if err := journal.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(raw, '\n'), 0600)
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".system-update-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func atomicCopy(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	output, err := os.CreateTemp(filepath.Dir(destination), ".system-update-copy-*")
	if err != nil {
		return err
	}
	temp := output.Name()
	defer os.Remove(temp)
	if err := output.Chmod(mode); err != nil {
		output.Close()
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, destination); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(destination))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func classifyError(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "signature"):
		return "signature_invalid"
	case strings.Contains(message, "sha-256") || strings.Contains(message, "hash"):
		return "artifact_corrupt"
	case strings.Contains(message, "incompatible") || strings.Contains(message, "schema"):
		return "incompatible"
	case strings.Contains(message, "size") || strings.Contains(message, "8 gib"):
		return "oversized"
	case strings.Contains(message, "newer") || strings.Contains(message, "replay"):
		return "ordering_rejected"
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
		return "interrupted"
	default:
		return "stage_failed"
	}
}

func boundedError(err error) string {
	message := strings.TrimSpace(err.Error())
	if len(message) > 512 {
		return message[:512]
	}
	return message
}

func validSlot(slot string) bool { return slot == "A" || slot == "B" }
