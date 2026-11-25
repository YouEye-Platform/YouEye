/**
 * Where an app is reached from the browser: `https://<its subdomain>.<the box's domain>`. One source for every
 * surface the dashboard embeds (widgets, notifications), built on the server (YE-151).
 *
 * The box's domain is the host the dashboard was asked on: Caddy serves the dashboard on the box's main domain and
 * every app on a subdomain of it, as the app drawer and the header build their links. A native app calling the
 * service API arrives on the internal address instead, so for it the configured `UI_EXTERNAL_URL` names the domain.
 * The host is never trimmed: a label taken off `notes.box.example` would point at another site's host.
 */

type Env = Record<string, string | undefined>;

/** A host on which an app has subdomains: a DNS name with a dot, not an IP address or a single label (`localhost`). */
function domainName(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (!name.includes(".") || name.startsWith("[") || /^[\d.]+$/.test(name)) return "";
  return /^[a-z0-9.-]+$/.test(name) ? name : "";
}

/** The `Host` header's name without its port. */
function hostName(host: string | null | undefined): string {
  const value = (host ?? "").trim();
  return value.startsWith("[") ? value : value.replace(/:\d+$/, "");
}

/** The box's domain for app links, or "" when this request names none (an IP address, setup). */
export function publicBaseDomain(host: string | null | undefined, isServiceCall: boolean, env?: Env): string {
  const source = isServiceCall ? env ?? process.env : {};
  const configured = source.UI_EXTERNAL_URL || source.BASE_URL || source.NEXTAUTH_URL || "";
  if (configured) {
    try {
      const name = domainName(new URL(configured).hostname);
      if (name) return name;
    } catch {
      // Fall through to the request host below.
    }
  }
  return domainName(hostName(host));
}

/** `https://<subdomain>.<domain>`, or null for an app with no subdomain or a request without a domain. */
export function publicAppOrigin(subdomain: string | null | undefined, baseDomain: string): string | null {
  return subdomain && baseDomain ? `https://${subdomain}.${baseDomain}` : null;
}

/** The app's public address, else the address it registered (`containerUrl`). */
export function publicAppUrl(declaration: { subdomain: string | null; containerUrl: string | null }, baseDomain: string): string | null {
  return publicAppOrigin(declaration.subdomain, baseDomain) ?? declaration.containerUrl;
}
