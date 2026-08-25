/**
 * Deployment configuration for the job-search plugin: the default tenant and
 * the JSON-feed portal list. Shared by the Service (portal adapters) and the
 * tools (default tenant).
 * @module @deepseek-ai/dsh-job-search/src/config
 */

import s from '@deepseek-ai/schemastery'

/** One configured JSON-feed portal. */
export interface PortalConfig {
  /** Stable adapter id, stamped on each scraped job. */
  id: string
  /** Human-readable board name. */
  label: string
  /** Template URL with `{query}` / `{location}` placeholders. */
  searchUrl: string
  /** Whether the adapter participates in `job_search_scrape`. */
  enabled: boolean
}

/** Deployment policy for the job-search plugin. */
export interface Config {
  /** Tenant used when a tool call omits `tenant_id`; defaults to `default`. */
  defaultTenantId: string
  /** Configured JSON-feed portals. */
  portals: PortalConfig[]
}

/** Schemastery configuration for the job-search plugin. */
export const Config: s<Config> = s.object({
  defaultTenantId: s.string().default('default'),
  portals: s.array(s.object({
    id: s.string().required(),
    label: s.string().required(),
    searchUrl: s.string().required(),
    enabled: s.boolean().required(),
  })).default([]),
})

/** Deployment policy the tools read to resolve the default tenant. */
export interface ToolConfig {
  defaultTenantId: string
}
