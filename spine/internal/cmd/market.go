package cmd

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

// The Control Panel reads apps from markets: the official YouEye Market (its address follows the box's channel) and
// custom markets the owner added by address. These commands use its API with the CLI token:
//   GET/POST/PATCH /api/market/source, POST /api/market/source/accept, POST /api/market/source/refresh,
//   GET /api/market/catalog, GET /api/market/app/<id>?source=<market id>.

const officialMarketID = "official"

const marketTrustWarning = "Apps from this market are not checked by YouEye. They run their own setup steps on your box. Add only markets you trust."

var marketCmd = &cobra.Command{
	Use:   "market",
	Short: "The markets this box installs apps from",
	Long: `The official YouEye Market is always there. You can add other markets by their address; apps from them are
not checked by YouEye and run their own setup steps on your box.`,
}

var marketListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the markets",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get("/api/market/source")
		if err != nil {
			return cpPlainError(err)
		}
		printMarketList(data)
		return nil
	},
}

var (
	marketAddTrusted bool
	marketAddName    string
)

var marketAddCmd = &cobra.Command{
	Use:   "add <address>",
	Short: "Add a market by its address",
	Long: `Add a market by its address (an HTTPS folder with a market.json). The box reads it first; an address that
is not a market adds nothing.

` + marketTrustWarning + ` Say so with --i-trust-this-market.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := validateMarketAdd(marketAddTrusted); err != nil {
			return err
		}
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Post("/api/market/source", marketAddRequest(args[0], marketAddName))
		if err != nil {
			return cpPlainError(err)
		}
		source, _ := data["source"].(map[string]interface{})
		output.Success(fmt.Sprintf("Market %s added: %s", textOf(source, "id"), textOf(source, "address", "url")))
		if market, ok := source["market"].(map[string]interface{}); ok {
			fmt.Printf("  It calls itself %s; %s apps, %s with setup steps.\n", marketSays(market), textOf(market, "apps"), textOf(market, "apps_with_setup"))
		} else if problem := textOf(source, "refresh_error"); problem != "" {
			output.Warn("Its apps could not be read yet: " + problem)
		}
		return nil
	},
}

// validateMarketAdd refuses to add a market without the owner's word that they trust it; nothing is sent then.
func validateMarketAdd(trusted bool) error {
	if trusted {
		return nil
	}
	output.Warn(marketTrustWarning)
	return errors.New("to add it, run the command again with --i-trust-this-market")
}

// marketAddRequest is the body of POST /api/market/source. The owner's consent is acceptRisk; without --name the
// Control Panel names the market by its host.
func marketAddRequest(address, name string) map[string]interface{} {
	body := map[string]interface{}{"url": strings.TrimSpace(address), "acceptRisk": true}
	if name = strings.TrimSpace(name); name != "" {
		body["name"] = name
	}
	return body
}

var marketRemoveCmd = &cobra.Command{
	Use:   "remove <id>",
	Short: "Remove a market",
	Long: `Remove a market from this box. Apps installed from it stay and keep running, but get no updates.
To update one again, choose a market for it: youeye app source <app> <market id> (a market added again
gets a new id, so its apps must be pointed at it). The official Market cannot be removed.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if args[0] == officialMarketID {
			return errors.New("the official Market cannot be removed")
		}
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get("/api/market/source")
		if err != nil {
			return cpPlainError(err)
		}
		body, err := marketRemoveRequest(data, args[0])
		if err != nil {
			return err
		}
		if _, err := controlClient.Patch("/api/market/source", body); err != nil {
			return cpPlainError(err)
		}
		output.Success("Market " + args[0] + " removed")
		return nil
	},
}

// marketRemoveRequest is the PATCH body that keeps every market but id: {active_sources: [{id}, ...]}. An entry with
// only its id keeps that market as it is.
func marketRemoveRequest(data map[string]interface{}, id string) (map[string]interface{}, error) {
	if id == officialMarketID {
		return nil, errors.New("the official Market cannot be removed")
	}
	sources, _ := data["sources"].([]interface{})
	keep := []interface{}{}
	found := false
	for _, item := range sources {
		source, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		sourceID := firstOf(source, "id")
		if sourceID == id {
			found = true
			continue
		}
		if sourceID != "" {
			keep = append(keep, map[string]interface{}{"id": sourceID})
		}
	}
	if !found {
		return nil, fmt.Errorf("there is no market %q (see youeye market list)", id)
	}
	return map[string]interface{}{"active_sources": keep}, nil
}

