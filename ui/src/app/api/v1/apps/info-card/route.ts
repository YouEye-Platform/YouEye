/**
 * Info Card Request API
 *
 * POST — Request an info card from a specific app via inter-app gateway
 */

import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getApp, getInfoCardProviders } from "@/lib/db/queries/app-management";
import { logInterAppRequest } from "@/lib/db/queries/inter-app";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { url, requesting_app } = body;

  // Rate limit info card requests per requesting app
  const appSlug = requesting_app ?? "ye-ui";
  const rlResult = checkRateLimit(appSlug, "info-card", RATE_LIMITS.infoCard);
  if (!rlResult.allowed) {
    const retryAfter = Math.ceil(rlResult.resetMs / 1000);
    return NextResponse.json(
      { error: "Too Many Requests", retry_after: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  if (!url) {
    return NextResponse.json(
      { error: "url is required" },
      { status: 400 }
    );
  }

  // Find matching provider based on URL triggers
  const providers = await getInfoCardProviders();
  let matchedProvider = null;
  let matchedCard = null;

  for (const provider of providers) {
    for (const card of provider.cards) {
      if (card.triggers.some((t) => url.includes(t))) {
        matchedProvider = provider;
        matchedCard = card;
        break;
      }
    }
    if (matchedProvider) break;
  }

  if (!matchedProvider || !matchedCard) {
    return NextResponse.json({ card: null, matched: false });
  }

  // Fetch info card from the providing app
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    // Extract query from URL for the card endpoint
    const query = extractQueryFromUrl(url);

    const cardUrl = `${matchedProvider.containerUrl}${matchedCard.endpoint}?url=${encodeURIComponent(url)}&query=${encodeURIComponent(query)}`;

    const response = await fetch(cardUrl, {
      headers: {
        "X-YouEye-User": session.authentikId ?? session.userId,
        "X-YouEye-Internal": "true",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      await logInterAppRequest(
        session.userId,
        requesting_app ?? "ye-ui",
        matchedProvider.appId,
        "info-card",
        false,
        `Provider returned ${response.status}`
      );
      return NextResponse.json({ card: null, matched: true, error: "Provider error" });
    }

    const cardData = await response.json();

    await logInterAppRequest(
      session.userId,
      requesting_app ?? "ye-ui",
      matchedProvider.appId,
      "info-card",
      true
    );

    return NextResponse.json({
      card: {
        ...cardData,
        provider: matchedProvider.appId,
        provider_name: matchedProvider.appName,
      },
      matched: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed";
    await logInterAppRequest(
      session.userId,
      requesting_app ?? "ye-ui",
      matchedProvider.appId,
      "info-card",
      false,
      msg
    );
    return NextResponse.json({ card: null, matched: true, error: msg });
  }
}

/** Extract a meaningful query from a URL */
function extractQueryFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Wikipedia: /wiki/Article_Name
    const wikiMatch = parsed.pathname.match(/\/wiki\/(.+)/);
    if (wikiMatch) return decodeURIComponent(wikiMatch[1].replace(/_/g, " "));
    // Generic: last path segment
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      return decodeURIComponent(segments[segments.length - 1].replace(/_/g, " "));
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}
