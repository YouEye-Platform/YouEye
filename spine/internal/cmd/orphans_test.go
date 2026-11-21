package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

// `youeye orphans clean` waits for the Control Panel's answer, which comes only when every orphan is removed: a
// cleanup that takes longer than an ordinary request still reports its result (it gave up at 2 minutes before).
func TestOrphansCleanWaitsPastTheOrdinaryTimeout(t *testing.T) {
	oldShort, oldLong := controlapi.RequestTimeout, controlapi.LongRequestTimeout
	controlapi.RequestTimeout, controlapi.LongRequestTimeout = 50*time.Millisecond, 5*time.Second
	t.Cleanup(func() { controlapi.RequestTimeout, controlapi.LongRequestTimeout = oldShort, oldLong })
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"POST /api/admin/orphans": func(string) (int, string) {
			time.Sleep(300 * time.Millisecond)
			return 200, `{"cleaned":2,"failed":0,"errors":[]}`
		},
	})
	var err error
	printed := captureStdout(t, func() { err = orphansCleanCmd.RunE(orphansCleanCmd, nil) })
	if err != nil || !strings.Contains(printed, "Removed 2 orphaned resource(s)") {
		t.Fatalf("orphans clean: %v\n%s", err, printed)
	}
	checkSent(t, fake, `POST /api/admin/orphans {"action":"cleanup-all"}`)
}
