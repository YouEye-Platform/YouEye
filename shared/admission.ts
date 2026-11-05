/**
 * Household admission protocol v1. No database, HTTP or framework dependencies.
 * Both CP's authority and UI's leased projection use this evaluator.
 */
export const ADMISSION_SCHEMA_VERSION = 1 as const;
export const MAX_ADMISSION_LEASE_MS = 60_000;
export type AdmissionMode = 'owner' | 'all_users' | 'groups' | 'users';
export type AdmissionState = 'ready' | 'pending' | 'quarantined' | 'retained' | 'deleted';
export interface AdmissionPolicy {
  schemaVersion: 1;
  appId: string;
  installationId: string;
  ownerId: string;
  mode: AdmissionMode;
  userIds: string[];
  groupIds: string[];
  revision: number;
  state: AdmissionState;
  publicAccess: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AdmissionPrincipal {
  id: string;
  active: boolean;
  deleted: boolean;
  groupIds: string[];
  uiUserId: string | null;
}
export type AdmissionReason = 'allowed' | 'unknown_app' | 'invalid_policy' | 'unknown_user'
  | 'inactive_user' | 'policy_pending' | 'not_granted' | 'expired_projection';
export interface AdmissionDecision {
  allowed: boolean;
  reason: AdmissionReason;
  installationId: string | null;
  revision: number | null;
}
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const isAppId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
function uuidList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(isUuid)
    && new Set(value).size === value.length;
}
export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  if (!value || typeof value !== 'object') return false;
  const p = value as AdmissionPolicy;
  return p.schemaVersion === ADMISSION_SCHEMA_VERSION && isAppId(p.appId)
    && isUuid(p.installationId) && isUuid(p.ownerId)
    && ['owner', 'all_users', 'groups', 'users'].includes(p.mode)
    && uuidList(p.userIds) && uuidList(p.groupIds)
    && Number.isSafeInteger(p.revision) && p.revision > 0
    && ['ready', 'pending', 'quarantined', 'retained', 'deleted'].includes(p.state)
    && typeof p.publicAccess === 'boolean'
    && typeof p.createdAt === 'string' && typeof p.updatedAt === 'string'
    && Number.isFinite(Date.parse(p.createdAt)) && Number.isFinite(Date.parse(p.updatedAt))
    && Date.parse(p.updatedAt) >= Date.parse(p.createdAt);
}
export function isAdmissionPrincipal(value: unknown): value is AdmissionPrincipal {
  if (!value || typeof value !== 'object') return false;
  const u = value as AdmissionPrincipal;
  return isUuid(u.id) && typeof u.active === 'boolean' && typeof u.deleted === 'boolean'
    && uuidList(u.groupIds) && (u.uiUserId === null || isUuid(u.uiUserId));
}
export function evaluateAdmission(policy: unknown, principal: unknown): AdmissionDecision {
  const deny = (reason: AdmissionReason, p?: AdmissionPolicy): AdmissionDecision => ({
    allowed: false, reason, installationId: p?.installationId ?? null, revision: p?.revision ?? null,
  });
  if (policy == null) return deny('unknown_app');
  if (!isAdmissionPolicy(policy)) return deny('invalid_policy');
  if (!isAdmissionPrincipal(principal)) return deny('unknown_user', policy);
  if (!principal.active || principal.deleted) return deny('inactive_user', policy);
  if (policy.state !== 'ready') return deny('policy_pending', policy);
  const admitted = principal.id === policy.ownerId || policy.mode === 'all_users'
    || (policy.mode === 'users' && policy.userIds.includes(principal.id))
    || (policy.mode === 'groups' && principal.groupIds.some(id => policy.groupIds.includes(id)));
  return admitted ? { allowed: true, reason: 'allowed', installationId: policy.installationId, revision: policy.revision }
    : deny('not_granted', policy);
}

export interface AdmissionProjection {
  schemaVersion: 1;
  challenge: string;
  policy: AdmissionPolicy;
  principals: AdmissionPrincipal[];
  sequence: number;
  issuedAt: number;
  expiresAt: number;
}
interface Lease {
  projection: AdmissionProjection;
  deadline: number;
}
/**
 * A process-local challenge prevents persisted or delayed pre-restart leases
 * from opening access. Wall time can shorten a lease, never extend it.
 */
