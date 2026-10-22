import { spineClient } from '@/lib/spine/client';
import { createPlatformDatabase } from './platform-transport';

// CP and ID each own at most one connection (two total), including when Next
// loads this module in several route bundles. Credentials remain server-side.
const key = Symbol.for('youeye.platform-postgres');
const state = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createPlatformDatabase> };
const database = state[key] ??= createPlatformDatabase(() => spineClient.getPostgresCredentials());
export const platformCommand = database.command;
