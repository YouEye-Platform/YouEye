package cmd

import (
	"encoding/json"
	"fmt"
	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
	"os"
)

func init() {
	trust := &cobra.Command{Use: "update-trust", Short: "Manage explicit owner trust for custom update sources"}
	trust.AddCommand(&cobra.Command{Use: "show", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		p, err := updatetrust.Load(updatetrust.Path)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(p)
	}})
	var repository, branch, scope, publisher, keyFile string
	enroll := &cobra.Command{Use: "enroll", Short: "Authorize a publisher for one repository, channel and component", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("owner trust changes require root")
		}
		if scope != "appliance" && scope != "spine" && scope != "cp" {
			return fmt.Errorf("host trust scope must be appliance, spine or cp; enroll app/UI trust in the Control Panel")
		}
		repo, err := updatetrust.Repository(repository)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(keyFile)
		if err != nil {
			return err
		}
		grant := updatetrust.Grant{Publisher: publisher, Repository: repo, Branch: branch, Scope: scope, PublicKey: string(raw)}
		p, err := updatetrust.Load(updatetrust.Path)
		if err != nil {
			return err
		}
		found := false
		for i, g := range p.Grants {
			if g.Repository == repo && g.Branch == branch && g.Scope == scope {
				p.Grants[i] = grant
				found = true
			}
		}
		if !found {
			p.Grants = append(p.Grants, grant)
		}
		if err := updatetrust.Save(updatetrust.Path, p); err != nil {
			return err
		}
		fingerprint, _ := updatetrust.Fingerprint(grant.PublicKey)
		fmt.Fprintf(cmd.OutOrStdout(), "Enrolled %s for %s (%s, %s); key %s\n", publisher, repo, branch, scope, fingerprint)
		return nil
	}}
	enroll.Flags().StringVar(&repository, "repository", "", "Exact HTTPS repository")
	enroll.Flags().StringVar(&branch, "branch", "dev", "Release branch: dev, main or beta")
	enroll.Flags().StringVar(&scope, "scope", "", "One of appliance, spine or cp")
	enroll.Flags().StringVar(&publisher, "publisher", "", "Personal publisher label")
	enroll.Flags().StringVar(&keyFile, "public-key", "", "Explicitly chosen Ed25519 public key file")
	for _, name := range []string{"repository", "scope", "publisher", "public-key"} {
		_ = enroll.MarkFlagRequired(name)
	}
	trust.AddCommand(enroll)
	revoke := &cobra.Command{Use: "revoke", Short: "Reject future updates from an enrolled publisher scope", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("owner trust changes require root")
		}
		if scope != "appliance" && scope != "spine" && scope != "cp" {
			return fmt.Errorf("host trust scope must be appliance, spine or cp; enroll app/UI trust in the Control Panel")
		}
		repo, err := updatetrust.Repository(repository)
		if err != nil {
			return err
		}
		p, err := updatetrust.Load(updatetrust.Path)
		if err != nil {
			return err
		}
		for i, g := range p.Grants {
			if g.Repository == repo && g.Branch == branch && g.Scope == scope {
				p.Grants[i].Revoked = true
				return updatetrust.Save(updatetrust.Path, p)
			}
		}
		return fmt.Errorf("source scope is not enrolled")
	}}
	revoke.Flags().StringVar(&repository, "repository", "", "Exact HTTPS repository")
	revoke.Flags().StringVar(&branch, "branch", "dev", "Release branch")
	revoke.Flags().StringVar(&scope, "scope", "", "Enrolled scope")
	_ = revoke.MarkFlagRequired("repository")
	_ = revoke.MarkFlagRequired("scope")
	trust.AddCommand(revoke)
	rootCmd.AddCommand(trust)
}
