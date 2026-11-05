/** Reconstruct only the privacy policy of an app-owned PostgreSQL login. */
export function restoredAppOwnerSessionPolicy(user: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user)
    || /^(?:postgres|youeye|youeye_ui|pointer)$/i.test(user) || /^pg_/i.test(user)) {
    throw new Error('Restore session policy requires a scoped app database owner');
  }
  return [
    ['log_statement', 'none'], ['log_min_error_statement', 'panic'],
    ['log_min_messages', 'panic'], ['log_min_duration_statement', '-1'],
    ['log_min_duration_sample', '-1'], ['log_duration', 'off'],
    ['log_statement_stats', 'off'],
  ].map(([setting, value]) => `ALTER ROLE "${user}" SET ${setting}='${value}';`).join('\n') + '\n';
}
