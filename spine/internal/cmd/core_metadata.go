package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func init() {
	var manifest, signature, inputs string
	command := &cobra.Command{Use: "verify-metadata", Args: cobra.NoArgs, Short: "Authenticate both System metadata representations without creating a request", RunE: func(cmd *cobra.Command, _ []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("protected installed metadata verification requires root")
		}
		raw, err := systemupdate.ReadCoreState(manifest, 1<<20)
		if err != nil {
			return err
		}
		sig, err := systemupdate.ReadCoreState(signature, 64)
		if err != nil {
			return err
		}
		_, facts, err := systemupdate.EnsureCoreMetadata(cmd.Context(), systemupdate.CoreHostSelection{Raw: raw, Signature: sig}, systemupdate.CoreDevelopmentTrustPath, "/var/lib/youeye/cache/core-update", systemupdate.ReleaseHTTPClient(), inputs)
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(releasecache.CoreMetadataPublicFacts(facts))
	}}
	command.Flags().StringVar(&manifest, "manifest", "", "protected exact execution manifest")
	command.Flags().StringVar(&signature, "signature", "", "original execution manifest signature")
	command.Flags().StringVar(&inputs, "inputs", "", "optional original signed offline Spine envelope plus paired metadata")
	coreUpdateCmd.AddCommand(command)
}
