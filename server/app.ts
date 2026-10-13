// DMF Toolkit API: vendor module library (catalogs) and workloads, plus the published graph
// the downstream DMF orchestrator pulls.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkCatalog, checkModule, ID_RE } from '../src/model/catalog'
import type { ModuleCatalog, VendorModule, WorkloadDescription } from '../src/model/types'
import { PRIMITIVE_LIBRARY } from '../src/model/primitives'
import { checkWorkload, publishProblems, toPublished } from '../src/model/workload'
import { HttpError, Store } from './db'

type Handler = (ctx: { params: string[]; query: URLSearchParams; body: () => Promise<unknown> }) => unknown
type Route = { method: string; pattern: RegExp; handler: Handler }

export function createApp(store: Store) {
  const routes: Route[] = []
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler })

  // ---- Primitive library (read-only: versioned in git) ----
  route('GET', '/api/library', () => PRIMITIVE_LIBRARY)
  route('GET', '/api/library/versions', () => ({ current: PRIMITIVE_LIBRARY.metadata.version, versions: store.libraryVersions() }))
  route('GET', '/api/library/:version', ({ params: [version] }) => store.getLibrary(version))

  // ---- Vendor modules ----
  route('GET', '/api/modules', () => ({ modules: store.listModules() }))
  route('GET', '/api/parts', () => ({ parts: store.listParts() }))
  route('PUT', '/api/modules/:id/:version', async ({ params: [id, version], body }) => {
    const { catalogId, module } = ((await body()) ?? {}) as { catalogId?: string; module?: VendorModule }
    if (typeof catalogId !== 'string') throw new HttpError(400, 'catalogId is required')
    const problems = checkModule(module)
    if (problems.length) throw new HttpError(400, 'invalid module', problems)
    if (module!.id !== id || module!.version !== version) throw new HttpError(400, `body must describe ${id}@${version}`)
    return store.saveModule(catalogId, module!)
  })
  route('DELETE', '/api/modules/:id/:version', ({ params: [id, version] }) => {
    store.deleteModule(id, version)
    return { deleted: `${id}@${version}` }
  })
  route('GET', '/api/catalogs', () => ({ catalogs: store.listCatalogs() }))
  route('GET', '/api/catalogs/:id', ({ params: [id] }) => store.exportCatalog(id))
  route('DELETE', '/api/catalogs/:id', ({ params: [id] }) => {
    store.deleteCatalog(id)
    return { deleted: id }
  })
  route('POST', '/api/catalogs', async ({ body }) => {
    const doc = await body()
    const problems = checkCatalog(doc)
    if (problems.length) throw new HttpError(400, 'invalid catalog', problems)
    if (!ID_RE.test((doc as ModuleCatalog).metadata.id)) throw new HttpError(400, 'invalid catalog id')
    return store.importCatalog(doc as ModuleCatalog)
  })

  // ---- Workloads ----
  route('GET', '/api/workloads', () => ({ workloads: store.listWorkloads() }))
  route('GET', '/api/workloads/:id', ({ params: [id] }) => store.getWorkload(id))
  route('GET', '/api/workloads/:id/revisions', ({ params: [id] }) => ({ revisions: store.listRevisions(id) }))
  route('GET', '/api/workloads/:id/revisions/:rev', ({ params: [id, rev] }) => store.getWorkload(id, Number(rev)))
  route('PUT', '/api/workloads/:id', async ({ params: [id], query, body }) => {
    const doc = (await body()) as WorkloadDescription
    if (!ID_RE.test(id)) throw new HttpError(400, 'workload id must be lowercase letters, digits, . _ -')
    if (doc?.metadata?.id !== id) throw new HttpError(400, `metadata.id must be "${id}"`)
    const problems = checkWorkload(doc, store.catalog())
    if (problems.length) throw new HttpError(400, 'invalid workload', problems)
    const base = query.get('baseRevision')
    return store.saveWorkload(doc, base === null ? undefined : Number(base))
  })
  route('DELETE', '/api/workloads/:id', ({ params: [id] }) => {
    store.deleteWorkload(id)
    return { deleted: id }
  })

  // The published graph for the orchestrator: latest revision (or ?revision=N), only if complete.
  route('GET', '/api/workloads/:id/published', ({ params: [id], query }) => {
    const rev = query.get('revision')
    const { revision, document } = store.getWorkload(id, rev === null ? undefined : Number(rev))
    const problems = publishProblems(document, store.catalog())
    if (problems.length) throw new HttpError(422, `revision ${revision} is not publishable`, problems)
    return toPublished(document, revision, store.catalog())
  })

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      const candidates = routes.filter((r) => r.pattern.test(url.pathname))
      const r = candidates.find((c) => c.method === req.method)
      if (!r) throw new HttpError(candidates.length ? 405 : 404, candidates.length ? 'method not allowed' : 'not found')
      const params = r.pattern.exec(url.pathname)!.slice(1).map(decodeURIComponent)
      const result = await r.handler({ params, query: url.searchParams, body: () => readJson(req) })
      send(res, 200, result)
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message, details: e.details })
      else {
        console.error(e)
        send(res, 500, { error: 'internal error' })
      }
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 10 * 1024 * 1024) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
