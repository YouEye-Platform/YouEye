export type IncusDevice = Record<string, string>;
export type IncusDeviceMap = Record<string, IncusDevice>;
export type IncusDeviceMergePatch = Record<string, IncusDevice | null>;

/**
 * Apply RFC 7396 merge-patch semantics to the top-level Incus device map.
 *
 * Incus 7.2 decodes an instance PATCH into its typed InstancePut structure
 * before merging devices. A nested JSON null therefore becomes an empty
 * device instead of deleting the named entry. Applying the explicit null here
 * lets the caller submit the resulting map through Incus's writable PUT shape.
 */
export function applyIncusDeviceMergePatch(
  current: IncusDeviceMap,
  patch: IncusDeviceMergePatch,
): IncusDeviceMap {
  const merged = Object.fromEntries(
    Object.entries(current).map(([name, device]) => [name, { ...device }]),
  );

  for (const [name, change] of Object.entries(patch)) {
    if (change === null) {
      delete merged[name];
      continue;
    }
    merged[name] = { ...(merged[name] ?? {}), ...change };
  }

  return merged;
}
