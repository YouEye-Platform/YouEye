'use client';

export type AISection = 'models' | 'groups' | 'instances' | 'providers' | 'usage' | 'playground';

export type EndpointPolicy = {
  mode: 'fixed' | 'required';
  label?: string;
  placeholder?: string;
};

export type Manifest = {
  id: string;
  name: string;
  iconKey?: string | null;
  type: string;
  baseUrl: string;
  endpoint?: EndpointPolicy;
  hasDiscovery?: boolean;
  staticModelCount?: number;
  auth?: {
    type: string;
    keyPrefix?: string;
    connectLabel?: string;
    deviceFlowSupported?: boolean;
  };
};

export type Account = {
  id: string;
  providerId: string;
  nickname: string | null;
  displayName: string;
  baseUrl: string | null;
  endpoint?: EndpointPolicy;
  status: string;
  providerName: string;
  iconKey?: string | null;
  providerType: string;
  authType: string;
  isBuiltin: boolean;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccountModel = {
  providerModelKey: string;
  modelId: string;
  rawModelId: string;
  name: string;
  catalogEntityId: string | null;
  slug: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: string | null;
  outputPrice: string | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  supportsStreaming: boolean | null;
};

export type AccountDetail = Omit<Account, 'providerName' | 'providerType' | 'authType' | 'isBuiltin'> & {
  provider: {
    id: string;
    name: string;
    type: string;
    status: string;
    authType: string;
    isBuiltin: boolean;
    manifestPath: string | null;
    iconKey?: string | null;
  };
  models: AccountModel[];
};

export type ProviderRoute = {
  providerModelKey: string;
  providerId: string;
  providerName: string;
  providerIconKey: string;
  rawModelId: string;
  available: boolean;
  accounts: Array<{ id: string; nickname: string | null }>;
  pricing: { input: number | null; output: number | null; currency: string; source: string | null; fetchedAt: string | null };
  capabilities: { tools: boolean; vision: boolean; streaming: boolean };
  contextWindow: number | null;
  maxOutput: number | null;
};

export type Benchmark = {
  id: string;
  benchmarkId: string;
  sourceModel: string;
  metrics: Record<string, string | number | boolean | null>;
  provenance: { source: string; sourceUrl: string; license: string; fetchedAt: string };
  fetchedAt: string;
  presentation: {
    label: string;
    score: number | null;
    rank: number | null;
    effectiveRank: number | null;
    rankDerived: boolean;
    population: number | null;
    percentile: number | null;
    unit: string;
    higherIsBetter: boolean;
  };
};

export type BenchmarkDescriptor = {
  id: string;
  label: string;
  description: string;
  sourceUrl: string;
  license: string;
  scoreMetric: string;
  rankMetric: string | null;
  unit: string;
  higherIsBetter: boolean;
  defaultVisible: boolean;
  rankingPriority: number | null;
  attribution: string | null;
};

export type CatalogModel = {
  id: string;
  slug: string;
  name: string;
  creator: string | null;
  creatorIconKey: string | null;
  modelIconKey: string | null;
  description: string | null;
  available: boolean;
  providerCount: number;
  availableProviderCount: number;
  contextWindow: number | null;
  maxOutput: number | null;
  capabilities: { reasoning: boolean; vision: boolean; tools: boolean; streaming: boolean };
  referencePricing: { input: number | null; output: number | null; currency: string; source: string | null; fetchedAt: string | null };
  providers: ProviderRoute[];
  aliases: Array<{ source: string; alias: string; provenance: { observationId: string } }>;
  benchmarks: Benchmark[];
  recommendedRanking: {
    method: 'mean_percentile';
    rank: number;
    percentile: number;
    coverage: number;
    eligibleSources: number;
    sources: Array<{
      sourceId: string;
      sourceLabel: string;
      rank: number;
      publishedRank: number | null;
      rankDerived: boolean;
      population: number;
      percentile: number;
      score: number | null;
      attribution: string | null;
    }>;
  } | null;
  metadataSource: string;
  metadataFetchedAt: string | null;
  releasedAt: string | null;
  nameProvenance: unknown;
  organization: { id: string; name: string; aliases: string[]; websiteUrl: string | null } | null;
  sources?: SourceState[];
};

export type SourceState = {
  sourceId: string;
  status: string;
  stale: boolean;
  fetchedAt: string | null;
  recordCount: number;
  error: { code: string; message: string } | null;
};

export type CatalogResponse = {
  items: CatalogModel[];
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
  facets: {
    creators: string[];
    providers: Array<{ id: string; name: string; available: boolean }>;
  };
  sources: SourceState[];
  benchmarkDescriptors: BenchmarkDescriptor[];
  ranking: { sort: 'recommended'; method: 'mean_percentile'; sourceIds: string[] };
};

export type Group = {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  entryCount: number;
  enabledEntryCount: number;
  previewEntries: Array<{
    id: string;
    modelName: string;
    alias: string | null;
    modelIconKey: string | null;
    providerName: string;
  }>;
  createdAt: string;
};

export type GroupEntry = {
  id: string;
  catalogEntityId: string | null;
  modelId: string;
  modelName: string;
  modelSlug: string | null;
  creator: string | null;
  modelIconKey: string | null;
  providerIconKey: string | null;
  providerId: string;
  providerName: string;
  providerAccountId: string | null;
  providerAccountNickname: string | null;
  providerModelKey: string | null;
  rawModelId: string;
  alias: string | null;
  enabled: boolean;
  providerAvailable: boolean;
  needsReview: boolean;
  position: number;
  hiddenAliases: string[];
  inputPrice: string | null;
  outputPrice: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
};

export type GroupDetail = Group & { entries: GroupEntry[] };

export type Instance = {
  id: string;
  name: string;
  modelGroupId: string | null;
  state: string;
  origin: string;
  icon?: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
  managedApplication?: {
    externalInstallationId: string;
    appId: string;
    displayName: string;
    state: string;
  } | null;
};

export type InstanceDetail = Instance & {
  models: Array<{ id: string; modelId: string; providerId: string; providerAccountId: string | null; alias: string | null; enabled: boolean; source: string }>;
  keys: APIKey[];
  groupEntries: GroupEntry[];
};

export type APIKey = {
  id: string;
  name: string;
  keyPreview: string;
  instanceId: string;
  allowedModels: string[];
  fallbackProviderId: string | null;
  revoked: boolean;
  requestCount: number;
  createdAt: string;
  lastUsed: string | null;
};

export type RecentUsage = {
  id: string;
  modelId: string;
  providerId: string;
  providerAccountId: string | null;
  instanceId: string | null;
  apiKeyId: string | null;
  source: string;
  outcome: string;
  statusCode: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  ttfbMs: number | null;
  tokensPerSecond: number | null;
  createdAt: string;
};

export type Stats = {
  sample: { requests: number; confidence: string };
  totals: { requests: number; successful: number; errors: number; successRate: number | null; totalCost: number | null; knownCostSamples: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  latency: { samples: number; p50: number | null; p95: number | null; p99: number | null; avg: number | null };
  ttfb: { samples: number; p50: number | null; p95: number | null };
  throughput: { samples: number; avg: number | null; p50: number | null };
  recent: RecentUsage[];
};

export type Breakdown = {
  group: string;
  items: Array<{ id: string | null; requests: number; inputTokens: number; outputTokens: number; totalCost: number | null; avgLatency: number | null; avgTtfb: number | null; successRate: number | null }>;
};

export type TestTarget = {
  id: string;
  name: string;
  canonicalModelId: string | null;
  creator: string | null;
  modelIconKey: string | null;
  aliases: string[];
  providers: Array<{
    id: string;
    providerId: string;
    providerName: string;
    providerAccountId: string;
    providerAccountNickname: string | null;
    providerIconKey: string;
    rawModelId: string;
  }>;
};

export type TestTargets = {
  models: TestTarget[];
  providers: Array<{ id: string; name: string; modelCount: number }>;
};

export async function aiApi<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase();
  let csrf = '';
  if (method !== 'GET' && method !== 'HEAD') {
    const response = await fetch('/settings/api/auth/csrf', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || typeof body.csrfToken !== 'string') throw new Error('Could not prepare a protected AI request');
    csrf = body.csrfToken;
  }
  const response = await fetch(`/api/ai${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || 'AI request failed');
  return body as T;
}

export async function streamModelTest(
  body: { providerId: string; providerAccountId: string; modelId: string; prompt: string; maxTokens: number },
  handlers: { onDelta: (text: string) => void; onDone: (reason: string | null) => void; onError: (message: string) => void },
) {
  const csrfResponse = await fetch('/settings/api/auth/csrf', { cache: 'no-store' });
  const csrfBody = await csrfResponse.json();
  if (!csrfResponse.ok || typeof csrfBody.csrfToken !== 'string') throw new Error('Could not prepare a protected AI request');
  const response = await fetch('/api/ai/test-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfBody.csrfToken },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || payload?.error || `Model test failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let sawDone = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value) return;
    if (value === '[DONE]') { sawDone = true; return; }
    try {
      const event = JSON.parse(value);
      if (event.error) throw new Error(event.error.message || 'The model stream failed');
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === 'string') handlers.onDelta(delta.reasoning_content);
      if (typeof delta?.content === 'string') handlers.onDelta(delta.content);
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    } catch (error) {
      if (error instanceof SyntaxError) return;
      handlers.onError(error instanceof Error ? error.message : 'The model stream failed');
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line.replace(/\r$/, ''));
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer.replace(/\r$/, ''));
  if (!sawDone) throw new Error('The model stream ended before completion');
  handlers.onDone(finishReason);
}

export function formatTokens(value: number | null | undefined) {
  if (value == null) return 'Unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}K`;
  return value.toLocaleString();
}

export function formatPrice(value: number | string | null | undefined) {
  if (value == null || value === '') return 'Unknown';
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(number >= 1 ? 2 : 4)}` : 'Unknown';
}

export function accountLabel(account: Pick<Account, 'nickname' | 'providerName' | 'id'>) {
  return account.nickname || `${account.providerName} · ${account.id.slice(-6)}`;
}
