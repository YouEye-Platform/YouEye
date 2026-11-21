package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

func TestUserDeleteRefusalSaysWhyAndHowToGoOn(t *testing.T) {
	refusal := &controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"Transfer application administration and explicitly retain/quarantine or dispose of private data before deleting this user","code":"disposition_required"}`)}
	err := userDeleteError(refusal, false)
	if !strings.HasPrefix(err.Error(), "Transfer application administration") || !strings.Contains(err.Error(), "--retain-data") {
		t.Fatalf("refusal without the way on: %v", err)
	}
	if strings.Contains(err.Error(), "control panel returned") {
		t.Fatalf("raw HTTP body shown: %v", err)
	}
	// With --retain-data the Control Panel's own reason is all (it names the apps the user administers or installed).
	installer := &controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"This user administers or installed photos.","code":"disposition_required"}`)}
	if err := userDeleteError(installer, true); err.Error() != "This user administers or installed photos." {
		t.Fatalf("got %v", err)
	}
	// The appliance owner cannot be deleted at all: no hint.
	owner := &controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"Appliance owner and management recovery access must remain active","code":"disposition_required"}`)}
	if err := userDeleteError(owner, false); strings.Contains(err.Error(), "--retain-data") {
		t.Fatalf("hint for the appliance owner: %v", err)
	}
	other := errors.New("unreachable")
	if userDeleteError(other, false) != other {
		t.Fatal("other errors must pass through")
	}
}
