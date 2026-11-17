/**
 * At Control Panel start: put the :80 setup server on the live Caddy config. A box set up before it existed
 * resumes Caddy's autosaved config (no :80 server, Caddy's own HTTP->HTTPS redirects); this converges it once.
 * Non-fatal: while Caddy is not up yet (first boot before the infrastructure deploy, or Caddy restarting), it
 * retries later. The deploy and reconcile paths write the same server, so a late success changes nothing.
 */
import { withCaddyMutation } from './serial';

export interface SetupHttpStartupOptions {
  ensure?: () => Promise<void>;
  retryMs?: number;
  attempts?: number;
  schedule?: (run: () => void, ms: number) => void;
}

export function startSetupHttpServerConvergence(options: SetupHttpStartupOptions = {}): Promise<boolean> {
  const ensure = options.ensure ?? (async () => (await import('./client')).ensureSetupHttpServer('youeye-control', 3000));
  const retryMs = options.retryMs ?? 60_000;
  const attempts = options.attempts ?? 60;
  const schedule = options.schedule ?? ((run, ms) => { setTimeout(run, ms).unref?.(); });
  return new Promise((resolve) => {
    let attempt = 0;
    const run = () => {
      attempt += 1;
      void withCaddyMutation(ensure).then(() => resolve(true), (error) => {
        if (attempt >= attempts) {
          console.warn('[caddy] HTTP setup server not ensured at startup:', error instanceof Error ? error.message : String(error));
          resolve(false);
          return;
        }
        schedule(run, retryMs);
      });
    };
    run();
  });
}
