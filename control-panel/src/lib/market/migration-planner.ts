import type { InstallMetadata, MigrationSpec } from './types';

export type MigrationWithSource = MigrationSpec & {
  source?: 'manifest' | 'update-plan';
};

function splitVersion(version: string): number[] {
  const stripped = version.replace(/^v/, '');
  if (!stripped) return [0];
  return stripped.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

function comparePlannerVersions(a: string, b: string): number {
  const aParts = splitVersion(a);
  const bParts = splitVersion(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index++) {
    const aValue = aParts[index] ?? 0;
    const bValue = bParts[index] ?? 0;
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
  }

  return 0;
}

export function migrationIdentity(migration: MigrationSpec): string {
  return migration.idempotencyKey
    || `${migration.fromVersion}->${migration.toVersion}:${migration.description || ''}:${JSON.stringify(migration.steps)}`;
}

export function mergeMigrationSources(
  manifestMigrations: MigrationSpec[],
  updatePlanMigrations: MigrationSpec[],
): MigrationWithSource[] {
  const byKey = new Map<string, MigrationWithSource>();

  for (const migration of manifestMigrations) {
    byKey.set(migrationIdentity(migration), { ...migration, source: 'manifest' });
  }

  for (const migration of updatePlanMigrations) {
    const key = migrationIdentity(migration);
    byKey.set(key, { ...migration, source: 'update-plan' });
  }

  return [...byKey.values()];
}

export function findApplicableMigrations(
  migrations: MigrationWithSource[],
  fromVersion: string,
  toVersion: string,
  appliedMigrations: InstallMetadata['appliedMigrations'] = [],
): MigrationWithSource[] {
  if (!migrations || migrations.length === 0) return [];
  const appliedKeys = new Set((appliedMigrations ?? []).map((item) => item.key));

  return migrations
    .filter((migration) => {
      if (migration.required === false) return false;
      if (migration.idempotencyKey && appliedKeys.has(migration.idempotencyKey)) return false;

      const startsAfterInstalled = comparePlannerVersions(migration.fromVersion, fromVersion) >= 0;
      const endsAfterInstalled = comparePlannerVersions(migration.toVersion, fromVersion) > 0;
      const endsAtOrBeforeTarget = comparePlannerVersions(migration.toVersion, toVersion) <= 0;

      return startsAfterInstalled && endsAfterInstalled && endsAtOrBeforeTarget;
    })
    .sort((a, b) => {
      const fromCmp = comparePlannerVersions(a.fromVersion, b.fromVersion);
      if (fromCmp !== 0) return fromCmp;
      return comparePlannerVersions(a.toVersion, b.toVersion);
    });
}

export function describeUpdatePath(
  fromVersion: string,
  targetVersion: string,
  migrations: Pick<MigrationSpec, 'toVersion'>[],
): string {
  if (migrations.length === 0) return `${fromVersion} -> ${targetVersion}`;

  const waypoints = [fromVersion, ...migrations.map((migration) => migration.toVersion), targetVersion]
    .filter((version, index, versions) => index === 0 || version !== versions[index - 1]);

  return waypoints.join(' -> ');
}
