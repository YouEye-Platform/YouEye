export async function uiRuntimeHealth(
  databaseConfigured: boolean,
  ensureSchema: () => Promise<void>,
): Promise<{ status: 'ok' | 'starting'; httpStatus: 200 | 503 }> {
  if (!databaseConfigured) return { status: 'ok', httpStatus: 200 };
  try {
    await ensureSchema();
    return { status: 'ok', httpStatus: 200 };
  } catch {
    return { status: 'starting', httpStatus: 503 };
  }
}
