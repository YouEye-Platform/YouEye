import type { AdmissionPolicy } from '../../../../shared/admission';
import type { AppManifest, InstallConfig, MarketApp } from './types';

/**
 * The "Only <site> users" switch (YE-154) is the one control for an app's gate: on keeps the admission gate with the
 * app's policy (owner only, all users, chosen users or groups); off is public access, so anyone who can reach the
 * address gets the app's own sign-in. It writes the admission policy's `publicAccess` (= not "only users"); the
 * install record's `forwardAuthEnabled` follows it for older readers.
 *
 * Some apps cannot be opened at all: they have no sign-in of their own, or they trust the gate's login header. For
 * them the switch stays on, with the reason.
 */
export type GateOnlyReason = 'no-sign-in' | 'login-header';

/** The identity headers the gate sets after sign-in (Caddy `copy_headers`, `engine.ts`). */
const LOGIN_HEADER = /\bX-YouEye-(?:Username|Groups|Email|Name|Uid)\b/i;

type GateManifest = Pick<AppManifest, 'sso' | 'credentials' | 'publicAccess' | 'env_mapping' | 'containers'>;

/**
 * Why an app must stay for the site's users only, or null when it may be opened. `officialPublicAccess` is whether
 * the manifest's `public_access: true` counts: only the official catalog's does (its apps are reviewed).
 * - `login-header`: the app takes the signed-in person from the gate's header (Navidrome's ExtAuth). Opened, anyone
 *   could send that header.
 * - `no-sign-in`: no `sso:`, no `credentials:` and no reviewed `public_access: true` (SearXNG, Wikiless, the arr
 *   apps with `AuthenticationMethod: External`). A catalog app that protects itself says `public_access: true`.
 */
export function gateOnlyReason(manifest: GateManifest, officialPublicAccess: boolean): GateOnlyReason | null {
  const environments = [manifest.env_mapping ?? {}, ...(manifest.containers ?? []).map((container) => container.environment ?? {})];
  if (environments.some((environment) => Object.values(environment).some((value) => LOGIN_HEADER.test(String(value))))) {
    return 'login-header';
  }
  const ownSignIn = Boolean(manifest.sso) || (manifest.credentials?.length ?? 0) > 0
    || (manifest.publicAccess === true && officialPublicAccess);
  return ownSignIn ? null : 'no-sign-in';
}

/**
 * The install's one access choice, from the request: `publicAccess` (the switch inverted; the CLI's
 * `--public-access`) wins; else the old `forwardAuthGate: true` means "only users". `forwardAuthGate: false` never
 * opened an app before 0.6.19 (it only left out an extra gate), so it is no choice: the manifest default applies.
 * Undefined = no explicit choice.
 */
export function explicitInstallPublicAccess(config: Pick<InstallConfig, 'publicAccess' | 'forwardAuthGate'>): boolean | undefined {
  if (typeof config.publicAccess === 'boolean') return config.publicAccess;
  if (config.forwardAuthGate === true) return false;
  return undefined;
}

/**
 * The install dialog's start. An app that already has a policy (a reinstall: retained data, or a policy kept after
 * an uninstall) starts from that policy, so leaving the switch alone keeps it (YE-168). Otherwise: off (public)
 * only for apps that protect themselves; always on for gate-only apps.
 */
export function defaultOnlyUsers(
  app: Pick<MarketApp, 'publicAccess' | 'gateOnly'>,
  existing?: { publicAccess: boolean } | null,
): boolean {
  if (existing) return !existing.publicAccess;
  return Boolean(app.gateOnly) || app.publicAccess !== true;
}

/** The dialog's switch is locked on for a gate-only app, unless its kept policy is already open (it can be closed). */
export function installSwitchLocked(app: Pick<MarketApp, 'gateOnly'>, existing?: { publicAccess: boolean } | null): boolean {
  return Boolean(app.gateOnly) && existing?.publicAccess !== true;
}

/**
 * What the install dialog sends for access: `publicAccess` is the switch inverted, explicit, so the install applies
 * what the dialog showed: on a reinstall the kept policy's own state when the switch was left alone. The old
 * `protectWithAccountLogin` keeps its meaning: the YouEye ID sign-in row for apps with their own login, else the gate
 * (= the switch). `forwardAuthGate` is no longer sent. A gate-only app whose kept policy is open sends no choice
 * when left open: the install keeps it, and only the switch (here or in Access settings) closes it.
 */
export function installAccessFields(
  app: Pick<MarketApp, 'gateOnly' | 'supportsSSO' | 'integrations'>,
  choice: { onlyUsers: boolean; youEyeSignIn: boolean; existing?: { publicAccess: boolean } | null },
): Pick<InstallConfig, 'publicAccess' | 'protectWithAccountLogin'> {
  const locked = installSwitchLocked(app, choice.existing);
  const onlyUsers = choice.onlyUsers || locked;
  const ownLogin = app.supportsSSO || Boolean(app.integrations?.some((integration) => integration.type === 'identity'));
  const keptOpenGateOnly = Boolean(app.gateOnly) && !onlyUsers;
  return {
    publicAccess: keptOpenGateOnly ? undefined : !onlyUsers,
    protectWithAccountLogin: ownLogin ? choice.youEyeSignIn : onlyUsers,
  };
}

/**
 * The switch in an installed app's Access settings. Its state is the admission policy's `publicAccess` (off =
 * public), never the install record, so a 0.6.18 record keeps showing the policy it has. `pendingPublic` is a change
 * on its way.
 */
export function accessSwitchState(
  data: { policy: AdmissionPolicy | null; reconciliation: 'applied' | 'pending'; gateOnly?: GateOnlyReason | null },
  pendingPublic: boolean | null,
) {
  const policy = data.policy;
  const publicAccess = pendingPublic ?? policy?.publicAccess === true;
  return {
    onlyUsers: !publicAccess,
    // Locked on while closed; an app that is somehow open can still be closed.
    locked: Boolean(data.gateOnly) && policy?.publicAccess !== true,
    // Forward-auth lets people through only once public access is applied: "Saved" is not "applied".
    opening: pendingPublic === true || (policy?.publicAccess === true && data.reconciliation !== 'applied'),
    // "Who may enter" is always shown (YE-232): with public access it still decides whose dashboard lists the app
    // and who may sign in to it with YouEye ID (`evaluateClientAdmission`).
    publicWhoHint: publicAccess,
  };
}

/** The Access route's PUT body that sets the switch on `policy` as read (its revision is the expected one). */
export function onlyUsersRequest(policy: AdmissionPolicy, onlyUsers: boolean) {
  return { policy: { ...policy, publicAccess: !onlyUsers }, expectedRevision: policy.revision };
}

/**
 * Sets the switch through the Access route. `fresh` (a retry) reads the policy again first, so a revision conflict
 * (someone else saved in between) resolves on the next try instead of repeating until the page is reloaded (YE-168).
 * `put` throws on a refusal.
 */
export async function putOnlyUsers<T extends { policy: AdmissionPolicy | null }>(
  io: { load(): Promise<T>; put(body: ReturnType<typeof onlyUsersRequest>): Promise<T> },
  current: T,
  onlyUsers: boolean,
  fresh: boolean,
): Promise<T> {
  const base = fresh ? await io.load() : current;
  if (!base.policy) throw new Error('The app has no access policy');
  return io.put(onlyUsersRequest(base.policy, onlyUsers));
}
