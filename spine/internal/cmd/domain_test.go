package cmd

import "testing"

func TestDomainCommandHasBundleSubcommands(t *testing.T) {
	found := map[string]bool{}
	for _, command := range domainCmd.Commands() {
		found[command.Name()] = true
	}

	for _, name := range []string{"show", "set", "export", "import"} {
		if !found[name] {
			t.Fatalf("domain command missing %q subcommand", name)
		}
	}

	if domainExportCmd.Flags().Lookup("include-token") == nil {
		t.Fatal("domain export command missing --include-token flag")
	}
	if domainImportPath != "/opt/youeye-control-data/byo-domain/import-bundle.json" {
		t.Fatalf("domain import path = %q", domainImportPath)
	}
}
