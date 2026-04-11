/**
 * Admin Proxy API Route — Catch-all
 *
 * Proxies requests from /api/admin/* to the Control Panel's
 * /api/ui-bridge/* endpoint via the Incus internal network.
 *
 * Auth: Requires valid JWT session with admin role.
 * Token: Attaches X-UI-Bridge-Token from /etc/youeye/ui-bridge-token.
 * Timeout: 15 seconds (extended to 300s for SSE streams).
 *
 * SSE Passthrough: When CP responds with Content-Type: text/event-stream,
 * the response is streamed directly to the browser as a ReadableStream
 * instead of being buffered. This supports app updates and marketplace installs.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { bridgeRequest, BridgeError } from "@/lib/admin/bridge-client";

/** Extract the proxy path from the catch-all params */
function getProxyPath(pathSegments: string[]): string {
  return pathSegments.join("/");
}

/** Proxy handler: validates auth, forwards to CP, returns response */
async function proxyHandler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  // 1. Check authentication
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // 2. Check admin role
  if (!session.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  // 3. Build the proxy path (forward query string too)
  const { path } = await params;
  let proxyPath = getProxyPath(path);
  const queryString = request.nextUrl.search;
  if (queryString) {
    proxyPath += queryString;
  }

  // 4. Forward the request to the Control Panel
  try {
    // Prepare fetch options
    const fetchOptions: RequestInit = {
      method: request.method,
    };

    // Forward body for non-GET requests
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        const body = await request.text();
        if (body) {
          fetchOptions.body = body;
        }
      } catch {
        // No body to forward
      }
    }

    const cpResponse = await bridgeRequest(proxyPath, fetchOptions);

    // 5. Check for SSE response — stream it directly instead of buffering
    const contentType = cpResponse.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && cpResponse.body) {
      return new Response(cpResponse.body, {
        status: cpResponse.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 6. Return the CP response to the browser (buffered)
    const responseBody = await cpResponse.text();

    return new NextResponse(responseBody, {
      status: cpResponse.status,
      headers: {
        "Content-Type": contentType || "application/json",
      },
    });
  } catch (error) {
    // 7. Handle bridge errors gracefully
    if (error instanceof BridgeError) {
      const statusMap: Record<string, number> = {
        TOKEN_MISSING: 503,
        TIMEOUT: 504,
        UNREACHABLE: 503,
      };

      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: statusMap[error.code] ?? 503 }
      );
    }

    // Unexpected error
    console.error("[admin-proxy] Unexpected error:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while communicating with the Control Panel.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  return proxyHandler(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  return proxyHandler(request, context);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  return proxyHandler(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  return proxyHandler(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse | Response> {
  return proxyHandler(request, context);
}
