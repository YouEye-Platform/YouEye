package storage

import (
	"fmt"
	"strings"
	"testing"
)

func TestIndependentCopyMountRejectsMissingDatasetBeforeEffects(t *testing.T) {
	for _, failure := range []string{"missing", "wrong-mount", "valid"} {
		t.Run(failure, func(t *testing.T) {
			mutations := 0
			err := mountExistingCopyDatasets(func(program string, args ...string) (string, error) {
				command := program + " " + strings.Join(args, " ")
				if program == "findmnt" {
					if args[len(args)-1] == DataMountpoint {
						return "zfs default/data", nil
					}
					return "zfs default/incus-state", nil
				}
				if args[0] == "mount" {
					mutations++
					return "", nil
				}
				if args[0] != "get" {
					t.Fatal("unexpected mutation", command)
				}
				property, dataset := args[len(args)-2], args[len(args)-1]
				if dataset == "default/incus-state" && failure == "missing" {
					return "", fmt.Errorf("absent")
				}
				switch property {
				case "mountpoint":
					if dataset == "default/data" {
						return DataMountpoint, nil
					}
					if failure == "wrong-mount" {
						return "/external", nil
					}
					return IncusStateMountpoint, nil
				case "canmount":
					return "on", nil
				case "mounted":
					return "no", nil
				}
				t.Fatal("unexpected observation", command)
				return "", nil
			})
			if failure == "valid" {
				if err != nil || mutations != 2 {
					t.Fatal("valid copy not mounted", err, mutations)
				}
			} else if err == nil || mutations != 0 {
				t.Fatal("invalid copy changed storage", err, mutations)
			}
		})
	}
}
