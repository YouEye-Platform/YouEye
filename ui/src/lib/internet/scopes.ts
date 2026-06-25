export type InternetScope = {
  host: string;
  paths: string[];
  methods: string[];
  scope: "user" | "service";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function permissionForInternetHost(host: string): string {
  return `internet:${normalizeHost(host)}`;
}

export function collectInternetScopes(manifest: Record<string, unknown> | null | undefined): InternetScope[] {
  const internet = asRecord(manifest?.internet);
  if (!internet) return [];

  const explicit = Array.isArray(internet.proxy) ? internet.proxy : [];
  const scopes: InternetScope[] = [];
  for (const raw of explicit) {
    const record = asRecord(raw);
    if (!record) continue;
    const host = asString(record.host);
    const paths = asStringArray(record.paths);
    if (!host || paths.length === 0) continue;
    const methods = asStringArray(record.methods).map((method) => method.toUpperCase());
    scopes.push({
      host: normalizeHost(host),
      paths,
      methods: methods.length > 0 ? methods : ["GET"],
      scope: record.scope === "service" ? "service" : "user",
    });
  }

  if (scopes.length > 0) return scopes;

  for (const host of asStringArray(internet.hosts)) {
    scopes.push({
      host: normalizeHost(host),
      paths: ["/*"],
      methods: ["GET"],
      scope: "user",
    });
  }
  return scopes;
}

export function collectInternetPermissions(manifest: Record<string, unknown> | null | undefined): string[] {
  return [...new Set(
    collectInternetScopes(manifest)
      .filter((scope) => scope.scope === "user")
      .map((scope) => permissionForInternetHost(scope.host))
  )].sort();
}

function wildcardHostMatches(pattern: string, host: string): boolean {
  const normalizedPattern = normalizeHost(pattern);
  const normalizedHost = normalizeHost(host);
  if (normalizedPattern === normalizedHost) return true;
  if (!normalizedPattern.startsWith("*.")) return false;
  const suffix = normalizedPattern.slice(1);
  return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

export function findInternetScope(
  manifest: Record<string, unknown> | null | undefined,
  url: URL,
  method: string,
): InternetScope | null {
  const requestMethod = method.toUpperCase();
  return collectInternetScopes(manifest).find((scope) => {
    if (!wildcardHostMatches(scope.host, url.hostname)) return false;
    if (!scope.methods.some((allowed) => allowed.toUpperCase() === requestMethod)) return false;
    return scope.paths.some((pattern) => pathMatches(pattern, url.pathname));
  }) ?? null;
}
