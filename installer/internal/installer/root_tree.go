package installer

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

// Generated offline from Artem's tree-roots source image with ansipx-render.
// Keep this as static data: Ansizalizer/ansipx are not runtime dependencies.
const rootPasswordTree = `
                                     -=..=:
                                    :.= -*.
                                    : :*--
                                   :  +==:
                                  -  ==#==-       :
                                -:  ==+*-==-:   :-=:
                             ::-   ===##-+::     :+:::             .
                       .::-==     .=:**++=-      .-#-=                .
              .::..:+- : :++      .**+  .+=     . =+=--:
                 ..      -:     ===---   -+.       :**=+=:        .           :::..
                       :: : .++-=-. .    .*#:      .=*##*+=:         .:.         :        .
        ..::: . ..:-=+==-=--*-           .#+-       =++*-.   .         .::-.      .
  :                ===- .-=%=.           ==.        .:*#=   .=-:         .-.
..              ::.:.     +#+          .*-           .#%=::   : .:--.         .
              :          .**.         :=-            .##+-.     .::::===.       ..
          --             :*-          .+.            #%+-           -=--=:   .            .::.:: .
        ..             .::.          .=  =.         :*==.:             =*#+-   .                .  .
      :                -+:          -:    ::       -*+: -:.             =#==-
     =                -=-       .         .-     -+=:    =*:             :=-++.
    .:              .=-.                      :+=:       :-#*-            :+=-. -=+=.
    :      :   ...   =+.                :   .*+.          .-*=.                   .--
  .      :          -.                     :*=.             .=+-    .        -      =+ . :.
                 :.:      -                +=:                ==:                   :*:
                .         ..           .:-=:-                  =+:      .            .*:
              -:                :-.::  .    =.                 :+-                     =.
              :              : .:           --                  .+-      .             ::
                           .=.              .=                   --.:                  +.
                         -.                 -.                  +    .::.              ..
                        .                 :.  :               .-        ::
                                       .       .             .           .:.
                                               .                           :
                                                                           :
`

func rootPasswordTreeLines() []string {
	return strings.Split(strings.Trim(rootPasswordTree, "\n"), "\n")
}

func rootPasswordTreeBackdrop(width, height int) []string {
	if width <= 0 || height <= 0 {
		return nil
	}

	rows := make([]string, height)
	for i := range rows {
		rows[i] = strings.Repeat(" ", width)
	}

	lines := rootPasswordTreeLines()
	artWidth := 0
	for _, line := range lines {
		if len(line) > artWidth {
			artWidth = len(line)
		}
	}

	startY := (height - len(lines)) / 2
	startX := (width - artWidth) / 2
	for i, line := range lines {
		y := startY + i
		if y < 0 || y >= height {
			continue
		}

		segment, x := rootTreeVisibleSegment(line, width, startX)
		if segment == "" {
			continue
		}
		rows[y] = rows[y][:x] + segment + rows[y][x+len(segment):]
	}
	return rows
}

func rootTreeVisibleSegment(line string, width, startX int) (string, int) {
	if width <= 0 || line == "" || startX >= width || startX+len(line) <= 0 {
		return "", 0
	}

	x := startX
	segment := line
	if x < 0 {
		segment = segment[-x:]
		x = 0
	}
	if x+len(segment) > width {
		segment = segment[:width-x]
	}
	return segment, x
}

func renderRootPasswordBackdropWithDialog(width, height int, dialog string) string {
	if width <= 0 || height <= 0 {
		return dialog
	}

	rows := rootPasswordTreeBackdrop(width, height)
	dialogLines := strings.Split(dialog, "\n")
	dialogWidth := lipgloss.Width(dialog)
	dialogHeight := len(dialogLines)
	x := (width - dialogWidth) / 2
	y := (height - dialogHeight) / 2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}

	rendered := make([]string, len(rows))
	for i, row := range rows {
		if i >= y && i < y+dialogHeight {
			overlay := dialogLines[i-y]
			overlayWidth := lipgloss.Width(overlay)
			end := x + overlayWidth
			if end > width {
				end = width
			}
			rendered[i] = theme.Dim.Render(row[:x]) + overlay + theme.Dim.Render(row[end:])
			continue
		}
		rendered[i] = theme.Dim.Render(row)
	}
	return strings.Join(rendered, "\n")
}
