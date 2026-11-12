package api

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type hostCPUCounters struct {
	idle, total uint64
	at          time.Time
}

func parseHostCPU(data string) (hostCPUCounters, bool) {
	fields := strings.Fields(strings.SplitN(data, "\n", 2)[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return hostCPUCounters{}, false
	}
	var values [8]uint64
	for i := 1; i < len(fields) && i <= len(values); i++ {
		value, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			return hostCPUCounters{}, false
		}
		values[i-1] = value
	}
	result := hostCPUCounters{idle: values[3] + values[4], at: time.Now()}
	// guest/guest_nice are already included in user/nice. I/O wait is idle.
	for _, value := range values {
		result.total += value
	}
	return result, true
}

func hostCPUPercent(before, after hostCPUCounters) float64 {
	if after.total <= before.total || after.idle < before.idle {
		return 0
	}
	total, idle := after.total-before.total, after.idle-before.idle
	if idle > total {
		return 0
	}
	return float64(total-idle) / float64(total) * 100
}

// Called under metricsMu; no background timer or collector runs without readers.
func (s *Server) sampleHostCPU() float64 {
	read := func() (hostCPUCounters, bool) {
		data, err := os.ReadFile("/proc/stat")
		if err != nil {
			return hostCPUCounters{}, false
		}
		return parseHostCPU(string(data))
	}
	current, ok := read()
	if !ok {
		return 0
	}
	previous := s.metricsCPU
	if previous.at.IsZero() || current.at.Sub(previous.at) > time.Minute {
		previous = current
		time.Sleep(200 * time.Millisecond)
		current, ok = read()
		if !ok {
			return 0
		}
	}
	s.metricsCPU = current
	return hostCPUPercent(previous, current)
}
