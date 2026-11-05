package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const firstDeployProgressSchema = "youeye.appliance.progress.v2"

type firstDeployProgressRecord struct {
	Schema    string `json:"schema"`
	Operation string `json:"operation"`
	State     string `json:"state"`
	Stage     string `json:"stage"`
	Detail    string `json:"detail"`
	Percent   int    `json:"percent"`
	Attempt   int    `json:"attempt"`
	UpdatedAt string `json:"updated_at"`
}

func emitFirstDeployProgress(stage, detail string, percent int) {
	path := strings.TrimSpace(os.Getenv("YOUEYE_FIRST_DEPLOY_PROGRESS_PATH"))
	if path == "" {
		return
	}
	if err := writeFirstDeployProgress(path, stage, detail, percent); err != nil {
		fmt.Printf("Warning: first-deploy progress could not be persisted: %v\n", err)
	}
}

func writeFirstDeployProgress(path, stage, detail string, percent int) error {
	if !filepath.IsAbs(path) || filepath.Base(path) != "progress.json" || filepath.Clean(path) != path {
		return errors.New("first-deploy progress path is invalid")
	}
	allowedStages := map[string]bool{
		"storage": true, "incus": true, "system_core": true, "server_interface": true,
		"database": true, "web_gateway": true, "network_shield": true, "ui": true,
	}
	if !allowedStages[stage] {
		return fmt.Errorf("first-deploy progress stage %q is invalid", stage)
	}
	if percent < 0 || percent > 100 {
		return errors.New("first-deploy progress percent is invalid")
	}
	previous := firstDeployProgressRecord{}
	if raw, err := os.ReadFile(path); err == nil {
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		if decoder.Decode(&previous) != nil || previous.Operation != "first-deploy" {
			return errors.New("existing first-deploy progress is invalid")
		}
	}
	if previous.Percent > percent {
		percent = previous.Percent
	}
	attempt, err := strconv.Atoi(strings.TrimSpace(os.Getenv("YOUEYE_FIRST_DEPLOY_ATTEMPT")))
	if err != nil || attempt < 1 {
		attempt = previous.Attempt
	}
	if attempt < 1 {
		attempt = 1
	}
	record := firstDeployProgressRecord{
		Schema: firstDeployProgressSchema, Operation: "first-deploy", State: "running",
		Stage: stage, Detail: safeFirstDeployDetail(detail), Percent: percent, Attempt: attempt,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	raw, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".first-deploy-progress-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(append(raw, '\n')); err != nil {
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
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func safeFirstDeployDetail(value string) string {
	value = strings.Map(func(char rune) rune {
		if char < 0x20 || char == 0x7f {
			return -1
		}
		return char
	}, strings.TrimSpace(value))
	if len(value) > 160 {
		value = value[:160]
	}
	return value
}

func decodeFirstDeployProgress(raw []byte) (firstDeployProgressRecord, error) {
	var record firstDeployProgressRecord
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return record, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return record, errors.New("progress contains trailing JSON")
	}
	return record, nil
}
