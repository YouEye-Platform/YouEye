package api

import (
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStatusConcurrentMissesCollectOnce(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "incus"), []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	s := testServer()
	var collections atomic.Int32
	s.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		collections.Add(1)
		time.Sleep(20 * time.Millisecond)
		return appliance.RuntimeStatus{}, nil, nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.handleStatus(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/status", nil))
		}()
	}
	wg.Wait()
	if got := collections.Load(); got != 1 {
		t.Fatalf("collected %d times for simultaneous cache misses", got)
	}
	s.statusTime = time.Now().Add(-time.Minute)
	s.handleStatus(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/status", nil))
	if got := collections.Load(); got != 2 {
		t.Fatalf("expired cache was not refreshed: %d", got)
	}
}
