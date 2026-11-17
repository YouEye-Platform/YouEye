/**
 * The box's mDNS names: Avahi publishes `youeye.local`, and `youeye-<N>.local` when another box on the LAN
 * already has it. These (and the box IP) are the onboarding surface only, so they can never be a platform domain.
 * Dependency-free: shared by the Edge middleware, server routes and the setup wizard.
 */
const MDNS_SETUP_NAME = /^youeye(?:-[0-9]{1,4})?\.local$/i;

/** Exactly a name Avahi publishes for the box (no port, no trailing dot). */
export function isMdnsSetupName(hostname: string): boolean {
  return MDNS_SETUP_NAME.test(hostname);
}

/** A platform domain that would collide with the box's setup address. */
export function isReservedSetupDomain(domain: string): boolean {
  return isMdnsSetupName(domain.trim().toLowerCase().replace(/\.+$/, ''));
}

export const RESERVED_SETUP_DOMAIN_ERROR =
  'youeye.local (and youeye-<N>.local) is this server\'s setup address and cannot be its domain. Choose another name.';
