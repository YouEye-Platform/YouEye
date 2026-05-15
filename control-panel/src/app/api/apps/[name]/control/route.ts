/**
 * App Control API
 * 
 * Start, stop, restart, or remove an app container.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getAppManifest } from '@/lib/apps/manifest';
import type { AppManifest } from '@/lib/apps/manifest';
import { incusRequest } from '@/lib/incus/server';
import type { AppControlRequest } from '@/types/apps';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
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

    // Require admin
    if (!session.isAdmin) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Verify CSRF token
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    const { name } = await params;
    const body: AppControlRequest = await request.json();
    const { action, force = false } = body;

    // Validate action
    if (!['start', 'stop', 'restart', 'remove'].includes(action)) {
      return NextResponse.json(
        { error: `Invalid action: ${action}` },
        { status: 400 }
      );
    }

    // Get app manifest
    const manifest = getAppManifest(name);
    if (!manifest) {
      return NextResponse.json(
        { error: `Unknown app: ${name}` },
        { status: 404 }
      );
    }

    console.log(`[Apps] ${action} ${manifest.displayName} by ${session.username}`);

    if (action === 'remove') {
      // Stop container first
      try {
        await incusRequest('PUT', `/1.0/instances/${manifest.containerName}/state`, {
          action: 'stop',
          force: true,
        });
        // Wait a bit for container to stop
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        // Ignore errors if already stopped
      }

      // Delete container
      const deleteResponse = await incusRequest('DELETE', `/1.0/instances/${manifest.containerName}`);
      
      if (deleteResponse.type === 'async' && deleteResponse.operation) {
        await waitForOperation(deleteResponse.operation);
      }

      return NextResponse.json({
        success: true,
        message: `${manifest.displayName} removed`,
      });
    }

    // Start, stop, or restart
    const stateResponse = await incusRequest('PUT', `/1.0/instances/${manifest.containerName}/state`, {
      action,
      force,
      timeout: 30,
    });

    if (stateResponse.type === 'async' && stateResponse.operation) {
      await waitForOperation(stateResponse.operation);
    }

    return NextResponse.json({
      success: true,
      message: `${manifest.displayName} ${action} successful`,
    });
  } catch (error) {
    console.error('Error controlling app:', error);
    return NextResponse.json(
      { 
        error: 'Failed to control app',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * Wait for an Incus operation to complete
 */
async function waitForOperation(operation: string, timeout = 60000): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const response = await incusRequest('GET', operation);
    
    if (response.metadata && typeof response.metadata === 'object') {
      const meta = response.metadata as { status: string };
      if (meta.status === 'Success' || meta.status === 'Cancelled') {
        return;
      }
      if (meta.status === 'Failure') {
        throw new Error(`Operation failed`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error('Operation timed out');
}
