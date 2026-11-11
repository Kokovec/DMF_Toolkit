// Starts the API. One instance (and one database) per customer install: `npm run server`.
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createApp } from './app'
import { Store } from './db'
import { checkCatalog } from '../src/model/catalog'
import { CAPABILITIES, checkFacility } from '../src/model/facility'
import { checkLibrary } from '../src/model/library'
import type { Facility, ModuleCatalog } from '../src/model/types'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const DB_PATH = process.env.DMF_DB ?? 'data/dmf-toolkit.db'
// Product catalogs shipped with the toolkit (one per company), loaded at every start.
const CATALOGS_DIR = process.env.DMF_CATALOGS ?? new URL('../catalogs/', import.meta.url).pathname

const problems = checkLibrary()
if (problems.length) throw new Error(`src/model/library.json is invalid: ${problems.join('; ')}`)

const facility = loadFacility()
const store = new Store(DB_PATH)
loadProductCatalogs()
createServer(createApp(store, { facility })).listen(PORT, HOST, () => {
  console.log(`DMF Toolkit API on http://${HOST}:${PORT} (database: ${DB_PATH})`)
})

// What the facility can run: DMF_FACILITY names the file the orchestrator exports
// (`make facility-export`). Unset: no facility, everything is offered. Set but unreadable or
// invalid: the server doesn't start, rather than silently offering everything.
function loadFacility(): Facility {
  const path = process.env.DMF_FACILITY
  if (!path) {
    console.log('No facility (DMF_FACILITY unset): every option is offered')
    return {}
  }
  let doc: { name: string; capabilities: Record<string, boolean>; limits?: Facility['limits'] }
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`DMF_FACILITY=${path} can't be read: ${(e as Error).message}`)
  }
  const problems = checkFacility(doc)
  if (problems.length) throw new Error(`DMF_FACILITY=${path} is invalid: ${problems.join('; ')}`)
  const known = CAPABILITIES.map((c) => c.id)
  const unknown = Object.keys(doc.capabilities).filter((c) => !known.includes(c))
  const unlisted = known.filter((c) => !(c in doc.capabilities))
  if (unknown.length) console.warn(`Facility ${doc.name}: capabilities the library doesn't know (ignored): ${unknown.join(', ')}`)
  if (unlisted.length) console.warn(`Facility ${doc.name}: doesn't list ${unlisted.join(', ')} (treated as unavailable)`)
  const off = known.filter((c) => doc.capabilities[c] !== true)
  console.log(`Facility ${doc.name} (${path}): not offered: ${off.join(', ') || 'none'}`)
  return { name: doc.name, capabilities: doc.capabilities, limits: doc.limits ?? {} }
}

// Every module models a real product; their catalogs live in catalogs/ and are imported (or updated)
// at start. A catalog that can't be imported (e.g. it would change a version a saved workload uses)
// is reported and skipped; the rest still load.
function loadProductCatalogs() {
  let files: string[]
  try {
    files = readdirSync(CATALOGS_DIR).filter((f) => f.endsWith('.catalog.json'))
  } catch {
    return console.warn(`No product catalogs: ${CATALOGS_DIR} not found`)
  }
  for (const f of files) {
    try {
      const doc = JSON.parse(readFileSync(`${CATALOGS_DIR}/${f}`, 'utf8')) as ModuleCatalog
      const problems = checkCatalog(doc)
      if (problems.length) throw new Error(problems.slice(0, 3).join('; '))
      const r = store.importCatalog(doc)
      console.log(`Catalog ${doc.metadata.name}: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged`)
    } catch (e) {
      const details = (e as { details?: string[] }).details
      console.warn(`Catalog ${f} not loaded: ${(e as Error).message}${details ? ` (${details.join('; ')})` : ''}`)
    }
  }
}
