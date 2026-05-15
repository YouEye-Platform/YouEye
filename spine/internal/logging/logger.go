// Package logging provides structured logging for Spine.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

var logger *slog.Logger

// Level represents log level
type Level string

const (
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Init initializes the logger with the specified configuration.
func Init(level string, format string) {
	var slogLevel slog.Level
	switch strings.ToLower(level) {
	case "debug":
		slogLevel = slog.LevelDebug
	case "warn", "warning":
		slogLevel = slog.LevelWarn
	case "error":
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: slogLevel,
	}

	var handler slog.Handler
	switch strings.ToLower(format) {
	case "json":
		handler = slog.NewJSONHandler(os.Stderr, opts)
	default:
		handler = slog.NewTextHandler(os.Stderr, opts)
	}

	logger = slog.New(handler)
}

// InitWithWriter initializes the logger with a custom writer (for testing).
func InitWithWriter(w io.Writer, level string, format string) {
	var slogLevel slog.Level
	switch strings.ToLower(level) {
	case "debug":
		slogLevel = slog.LevelDebug
	case "warn", "warning":
		slogLevel = slog.LevelWarn
	case "error":
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: slogLevel,
	}

	var handler slog.Handler
	switch strings.ToLower(format) {
	case "json":
		handler = slog.NewJSONHandler(w, opts)
	default:
		handler = slog.NewTextHandler(w, opts)
	}

	logger = slog.New(handler)
}

// Default returns the default logger, initializing if needed.
func Default() *slog.Logger {
	if logger == nil {
		Init("info", "text")
	}
	return logger
}

// Debug logs a debug message.
func Debug(msg string, args ...any) {
	Default().Debug(msg, args...)
}

// Info logs an info message.
func Info(msg string, args ...any) {
	Default().Info(msg, args...)
}

// Warn logs a warning message.
func Warn(msg string, args ...any) {
	Default().Warn(msg, args...)
}

// Error logs an error message.
func Error(msg string, args ...any) {
	Default().Error(msg, args...)
}

// With returns a logger with additional context.
func With(args ...any) *slog.Logger {
	return Default().With(args...)
}

// WithComponent returns a logger tagged with a component name.
func WithComponent(component string) *slog.Logger {
	return Default().With("component", component)
}
