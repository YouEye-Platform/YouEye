package api

import (
	"errors"
	"strings"
	"testing"
)

func TestPrepareIncusSnapshotReplacesStaleSnapshotBeforeMutation(t *testing.T) {
	var calls []string
	runner := func(args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if len(calls) == 1 {
			return []byte("daily\npre-update\n"), nil
		}
		return nil, nil
	}
	if err := prepareIncusSnapshot("youeye-control", "pre-update", runner); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"snapshot list youeye-control --format csv -c n",
		"snapshot delete youeye-control pre-update",
		"snapshot create youeye-control pre-update",
	}
	if strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %v", calls)
	}
}

func TestPrepareIncusSnapshotFailsClosed(t *testing.T) {
	t.Run("list", func(t *testing.T) {
		calls := 0
		err := prepareIncusSnapshot("youeye-control", "pre-update", func(args ...string) ([]byte, error) {
			calls++
			return []byte("unavailable"), errors.New("list failed")
		})
		if err == nil || calls != 1 {
			t.Fatalf("result = %v calls=%d", err, calls)
		}
	})
	t.Run("create", func(t *testing.T) {
		calls := 0
		err := prepareIncusSnapshot("youeye-control", "pre-update", func(args ...string) ([]byte, error) {
			calls++
			if calls == 1 {
				return nil, nil
			}
			return []byte("no space"), errors.New("create failed")
		})
		if err == nil || calls != 2 || !strings.Contains(err.Error(), "no space") {
			t.Fatalf("result = %v calls=%d", err, calls)
		}
	})
}
