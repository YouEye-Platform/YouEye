/**
 * Connector Manifest v1 Schema.
 * No backwards compatibility — this is the only version.
 * Designed with growth potential: fields for future features exist from day one.
 */

import { z } from 'zod/v4';

// ─── Auth Configuration ────────────────────────────────────

export const ConnectorAuthSchema = z.object({
  method: z.enum(['none', 'api-key', 'bearer', 'basic', 'oauth2']),
  provider: z.string().optional(),
  header: z.string().optional(),
  value: z.string().optional(),
});

// ─── Permissions ────────────────────────────────────────────

export const ConnectorPermissionsSchema = z.object({
  network: z.object({
    type: z.enum(['local', 'internet']),
    allowedHosts: z.array(z.string()).default([]),
  }),
  scopes: z.array(z.string()).default([]),
  auth: ConnectorAuthSchema,
});

// ─── Config Fields ──────────────────────────────────────────

export const ConnectorConfigFieldSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  type: z.enum(['text', 'secret', 'select', 'number', 'toggle']),
  required: z.boolean().default(false),
  managed: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  helpText: z.string().optional(),
  helpUrl: z.string().url().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
});

export const ConnectorConfigSchema = z.object({
  fields: z.array(ConnectorConfigFieldSchema).default([]),
});

// ─── Response Transform ─────────────────────────────────────

export const ResponseTransformSchema = z.object({
  type: z.enum(['json-map', 'script', 'passthrough']),
  root: z.string().optional(),
  map: z.record(z.string(), z.string()).optional(),
  code: z.string().optional(),
});

// ─── API Endpoints ──────────────────────────────────────────

export const ConnectorEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  url: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  responseTransform: ResponseTransformSchema.optional(),
});

export const ConnectorApiSchema = z.object({
  endpoints: z.record(z.string(), ConnectorEndpointSchema),
});

// ─── UI Components ──────────────────────────────────────────

export const ConnectorUIComponentSchema = z.object({
  entry: z.string().min(1),
  protocol: z.string().min(1),
});

export const ConnectorUISchema = z.record(z.string(), ConnectorUIComponentSchema).optional();

// ─── Capabilities ───────────────────────────────────────────

export const ConnectorCapabilitySchema = z.object({
  multiple: z.boolean().default(false),
});

// ─── Metadata ───────────────────────────────────────────────

export const ConnectorMetadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  provides: z.array(z.string().min(1)).min(1),
  network: z.enum(['local', 'internet']),
});

// ─── Root Connector Manifest ────────────────────────────────

export const ConnectorManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('connector'),
  metadata: ConnectorMetadataSchema,
  permissions: ConnectorPermissionsSchema,
  config: ConnectorConfigSchema.default({ fields: [] }),
  api: ConnectorApiSchema,
  ui: ConnectorUISchema,
  capabilities: z.record(z.string(), ConnectorCapabilitySchema).optional(),
});

// ─── Connector Catalog ──────────────────────────────────────

export const ConnectorCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1).optional(),
});

export const ConnectorCatalogSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('connector-catalog'),
  connectors: z.array(ConnectorCatalogEntrySchema).min(1),
});

// ─── Type Exports ───────────────────────────────────────────

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
export type ConnectorCatalogEntry = z.infer<typeof ConnectorCatalogEntrySchema>;
export type ConnectorCatalog = z.infer<typeof ConnectorCatalogSchema>;
export type ConnectorEndpoint = z.infer<typeof ConnectorEndpointSchema>;
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>;
export type ResponseTransform = z.infer<typeof ResponseTransformSchema>;
export type ConnectorUIComponent = z.infer<typeof ConnectorUIComponentSchema>;
