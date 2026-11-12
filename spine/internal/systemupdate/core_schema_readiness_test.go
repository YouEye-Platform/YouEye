package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCoreSchemaReadinessRetriesOnlyReadOnlyUnavailableResponses(t *testing.T) {
	for _, method := range []bool{false, true} {
		for _, status := range []int{403, 409, 500, 502, 503, 504} {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
			_, err := coreSchemaRequest(context.Background(), server.Client(), server.URL, "X-CLI-Token", "fixture", coreComponentMarker{}, method)
			server.Close()
			want := !method && (status == 502 || status == 503 || status == 504)
			if errors.Is(err, errCoreSchemaNotReady) != want {
				t.Fatalf("POST=%v HTTP=%d retry classification: %v", method, status, err)
			}
		}
	}
}

func TestCoreSchemaReadinessWaitRevalidatesAndDoesNotReplayUnknownEffects(t *testing.T) {
	for _, terminal := range []error{nil, errors.New("lost POST response"), errors.New("identity changed")} {
		calls := 0
		got, err := waitCoreSchemaReadiness(context.Background(), func(context.Context) (CoreActionObservation, error) {
			calls++
			if calls < 3 {
				return CoreActionObservation{}, errCoreSchemaNotReady
			}
			return CoreActionObservation{State: "succeeded"}, terminal
		}, time.Millisecond)
		if calls != 3 || err != terminal || got.State != "succeeded" {
			t.Fatalf("calls=%d result=%+v err=%v", calls, got, err)
		}
	}
}

func TestCoreSchemaReadinessCancellationStopsWithoutStartingEffects(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, err := waitCoreSchemaReadiness(ctx, func(context.Context) (CoreActionObservation, error) {
		calls++
		cancel()
		return CoreActionObservation{}, errCoreSchemaNotReady
	}, time.Hour)
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestCoreSchemaTransportFailureNeverRetriesPOST(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	server.Close()
	for _, begin := range []bool{false, true} {
		_, err := coreSchemaRequest(context.Background(), server.Client(), server.URL, "X-CLI-Token", "fixture", coreComponentMarker{}, begin)
		if errors.Is(err, errCoreSchemaNotReady) == begin {
			t.Fatalf("POST=%v: %v", begin, err)
		}
		if coreNativeFailureCode(err) != "schema_response_unavailable" {
			t.Fatal(err)
		}
	}
}

func TestCoreSchemaFailureCodesRemainAllowlistedAndUncertain(t *testing.T) {
	for _, item := range []struct {
		err  error
		code string
	}{
		{fmt.Errorf("private diagnostics: %w", errCoreSchemaRequestRejected), "schema_request_rejected"},
		{errCoreSchemaIdentityMismatch, "schema_identity_mismatch"},
		{errors.New("private credentials must not be retained"), "native_action_failed"},
	} {
		code := coreNativeFailureCode(item.err)
		if code != item.code {
			t.Fatal(code)
		}
		if err := validateNativeResult(CoreActionObservation{State: "unknown", Stage: "execute", Code: code, EffectState: "started"}); err != nil {
			t.Fatal(err)
		}
	}
}
