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
	pad := 18 - len(label)
	if pad < 1 {
		pad = 1
	}
	padded := label + ":" + strings.Repeat(" ", pad)
	fmt.Printf("  %s%s%s%s\n", padded, color, value, Reset)
}

func Success(msg string) {
	fmt.Printf("%s\u2713%s %s\n", Green, Reset, msg)
}

func Warn(msg string) {
	fmt.Printf("%s!%s %s\n", Yellow, Reset, msg)
}

func Error(msg string) {
	fmt.Printf("%s\u2717%s %s\n", Red, Reset, msg)
}

func Info(msg string) {
	fmt.Printf("%s\u2192%s %s\n", Blue, Reset, msg)
}

// Table prints a formatted table.
func Table(headers []string, rows [][]string) {
	if len(rows) == 0 {
		fmt.Println("  (none)")
		return
	}

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

	headerLine := "  "
	separatorLine := "  "
	for i, h := range headers {
		headerLine += fmt.Sprintf("%-*s  ", widths[i], h)
		separatorLine += strings.Repeat("\u2500", widths[i]) + "  "
	}
	fmt.Println(Bold + headerLine + Reset)
	fmt.Println(Gray + separatorLine + Reset)

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
	icon := "\u23f3"
	color := ""
	switch status {
	case "success", "complete", "done":
		icon = Green + "\u2713" + Reset
		color = Green
	case "error", "failed":
		icon = Red + "\u2717" + Reset
		color = Red
	case "skipped":
		icon = Yellow + "\u2192" + Reset
		color = Yellow
	case "progress", "running":
		icon = Blue + "\u23f3" + Reset
		color = Blue
	}

	if total > 0 {
		fmt.Printf("  %s [%d/%d] %s%s%s\n", icon, step, total, color, message, Reset)
	} else {
		fmt.Printf("  %s %s%s%s\n", icon, color, message, Reset)
	}
}
