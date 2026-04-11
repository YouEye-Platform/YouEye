/**
 * Native app utility functions.
 * Container naming and Gitea repo mapping for native apps (Wiki, Search, Notes).
 *
 * The catalog itself has moved to YE-AppMarket YAML manifests.
 * These utility functions remain for the installer/uninstaller.
 */

/** Container name for a native app */
export function nativeContainerName(appId: string): string {
  const map: Record<string, string> = {
    'ye-wiki': 'ye-app-wiki',
    'ye-search': 'ye-app-search',
    'ye-notes': 'ye-app-notes',
    'ye-cinema': 'ye-app-cinema',
    'ye-weather': 'ye-app-weather',
    'ye-translate': 'ye-app-translate',
    wiki: 'ye-app-wiki',
    search: 'ye-app-search',
    notes: 'ye-app-notes',
    cinema: 'ye-app-cinema',
    weather: 'ye-app-weather',
    translate: 'ye-app-translate',
  };
  return map[appId] ?? `ye-app-${appId.replace('ye-', '')}`;
}

/** Gitea repo name for a native app */
export function nativeGiteaRepo(appId: string): string {
  const map: Record<string, string> = {
    'ye-wiki': 'YE-App-Wiki',
    'ye-search': 'YE-App-Search',
    'ye-notes': 'YE-App-Notes',
    'ye-cinema': 'YE-App-Cinema',
    'ye-weather': 'YE-App-Weather',
    'ye-translate': 'YE-App-Translate',
    wiki: 'YE-App-Wiki',
    search: 'YE-App-Search',
    notes: 'YE-App-Notes',
    cinema: 'YE-App-Cinema',
    weather: 'YE-App-Weather',
    translate: 'YE-App-Translate',
  };
  return map[appId] ?? appId;
}
