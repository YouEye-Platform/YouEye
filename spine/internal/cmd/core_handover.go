package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/spineselect"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The hand-over after the Spine step.
//
// A System request is coordinated by the process that runs `update core
// activate|resume` (a transient unit started by the API, the boot unit, or a
// terminal). Every step is a separate process started through the launcher, so
// the steps after apply-spine already run in the new Spine; only this loop
// stayed in the Spine that started the request. After apply-spine has
// succeeded, the loop therefore replaces itself: it execs the baked launcher
// with `update core resume --request <id>`, which runs the slot's current
// Spine. The process, its unit and its main PID stay the same, so there is no
// second unit to name, start or collect, and nothing can run beside it.
//
// The journal at that point (apply-spine succeeded, nothing after it started)
// is what a lost coordinator leaves, and `resume` is the command that continues
// it: after a reboot `youeye-core-update.service` does exactly that, and an
// image update has always changed coordinators this way. Every hold of the
// request (the lifecycle reservation, the container power holds, the ingress
// gate, the service holds inside the containers) is durable state, none is a
// lock or descriptor of this process.
//
// The hand-over is refused, and this Spine keeps coordinating as before, unless
// the slot's committed Spine is the release's and that Spine, asked through the
// same launcher, reads this very request and answers that it can continue it
// (`update core status --can-resume --request <id>`): it has built the runtime
// its `resume` builds and passed every check `resume` makes before it records
// the next step. A Spine that does not know the flag, answers "no", answers
// about another request or state, answers something unreadable or does not
// answer in time is not handed anything. The launcher runs the question and
// `resume` the same way, so the Spine that answers is the Spine that would
// continue.

const (
	// coreHandOverProbeTimeout bounds the question. It is asked while the
	// Control Panel and the dashboard are held, so a Spine that hangs costs at
	// most this long (plus coreHandOverProbeWaitDelay) before this Spine
	// carries on. A healthy answer needs a few file reads and short runs of
	// `findmnt` and `lsblk`.
	coreHandOverProbeTimeout = 20 * time.Second
	// coreHandOverProbeWaitDelay: how long after the kill a descendant that
	// escaped it may keep the answer pipe open before it is closed anyway.
	coreHandOverProbeWaitDelay = 2 * time.Second
	// coreHandOverProbeMaxOutput is above the largest valid answer (a 2 MiB
	// receipt and a 4 MiB journal).
	coreHandOverProbeMaxOutput = 8 << 20
)

// coreNotice writes one line about what this coordinator decided to standard
// error: in a continuation unit and in the boot unit that is the system
// journal (`journalctl -u 'youeye-core-control-*' -u youeye-core-update`). It
// is for decisions only, never for progress: while a step runs the coordinator
// looks about once a second. Tests replace it.
var coreNotice = func(line string) { fmt.Fprintln(os.Stderr, "core update: "+line) }

// Tests replace these.
var (
	coreHandOverExec    = syscall.Exec
	coreHandOverCurrent = coreCurrentSpineSHA256
	coreHandOverProbe   = func(ctx context.Context, executable, request string, env []string) ([]byte, error) {
		return runCoreHandOverProbe(ctx, coreHandOverProbeTimeout, executable, []string{"update", "core", "status", "--can-resume", "--request", request}, env)
	}
	// coreResumeCheck is the new Spine's side of the question: it builds what
	// `resume` builds (the installed runtime and the continuation's
	// coordinator) and runs CheckResume, which only reads.
	coreResumeCheck = func(ctx context.Context, request string) (systemupdate.CoreJournal, error) {
		runtime, err := installedCoreRuntime()
		if err != nil {
			return systemupdate.CoreJournal{}, err
		}
		return coreContinuationManager(runtime).CheckResume(ctx, request)
	}
)

// coreProbeAnswer is a bounded buffer. The buffer is a field, not embedded: an
// embedded one would lend its ReadFrom, and the copy would bypass the bound.
type coreProbeAnswer struct{ read bytes.Buffer }

func (a *coreProbeAnswer) Write(p []byte) (int, error) {
	if a.read.Len()+len(p) > coreHandOverProbeMaxOutput {
		return 0, fmt.Errorf("the answer is too large")
	}
	return a.read.Write(p)
}

