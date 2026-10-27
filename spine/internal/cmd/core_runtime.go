package cmd

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"github.com/youeye-platform/YouEye/spine/internal/util"
)

func currentCoreSelection() (systemupdate.CoreReleaseSelection, error) {
	c, err := channels.Load()
	if err != nil {
		return systemupdate.CoreReleaseSelection{}, err
	}
	channel := c.Effective(channels.ComponentSystem, GetConfig())
	if err = channels.ValidateSystemChannel(channel); err != nil {
		return systemupdate.CoreReleaseSelection{}, err
	}
	return systemupdate.CoreReleaseSelection{Source: channel.Source, Branch: channel.Branch, Fallback: channel.Fallback, Tag: channel.Tag, ManifestSHA256: channel.ArtifactSHA256}, nil
}

func installedCoreRuntime() (systemupdate.NativeCoreRuntime, error) {
	var r systemupdate.NativeCoreRuntime
	if os.Geteuid() != 0 {
		return r, fmt.Errorf("native core operation requires root")
	}
	if err := requireImageUpdate(false); err != nil {
		return r, err
	}
	cfg := GetConfig()
	if cfg.Deployment.Container.Name != "youeye-control" || cfg.Deployment.UI.ContainerName != "youeye-ui" || cfg.Deployment.UI.Port != 3000 {
		return r, fmt.Errorf("core runtime requires the installed appliance service contract")
	}
	if cfg.Deployment.ControlPanel.Port < 1 || cfg.Deployment.ControlPanel.Port > 65535 {
		return r, fmt.Errorf("invalid installed CP port")
	}
	coordinator, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).BootstrapExecutable(systemupdate.CoreDevelopmentTrustPath)
	if err != nil {
		return r, err
	}
	if coordinator == "" {
		coordinator = "/usr/local/bin/youeye"
	}
	checkpoint := systemupdate.NativeCoreCheckpoint{Root: systemupdate.CoreStatePath, DataRoot: "/var/lib/youeye", StatePath: appliance.StatePath, Bridge: cfg.Deployment.Incus.Network,
		IngressPorts: []uint16{80, 443, uint16(cfg.Deployment.ControlPanel.Port), 3001},
		DNSHostAddress: func(ctx context.Context) (string, error) {
			ip := util.GetPrimaryIP()
			parsed := net.ParseIP(ip)
			if ctx.Err() != nil || parsed == nil || parsed.To4() == nil || !parsed.IsGlobalUnicast() {
				return "", fmt.Errorf("current host address unavailable")
			}
			addresses, err := net.InterfaceAddrs()
			if err != nil {
				return "", err
			}
			for _, a := range addresses {
				if n, ok := a.(*net.IPNet); ok && n.IP.Equal(parsed) {
					return ip, nil
				}
			}
			return "", fmt.Errorf("host address is not assigned")
		}}
	cache := systemupdate.CoreArtifactCache{Root: filepath.Join(checkpoint.DataRoot, "cache", "core-update"), TrustKeyPath: systemupdate.CoreDevelopmentTrustPath, Client: systemupdate.ReleaseHTTPClient()}
	services := systemupdate.NativeCoreServices{Checkpoint: checkpoint, Cache: cache, CPAppDir: cfg.Deployment.ControlPanel.AppDir, UIAppDir: cfg.Deployment.UI.AppDir, CPPort: cfg.Deployment.ControlPanel.Port}
	authority := systemupdate.NativeCoreAuthority{FirstBootPolicyPath: filepath.Join(systemupdate.CoreBootstrapPath, "release-policy.json"), FirstBootCompletePath: "/var/lib/youeye-state/first-deploy/complete", Checkpoint: checkpoint, TrustKeyPath: cache.TrustKeyPath, Client: cache.Client, CurrentSelection: currentCoreSelection}
	host := systemupdate.NewDefault()
	r = systemupdate.NativeCoreRuntime{Root: checkpoint.Root, Host: host, Cache: cache, Services: services, Checkpoint: checkpoint,
		Runner: systemupdate.CoreSystemdRunner{Root: checkpoint.Root, Executable: coordinator}, AuthorizeTarget: authority.AuthorizeTarget, AuthorizePrevious: authority.AuthorizePrevious,
		HostHealth: func(ctx context.Context, j systemupdate.CoreJournal) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			_, image, err := applianceRuntime()
			if err != nil || image == nil {
				return "", fmt.Errorf("running immutable host unavailable")
			}
			if err = systemupdate.BindCoreImage(j.Target, *image); err != nil {
				return "", err
			}
			health := collectApplianceHealth("base")
			if health.ExitCode != healthExitHealthy {
				return "", fmt.Errorf("selected immutable host/storage health failed")
			}
			return "selected immutable host, persistent partition identity, ZFS and baked prerequisites", nil
		},
		AuthenticatedHealth: func(ctx context.Context, j systemupdate.CoreJournal, recovery bool) (string, error) {
			evidence, err := services.Health(ctx, j.RequestID, recovery)
			if err != nil {
				return "", err
			}
			health := collectApplianceHealth("operational")
			if health.ExitCode != healthExitHealthy {
				return "", fmt.Errorf("platform operational health failed")
			}
			ip, err := util.ReadStoredHostIP()
			if err != nil || ip == "" {
				return "", fmt.Errorf("installed host address unavailable")
			}
			if err = verifyDeploymentCompletion(ip); err != nil {
				return "", fmt.Errorf("platform service/credential binding failed")
			}
			return evidence + "; native operational and service/credential bindings", nil
		},
		RecoverHost: func(ctx context.Context, j systemupdate.CoreJournal, observe bool) (systemupdate.CoreActionObservation, error) {
			return host.RecoverCoreHost(ctx, j.RequestID, observe)
		},
	}
	return r, r.Validate()
}
