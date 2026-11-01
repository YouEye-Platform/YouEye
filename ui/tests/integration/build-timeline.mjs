// Builds the production queries against an isolated schema and an in-memory
// cookie fixture. The output is a disposable test program, never runtime code.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
await build({
  entryPoints: [root + 'tests/integration/timeline-postgres.ts'],
  outfile: process.argv[2] || '/tmp/youeye-timeline-postgres.cjs',
  platform: 'node', format: 'cjs', bundle: true, target: 'node22',
  alias: { '@/db': root + 'tests/integration/timeline-db.ts', '@/db/schema': root + 'src/db/schema.ts', 'next/headers': root + 'tests/integration/timeline-cookies.ts', '@': root + 'src' },
});
