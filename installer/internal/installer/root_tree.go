package installer

import (
	"strings"

	"git.potemk.in/potemsla/YouEye/installer/internal/installer/theme"
)

// Generated offline from Artem's tree-roots source image with ansipx-render.
// Keep this as static data: Ansizalizer/ansipx are not runtime dependencies.
const rootPasswordTree = `
                         ++*-:::.. ...
                        --**:..::::..:
                       --+%*+-.-=-:.....
                    :-=.+*%*+: :*+=.....:--:. .
         . .:::-=-=*=  -##-*=. .+#*=:  ::.  :---:.
       ..  .::...:==-+++--..%=  .+#%*=. .:--:   .=-.:.::.
  .. .=.::--::-+**+*%- ..  -*-   -*%=:==:.  :+=.  :.   .
   ..:     ..--:.  **:    =+.   ..+@+- .=+++-..:--.:....:..
  :      :--     ::*-   .-+=.  :..%*=:   .:=**-:......::----.:.
.      .=.   .. :-*:  .::-  =. .=*=-+-     .=#*=.:....      :  .
       -:  ::::-=*.  ...   : -++-.  -#*:..   :+=-+*-.  .     .
     .. ..:..  :=..: .   : .:#=.     .=*: ::   :  .*--:::.
   .  ..     :-    ::  .:.--=+.   .    =*.  :. :   :*.   .-:
    .       :-      :-=:     +-  .     .++   :      :=     ..
            :     :-:        =-         +.:--       .=        .
                 ::       ... :.      .-    .=:     .. .
                       ..      .     .:       =
`

func rootPasswordTreeView(width, height int) string {
	if width < 92 || height < 32 {
		return ""
	}

	lines := strings.Split(strings.Trim(rootPasswordTree, "\n"), "\n")
	rendered := make([]string, 0, len(lines))
	for _, line := range lines {
		rendered = append(rendered, "  "+theme.Dim.Render(line))
	}
	return strings.Join(rendered, "\n")
}
