/**
 * Zod schemas for connector manifest validation.
 * Connector manifests live in YE-AppMarket/connectors/*.yaml.
 */

import { z } from 'zod/v4';

// ─── Auth Configuration ────────────────────────────────────

export const ConnectorAuthSchema = z.object({
  method: z.enum(['none', 'api-key', 'bearer', 'basic', 'oauth2']),
  /** Header name for the credential (e.g. "Authorization") */
  header: z.string().optional(),
  /** Header value template (e.g. "Bearer ${config.api_key}") */
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
  type: z.enum(['json-map', 'passthrough']),
  /** JSONPath to the root of the result array/object */
  root: z.string().optional(),
  /** Field mapping: output key → JSONPath expression */
  map: z.record(z.string(), z.string()).optional(),
});

// ─── API Endpoints ──────────────────────────────────────────

export const ConnectorEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  /** URL template with ${param} substitution */
  url: z.string().min(1),
  /** Query/body param mapping: upstream param name → template expression */
  params: z.record(z.string(), z.string()).optional(),
  /** Headers to add to the upstream request */
  headers: z.record(z.string(), z.string()).optional(),
  /** How to transform the upstream response */
  responseTransform: ResponseTransformSchema.optional(),
});

export const ConnectorApiSchema = z.object({
  endpoints: z.record(z.string(), ConnectorEndpointSchema),
});

// ─── Metadata ───────────────────────────────────────────────

export const ConnectorMetadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  /** What capability this connector provides (e.g. "encyclopedia", "media-catalog") */
  provides: z.string().min(1),
  /** Network requirement */
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
});

// ─── Connector Catalog ──────────────────────────────────────

export const ConnectorCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
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
