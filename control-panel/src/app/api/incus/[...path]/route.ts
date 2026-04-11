/**
 * Incus API Proxy Route
 * 
 * This proxies requests to the Incus Unix socket.
 * All requests require authentication.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { incusRequest } from '@/lib/incus/server';

// Methods that modify state require CSRF token
const CSRF_REQUIRED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleIncusRequest(request, 'GET', (await params).path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleIncusRequest(request, 'POST', (await params).path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleIncusRequest(request, 'PUT', (await params).path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleIncusRequest(request, 'DELETE', (await params).path);
}

async function handleIncusRequest(
  request: NextRequest,
  method: string,
  pathParts: string[]
) {
  try {
    // Check authentication
    const session = await getSession();
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Build path with query string
    const basePath = '/' + pathParts.join('/');
    
    // Get query string from request URL
    const queryString = request.nextUrl.search || '';
    const fullPath = basePath + queryString;
    
    // Log request 
    console.log(`[Incus] ${method} ${fullPath} by ${session.username}`);
    
    // Check admin access for sensitive operations
    if (requiresAdmin(method, basePath) && !session.isAdmin) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Verify CSRF token for state-changing methods
    if (CSRF_REQUIRED_METHODS.includes(method)) {
      const csrfToken = request.headers.get('X-CSRF-Token');
      if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
        return NextResponse.json(
          { error: 'Invalid CSRF token' },
          { status: 403 }
        );
      }
    }

    // Parse request body if present
    let body: unknown = undefined;
    if (CSRF_REQUIRED_METHODS.includes(method)) {
      try {
        body = await request.json();
      } catch {
        // No body or invalid JSON - that's okay for some requests
      }
    }

    // Make the Incus request
    const response = await incusRequest(method, fullPath, body);

    return NextResponse.json(response);
  } catch (error) {
    console.error('Incus proxy error:', error);
    return NextResponse.json(
      { 
        error: 'Incus request failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * Check if a path/method combination requires admin access
 */
function requiresAdmin(method: string, path: string): boolean {
  // Read operations are allowed for all authenticated users
  if (method === 'GET') {
    // But some paths still need admin
    if (path.includes('/certificates') || path.includes('/cluster')) {
      return true;
    }
    return false;
  }

  // All write operations require admin
  return true;
}
