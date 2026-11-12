/**
 * The app variable registry: every `${…}` name an app manifest or setup file may use.
 * `docs/app-environment.md` lists exactly these names (checked by tests/app-format.test.ts).
 */

/** When a variable is usable in a manifest or setup file. */
export type VariableAvailability =
  | 'always'      // every manifest and setup file
  | 'sidecars'    // only for a sidecar the app declares (and `.url` only when it has a port)
  | 'database'    // only when `database:` is set (not `none`)
  | 'sso'         // only when `sso:` is set
  | 'smtp'        // only when `smtp:` is set
  | 'ai'          // only when `ai:` is set
  | 'setup'       // only in setup files
  | 'connect';    // only in `connect:<app>` setup files

export interface VariableDefinition {
  /** The name as written in the docs, e.g. `sidecar.<name>.host`. */
  doc: string;
  /** Matches the full variable name (without `${` and `}`). */
  pattern: RegExp;
  description: string;
  available: VariableAvailability;
}

const SEGMENT = '[A-Za-z0-9_-]+';
const exact = (name: string) => new RegExp(`^${name.replace(/\./g, '\\.')}$`);

const define = (doc: string, description: string, available: VariableAvailability, pattern = exact(doc)): VariableDefinition =>
  ({ doc, pattern, description, available });

export const APP_VARIABLES: readonly VariableDefinition[] = [
  define('platform.domain', "the box's domain", 'always'),
  define('platform.version', 'the installed YouEye release name', 'always'),
  define('platform.locale', 'the box language (e.g. en)', 'always'),
  define('platform.timezone', 'the box time zone (e.g. Europe/Prague)', 'always'),
  define('platform.site_name', "the box's display name", 'always'),
  define('app.id', 'the app id', 'always'),
  define('app.name', 'the app name', 'always'),
  define('app.subdomain', 'the chosen subdomain', 'always'),
  define('app.fqdn', '<subdomain>.<domain>', 'always'),
  define('app.url', 'https://<subdomain>.<domain>', 'always'),
  define('app.internal_url', "the main container's URL on the app network", 'always'),
  define('sidecar.<name>.host', "a sidecar's host name on the app network", 'sidecars', /^sidecar\.([a-z0-9-]{1,30})\.host$/),
  define('sidecar.<name>.url', 'http://<host>:<port> of a sidecar', 'sidecars', /^sidecar\.([a-z0-9-]{1,30})\.url$/),
  define('secret.<name>', 'a generated secret', 'always', /^secret\.([a-z0-9_]{1,40})$/),
  define('database.url', 'postgresql://user:password@host:port/name', 'database'),
  define('database.host', 'database host', 'database'),
  define('database.port', 'database port', 'database'),
  define('database.name', 'database name', 'database'),
  define('database.user', 'database user', 'database'),
  define('database.password', 'database password', 'database'),
  define('sso.slug', "the app's OAuth client slug", 'sso'),
  define('sso.issuer', 'the YouEye ID issuer', 'sso'),
  define('sso.discovery_url', 'discovery document, reachable from the app network', 'sso'),
  define('sso.authorize_url', 'browser authorize endpoint', 'sso'),
  define('sso.client_id', "the app's OAuth client id", 'sso'),
  define('sso.client_secret', "the app's OAuth client secret", 'sso'),
  define('sso.callback_url', 'app.url + sso.callback', 'sso'),
  define('sso.logout_url', 'YouEye ID end-session endpoint', 'sso'),
  define('sso.admin_group', 'the group that marks admins', 'sso'),
  define('identity.name', "the identity provider's display name", 'always'),
  define('identity.external_url', 'YouEye ID for the browser', 'always'),
  define('identity.internal_url', 'YouEye ID for the app network', 'always'),
  define('smtp.host', 'mail host', 'smtp'),
  define('smtp.port', 'mail port', 'smtp'),
  define('smtp.user', 'mail user', 'smtp'),
  define('smtp.password', 'mail password', 'smtp'),
  define('smtp.from', 'mail sender', 'smtp'),
  define('smtp.security', 'mail transport security', 'smtp'),
  define('ai.openai_base_url', "Pointer's OpenAI-compatible endpoint", 'ai'),
  define('ai.anthropic_base_url', "Pointer's Anthropic-compatible endpoint", 'ai'),
  define('ai.google_base_url', "Pointer's Google-compatible endpoint", 'ai'),
  define('ai.api_key', "the app's Pointer key", 'ai'),
  define('ai.default_model', 'default model chosen by the owner', 'ai'),
  define('ai.utility_model', 'utility model chosen by the owner', 'ai'),
  define('youeye.gateway_url', 'the YouEye app gateway', 'always'),
  define('youeye.app_token', "the app's gateway token", 'always'),
  define('vars.<name>…', 'a value saved by an earlier step', 'setup', new RegExp(`^vars\\.${SEGMENT}(\\.${SEGMENT})*$`)),
  define('item.<field>', 'the current item of a for_each step', 'setup', new RegExp(`^item\\.${SEGMENT}(\\.${SEGMENT})*$`)),
  define('peer.id', 'the connected app id', 'connect'),
  define('peer.host', 'the connected app host', 'connect'),
  define('peer.url', 'the connected app URL', 'connect'),
  define('peer.api_key', "the connected app's API key", 'connect'),
  define('self.host', 'this app host as seen by a peer', 'connect'),
  define('self.url', 'this app URL as seen by a peer', 'connect'),
  define('self.api_key', "this app's API key", 'connect'),
];

