package cmd

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
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
			out["installed_build"] = receipt.Release.Build
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(out)
	}})
	channelCmd.AddCommand(&cobra.Command{Use: "set <channel>", Args: cobra.ExactArgs(1), Short: "Follow another channel of the same repository", RunE: func(cmd *cobra.Command, args []string) error {
		policy, err := setReleaseChannel(channelPolicyPath, args[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Following %s of %s. The box never downgrades: if that channel is behind the installed version it waits for it to catch up.\n", policy.Channel, policy.Repository)
		return nil
	}})
}

// setReleaseChannel changes only the channel; the repository never changes
// after installation.
func setReleaseChannel(path, channel string) (systemupdate.ReleasePolicy, error) {
	if !releasecache.ValidChannel(channel) {
		return systemupdate.ReleasePolicy{}, fmt.Errorf("channel must be one of dev, alpha, beta, stable")
	}
	policy, err := systemupdate.LoadReleasePolicy(path)
	if err != nil {
		return policy, err
	}
	policy.Channel = channel
	return policy, systemupdate.SaveReleasePolicy(path, policy)
}
