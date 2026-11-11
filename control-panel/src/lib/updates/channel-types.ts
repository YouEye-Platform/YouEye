export interface Channel {
  source?: string;
  branch?: string;
  tag?: string;
  artifact_sha256?: string;
  fallback?: string[];
}

/**
 * The release_channels block of youeye.yaml. Core channels are host-owned and
 * read-only here; only app channels ("app:<id>") are writable. The System
 * update source is not a channel: Spine reports it from the installer-recorded
 * release policy (GET /api/appliance/core-update/status → selection).
 */
export interface ReleaseChannelsConfig {
  default?: Channel;
  spine?: Channel;
  control?: Channel;
  ui?: Channel;
  apps?: Record<string, Channel>;
}
