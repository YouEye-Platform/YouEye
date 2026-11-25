/** What the app page's Connections section shows (YE-227), without React: the list's count and the section use it. */

/** A suggested connection, as `GET /api/suggestions` lists it (lib/bridges/suggestions.ts). */
export interface ConnectionSuggestion {
  id: string;
  type: "bridge" | "internet";
  fromAppId: string;
  fromAppName?: string;
  targetAppId?: string;
  targetAppName?: string;
  targetInstalled?: boolean;
  scope?: "user" | "service";
  dismissed: boolean;
}

/** A connection, as `GET /api/bridges?appId=` lists it (lib/bridges/store.ts). */
export interface AppConnection {
  id: string;
  from: string;
  to: string;
  direction: "one-way" | "both-ways";
  active: boolean;
  rewirePending?: boolean;
}

/** The suggestions that concern `appId` and still wait for a decision. */
export function pendingSuggestionsFor(appId: string, suggestions: ConnectionSuggestion[]): ConnectionSuggestion[] {
  return suggestions.filter((s) => s.type === "bridge" && !s.dismissed && !!s.targetAppId
    && (s.fromAppId === appId || s.targetAppId === appId));
}

/** How many suggestions an app's row in the list should mention: those that can be approved now. */
export function approvableCount(appId: string, suggestions: ConnectionSuggestion[]): number {
  return pendingSuggestionsFor(appId, suggestions).filter((s) => s.targetInstalled !== false).length;
}

/**
 * The names a suggestion row shows. An installed app's own name comes first (`installedName`): the store keeps the
 * app id for the consumer of a reverse suggestion and the want's label for the target of a type-based one. A target
 * that is not installed has only the stored name.
 */
export function suggestionNames(s: ConnectionSuggestion, installedName: (id: string) => string | undefined): { from: string; to: string } {
  const to = s.targetAppId ?? "";
  return {
    from: installedName(s.fromAppId) ?? (s.fromAppName || s.fromAppId),
    to: installedName(to) ?? (s.targetAppName || to),
  };
}
