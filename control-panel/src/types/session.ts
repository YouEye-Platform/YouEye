/**
 * Session Types
 */

export interface SessionPayload {
  username: string;
  isAdmin: boolean;
  groups: string[];
  iat: number;
  exp: number;
}
