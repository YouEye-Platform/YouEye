/**
 * Claims YouEye ID sets itself, JWT/OIDC standard claims and scopes. An app's role claim
 * (manifest `sso.role_claim`) may not use one of these names: the validator refuses it and
 * `roleClaims` never sends it, so a role claim can never replace `sub`, `groups` or `is_admin`.
 */
export const RESERVED_ROLE_CLAIMS: ReadonlySet<string> = new Set([
  'iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti', 'auth_time', 'nonce', 'acr', 'amr', 'azp', 'sid', 'at_hash',
  'c_hash', 'scope', 'client_id', 'token_use', 'preferred_username', 'name', 'given_name', 'family_name',
  'middle_name', 'nickname', 'profile', 'picture', 'website', 'email', 'email_verified', 'gender', 'birthdate',
  'zoneinfo', 'locale', 'phone_number', 'phone_number_verified', 'address', 'updated_at', 'groups', 'is_admin',
  'openid', 'offline_access',
]);