/** Every `${…}` reference in a string. A fresh regex per call (no shared lastIndex). */
export function variableReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) names.push(match[1].trim());
  return names;
}

export function findVariable(name: string): { definition: VariableDefinition; match: RegExpExecArray } | null {
  for (const definition of APP_VARIABLES) {
    const match = definition.pattern.exec(name);
    if (match) return { definition, match };
  }
  return null;
}

/** What a manifest offers to its variables (used to check availability). */
export interface VariableScope {
  sidecars: Map<string, { port?: number }>;
  database: boolean;
  sso: boolean;
  smtp: boolean;
  ai: boolean;
  /** `undefined` for the manifest itself; the setup file's `for:` otherwise. */
  setupFor?: string;
}

/** Names no setup file gets: re-runs (url-change, the sign-in toggle) have no gateway token and no Pointer key. */
const NOT_IN_SETUP = /^(youeye\.app_token|ai\.)/;
/** Besides vars, item, peer and self, a connect:<app> file gets only the consumer's own identity and secrets. */
const IN_CONNECT = /^(app\.(id|name|subdomain|fqdn|url)|secret\.)/;

/** An error message when `name` is not usable in `scope`, or null. */
export function checkVariable(name: string, scope: VariableScope): string | null {
  const found = findVariable(name);
  if (!found) return `unknown variable \${${name}}`;
  const { definition, match } = found;
  if (scope.setupFor?.startsWith('connect:') && definition.available !== 'setup' && definition.available !== 'connect'
    && !IN_CONNECT.test(name)) {
    return `\${${name}} is not available in connect:<app> setup files (use \${self.*} and \${peer.*})`;
  }
  if (scope.setupFor && NOT_IN_SETUP.test(name)) return `\${${name}} is not available in setup files`;
  switch (definition.available) {
    case 'always':
      return null;
    case 'sidecars': {
      const sidecar = scope.sidecars.get(match[1]);
      if (!sidecar) return `\${${name}} names a sidecar the app does not declare`;
      if (name.endsWith('.url') && !sidecar.port) return `\${${name}} needs a port on sidecar "${match[1]}"`;
      return null;
    }
    case 'database':
    case 'sso':
    case 'smtp':
    case 'ai':
      return scope[definition.available] ? null : `\${${name}} needs \`${definition.available}:\` in the manifest`;
    case 'setup':
      return scope.setupFor ? null : `\${${name}} is only available in setup files`;
    case 'connect':
      return scope.setupFor?.startsWith('connect:') ? null : `\${${name}} is only available in connect:<app> setup files`;
  }
}
