import { SpineAPIError, spineClient, type CoreUpdateStatus } from '../spine/client';
import { coreSchemaComponent } from './core-schema';

/** A reader mismatch permits legacy behavior only with positively absent core identity. */
export async function readCoreUpdateStatus(): Promise<CoreUpdateStatus> {
  try { return await spineClient.getCoreUpdateStatus(); }
  catch (error) {
    if (error instanceof SpineAPIError && error.statusCode === 404
      && await coreSchemaComponent('cp') === null) return { schema: 'youeye.core-status.v1', managed: false };
    throw error;
  }
}

/** The installed host owns core mutation authority, including direct UI calls. */
export async function assertIndependentCoreUpdate(component: string): Promise<void> {
  if (!['spine', 'control', 'ui', 'system', 'host-system'].includes(component)) return;
  if ((await readCoreUpdateStatus()).managed) {
    throw new Error('This installation uses one signed System release; update the complete core selection.');
  }
}
