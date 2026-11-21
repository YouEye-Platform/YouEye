/**
 * App Secrets Management
 * 
 * Manages secure storage of app credentials using systemd environment variables.
 * This follows the same pattern as JWT_SECRET storage.
 * 
 * Security Model:
 * - Secrets stored in systemd service environment (inside youeye-control container)
 * - Only readable by root via systemctl show
 * - Persists across container restarts
 * - Not encrypted at rest (relies on OS-level permissions)
 * 
 * Usage:
 * - getPiholePassword() - Get current Pi-Hole password (Spine keeps it; the deployer and the System updater set it)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { spineClient } from '@/lib/spine/client';

const execAsync = promisify(exec);

const SERVICE_NAME = 'youeye-control';

interface SystemdEnvironment {
  JWT_SECRET?: string;
  PIHOLE_PASSWORD?: string;
  [key: string]: string | undefined;
}

/**
 * Execute a command locally (control panel runs as root in its container)
 */
async function execLocal(command: string): Promise<string> {
  const { stdout } = await execAsync(command);
  return stdout.trim();
}

/**
 * Parse systemd environment variables from service file
 */
async function getSystemdEnvironment(): Promise<SystemdEnvironment> {
  try {
    const output = await execLocal(
      `systemctl show ${SERVICE_NAME} --property=Environment --no-pager`
    );
    
    // Parse: Environment=JWT_SECRET=xxx PIHOLE_PASSWORD=yyy
    const envLine = output.replace('Environment=', '');
    const env: SystemdEnvironment = {};
    
    // Split by space, handle values that may contain special chars
    const matches = envLine.matchAll(/([A-Z_]+)=([^\s]+)/g);
    for (const match of matches) {
      env[match[1]] = match[2];
    }
    
    return env;
  } catch (error) {
    console.error('[Secrets] Failed to read systemd environment:', error);
    return {};
  }
}

/**
 * Get Pi-Hole password from Spine API (reads from host file)
 * Falls back to systemd env if Spine is unavailable
 */
export async function getPiholePassword(): Promise<string> {
  try {
    const creds = await spineClient.getPiholeCredentials();
    return creds.password;
  } catch (error) {
    console.error('[Secrets] Failed to get Pi-Hole password from Spine:', error);
    // Fallback to systemd env
    try {
      const env = await getSystemdEnvironment();
      return env.PIHOLE_PASSWORD || '';
    } catch {
      return '';
    }
  }
}
