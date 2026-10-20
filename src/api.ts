import { useSyncExternalStore } from 'react'
import { Catalog, currentCatalog, setCatalog, subscribeCatalog } from './model/catalog'
import { vendorSlug } from './model/modules'
import { API_VERSION, type ModuleCatalog, type VendorModule, type WorkloadDescription } from './model/types'

export class ApiError extends Error {
  readonly status: number
  readonly details: string[]

  constructor(status: number, message: string, details: string[] = []) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.details)
  return data as T
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return [e.message, ...e.details.slice(0, 3)].join(' — ') + (e.details.length > 3 ? ' …' : '')
  return 'library server not reachable (start it with `npm run server`)'
}

export type CatalogSummary = { id: string; name: string; version: string; vendor: string; moduleCount: number }
export type PartSummary = {
  id: string
  version: string
  catalogId: string
  name: string
  categories: string // comma-separated
  vendor: string | null
  usedBy: number
}
export type WorkloadSummary = { id: string; name: string; revision: number; updatedAt: string }
export type CatalogImportResult = { added: string[]; updated: string[]; unchanged: string[] }

const enc = encodeURIComponent

export const api = {
  modules: () => call<{ modules: VendorModule[] }>('GET', '/modules').then((r) => r.modules),
  parts: () => call<{ parts: PartSummary[] }>('GET', '/parts').then((r) => r.parts),
  saveModule: (catalogId: string, module: VendorModule) =>
    call<{ result: keyof CatalogImportResult }>('PUT', `/modules/${enc(module.id)}/${enc(module.version)}`, {
      catalogId,
      module,
    }),
  deleteModule: (id: string, version: string) => call<unknown>('DELETE', `/modules/${enc(id)}/${enc(version)}`),
  catalogs: () => call<{ catalogs: CatalogSummary[] }>('GET', '/catalogs').then((r) => r.catalogs),
  importCatalog: (doc: ModuleCatalog) => call<CatalogImportResult>('POST', '/catalogs', doc),
  // One catalog per vendor; its id is derived from the vendor name.
  createCatalog: (vendor: string, name: string) =>
    call<CatalogImportResult>('POST', '/catalogs', {
      apiVersion: API_VERSION,
      kind: 'ModuleCatalog',
      metadata: { id: vendorSlug(vendor), name: name || vendor, version: '1', vendor },
      spec: { modules: [] },
    } satisfies ModuleCatalog),
  deleteCatalog: (id: string) => call<unknown>('DELETE', `/catalogs/${enc(id)}`),
  workloads: () => call<{ workloads: WorkloadSummary[] }>('GET', '/workloads').then((r) => r.workloads),
  workload: (id: string) => call<{ revision: number; document: WorkloadDescription }>('GET', `/workloads/${enc(id)}`),
  saveWorkload: (doc: WorkloadDescription, baseRevision: number) =>
    call<{ revision: number }>('PUT', `/workloads/${enc(doc.metadata.id)}?baseRevision=${baseRevision}`, doc),
  deleteWorkload: (id: string) => call<unknown>('DELETE', `/workloads/${enc(id)}`),
  published: (id: string, revision: number) =>
    call<WorkloadDescription>('GET', `/workloads/${enc(id)}/published?revision=${revision}`),
}

// Replace the UI catalog with the server's vendor module library (all versions).
export async function refreshCatalog() {
  setCatalog(new Catalog(await api.modules()))
}

export function useCatalog(): Catalog {
  return useSyncExternalStore(subscribeCatalog, currentCatalog)
}
