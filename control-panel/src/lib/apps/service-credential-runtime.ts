/** Preserve unrelated protected environment settings when reinjecting credentials. */
export function rewriteCredentialEnvironment(
  existing: string,
  replacements: Record<string, string>,
): string {
  const keys = new Set(Object.keys(replacements));
  for (const [key, value] of Object.entries(replacements)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(key)
      || /[\r\n\0]/.test(value)) throw new Error('Unsafe app credential environment mapping');
  }
  const seen = new Set<string>();
  const lines = existing.replace(/\n$/, '').split('\n').map(line => {
    const key = /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!key || !keys.has(key)) return line;
    if (seen.has(key)) throw new Error('Ambiguous app credential environment mapping');
    seen.add(key);
    return `${key}=${replacements[key]}`;
  });
  for (const key of keys) if (!seen.has(key)) lines.push(`${key}=${replacements[key]}`);
  return `${lines.join('\n')}\n`;
}

export function assertPrivateCredentialMapping(environment: Record<string, string>, secret: string): void {
  if (Object.entries(environment).some(([key, value]) =>
    /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(key) && value.includes(secret))) {
    throw new Error('App credentials cannot be injected into browser-public configuration');
  }
}

/** V1 supports token templates only in private system configuration. */
export function assertPrivateCredentialConfig(
  files: Array<{ path: string; template: string; permission: string; directoryPermission: string }>,
): void {
  for (const file of files) {
    if (!file.template.includes('${integration.app_token}')) continue;
    if (!/^\/etc\/[^\\\0]+$/.test(file.path) || file.path.split('/').some(part => part === '.' || part === '..')
      || !/^(?:0o)?0?[46]00$/.test(file.permission)
      || !/^(?:0o)?0?[57]00$/.test(file.directoryPermission)) {
      throw new Error('App service credential templates require private /etc configuration');
    }
  }
}
