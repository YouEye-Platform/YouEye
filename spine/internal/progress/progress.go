// Package progress lets deep deploy steps report first-deploy progress
// (stage, detail, percent) without importing the command package. The
// command package installs the writer; outside first deployment it does
// nothing.
package progress

// Reporter writes one progress record.
var Reporter = func(stage, detail string, percent int) {}

// Report sends one progress record to the installed writer.
func Report(stage, detail string, percent int) { Reporter(stage, detail, percent) }
