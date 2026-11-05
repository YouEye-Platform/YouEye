const MAX_DIAGNOSTIC_LENGTH = 1600;

const SENSITIVE_ASSIGNMENT = /\b(password|passwd|token|secret|authorization|cookie|private[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

/**
 * Keep durable deployment diagnostics useful without persisting credentials or
 * unbounded command output. The complete raw error remains in the owning
 * service's protected journal; job state contains only this operator-safe form.
 */
export function sanitizeDeploymentDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const singleLine = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(BEARER_VALUE, 'Bearer <redacted>')
    .replace(SENSITIVE_ASSIGNMENT, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();

  if (singleLine.length <= MAX_DIAGNOSTIC_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`;
}
