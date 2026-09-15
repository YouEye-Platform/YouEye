export interface Channel {
  source?: string;
  branch?: string;
  tag?: string;
  artifact_sha256?: string;
  fallback?: string[];
}

export interface ReleaseChannelsConfig {
  default?: Channel;
  spine?: Channel;
  control?: Channel;
  ui?: Channel;
  apps?: Record<string, Channel>;
}
