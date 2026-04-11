/**
 * UI Bridge: Updates
 *
 * GET /api/ui-bridge/updates
 *
 * Returns available updates for all YouEye components.
 * Reuses the existing Spine update check logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const updates = await spineClient.checkUpdates();

    const components: Array<{
      name: string;
      current_version: string;
      latest_version: string;
      update_available: boolean;
      repo: string;
    }> = [];

    // Spine
    if (updates.spine) {
      components.push({
        name: 'Spine',
        current_version: updates.spine.current,
        latest_version: updates.spine.latest,
        update_available: updates.spine.available,
        repo: 'YouEye (Spine)',
      });
    }

    // Control Panel
    if (updates.control) {
      components.push({
        name: 'Control Panel',
        current_version: updates.control.current,
        latest_version: updates.control.latest,
        update_available: updates.control.available,
        repo: 'YouEye (Control Panel)',
      });
    }

    // Incus
    if (updates.incus) {
      components.push({
        name: 'Incus',
        current_version: updates.incus.current,
        latest_version: updates.incus.current, // Incus doesn't have a "latest" field
        update_available: updates.incus.upgradeable,
        repo: 'incus',
      });
    }

    // System packages
    if (updates.system) {
      components.push({
        name: 'System',
        current_version: `${updates.system.upgradeable_count} packages`,
        latest_version: updates.system.upgradeable_count > 0 ? 'updates available' : 'up to date',
        update_available: updates.system.upgradeable_count > 0,
        repo: 'system',
      });
    }

    // OCI apps
    if (updates.apps) {
      for (const app of updates.apps) {
        components.push({
          name: app.display_name || app.name,
          current_version: app.image_tag || 'unknown',
          latest_version: app.available ? 'update available' : app.image_tag || 'unknown',
          update_available: app.available,
          repo: `YE-App-${app.name}`,
        });
      }
    }

    return NextResponse.json({ components });
  } catch (err) {
    console.error('[UI Bridge] Updates check error:', err);
    return NextResponse.json(
      { error: 'Failed to check for updates' },
      { status: 500 }
    );
  }
}