var marketAcceptCmd = &cobra.Command{
	Use:   "accept <id>",
	Short: "Accept a market, so its apps may be installed and updated",
	Long: `A market added by address is accepted when it is added. A market that lost its acceptance (its address
changed) lists its apps but installs and updates nothing until you accept it again.

` + marketTrustWarning,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		output.Warn(marketTrustWarning)
		data, err := controlClient.Post("/api/market/source/accept", map[string]interface{}{"id": args[0]})
		if err != nil {
			return cpPlainError(err)
		}
		source, _ := data["source"].(map[string]interface{})
		output.Success(fmt.Sprintf("Market %s (%s) accepted", args[0], textOf(source, "url")))
		return nil
	},
}

var marketRefreshCmd = &cobra.Command{
	Use:   "refresh [id]",
	Short: "Ask the markets for new versions now",
	Long:  `Ask one market, or every market that is turned on, for its current state now and wait for the answers.`,
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		id := ""
		if len(args) == 1 {
			id = args[0]
		}
		// What each market's state was before, to say whether the refresh brought something new.
		before := map[string]float64{}
		if sources, err := controlClient.Get("/api/market/source"); err == nil {
			before = marketSequences(sources)
		}
		data, err := controlClient.Post("/api/market/source/refresh", marketRefreshRequest(id))
		if err != nil {
			return cpPlainError(err)
		}
		failed := false
		for _, result := range marketRefreshResults(data, before) {
			if result.OK {
				output.Success(result.Line)
			} else {
				failed = true
				output.Error(result.Line)
			}
		}
		if failed {
			return &ExitError{Code: 1}
		}
		return nil
	},
}

// marketRefreshRequest is the body of POST /api/market/source/refresh: {id} for one market, {} for all.
func marketRefreshRequest(id string) map[string]interface{} {
	if id == "" {
		return map[string]interface{}{}
	}
	return map[string]interface{}{"id": id}
}

type marketRefreshResult struct {
	OK   bool
	Line string
}

// marketSequences is {source id: sequence of its accepted market, 0 when it has none yet} from GET /api/market/source.
func marketSequences(data map[string]interface{}) map[string]float64 {
	sequences := map[string]float64{}
	list, _ := data["sources"].([]interface{})
	for _, item := range list {
		source, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		sequences[firstOf(source, "id")] = 0
		if market, ok := source["market"].(map[string]interface{}); ok {
			if sequence, ok := market["sequence"].(float64); ok {
				sequences[firstOf(source, "id")] = sequence
			}
		}
	}
	return sequences
}

// marketRefreshResults reads {results: [{id, ok, sequence?, commit?, error?}]}: the commit and date of each market
// that answered, the reason for each that did not. `before` is each market's sequence before the refresh: a market
// whose sequence moved was updated; the others (and any whose earlier state is not known) are up to date.
func marketRefreshResults(data map[string]interface{}, before map[string]float64) []marketRefreshResult {
	list, _ := data["results"].([]interface{})
	results := []marketRefreshResult{}
	for _, item := range list {
		result, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := textOf(result, "id")
		if ok, _ := result["ok"].(bool); !ok {
			problem := textOf(result, "error")
			if problem == "" {
				problem = "no answer"
			}
			results = append(results, marketRefreshResult{false, id + ": " + problem})
			continue
		}
		parts := []string{}
		if commit := shortCommit(firstOf(result, "commit")); commit != "" {
			parts = append(parts, "commit "+commit)
		}
		state := "up to date"
		if sequence, ok := result["sequence"].(float64); ok && sequence > 0 {
			parts = append(parts, shortTime(time.Unix(int64(sequence), 0).UTC().Format(time.RFC3339)))
			if old, known := before[firstOf(result, "id")]; known && old != sequence {
				state = "updated"
			}
		}
		line := id + ": " + state
		if len(parts) > 0 {
			if state == "updated" {
				line += " to " + strings.Join(parts, ", ")
			} else {
				line += " (" + strings.Join(parts, ", ") + ")"
			}
		}
		results = append(results, marketRefreshResult{true, line})
	}
	return results
}

