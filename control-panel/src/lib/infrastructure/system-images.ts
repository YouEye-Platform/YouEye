/**
 * The images of the three core containers (Caddy, PostgreSQL, Pi-hole), pinned by digest.
 *
 * They ship with the Control Panel and change only with a System release: no Market source
 * can supply or replace them, and first deploy needs no Market.
 */

import { incusRequest } from '@/lib/incus/server';

export type SystemImageId = 'postgresql' | 'caddy' | 'pihole';

export interface SystemImage {
  version: string;
  /** Full image reference with its digest. */
  image: string;
  containerName: string;
}

export const SYSTEM_IMAGES: Record<SystemImageId, SystemImage> = {
  caddy: {
    version: '2.11.4',
    image: 'docker.io/library/caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52',
    containerName: 'youeye-caddy',
  },
  pihole: {
    version: '2026.05.0',
    image: 'docker.io/pihole/pihole@sha256:70a9c11171ded2eee735d88c127996da209284a329d50f5ae59c06b861d401b3',
    containerName: 'youeye-pihole',
  },
  postgresql: {
    version: '17.10',
    image: 'docker.io/library/postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193',
    containerName: 'youeye-postgres',
  },
};

export const SYSTEM_IMAGE_IDS = Object.keys(SYSTEM_IMAGES) as SystemImageId[];

/**
 * Recorded on each container: the pinned image it was built from. The key names predate the
 * pins (the Market used to supply these images); they are kept so that containers deployed
 * before stay tracked.
 */
export const RECORDED_IMAGE_KEY = 'user.youeye.market.image';
export const RECORDED_VERSION_KEY = 'user.youeye.market.version';

export async function recordSystemContainerImage(id: SystemImageId): Promise<void> {
  const { containerName, image, version } = SYSTEM_IMAGES[id];
  const result = await incusRequest<Record<string, unknown>>(
    'PATCH',
    `/1.0/instances/${containerName}`,
    {
      config: { [RECORDED_IMAGE_KEY]: image, [RECORDED_VERSION_KEY]: version },
    },
    { timeout: 30_000 },
  );
  if (result.error) {
    throw new Error(`Failed to record the image of ${containerName}: ${result.error}`);
  }
}
