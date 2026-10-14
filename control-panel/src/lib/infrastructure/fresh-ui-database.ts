type Component = { schema: string; role: string; requestId: string; manifestSHA256: string; artifactSHA256: string };
export type FreshUIIdentity = Component & { role: 'ui' };
const digest = /^[0-9a-f]{64}$/;

export function requiresFreshUIDatabase(component: Component | null, setupComplete: boolean): boolean {
  return !setupComplete && component?.schema === 'youeye.core-component.v1' && component.role === 'cp'
    && digest.test(component.manifestSHA256) && digest.test(component.artifactSHA256)
    && component.requestId === `install-${component.manifestSHA256}`;
}

export type FreshUIDatabaseOperations = {
  assertIdentity(): Promise<void>;
  credentials(): Promise<{ host: string; port: string; user: string; password: string }>;
  databaseOwner(): Promise<string | undefined>;
  createDatabase(): Promise<void>;
  readEnvironment(): Promise<string | undefined>;
  writeEnvironment(value: string): Promise<void>;
  start(): Promise<void>;
};

/** Only the database binding; UI owns schema receipts and setup owns identities. */
export async function configureFreshUIDatabase(identity: FreshUIIdentity, ops: FreshUIDatabaseOperations): Promise<void> {
  if (identity.schema !== 'youeye.core-component.v1' || identity.role !== 'ui'
    || !digest.test(identity.manifestSHA256) || !digest.test(identity.artifactSHA256)
    || identity.requestId !== `install-${identity.manifestSHA256}`) throw new Error('Exact fresh UI identity required');
  await ops.assertIdentity();
  const credentials = await ops.credentials();
  if (credentials.user !== 'youeye' || !/^[A-Za-z0-9.-]+$/.test(credentials.host)
    || !/^\d{1,5}$/.test(credentials.port) || +credentials.port < 1 || +credentials.port > 65535
    || !credentials.password || /[\r\n\0]/.test(credentials.password)) throw new Error('Fresh UI database binding is invalid');
  const password = encodeURIComponent(credentials.password).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const environment = `# Fresh UI database: ${identity.requestId}\nDATABASE_URL=postgresql://youeye:${password}@${credentials.host}:${credentials.port}/youeye_ui\n`;
  const previous = await ops.readEnvironment();
  if (previous !== undefined && previous !== environment) throw new Error('Existing UI environment requires its saved configuration');
  let owner = await ops.databaseOwner();
  if (owner === undefined) {
    await ops.createDatabase();
    owner = await ops.databaseOwner();
  }
  if (owner !== 'youeye') throw new Error('Fresh UI database ownership is not verified');
  await ops.assertIdentity();
  if (previous === undefined) await ops.writeEnvironment(environment);
  if (await ops.readEnvironment() !== environment) throw new Error('Fresh UI environment readback differs');
  await ops.assertIdentity();
  await ops.start();
}
