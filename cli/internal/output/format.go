package output

import (
	"fmt"
	"strings"
)

// ANSI color codes
const (
	Reset  = "\033[0m"
	Bold   = "\033[1m"
	Red    = "\033[31m"
	Green  = "\033[32m"
	Yellow = "\033[33m"
	Blue   = "\033[34m"
	Cyan   = "\033[36m"
	Gray   = "\033[90m"
)

func Header(title string) {
	fmt.Println(Bold + "========================================" + Reset)
	fmt.Println(Bold + "  " + title + Reset)
	fmt.Println(Bold + "========================================" + Reset)
}

func Section(title string) {
	fmt.Println()
	fmt.Println(Bold + title + Reset)
}

func StatusLine(label, value, color string) {
	padded := label + ":" + strings.Repeat(" ", max(1, 18-len(label)))
	fmt.Printf("  %s%s%s%s\n", padded, color, value, Reset)
}

func Success(msg string) {
	fmt.Printf("%s✓%s %s\n", Green, Reset, msg)
}

func Warn(msg string) {
	fmt.Printf("%s!%s %s\n", Yellow, Reset, msg)
}

func Error(msg string) {
	fmt.Printf("%s✗%s %s\n", Red, Reset, msg)
}

func Info(msg string) {
	fmt.Printf("%s→%s %s\n", Blue, Reset, msg)
}

// Table prints a formatted table.
func Table(headers []string, rows [][]string) {
	if len(rows) == 0 {
		fmt.Println("  (none)")
		return
	}

	// Calculate column widths
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, cell := range row {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	// Print header
	headerLine := "  "
	separatorLine := "  "
	for i, h := range headers {
		headerLine += fmt.Sprintf("%-*s  ", widths[i], h)
		separatorLine += strings.Repeat("─", widths[i]) + "  "
	}
	fmt.Println(Bold + headerLine + Reset)
	fmt.Println(Gray + separatorLine + Reset)

	// Print rows
	for _, row := range rows {
		line := "  "
		for i, cell := range row {
			if i < len(widths) {
				line += fmt.Sprintf("%-*s  ", widths[i], cell)
			}
		}
		fmt.Println(line)
	}
}

// SSEProgress prints an SSE progress event.
func SSEProgress(step, total int, status, message string) {
	icon := "⏳"
	color := ""
	switch status {
	case "success", "complete", "done":
		icon = Green + "✓" + Reset
		color = Green
	case "error", "failed":
		icon = Red + "✗" + Reset
		color = Red
	case "skipped":
		icon = Yellow + "→" + Reset
		color = Yellow
	case "progress", "running":
		icon = Blue + "⏳" + Reset
		color = Blue
	}

	if total > 0 {
		fmt.Printf("  %s [%d/%d] %s%s%s\n", icon, step, total, color, message, Reset)
	} else {
		fmt.Printf("  %s %s%s%s\n", icon, color, message, Reset)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