// runCoreHandOverProbe runs the question as a child and returns its standard
// output only when it exited with status 0 in time. When the time is up, the
// child and everything it started (its own process group) are killed.
func runCoreHandOverProbe(ctx context.Context, timeout time.Duration, executable string, args, env []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	probe := exec.CommandContext(ctx, executable, args...)
	probe.Env = env
	var answer coreProbeAnswer
	probe.Stdout = &answer
	probe.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	probe.Cancel = func() error {
		err := syscall.Kill(-probe.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	probe.WaitDelay = coreHandOverProbeWaitDelay
	err := probe.Run()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("no answer within %s: %w", timeout, ctx.Err())
	}
	if err != nil {
		return nil, err
	}
	return answer.read.Bytes(), nil
}

// coreAnswerCanResume adds this Spine's answer for the request to a status
// answer: "can_resume" (always), "can_resume_request" (the request the answer
// is about) and, when it cannot, "can_resume_reason". When it can,
// "transaction" is the journal that was judged. The returned error is the
// command's: non-nil unless the answer is yes.
func coreAnswerCanResume(ctx context.Context, out map[string]any, request string) error {
	out["can_resume_request"] = request
	judged, err := coreResumeCheck(ctx, request)
	if err != nil {
		reason := err.Error()
		if len(reason) > 300 {
			reason = reason[:300]
		}
		out["can_resume"], out["can_resume_reason"] = false, reason
		return fmt.Errorf("this Spine cannot continue request %s now: %w", request, err)
	}
	out["can_resume"], out["transaction"] = true, judged
	return nil
}

// coreCurrentSpineSHA256 is the committed Spine of the booted slot. A trial
// that is still pending is not a hand-over target. It only reads.
func coreCurrentSpineSHA256() (string, error) {
	slot, err := bootedSlot()
	if err != nil {
		return "", err
	}
	selection, err := spineselect.Load(spineRoot)
	if err != nil {
		return "", err
	}
	state := selection.Slots[slot]
	if state == nil || state.Current == nil || state.Trial != nil {
		return "", fmt.Errorf("slot %s has no committed Spine", slot)
	}
	return state.Current.SHA256, nil
}

// coreHandOverEnvironment drops the launcher's marker, so that the baked
// launcher delegates again (it removes the marker itself at start; this keeps
// the hand-over independent of that).
func coreHandOverEnvironment(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, spineselect.DelegatedEnv+"=") {
			out = append(out, entry)
		}
	}
	return out
}

// coreHandOverToSelectedSpine returns only when the hand-over was not made.
func coreHandOverToSelectedSpine(ctx context.Context, j systemupdate.CoreJournal) error {
	member, ok := j.Target.Member("spine")
	if !ok {
		return fmt.Errorf("the release has no Spine")
	}
	current, err := coreHandOverCurrent()
	if err != nil {
		return err
	}
	if current != member.Artifact.SHA256 {
		return fmt.Errorf("the slot's committed Spine is not the release's Spine")
	}
	env := coreHandOverEnvironment(os.Environ())
	raw, err := coreHandOverProbe(ctx, coreBakedExecutable, j.RequestID, env)
	if err != nil {
		return fmt.Errorf("the new Spine did not confirm that it can continue this request: %w", err)
	}
	var status struct {
		CanResume        *bool  `json:"can_resume"`
		CanResumeRequest string `json:"can_resume_request"`
		Transaction      struct {
			RequestID      string `json:"request_id"`
			ManifestSHA256 string `json:"manifest_sha256"`
			Phase          string `json:"phase"`
			Steps          []struct {
				Name  string `json:"name"`
				State string `json:"state"`
			} `json:"steps"`
		} `json:"transaction"`
	}
	if json.Unmarshal(raw, &status) != nil {
		return fmt.Errorf("the new Spine's answer is unreadable")
	}
	if status.CanResume == nil || !*status.CanResume || status.CanResumeRequest != j.RequestID {
		return fmt.Errorf("the new Spine did not answer that it can continue this request")
	}
	seen := status.Transaction
	if seen.RequestID != j.RequestID || seen.ManifestSHA256 != j.ManifestSHA256 || seen.Phase != j.Phase || len(seen.Steps) != len(j.Steps) {
		return fmt.Errorf("the new Spine does not read this request")
	}
	for i, step := range j.Steps {
		if seen.Steps[i].Name != step.Name || seen.Steps[i].State != step.State {
			return fmt.Errorf("the new Spine reads another state of this request")
		}
	}
	// Written before the exec, which leaves nobody to write it afterwards. Exec
	// returns only on failure; the process image is unchanged then, and the
	// caller says that this Spine keeps coordinating.
	coreNotice(fmt.Sprintf("handing request %s over to Spine %s (sha256 %.12s)", j.RequestID, releaseSpineIdentity(j.Target, member).shown(), member.Artifact.SHA256))
	if err := coreHandOverExec(coreBakedExecutable, []string{coreBakedExecutable, "update", "core", "resume", "--request", j.RequestID}, env); err != nil {
		return fmt.Errorf("starting the new Spine's continuation failed: %w", err)
	}
	return fmt.Errorf("the new Spine's continuation did not start")
}
