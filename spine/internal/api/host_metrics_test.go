package api

import (
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestHostCPUAccounting(t *testing.T) {
	counters, ok := parseHostCPU("cpu 100 20 30 700 100 10 20 20 50 10\ncpu0 1 2 3 4")
	if !ok || counters.total != 1000 || counters.idle != 800 {
		t.Fatalf("guest time must not be double counted and iowait is idle: %+v", counters)
	}
	if got := hostCPUPercent(hostCPUCounters{}, counters); got != 20 {
		t.Fatalf("usage=%v", got)
	}
	if _, ok := parseHostCPU("cpu 1 bad 3 4"); ok {
		t.Fatal("malformed counters accepted")
	}
	if got := hostCPUPercent(counters, hostCPUCounters{total: 20, idle: 10}); got != 0 {
		t.Fatal("reset counter underflow")
	}
}

func TestMetricsConcurrentReadersReuseObservationAndExpire(t *testing.T) {
	s := &Server{}
	var wg sync.WaitGroup
	bodies := make([]string, 12)
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			response := httptest.NewRecorder()
			s.handleMetrics(response, httptest.NewRequest("GET", "/api/metrics", nil))
			bodies[i] = response.Body.String()
		}(i)
	}
	wg.Wait()
	for _, body := range bodies {
		if body != bodies[0] {
			t.Fatal("concurrent readers received separate collections")
		}
	}
	first := s.metricsTime
	cpu := s.metricsCPU
	s.handleMetrics(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/metrics", nil))
	if s.metricsTime != first || s.metricsCPU != cpu {
		t.Fatal("warm read sampled again")
	}
	s.metricsTime = time.Now().Add(-16 * time.Second)
	s.handleMetrics(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/metrics", nil))
	if !s.metricsTime.After(first) || !s.metricsCPU.at.After(cpu.at) {
		t.Fatal("expired metrics did not refresh")
	}
}