export class AdmissionLeaseStore {
  private leases = new Map<string, Lease>();
  constructor(
    readonly challenge: string,
    private readonly monotonicNow: () => number,
    private readonly wallNow: () => number = Date.now,
  ) {}
  apply(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const p = value as AdmissionProjection;
    const now = this.wallNow();
    if (p.schemaVersion !== 1 || p.challenge !== this.challenge || !isAdmissionPolicy(p.policy)
      || !Array.isArray(p.principals) || !p.principals.every(isAdmissionPrincipal)
      || new Set(p.principals.map(u => u.id)).size !== p.principals.length
      || new Set(p.principals.filter(u => u.uiUserId).map(u => u.uiUserId)).size
        !== p.principals.filter(u => u.uiUserId).length
      || !Number.isSafeInteger(p.sequence) || p.sequence < 1
      || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt
      || p.expiresAt - p.issuedAt > MAX_ADMISSION_LEASE_MS) return false;
    const previous = this.leases.get(p.policy.appId);
    if (previous && (p.policy.installationId !== previous.projection.policy.installationId
      || p.policy.revision < previous.projection.policy.revision
      || p.sequence <= previous.projection.sequence)) return false;
    // Clone so callers cannot mutate accepted state after validation.
    const projection = structuredClone(p);
    this.leases.set(p.policy.appId, {
      projection, deadline: this.monotonicNow() + Math.min(MAX_ADMISSION_LEASE_MS, p.expiresAt - now),
    });
    return true;
  }
  snapshot(appId: string): AdmissionProjection | null {
    const lease = this.leases.get(appId);
    if (!lease || this.monotonicNow() >= lease.deadline || this.wallNow() >= lease.projection.expiresAt) return null;
    return structuredClone(lease.projection);
  }
  evaluate(appId: string, identityId: string): AdmissionDecision {
    const projection = this.snapshot(appId);
    if (!projection) return { allowed: false, reason: 'expired_projection', installationId: null, revision: null };
    return evaluateAdmission(projection.policy, projection.principals.find(u => u.id === identityId));
  }
}

export type ResourceScope = 'system' | 'app_global' | 'per_user' | 'shared';
export interface ResourceOwnership {
  schemaVersion: 1;
  appId: string;
  installationId: string;
  resourceId: string;
  scope: ResourceScope;
  enforcement: 'platform' | 'app_native' | 'needs_review';
  ownerId: string;
  identityUserId: string | null;
  uiUserId: string | null;
  shareId: string | null;
  consumerIds: string[];
  state: 'active' | 'quarantined' | 'retained' | 'deleted';
}
export function isResourceOwnership(value: unknown): value is ResourceOwnership {
  if (!value || typeof value !== 'object') return false;
  const r = value as ResourceOwnership;
  if (r.schemaVersion !== 1 || !isAppId(r.appId) || !isUuid(r.installationId) || !isUuid(r.ownerId)
    || typeof r.resourceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(r.resourceId)
    || !['system', 'app_global', 'per_user', 'shared'].includes(r.scope)
    || !['platform', 'app_native', 'needs_review'].includes(r.enforcement)
    || !['active', 'quarantined', 'retained', 'deleted'].includes(r.state)
    || !uuidList(r.consumerIds)
    || !(r.identityUserId === null || isUuid(r.identityUserId))
    || !(r.uiUserId === null || isUuid(r.uiUserId))
    || !(r.shareId === null || isUuid(r.shareId))) return false;
  if (r.scope === 'per_user') {
    return isUuid(r.identityUserId) && r.ownerId === r.identityUserId
      && (r.enforcement !== 'platform' || isUuid(r.uiUserId))
      && r.shareId === null && r.consumerIds.length === 0;
  }
  if (r.scope === 'shared') return isUuid(r.shareId) && r.identityUserId === null && r.uiUserId === null;
  return r.identityUserId === null && r.uiUserId === null && r.shareId === null && r.consumerIds.length === 0;
}
