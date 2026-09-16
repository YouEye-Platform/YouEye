package cmd

// ExitError lets machine-oriented commands return a stable process exit code
// without conflating every health state with the generic CLI error code.
type ExitError struct {
	Code    int
	Message string
}

func (e *ExitError) Error() string { return e.Message }
func (e *ExitError) ExitCode() int { return e.Code }
