import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
await build({
  entryPoints: [root + "tests/integration/widgets-postgres.ts"],
  outfile: process.argv[2] || "/tmp/youeye-widgets-postgres.cjs",
  platform: "node", format: "cjs", bundle: true, target: "node22",
  alias: { "@/db": root + "tests/integration/widgets-db.ts", "@/db/schema": root + "src/db/schema.ts", "@": root + "src" },
});
