package container

import (
	"errors"
	"testing"
)

func TestEnforceUIEgressBlockLeavesACorrectACLAlone(t *testing.T) {
	repairs := 0
	repair := func(string, string) error { repairs++; return nil }
	if err := enforceUIEgressBlock("acl", "10.0.0.2", func(string, string) error { return nil }, repair); err != nil {
		t.Fatal(err)
	}
	if repairs != 0 {
		t.Fatalf("a correct ACL was recreated %d time(s): the UI has no block while it is", repairs)
	}
}

func TestEnforceUIEgressBlockRepairsDrift(t *testing.T) {
	repairs, repaired := 0, false
	verify := func(string, string) error {
		if repaired {
			return nil
		}
		return errors.New("stale Control Panel address")
	}
	repair := func(string, string) error { repairs++; repaired = true; return nil }
	if err := enforceUIEgressBlock("acl", "10.0.0.2", verify, repair); err != nil {
		t.Fatal(err)
	}
	if repairs != 1 {
		t.Fatalf("drift was repaired %d time(s), want 1", repairs)
	}
	stillWrong := func(string, string) error { return errors.New("no rule") }
	if err := enforceUIEgressBlock("acl", "10.0.0.2", stillWrong, func(string, string) error { return nil }); err == nil {
		t.Fatal("a repair that did not take was reported as enforced")
	}
}
