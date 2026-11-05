import {
  createPointerLifecycleAssertion,
  POINTER_SYSTEM_LIFECYCLE_ACTOR,
  type PointerLifecycleActor,
} from '@/lib/identity/tokens';
import { POINTER_MANAGEMENT_BASE } from './client';

export interface PointerManagedGroup {
  id: string;
  name: string;
  isDefault: boolean;
  enabledModelCount: number;
  connectedProviderCount: number;
  unavailableRouteCount: number;
  status: 'empty' | 'degraded' | 'available';
}

export interface PointerManagedInstallation {
  externalInstallationId: string;
  app: {
    id: string;
    displayName: string;
    version: string | null;
    adapterRevision: string | null;
  };
  pointer: { installationId: string; instanceId: string };
  routingOwner: {
    id: string;
    displayName: string;
    state: 'active' | 'disabled';
    externalSubject: string | null;
  } | null;
  state: 'provisioning' | 'active' | 'rotating' | 'disabled' | 'archived' | 'error';
  selectedGroup: {
    id: string;
    name: string;
    isDefault: boolean;
    modelCount: number;
    providerCount: number;
    unavailableRouteCount: number;
  } | null;
  credential: {
    id: string;
    preview: string;
    lifecycle: string;
    generation: number;
    revoked: boolean;
    deliveryState: string;
  } | null;
  drift: {
    codes: string[];
    healthy: boolean;
    unavailableRouteCount: number;
    recoveryActions: string[];
  };
}

export interface PointerCredentialDelivery {
  id: string;
  credential: string;
  expiresAt: string;
  acknowledgementRequired: true;
}

type EnsureResponse = {
  installation: PointerManagedInstallation;
  credentialDelivery: PointerCredentialDelivery | null;
};

function installationPath(externalInstallationId: string) {
  return `/api/platform/v1/installations/${encodeURIComponent(externalInstallationId)}`;
}

function idempotency(action: string) {
  return `market-${action}-${crypto.randomUUID()}`;
}

async function lifecycleFetch<T>(
  actor: PointerLifecycleActor,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!path.startsWith('/api/platform/v1/')) {
    throw new Error('Pointer lifecycle path is outside the supported boundary');
  }
  const assertion = await createPointerLifecycleAssertion(actor);
  const response = await fetch(`${POINTER_MANAGEMENT_BASE}${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'x-request-id': crypto.randomUUID(),
    },
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = payload?.error?.code || `http_${response.status}`;
    const message = payload?.error?.message || 'Pointer application lifecycle request failed';
    throw new Error(`${message} (${code})`);
  }
  return response.json() as Promise<T>;
}

export async function listPointerActorGroups(actor: PointerLifecycleActor) {
  const response = await lifecycleFetch<{ items: PointerManagedGroup[] }>(
    actor,
    '/api/platform/v1/groups?owner=actor'
  );
  return response.items;
}

export async function ensurePointerManagedApp(input: {
  actor: PointerLifecycleActor;
  externalInstallationId: string;
  appId: string;
  displayName: string;
  appVersion?: string;
  groupId: string;
  iconUrl?: string;
}) {
  return lifecycleFetch<EnsureResponse>(
    input.actor,
    installationPath(input.externalInstallationId),
    {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotency('ensure') },
      body: JSON.stringify({
        appId: input.appId,
        displayName: input.displayName,
        ...(input.appVersion ? { appVersion: input.appVersion } : {}),
        groupId: input.groupId,
        routingOwner: 'actor',
        ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
        adapterRevision: 'youeye-market-ai-v1',
      }),
    }
  );
}

export async function acknowledgePointerCredential(input: {
  actor: PointerLifecycleActor;
  externalInstallationId: string;
  deliveryId: string;
}) {
  return lifecycleFetch<{ acknowledged: true }>(
    input.actor,
    `${installationPath(input.externalInstallationId)}/credential-deliveries/${encodeURIComponent(input.deliveryId)}/ack`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotency('ack') },
      body: '{}',
    }
  );
}

export async function readPointerManagedApp(
  externalInstallationId: string,
  actor: PointerLifecycleActor = POINTER_SYSTEM_LIFECYCLE_ACTOR
) {
  return lifecycleFetch<PointerManagedInstallation>(
    actor,
    installationPath(externalInstallationId)
  );
}

export async function setPointerManagedAppEnabled(
  externalInstallationId: string,
  enabled: boolean,
  actor: PointerLifecycleActor = POINTER_SYSTEM_LIFECYCLE_ACTOR
) {
  return lifecycleFetch<PointerManagedInstallation>(
    actor,
    `${installationPath(externalInstallationId)}/${enabled ? 'enable' : 'disable'}`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotency(enabled ? 'enable' : 'disable') },
      body: '{}',
    }
  );
}

export async function archivePointerManagedApp(
  externalInstallationId: string,
  actor: PointerLifecycleActor = POINTER_SYSTEM_LIFECYCLE_ACTOR
) {
  return lifecycleFetch<{ archived: true; credentialsRevoked: true }>(
    actor,
    installationPath(externalInstallationId),
    {
      method: 'DELETE',
      headers: { 'Idempotency-Key': idempotency('archive') },
    }
  );
}

export async function archivePointerManagedAppIfPresent(
  externalInstallationId: string,
  actor: PointerLifecycleActor = POINTER_SYSTEM_LIFECYCLE_ACTOR
) {
  try {
    return await archivePointerManagedApp(externalInstallationId, actor);
  } catch (error) {
    if (error instanceof Error && error.message.includes('(installation_not_found)')) {
      return { archived: true as const, credentialsRevoked: true as const, absent: true };
    }
    throw error;
  }
}

export async function changePointerManagedAppGroup(input: {
  actor: PointerLifecycleActor;
  externalInstallationId: string;
  groupId: string;
}) {
  return lifecycleFetch<PointerManagedInstallation>(
    input.actor,
    `${installationPath(input.externalInstallationId)}/group`,
    {
      method: 'PATCH',
      headers: { 'Idempotency-Key': idempotency('group') },
      body: JSON.stringify({ groupId: input.groupId }),
    }
  );
}

export async function takeOverPointerManagedApp(input: {
  actor: PointerLifecycleActor;
  externalInstallationId: string;
  groupId: string;
}) {
  return lifecycleFetch<PointerManagedInstallation>(
    input.actor,
    `${installationPath(input.externalInstallationId)}/routing-owner/takeover`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotency('takeover') },
      body: JSON.stringify({ groupId: input.groupId }),
    }
  );
}

export async function setPointerActorState(
  actor: PointerLifecycleActor,
  state: 'active' | 'disabled'
) {
  return lifecycleFetch<{
    state: 'active' | 'disabled';
    affectedInstallations: number;
    attentionRequired: boolean;
  }>(actor, '/api/platform/v1/actors/current/state', {
    method: 'PUT',
    headers: { 'Idempotency-Key': idempotency(`actor-${state}`) },
    body: JSON.stringify({ state }),
  });
}

export async function setPointerManagedActorState(
  actorSubject: string,
  state: 'active' | 'disabled'
) {
  return lifecycleFetch<{
    actorUserId: string | null;
    state: 'active' | 'disabled';
    affectedInstallations: number;
    attentionRequired: boolean;
    absent?: boolean;
  }>(POINTER_SYSTEM_LIFECYCLE_ACTOR, '/api/platform/v1/actors/state', {
    method: 'PUT',
    headers: { 'Idempotency-Key': idempotency(`managed-actor-${state}`) },
    body: JSON.stringify({ actorSubject, state }),
  });
}
