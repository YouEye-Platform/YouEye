const NEXT_PHASE_PRODUCTION_BUILD = "phase-production-build";

export function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === NEXT_PHASE_PRODUCTION_BUILD;
}
