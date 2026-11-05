package cmd

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestSystemUpdateHelpDescribesBothRuntimeKinds(t *testing.T) {
	if !strings.Contains(updateSystemCmd.Short, "host system") {
		t.Fatalf("system update help %q does not describe mutable hosts", updateSystemCmd.Short)
	}
	if !strings.Contains(updateSystemCmd.Short, "signed appliance image") {
		t.Fatalf("system update help %q does not describe sealed appliances", updateSystemCmd.Short)
	}
}

func TestRunControlUpdateFinalizationOrdersReconciliationBeforeCredentials(t *testing.T) {
	var calls []string
	record := func(name string) func() error {
		return func() error {
			calls = append(calls, name)
			return nil
		}
	}

	err := runControlUpdateFinalization(controlUpdateFinalizers{
		reconcileInfrastructure: record("reconcile"),
		provisionBridgeToken:    record("bridge-token"),
		provisionCLIToken:       record("cli-token"),
		enforceUIEgressBlock:    record("ui-egress"),
		repairControlProxy:      record("control-proxy"),
	})
	if err != nil {
		t.Fatalf("runControlUpdateFinalization() error = %v", err)
	}

	want := []string{"reconcile", "bridge-token", "cli-token", "ui-egress", "control-proxy"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("finalization order = %v, want %v", calls, want)
	}
}

func TestRunControlUpdateFinalizationStopsBeforeCredentialsWhenReconciliationFails(t *testing.T) {
	var calls []string
	reconcileErr := errors.New("reconcile failed")

	err := runControlUpdateFinalization(controlUpdateFinalizers{
		reconcileInfrastructure: func() error {
			calls = append(calls, "reconcile")
			return reconcileErr
		},
		provisionBridgeToken: func() error {
			calls = append(calls, "bridge-token")
			return nil
		},
	})
	if !errors.Is(err, reconcileErr) {
		t.Fatalf("runControlUpdateFinalization() error = %v, want wrapped %v", err, reconcileErr)
	}
	if !strings.Contains(err.Error(), "infrastructure reconciliation failed") {
		t.Fatalf("runControlUpdateFinalization() error = %q, want reconciliation context", err)
	}
	if want := []string{"reconcile"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls after reconciliation failure = %v, want %v", calls, want)
	}
}