var marketSearchCmd = &cobra.Command{
	Use:   "search <text>",
	Short: "Search the apps of all markets",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		catalog, err := controlClient.GetArray("/api/market/catalog")
		if err != nil {
			return cpPlainError(err)
		}
		rows := marketSearchRows(catalog, args[0])
		if len(rows) == 0 {
			fmt.Printf("No apps match '%s'\n", args[0])
			return nil
		}
		output.Table([]string{"ID", "NAME", "MARKET", "VERSION", "NOTE", "DESCRIPTION"}, rows)
		return nil
	},
}

// marketSearchRows lists the catalog apps (GET /api/market/catalog `apps`) whose id, name, category, tagline or
// description contain query, with the market each comes from.
func marketSearchRows(catalog []interface{}, query string) [][]string {
	query = strings.ToLower(strings.TrimSpace(query))
	rows := [][]string{}
	for _, item := range catalog {
		app, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := textOf(app, "id")
		name := textOf(app, "name", "id")
		desc := textOf(app, "tagline", "description")
		searchable := strings.ToLower(strings.Join([]string{id, name, textOf(app, "category"), textOf(app, "tagline"), textOf(app, "description")}, " "))
		if !strings.Contains(searchable, query) {
			continue
		}
		rows = append(rows, []string{id, name, textOf(app, "sourceName", "sourceId"), textOf(app, "version"), marketAppNote(app), truncate(desc, 50)})
	}
	return rows
}

// marketAppNote says why an app cannot be installed now: it needs a newer YouEye, or its market is not accepted.
func marketAppNote(app map[string]interface{}) string {
	if version := textOf(app, "needsYouEye"); version != "" {
		return "needs YouEye " + version
	}
	if blocked, ok := app["installBlocked"].(map[string]interface{}); ok && blocked != nil {
		return "needs a newer YouEye"
	}
	if notAccepted, _ := app["sourceNotAccepted"].(bool); notAccepted {
		return "market not accepted"
	}
	return ""
}

var marketInfoSource string

var marketInfoCmd = &cobra.Command{
	Use:   "info <app id>",
	Short: "Show one app of the markets",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := requireCP(); err != nil {
			return err
		}
		data, err := controlClient.Get(marketInfoPath(args[0], marketInfoSource))
		if err != nil {
			if problem := unknownMarketSource(err, marketInfoSource); problem != nil {
				return problem
			}
			return cpPlainError(err)
		}
		app, _ := data["app"].(map[string]interface{})
		if app == nil {
			return fmt.Errorf("the Control Panel sent no app for %q", args[0])
		}
		output.Section("Market app: " + textOf(app, "name", "id"))
		for _, line := range marketInfoLines(data) {
			output.StatusLine(line[0], line[1], "")
		}
		return nil
	},
}

// unknownMarketSource says what a 404 from GET /api/market/app/<id>?source=<id> means when --source names no market
// (or a market that is turned off): the route answers only `App "<id>" not found` then. Nil when the market exists
// and is on (the app is not in it), or when the answer is something else.
func unknownMarketSource(err error, source string) error {
	var answer *controlapi.HTTPError
	if source == "" || strings.HasPrefix(source, "direct:") || !errors.As(err, &answer) || answer.StatusCode != 404 {
		return nil
	}
	data, listErr := controlClient.Get("/api/market/source")
	if listErr != nil {
		return nil
	}
	for _, market := range marketSources(data) {
		if firstOf(market, "id") != source {
			continue
		}
		if on, ok := market["enabled"].(bool); ok && !on {
			return fmt.Errorf("market %q is turned off, so its apps are not listed (see youeye market list)", source)
		}
		return nil
	}
	return fmt.Errorf("there is no market %q (see youeye market list)", source)
}

// marketInfoPath is GET /api/market/app/<id>, with ?source=<market id> when one is named.
func marketInfoPath(appID, source string) string {
	path := "/api/market/app/" + url.PathEscape(appID)
	if source != "" {
		path += "?source=" + url.QueryEscape(source)
	}
	return path
}

