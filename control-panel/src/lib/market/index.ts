/**
 * App Market — YAML-driven deployment engine.
 * Replaces the temp-market hardcoded installers with a generic engine
 * that deploys any app from a youeye-file.yaml manifest.
 */

// Schema & parsing
export { AppManifestSchema, CatalogSchema } from './schema';
export { parseManifest, parseCatalog, tryParseManifest } from './parser';

// Types
export type {
  AppManifest,
  AppMetadata,
  ContainerSpec,
  SecretSpec,
  ConfigFileSpec,
  SSOConfig,
  SSOStep,
  UninstallSpec,
  HealthCheckSpec,
  Catalog,
  CatalogEntry,
  InstallConfig,
  InstallMetadata,
  InstallEvent,
  InstallEventCallback,
  AppStatus,
  AppStatusInfo,
  ContainerStatusInfo,
  VariableContext,
  MarketApp,
} from './types';

// Engine
export { installApp } from './engine';
export { uninstallApp } from './uninstaller';

// Metadata
export { readInstallMetadata, listInstalledApps } from './metadata';

// Variables
export { resolveVariables, resolveVariablesDeep } from './variables';

// Catalog
export { fetchCatalog, fetchManifest, fetchAvailableApps, clearCatalogCache } from './catalog';

// SSO & Authentik
export {
  isAuthentikAvailable,
  getAuthentikExternalUrl,
  createAuthentikOAuth2App,
  removeAuthentikOAuth2App,
} from './authentik';
export { executeSSOSteps } from './sso-engine';
