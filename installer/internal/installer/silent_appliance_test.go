package installer

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestApplianceProgressRecordIsStructuredAndMachineReadable(t *testing.T) {
	record := applianceProgressRecord{
		Schema: "youeye.installer.progress.v1", Operation: "install", State: "running",
		Stage: "write-system-a", Detail: "verified readback", Percent: 0.78,
	}
	var output bytes.Buffer
	if err := json.NewEncoder(&output).Encode(record); err != nil {
		t.Fatal(err)
	}
	var got applianceProgressRecord
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Schema != "youeye.installer.progress.v1" || got.Stage != "write-system-a" || got.Percent != 0.78 {
		t.Fatalf("unexpected progress record: %+v", got)
	}
}
