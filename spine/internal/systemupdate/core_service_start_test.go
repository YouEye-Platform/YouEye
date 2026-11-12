package systemupdate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCoreServiceHoldReleaseRequiresDurableExactIntent(t *testing.T) {
	for _, mode := range []string{"normal", "missing", "recorded-missing", "foreign", "changed-condition", "reheld"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			etc := filepath.Join(root, "etc/youeye")
			if err := os.MkdirAll(etc, 0700); err != nil {
				t.Fatal(err)
			}
			j := CoreJournal{RequestID: "update-1", ManifestSHA256: checksum([]byte("manifest"))}
			stage := CoreServiceStage{Role: "cp"}
			for _, unit := range []string{"youeye-control", "youeye-id"} {
				dir := filepath.Join(root, "etc/systemd/system", unit+".service.d")
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatal(err)
				}
				content := "[Unit]\nConditionPathExists=!/etc/youeye/core-update-hold.json\n"
				if mode == "changed-condition" {
					content = "[Unit]\nConditionPathExists=/different\n"
				}
				if err := os.WriteFile(filepath.Join(dir, "90-youeye-core-update.conf"), []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}
			held := map[string]string{"request_id": j.RequestID, "manifest_sha256": j.ManifestSHA256}
			if mode == "foreign" {
				held["request_id"] = "another"
			}
			file := filepath.Join(etc, "core-update-hold.json")
			if mode != "missing" && mode != "recorded-missing" {
				raw, _ := json.Marshal(held)
				if err := os.WriteFile(file, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "recorded-missing" {
				stage.StartState = "requested"
			}
			if mode == "reheld" {
				stage.StartState = "started"
			}
			dir, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer dir.Close()
			intent := false
			save := func(value CoreServiceStage) error {
				if _, err := os.Stat(file); err != nil {
					t.Fatal("removed hold before durable intent")
				}
				intent = value.StartState == "requested"
				return nil
			}
			err = releaseCoreServiceHold(dir, j, &stage, save)
			valid := mode == "normal" || mode == "recorded-missing"
			if (err == nil) != valid {
				t.Fatal(mode, err)
			}
			if mode == "normal" {
				if !intent {
					t.Fatal("missing start intent")
				}
				if _, err := os.Lstat(file); !os.IsNotExist(err) {
					t.Fatal("hold not removed")
				}
				if err := releaseCoreServiceHold(dir, j, &stage, save); err != nil {
					t.Fatal("lost removal acknowledgement did not reconcile", err)
				}
			}
		})
	}
}
