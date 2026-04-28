/**
 * Update Progress Embed
 *
 * Minimal embed page loaded as a hidden iframe by YE-UI.
 * Communicates with parent via postMessage:
 *
 * Parent → iframe:
 *   { type: "start-update", component: "wiki" }
 *   { type: "check-updates" }
 *   { type: "get-status" }
 *   { type: "acknowledge", id: 123 }
 *
 * iframe → parent:
 *   { type: "update-status", entries: [...], timestamp: "..." }
 *   { type: "update-enqueued", component: "wiki", entry: {...}, position: N }
 *   { type: "check-updates-started" }
 *   { type: "error", message: "..." }
 */

import { validateEmbedSession } from '@/lib/embed/session-auth';
import { UpdateProgressClient } from './client';

export default async function UpdateProgressPage() {
  const auth = await validateEmbedSession('admin');

  if (!auth.authenticated || !auth.authorized) {
    return (
      <div style={{ display: 'none' }}>
        <script dangerouslySetInnerHTML={{ __html: `
          window.parent.postMessage({ type: 'error', message: 'Unauthorized: ${auth.reason || 'not authenticated'}' }, '*');
        `}} />
      </div>
    );
  }

  return <UpdateProgressClient />;
}
