package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var channelPolicyPath = filepath.Join(systemupdate.CoreBootstrapPath, "release-policy.json")

var channelCmd = &cobra.Command{
	Use:   "channel",
	Short: "Show or change the release channel this box follows (dev, alpha, beta, stable)",
}

func init() {
	channelCmd.AddCommand(&cobra.Command{Use: "get", Args: cobra.NoArgs, Short: "Show the repository and channel", RunE: func(cmd *cobra.Command, _ []string) error {
		policy, err := systemupdate.LoadReleasePolicy(channelPolicyPath)
		if err != nil {
			return err
		}
		out := map[string]string{"repository": policy.Repository, "channel": policy.Channel}
		if receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt(); err == nil {
			out["installed_version"] = receipt.Release.Version
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(out)
	}})
	var repository string
	set := &cobra.Command{Use: "set <channel>", Args: cobra.ExactArgs(1), Short: "Follow another channel, and with --repository another repository", RunE: func(cmd *cobra.Command, args []string) error {
		ctx, cancel := context.WithTimeout(commandContext(cmd), 60*time.Second)
		defer cancel()
		source, err := systemupdate.SetReleaseSource(ctx, systemupdate.ReleaseSourceChange{PolicyPath: channelPolicyPath, FirstDeployMarker: channelFirstDeployMarker,
			CoreRoot: channelCoreRoot, Channel: args[0], Repository: repository, Read: channelIndexReader})
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		fmt.Fprintf(out, "Following %s of %s.", source.Policy.Channel, source.Policy.Repository)
		if source.RepositoryChanged {
			fmt.Fprintf(out, " That channel offers YouEye %s now; updates now come from this host.", source.Head)
		}
		fmt.Fprintln(out, " The box never downgrades: if that channel is behind the installed version it waits for it to catch up.")
		return nil
	}}
	set.Flags().StringVar(&repository, "repository", "", "follow this repository (https://host/owner/repository); its channel index is read first")
	channelCmd.AddCommand(set)
}

// The release policy changes in one place for the CLI and the Spine API
// (systemupdate.SetReleaseSource); tests replace these.
var (
	channelFirstDeployMarker                                 = systemupdate.FirstDeployCompletePath
	channelCoreRoot                                          = systemupdate.CoreStatePath
	channelIndexReader       systemupdate.ChannelIndexReader = systemupdate.LiveChannelIndex
)

func commandContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}
