// Starts the API. One instance (and one database) per customer install: `npm run server`.
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createApp } from './app'
import { Store } from './db'
import { checkCatalog } from '../src/model/catalog'
import { checkLibrary } from '../src/model/library'
import type { ModuleCatalog } from '../src/model/types'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const DB_PATH = process.env.DMF_DB ?? 'data/dmf-toolkit.db'
// Product catalogs shipped with the toolkit (one per company), loaded at every start.
const CATALOGS_DIR = process.env.DMF_CATALOGS ?? new URL('../catalogs/', import.meta.url).pathname

const problems = checkLibrary()
if (problems.length) throw new Error(`src/model/library.json is invalid: ${problems.join('; ')}`)

const store = new Store(DB_PATH)
loadProductCatalogs()
createServer(createApp(store)).listen(PORT, HOST, () => {
  console.log(`DMF Toolkit API on http://${HOST}:${PORT} (database: ${DB_PATH})`)
})

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
