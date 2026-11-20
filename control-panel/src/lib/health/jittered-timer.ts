/**
 * A periodic background job whose ticks never line up with another job's: a random first delay, then every
 * period ±15 %. Two fixed timers started together (the app prober every 30 s, the watchdog every 60 s) met on
 * every tick, for good.
 */
export interface JitteredLoopOptions {
  periodMs: number;
  /** The first run falls at a random point in this range. */
  firstDelayMs?: [min: number, max: number];
  /** Share of the period each interval may be shorter or longer by. */
  jitter?: number;
  random?: () => number;
}

export const FIRST_DELAY_MS: [number, number] = [60_000, 90_000];
export const PERIOD_JITTER = 0.15;

export function jitteredDelay(periodMs: number, jitter: number, random: number): number {
  return Math.round(periodMs * (1 - jitter + 2 * jitter * random));
}

/** Returns the stop function. */
export function startJitteredLoop(run: () => void, options: JitteredLoopOptions): () => void {
  const random = options.random ?? Math.random;
  const [min, max] = options.firstDelayMs ?? FIRST_DELAY_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    timer = setTimeout(tick, jitteredDelay(options.periodMs, options.jitter ?? PERIOD_JITTER, random()));
    run();
  };
  timer = setTimeout(tick, Math.round(min + (max - min) * random()));
  return () => { stopped = true; clearTimeout(timer); };
}
