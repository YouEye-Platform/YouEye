import type { SpineComponentUpdate } from '@/lib/spine/client';

export interface ComponentUpdatePresentation {
  available: boolean;
  current: string;
  candidate: string;
}

/**
 * Interpret core component updates through the channel-authoritative fields.
 * Legacy fields are used only when talking to a Spine version that does not
 * expose candidate/update_available at all.
 */
export function componentUpdatePresentation(entry: SpineComponentUpdate): ComponentUpdatePresentation {
  const hasChannelAnswer = entry.update_available !== undefined || entry.candidate !== undefined;
  return {
    available: hasChannelAnswer ? entry.update_available === true : entry.available === true,
    current: entry.current,
    candidate: hasChannelAnswer ? (entry.candidate?.version || entry.current) : entry.latest,
  };
}