// marketInfoLines reads GET /api/market/app/<id> ({app: MarketApp, variants, installed}) into label/value lines.
// Every value is text from a market or the Control Panel, cleaned for the terminal (textOf).
func marketInfoLines(data map[string]interface{}) [][2]string {
	app, _ := data["app"].(map[string]interface{})
	lines := [][2]string{}
	add := func(label, value string) {
		if value != "" {
			lines = append(lines, [2]string{label, value})
		}
	}
	add("ID", textOf(app, "id"))
	market := textOf(app, "sourceName", "sourceId")
	if id := textOf(app, "sourceId"); id != "" && id != market {
		market += " (" + id + ")"
	}
	add("Market", market)
	add("Market address", textOf(app, "sourceRepoUrl"))
	add("Version", textOf(app, "version"))
	if blocked, ok := app["installBlocked"].(map[string]interface{}); ok && blocked != nil {
		add("Cannot install", textOf(blocked, "message"))
	}
	if version := textOf(app, "needsYouEye"); version != "" {
		add("Needs", "YouEye "+version)
	}
	if notAccepted, _ := app["sourceNotAccepted"].(bool); notAccepted {
		add("Market accepted", "no (youeye market accept "+textOf(app, "sourceId")+")")
	}
	add("Category", textOf(app, "category"))
	add("Description", textOf(app, "tagline", "description"))
	add("Developer", textOf(app, "developer"))
	add("Website", textOf(app, "website"))
	if setups, ok := app["setups"].([]interface{}); ok && len(setups) > 0 {
		add("Setup files", strconv.Itoa(len(setups)))
	}
	if sso, ok := app["supportsSSO"].(bool); ok {
		add("YouEye ID sign-in", yesNo(sso))
	}
	// `installed`: where the installed app takes its updates from, as its install recorded it
	// ({sourceId, sourceName, sourceAddress, version, updateBlocked}; null when it is not installed).
	if installed, ok := data["installed"].(map[string]interface{}); ok {
		text := "yes"
		if version := textOf(installed, "version"); version != "" {
			text = "version " + version
		}
		if from := textOf(installed, "sourceName", "sourceId"); from != "" {
			if id := textOf(installed, "sourceId"); id != "" && id != from {
				from += " (" + id + ")"
			}
			text += ", from " + from
		}
		if address := textOf(installed, "sourceAddress"); address != "" {
			text += ", " + address
		}
		add("Installed", text)
		if blocked, ok := installed["updateBlocked"].(map[string]interface{}); ok {
			reason := textOf(blocked, "message", "code")
			if reason == "" {
				reason = "blocked"
			}
			add("Updates", reason)
		}
	}
	return lines
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

// printMarketList prints GET /api/market/source: a table of the markets, the reasons of failed refreshes, and the
// git sources this box had before markets were read by address.
func printMarketList(data map[string]interface{}) {
	output.Table([]string{"ID", "NAME", "ADDRESS", "MARKET SAYS", "COMMIT", "DATE", "APPS", "ENABLED", "ACCEPTED", "LAST REFRESH"}, marketListRows(data))
	for _, problem := range marketRefreshErrors(data) {
		output.Warn(problem)
	}
	if removed := removedMarketLines(data); len(removed) > 0 {
		fmt.Println()
		output.Info("These git sources were removed when YouEye moved to markets by address. Add them again with 'youeye market add <address>' if they publish a market:")
		for _, line := range removed {
			fmt.Println("  " + line)
		}
	}
}

// marketListRows renders the sources of GET /api/market/source. ADDRESS is where the box reads the market (for the
// official Market, the lane the box's channel follows); MARKET SAYS is the market's own name and publisher.
func marketListRows(data map[string]interface{}) [][]string {
	rows := [][]string{}
	for _, source := range marketSources(data) {
		accepted := shortTime(textOf(source, "accepted_at"))
		if textOf(source, "kind") == "official" {
			accepted = "official"
		} else if accepted == "" {
			accepted = "no"
		}
		enabled := "yes"
		if on, ok := source["enabled"].(bool); ok && !on {
			enabled = "no"
		}
		address := textOf(source, "address", "url")
		if address == "" {
			address = "(not read yet)"
		}
		says, commit, date, apps := "-", "", "", ""
		if market, ok := source["market"].(map[string]interface{}); ok {
			says = marketSays(market)
			commit = shortCommit(firstOf(market, "commit"))
			date = shortTime(textOf(market, "sequence_date"))
			apps = textOf(market, "apps")
		}
		refreshed := shortTime(textOf(source, "refreshed_at"))
		if textOf(source, "refresh_error") != "" {
			refreshed = "failed (see below)"
		} else if refreshed == "" {
			refreshed = "never"
		}
		rows = append(rows, []string{textOf(source, "id"), textOf(source, "name"), address, says, commit, date, apps, enabled, accepted, refreshed})
	}
	return rows
}

// marketRefreshErrors names each market whose last refresh failed, with the reason.
func marketRefreshErrors(data map[string]interface{}) []string {
	problems := []string{}
	for _, source := range marketSources(data) {
		if problem := textOf(source, "refresh_error"); problem != "" {
			line := textOf(source, "id") + ": the last refresh failed"
			if at := shortTime(textOf(source, "checked_at")); at != "" {
				line += " at " + at
			}
			problems = append(problems, line+": "+problem)
		}
	}
	return problems
}

// removedMarketLines lists `removed_sources` (git sources dropped when markets moved to addresses).
func removedMarketLines(data map[string]interface{}) []string {
	list, _ := data["removed_sources"].([]interface{})
	lines := []string{}
	for _, item := range list {
		source, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		line := textOf(source, "id") + "  " + textOf(source, "name") + "  " + textOf(source, "address")
		if branch := textOf(source, "branch"); branch != "" {
			line += " (branch " + branch + ")"
		}
		if at := shortTime(textOf(source, "removed_at")); at != "" {
			line += "  removed " + at
		}
		lines = append(lines, line)
	}
	return lines
}

func marketSources(data map[string]interface{}) []map[string]interface{} {
	list, _ := data["sources"].([]interface{})
	sources := []map[string]interface{}{}
	for _, item := range list {
		if source, ok := item.(map[string]interface{}); ok {
			sources = append(sources, source)
		}
	}
	return sources
}

// marketSays quotes what a market says about itself: its name and publisher are its own words, not checked.
func marketSays(market map[string]interface{}) string {
	says := strconv.Quote(textOf(market, "name"))
	if publisher := textOf(market, "publisher"); publisher != "" {
		says += " by " + strconv.Quote(publisher)
	}
	return says
}

// shortCommit shows a commit as its first 7 characters, and only when it is a hex commit id: a market writes its
// own commit field, and anything else is not shown.
func shortCommit(commit string) string {
	if !hexCommit.MatchString(commit) {
		return ""
	}
	if len(commit) > 7 {
		return commit[:7]
	}
	return commit
}

var hexCommit = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// textOf is firstOf for text that is printed: what a market or the Control Panel sends is cleaned of control
// characters and escape sequences (terminalText), on one line.
func textOf(m map[string]interface{}, keys ...string) string {
	return terminalText(firstOf(m, keys...), false)
}

// terminalText is text from a market or the Control Panel made safe to print: invalid UTF-8 is replaced, escape
// sequences (ESC and the C1 introducers: CSI, OSC, DCS, SOS, PM, APC, with their parameters or strings) are removed,
// and so are the other C0 controls, DEL and C1 controls. With keepNewlines, newlines and tabs stay; without, they
// become spaces (table cells and one-line messages).
func terminalText(text string, keepNewlines bool) string {
	runes := []rune(strings.ToValidUTF8(text, "\uFFFD"))
	var out strings.Builder
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == 0x1b || r == 0x90 || r == 0x98 || r == 0x9b || r == 0x9d || r == 0x9e || r == 0x9f:
			i = endOfEscape(runes, i)
		case r == '\n' || r == '\t':
			if keepNewlines {
				out.WriteRune(r)
			} else {
				out.WriteRune(' ')
			}
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f):
			// dropped
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

// endOfEscape is the index of the last rune of the escape sequence that starts at runes[start].
func endOfEscape(runes []rune, start int) int {
	i, kind := start, runes[start]
	if kind == 0x1b {
		if i+1 >= len(runes) {
			return i
		}
		i++
		switch runes[i] {
		case '[':
			kind = 0x9b
		case ']':
			kind = 0x9d
		case 'P':
			kind = 0x90
		case 'X':
			kind = 0x98
		case '^':
			kind = 0x9e
		case '_':
			kind = 0x9f
		default:
			// ESC, intermediates (0x20–0x2F), one final (0x30–0x7E).
			for i < len(runes) && runes[i] >= 0x20 && runes[i] <= 0x2f {
				i++
			}
			if i < len(runes) && runes[i] >= 0x30 && runes[i] <= 0x7e {
				return i
			}
			return i - 1
		}
	}
	if kind == 0x9b {
		// CSI: parameters and intermediates (0x20–0x3F), then one final (0x40–0x7E).
		for j := i + 1; j < len(runes); j++ {
			if runes[j] >= 0x40 && runes[j] <= 0x7e {
				return j
			}
			if runes[j] < 0x20 || runes[j] > 0x3f {
				return j - 1
			}
		}
		return len(runes) - 1
	}
	// OSC, DCS, SOS, PM, APC: a string up to BEL or ST (ESC \ or 0x9C); unterminated, the rest.
	for j := i + 1; j < len(runes); j++ {
		if runes[j] == 0x07 || runes[j] == 0x9c {
			return j
		}
		if runes[j] == 0x1b && j+1 < len(runes) && runes[j+1] == '\\' {
			return j + 1
		}
	}
	return len(runes) - 1
}

// cleanServerError is err with its text cleaned for the terminal (terminalText, newlines kept); err itself when its
// text needs no cleaning.
func cleanServerError(err error) error {
	if err == nil {
		return nil
	}
	if text := terminalText(err.Error(), true); text != err.Error() {
		return errors.New(text)
	}
	return err
}

// shortTime shows an ISO time as "2006-01-02 15:04Z"; text that is not a time is shown as it is.
func shortTime(value string) string {
	if value == "" {
		return ""
	}
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return at.UTC().Format("2006-01-02 15:04Z")
}

// cpPlainError shows a Control Panel refusal by its own message ({error}) instead of the raw answer, cleaned for
// the terminal.
func cpPlainError(err error) error {
	var answer *controlapi.HTTPError
	if errors.As(err, &answer) {
		if message := terminalText(answer.Field("error"), true); message != "" {
			return errors.New(message)
		}
	}
	return cleanServerError(err)
}

// newerYouEyeRefusal shows the Control Panel's 409 `requires-newer-youeye` (the app needs a newer YouEye than this
// box runs) as its message; other errors are returned as they are (their text cleaned for the terminal).
func newerYouEyeRefusal(err error) error {
	var answer *controlapi.HTTPError
	if !errors.As(err, &answer) || answer.StatusCode != 409 || answer.Field("code") != "requires-newer-youeye" {
		return cleanServerError(err)
	}
	message := terminalText(answer.Field("error"), true)
	if message == "" {
		message = "This app needs a newer YouEye than this box runs."
	}
	if version := terminalText(answer.Field("needsYouEye"), false); version != "" && !strings.Contains(message, version) {
		message += " (needs YouEye " + version + ")"
	}
	return errors.New(message)
}

func init() {
	marketAddCmd.Flags().BoolVar(&marketAddTrusted, "i-trust-this-market", false, "Confirm you trust this market (required)")
	marketAddCmd.Flags().StringVar(&marketAddName, "name", "", "Your name for the market (default: its host)")
	marketInfoCmd.Flags().StringVar(&marketInfoSource, "source", "", "The market to read the app from (an id from 'youeye market list'); default: the first that has it")

	marketCmd.AddCommand(marketListCmd)
	marketCmd.AddCommand(marketAddCmd)
	marketCmd.AddCommand(marketRemoveCmd)
	marketCmd.AddCommand(marketAcceptCmd)
	marketCmd.AddCommand(marketRefreshCmd)
	marketCmd.AddCommand(marketSearchCmd)
	marketCmd.AddCommand(marketInfoCmd)
}
