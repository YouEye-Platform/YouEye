package cmd

import "testing"

func TestSetupIsCompletedAcceptsCurrentSnakeCaseContract(t *testing.T) {
	if !setupIsCompleted(map[string]interface{}{"setup_completed": true}) {
		t.Fatal("setup_completed=true was not recognised")
	}
	if setupIsCompleted(map[string]interface{}{"setup_completed": false}) {
		t.Fatal("setup_completed=false was reported complete")
	}
}

func TestSetupIsCompletedRetainsIntentionalCompatibilityAliases(t *testing.T) {
	for _, data := range []map[string]interface{}{
		{"setupCompleted": true},
		{"completed": true},
	} {
		if !setupIsCompleted(data) {
			t.Fatalf("compatibility response %#v was not recognised", data)
		}
	}
}
