package systemupdate

import (
	"errors"
	"fmt"
	"os"
	"runtime"

	"golang.org/x/sys/unix"
)

// A container root reached through /proc/<init>/root can be an idmapped
// mount. Host root then has no filesystem identity in that mount: namespace writes
// fail with EOVERFLOW before changing an inode. Retry only that failure,
// using the anchored parent's mapped owner for the single namespace syscall.
// Reads, ownership validation, journal writes and subsequent operations keep
// the caller's credentials. No container program or namespace is entered.
func mutateCoreMapped(parent *os.File, create func() error) error {
	defer runtime.KeepAlive(parent)
	err := create()
	if !errors.Is(err, unix.EOVERFLOW) {
		return err
	}
	var owner unix.Stat_t
	if unix.Fstat(int(parent.Fd()), &owner) != nil || owner.Mode&unix.S_IFMT != unix.S_IFDIR || owner.Mode&0022 != 0 || owner.Uid == ^uint32(0) || owner.Gid == ^uint32(0) {
		return fmt.Errorf("safe mapped core parent ownership required")
	}
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		uid, uidErr := unix.SetfsuidRetUid(-1)
		gid, gidErr := unix.SetfsgidRetGid(-1)
		if uidErr != nil || gidErr != nil {
			runtime.UnlockOSThread()
			result <- fmt.Errorf("core filesystem identity unavailable")
			return
		}
		var operationErr error
		defer func() {
			_, restoreUID := unix.SetfsuidRetUid(uid)
			_, restoreGID := unix.SetfsgidRetGid(gid)
			actualUID, checkUID := unix.SetfsuidRetUid(-1)
			actualGID, checkGID := unix.SetfsgidRetGid(-1)
			if restoreUID == nil && restoreGID == nil && checkUID == nil && checkGID == nil && actualUID == uid && actualGID == gid {
				runtime.UnlockOSThread()
			} else {
				// Exiting a still-locked goroutine retires its OS thread. Never
				// return changed filesystem credentials to the runtime pool.
				operationErr = errors.Join(operationErr, fmt.Errorf("core filesystem identity restoration failed"))
			}
			result <- operationErr
		}()
		_, setGID := unix.SetfsgidRetGid(int(owner.Gid))
		_, setUID := unix.SetfsuidRetUid(int(owner.Uid))
		actualUID, checkUID := unix.SetfsuidRetUid(-1)
		actualGID, checkGID := unix.SetfsgidRetGid(-1)
		if setGID != nil || setUID != nil || checkUID != nil || checkGID != nil || actualUID != int(owner.Uid) || actualGID != int(owner.Gid) {
			operationErr = fmt.Errorf("mapped core filesystem identity unavailable")
			return
		}
		operationErr = create()
	}()
	return <-result
}

func mkdirCoreMapped(parent *os.File, name string, mode uint32) error {
	return mutateCoreMapped(parent, func() error { return unix.Mkdirat(int(parent.Fd()), name, mode) })
}

func openCoreMappedExclusive(parent *os.File, name string, mode uint32) (int, error) {
	fd := -1
	err := mutateCoreMapped(parent, func() error {
		var err error
		fd, err = unix.Openat(int(parent.Fd()), name, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
		return err
	})
	if err != nil && fd >= 0 {
		unix.Close(fd)
		fd = -1
	}
	return fd, err
}

func symlinkCoreMapped(parent *os.File, target, name string) error {
	return mutateCoreMapped(parent, func() error { return unix.Symlinkat(target, int(parent.Fd()), name) })
}
