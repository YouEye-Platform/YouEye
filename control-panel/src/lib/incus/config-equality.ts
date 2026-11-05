/** Incus omits optional empty fields in some API representations. Map ordering
 * and those empty fields are not drift; nonempty extra fields are. */
export function sameIncusFields(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  if (!actual) return false;
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every(key => (actual[key] ?? '') === (expected[key] ?? ''));
}

export function canonicalIncusRules(rules: Array<Record<string, string>>): string[] {
  return rules.map(rule => JSON.stringify(Object.fromEntries(
    Object.entries(rule).filter(([, value]) => value !== '').sort(([a], [b]) => a.localeCompare(b)),
  ))).sort();
}

export function sameIncusAcl(actual: { description?: string; config?: Record<string, string>; ingress?: Array<Record<string, string>>; egress?: Array<Record<string, string>> }, expected: { description: string; egress: Array<Record<string, string>> }): boolean {
  return actual.description === expected.description
    && sameIncusFields(actual.config ?? {}, {})
    && (actual.ingress ?? []).length === 0
    && JSON.stringify(canonicalIncusRules(actual.egress ?? [])) === JSON.stringify(canonicalIncusRules(expected.egress));
}
