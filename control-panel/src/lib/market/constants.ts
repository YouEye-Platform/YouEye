/**
 * Shared constants for the market/engine subsystem.
 */

/**
 * DNS domain suffix for Incus container names.
 * Containers are reachable as `<name>.<CONTAINER_DOMAIN>` on the bridge network.
 * Defaults to "youeye" — set by Spine during `incus network create` via dns.domain.
 */
export const CONTAINER_DOMAIN = process.env.CONTAINER_DNS_DOMAIN || 'youeye';
