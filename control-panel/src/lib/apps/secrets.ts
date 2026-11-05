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
 * - getPiholePassword() - Get current Pi-Hole password
 * - setPiholePassword(password) - Update Pi-Hole password
 * - initializePiholePassword() - Set initial password during installation
 * 
 * @see YouEye-Agents/App Support/Secrets-System.md for full documentation
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { incusRequest, updateInstanceState } from '@/lib/incus/server';
import { spineClient } from '@/lib/spine/client';

const execAsync = promisify(exec);

const SERVICE_NAME = 'youeye-control';
const PIHOLE_CONTAINER = 'youeye-pihole';

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
 * Update systemd service file with new environment variables
 */
async function updateSystemdEnvironment(env: SystemdEnvironment): Promise<void> {
  // Read current service file
  const serviceContent = await execLocal(
    `cat /etc/systemd/system/${SERVICE_NAME}.service`
  );
  
  // Parse current service file
  const lines = serviceContent.split('\n');
  const newLines: string[] = [];
  
  // Build environment lines
  const envLines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value) {
      envLines.push(`Environment=${key}=${value}`);
    }
  }
  
  // Replace all Environment= lines
  let inServiceSection = false;
  let envAdded = false;
  
  for (const line of lines) {
    if (line === '[Service]') {
      inServiceSection = true;
      newLines.push(line);
      continue;
    }
    
    if (line.startsWith('[') && line !== '[Service]') {
      // New section - add env lines before leaving [Service]
      if (inServiceSection && !envAdded) {
        newLines.push(...envLines);
        envAdded = true;
      }
      inServiceSection = false;
    }
    
    // Skip existing Environment= lines
    if (line.startsWith('Environment=')) {
      continue;
    }
    
    // Add env lines right after [Service]
    if (inServiceSection && !envAdded && !line.startsWith('Environment=')) {
      if (line !== '' && !line.startsWith('#')) {
        newLines.push(...envLines);
        envAdded = true;
      }
    }
    
    newLines.push(line);
  }
  
  // If we haven't added env lines yet, add them at the end of [Service]
  if (!envAdded) {
    newLines.push(...envLines);
  }
  
  const newContent = newLines.join('\n');
  
  // Write updated service file
  // Use base64 encoding to safely transfer content with special characters
  const base64Content = Buffer.from(newContent).toString('base64');
  await execLocal(
    `bash -c 'echo "${base64Content}" | base64 -d > /etc/systemd/system/${SERVICE_NAME}.service'`
  );
  
  // Reload systemd
  await execLocal('systemctl daemon-reload');
  
  console.log('[Secrets] Updated systemd environment and reloaded daemon');
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

/**
 * Set Pi-Hole password in secure storage and update Pi-Hole container
 * 
 * @param newPassword - New password (min 8 characters)
 * @throws Error if password is invalid or update fails
 */
export async function setPiholePassword(newPassword: string): Promise<void> {
  // Validate password
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  
  // Get current environment and update
  const env = await getSystemdEnvironment();
  env.PIHOLE_PASSWORD = newPassword;
  
  // Update systemd environment
  await updateSystemdEnvironment(env);
  
  // Update Pi-Hole container password via pihole CLI (FTL v6+)
  try {
    // Check if container exists and is running
    const containerResponse = await incusRequest<{ status: string }>(
      'GET',
      `/1.0/instances/${PIHOLE_CONTAINER}`
    );
    
    if (containerResponse.metadata?.status !== 'Running') {
      console.log('[Secrets] Pi-Hole container not running, password saved for next start');
      return;
    }
    
    // FTL v6 locks out `pihole setpassword` when the env var
    // FTLCONF_webserver_api_password is set on the container. Remove
    // both the v6 and legacy v5 env vars first so the CLI works, then
    // set the password via CLI so it's stored in pihole.toml (survives
    // restarts without needing any env var).
    const containerConfig = await incusRequest<{ config?: Record<string, string> }>(
      'GET',
      `/1.0/instances/${PIHOLE_CONTAINER}`
    );
    const cfg = containerConfig.metadata?.config ?? {};
    const envVarsToRemove: Record<string, string> = {};
    if (cfg['environment.FTLCONF_webserver_api_password']) {
      envVarsToRemove['environment.FTLCONF_webserver_api_password'] = '';
    }
    if (cfg['environment.WEBPASSWORD']) {
      envVarsToRemove['environment.WEBPASSWORD'] = '';
    }
    if (Object.keys(envVarsToRemove).length > 0) {
      // Restart required for FTL to stop reading the env var override
      await incusRequest('PATCH', `/1.0/instances/${PIHOLE_CONTAINER}`, {
        config: envVarsToRemove,
      });
      console.log('[Secrets] Removed Pi-Hole password env var overrides, restarting container...');
      await incusRequest('PUT', `/1.0/instances/${PIHOLE_CONTAINER}/state`, {
        action: 'restart', timeout: 30, force: false,
      });
      // Wait for Pi-Hole to come back up
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Now set password via CLI (works because no env var override)
    const execResponse = await incusRequest<{
      return: number;
      output?: string;
    }>(
      'POST',
      `/1.0/instances/${PIHOLE_CONTAINER}/exec`,
      {
        command: ['pihole', 'setpassword', newPassword],
        'record-output': true,
        'wait-for-websocket': false,
      }
    );

    if (execResponse.operation) {
      const opId = execResponse.operation.split('/').pop();
      await incusRequest('GET', `/1.0/operations/${opId}/wait?timeout=30`);
    }

    // Also update the stored password file on host via Spine API
    try {
      await spineClient.updatePiholePassword(newPassword);
      console.log('[Secrets] Updated Pi-Hole password in Spine storage');
    } catch (spineErr) {
      console.error('[Secrets] Warning: could not update Spine storage:', spineErr);
    }
    
    console.log('[Secrets] Pi-Hole password updated via pihole setpassword');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Secrets] Error updating Pi-Hole password:', errorMessage);
    // Pi-Hole container might not exist yet
    console.log('[Secrets] Pi-Hole container not available, password saved for next install');
  }
}

/**
 * Initialize Pi-Hole password during installation
 * Called by install API when Pi-Hole is first installed
 * 
 * @param password - Optional custom password (defaults to fetching from Spine)
 */
export async function initializePiholePassword(password?: string): Promise<void> {
  let actualPassword = password;
  
  if (!actualPassword) {
    try {
      const creds = await spineClient.getPiholeCredentials();
      actualPassword = creds.password;
    } catch {
      console.log('[Secrets] Could not fetch password from Spine during init');
      return;
    }
  }
  
  try {
    const env = await getSystemdEnvironment();
    env.PIHOLE_PASSWORD = actualPassword;
    await updateSystemdEnvironment(env);
    
    console.log('[Secrets] Pi-Hole password initialized');
  } catch (error) {
    console.log('[Secrets] Could not initialize password, will use Spine fallback');
  }
}

/**
 * Check if a custom Pi-Hole password has been set
 */
export async function hasCustomPiholePassword(): Promise<boolean> {
  try {
    const password = await getPiholePassword();
    return password !== '';
  } catch {
    return false;
  }
}
