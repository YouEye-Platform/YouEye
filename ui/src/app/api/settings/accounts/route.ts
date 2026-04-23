/**
 * Accounts API — aggregate view of all user credentials
 *
 * GET /api/settings/accounts — returns OAuth providers (with user status)
 *   and all stored API keys (metadata only, no decrypted values)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { userConnectorSecrets, userAuthTokens, authProviders } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  listProviders,
  getUserToken,
  isTokenExpired,
} from "@/lib/db/queries/auth-providers";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  // 1. OAuth providers + user connection status
  const providers = await listProviders();
  const oauthAccounts = await Promise.all(
    providers
      .filter((p) => p.enabled)
      .map(async (p) => {
        const token = await getUserToken(session.userId, p.id);
        const expired = token ? isTokenExpired(token.expiresAt) : false;
        const expiresAt = token?.expiresAt ?? null;
        let daysUntilExpiry: number | null = null;
        if (expiresAt) {
          daysUntilExpiry = Math.max(
            0,
            Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          );
        }
        return {
          providerId: p.id,
          slug: p.slug,
          name: p.name,
          type: p.type,
          connected: !!token,
          expired,
          scopes: token?.scopes ?? null,
          expiresAt,
          daysUntilExpiry,
        };
      })
  );

  // 2. Manual API keys (non-managed secrets — those without authProviderId)
  const secrets = await db
    .select({
      id: userConnectorSecrets.id,
      connectorId: userConnectorSecrets.connectorId,
      key: userConnectorSecrets.key,
      boundHost: userConnectorSecrets.boundHost,
      createdAt: userConnectorSecrets.createdAt,
      authProviderId: userConnectorSecrets.authProviderId,
    })
    .from(userConnectorSecrets)
    .where(eq(userConnectorSecrets.userId, session.userId));

  // Filter to manual keys (authProviderId is null)
  const apiKeys = secrets
    .filter((s) => !s.authProviderId)
    .map((s) => ({
      id: s.id,
      connectorId: s.connectorId,
      key: s.key,
      boundHost: s.boundHost,
      createdAt: s.createdAt,
    }));

  return NextResponse.json({
    oauthAccounts,
    apiKeys,
  });
}
