package systemupdate

import (
	"context"
	"testing"
	"time"
)

// Package tests check settlement once; TestCoreProviderSettledWaitsForRunningOperations covers the wait.
func init() { coreProviderSettleWait = 0 }

func TestCoreProviderSettledWaitsForRunningOperations(t *testing.T) {
	old := coreProviderSettleWait
	coreProviderSettleWait = time.Minute
	t.Cleanup(func() { coreProviderSettleWait = old })
	calls := 0
	p := NativeCoreCheckpoint{Capture: func(context.Context, string, ...string) ([]byte, error) {
		calls++
		if calls < 3 {
			return []byte(coreProviderResponse(`{"running":[{"id":"refresh","class":"task","status_code":103}]}`)), nil
		}
		return []byte(coreProviderResponse(`{"success":[{"id":"refresh","class":"task","status_code":200}]}`)), nil
	}}
	if err := p.requireProviderSettled(context.Background()); err != nil || calls != 3 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	// Anything other than "still running" fails at once.
	calls = 0
	p.Capture = func(context.Context, string, ...string) ([]byte, error) {
		calls++
		return []byte(coreProviderResponse(`{"success":[{"id":"x","class":"unknown","status_code":200}]}`)), nil
	}
	if err := p.requireProviderSettled(context.Background()); err == nil || calls != 1 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	// A cancelled context stops the wait.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.Capture = func(context.Context, string, ...string) ([]byte, error) {
		return []byte(coreProviderResponse(`{"running":[{"id":"refresh","class":"task","status_code":103}]}`)), nil
	}
	if err := p.requireProviderSettled(ctx); err == nil {
		t.Fatal("cancelled wait succeeded")
	}
}
