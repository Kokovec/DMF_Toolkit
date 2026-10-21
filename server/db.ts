// Parts library + workload store on SQLite (node:sqlite). The schema sticks to
// portable SQL (TEXT JSON documents, ISO timestamps) so it can move to Postgres.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Catalog } from '../src/model/catalog'
import { catalogProblems } from '../src/model/modules'
import { getFeature, LIBRARY } from '../src/model/library'
import { feedOptions } from '../src/model/compose'
import { withDerived } from '../src/model/modules'
import { getPath } from '../src/model/schema'
import { API_VERSION, type ModuleCatalog, type FeatureLibrary, type ControlSpec, type Dependency, type JsonValue, type ModuleBlock, type ModuleDesign, type ResourceProfile, type VendorModule, type WorkloadDescription } from '../src/model/types'

// Bump when the schema or the stored document shapes change incompatibly.
const SCHEMA_VERSION = 9

const SCHEMA = `
-- Every feature library version this install has run with (the file lives in git).
-- (Table name kept from when it was the primitive library.)
CREATE TABLE IF NOT EXISTS primitive_library (
  version     TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  document    TEXT NOT NULL,
  loaded_at   TEXT NOT NULL
);

-- One catalog per vendor; its id prefixes every module type id.
CREATE TABLE IF NOT EXISTS catalogs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  vendor      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS catalogs_by_vendor ON catalogs(vendor);

-- One row per (vendor module, version). Versions referenced by a saved workload are immutable.
CREATE TABLE IF NOT EXISTS modules (
  id          TEXT NOT NULL,
  version     TEXT NOT NULL,
  catalog_id  TEXT NOT NULL REFERENCES catalogs(id),
  categories  TEXT NOT NULL, -- comma-separated palette headings
  vendor      TEXT,
  name        TEXT NOT NULL,
  document    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS workloads (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Every save is a new, immutable revision.
CREATE TABLE IF NOT EXISTS workload_revisions (
  workload_id TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  document    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (workload_id, revision)
);

-- Which part versions each revision uses; protects referenced parts from change/deletion.
CREATE TABLE IF NOT EXISTS workload_type_refs (
  workload_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  type_id      TEXT NOT NULL,
  type_version TEXT NOT NULL,
  PRIMARY KEY (workload_id, revision, type_id, type_version),
  FOREIGN KEY (workload_id, revision) REFERENCES workload_revisions(workload_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workload_type_refs_by_module ON workload_type_refs(type_id, type_version);
`

export class HttpError extends Error {
  readonly status: number
  readonly details?: string[]

  constructor(status: number, message: string, details?: string[]) {
    super(message)
    this.status = status
    this.details = details
  }
}

export type CatalogImportResult = { added: string[]; updated: string[]; unchanged: string[] }

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { n: tables } = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    if (tables > 0) {
      if (version < 2 || version > SCHEMA_VERSION)
        throw new Error(`${path} has schema version ${version}, expected ${SCHEMA_VERSION}. It holds dev data only: delete it to reset.`)
      if (version === 2) this.migrateFrom2()
      if (version <= 3) this.migrateFrom3()
      // v4 -> v5 only added the library table (created by SCHEMA).
      if (version <= 5) this.migrateFrom5()
      if (version <= 6) this.migrateFrom6()
      if (version <= 7) this.migrateFrom7()
      if (version <= 8) this.migrateFrom8()
    }
    this.db.exec(SCHEMA)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    this.recordLibrary(LIBRARY)
  }

  // v5 -> v6: modules are designed from features (no primitives). The `role` column becomes
  // `categories`; modules built from the old Receiver primitive are converted to a design.
  private migrateFrom5() {
    this.tx(() => {
      const cols = this.db.prepare("SELECT name FROM pragma_table_info('modules')").all() as { name: string }[]
      if (cols.some((c) => c.name === 'role')) this.db.exec('ALTER TABLE modules RENAME COLUMN role TO categories')
      const rows = this.db.prepare('SELECT id, version, catalog_id AS catalogId, document FROM modules').all() as {
        id: string
        version: string
        catalogId: string
        document: string
      }[]
      for (const r of rows) {
        const old = JSON.parse(r.document) as VendorModule & { role?: string }
        if (old.design) continue
        if (this.isReferenced(r.id, r.version))
          throw new Error(`module ${r.id}@${r.version} is used by a saved workload and can't be converted automatically`)
        const converted = convertReceiver(old, `${r.catalogId}.${this.maxModuleNumber(r.catalogId) + 1}`)
        this.db
          .prepare('UPDATE modules SET id = ?, categories = ?, document = ? WHERE id = ? AND version = ?')
          .run(converted.id, converted.categories.join(','), JSON.stringify(converted), r.id, r.version)
      }
    })
  }

  // v6 -> v7: SRT bonding, network constraints and expected payload became options built into
  // input blocks (library 2.1.0). Drop them from saved designs and recompute ports and parameters
  // (same parameter paths, so instances in workloads are unaffected).
  private migrateFrom6() {
    const moved = new Set(['addon.bonding', 'addon.network', 'addon.payload'])
    this.tx(() => {
      const rows = this.db.prepare('SELECT id, version, document FROM modules').all() as { id: string; version: string; document: string }[]
      for (const r of rows) {
        const m = JSON.parse(r.document) as VendorModule
        if (!m.design) continue
        const design = { ...m.design, blocks: m.design.blocks.map((b) => ({ ...b, addons: b.addons.filter((a) => !moved.has(a)) })) }
        this.db.prepare('UPDATE modules SET document = ? WHERE id = ? AND version = ?').run(JSON.stringify(withDerived({ ...m, design })), r.id, r.version)
      }
    })
  }

  // v7 -> v8: vendor settings, control & health, dependencies and resources moved from the module
  // to each function instance. Every instance in every workload revision gets its module's values
  // (vendor settings merged with the mapped core values, bindings folded into the dependencies);
  // modules keep identity, categories and design only.
  private migrateFrom7() {
    this.tx(() => {
      const legacy = new Map<string, LegacyModule>()
      const mods = this.db.prepare('SELECT id, version, document FROM modules').all() as { id: string; version: string; document: string }[]
      for (const r of mods) legacy.set(`${r.id}@${r.version}`, JSON.parse(r.document))
      const revs = this.db.prepare('SELECT workload_id AS id, revision, document FROM workload_revisions').all() as { id: string; revision: number; document: string }[]
      for (const r of revs) {
        const doc = JSON.parse(r.document) as WorkloadDescription
        doc.spec.functions = doc.spec.functions.map((f) => {
          const { bindings, ...fn } = f as typeof f & { bindings?: Record<string, string> }
          const m = legacy.get(`${f.type}@${f.typeVersion}`)
          if (!m) return fn
          const settings = legacyVendorConfig(m, f.parameters, f.settings ?? {})
          return {
            ...fn,
            ...(Object.keys(settings).length ? { settings } : {}),
            ...(m.control ? { control: m.control } : {}),
            ...(m.dependencies?.length ? { dependencies: m.dependencies.map((d) => (bindings?.[d.name] ? { ...d, binding: bindings[d.name] } : d)) } : {}),
            ...(m.resources ? { resources: m.resources } : {}),
          }
        })
        this.db.prepare('UPDATE workload_revisions SET document = ? WHERE workload_id = ? AND revision = ?').run(JSON.stringify(doc), r.id, r.revision)
      }
      for (const r of mods) {
        const { vendorSettings: _v, control: _c, dependencies: _d, resources: _r, ...m } = legacy.get(`${r.id}@${r.version}`)!
        this.db.prepare('UPDATE modules SET document = ? WHERE id = ? AND version = ?').run(JSON.stringify(m), r.id, r.version)
      }
    })
  }

  // v8 -> v9: designs have no links any more (a module lists its functions; wiring is
  // the workload's job). Blocks with ports now carry their own feed type: MXL outputs and external
  // outputs keep the feed that reached them through the old links.
  private migrateFrom8() {
    this.tx(() => {
      const rows = this.db.prepare('SELECT id, version, document FROM modules').all() as { id: string; version: string; document: string }[]
      for (const r of rows) {
        const m = JSON.parse(r.document) as VendorModule
        const old = m.design as ModuleDesign & { links?: { from: string; to: string }[]; layout?: unknown }
        if (!old) continue
        const links = old.links ?? []
        const feed = (id: string, seen = new Set<string>()): ModuleBlock['essence'] => {
          if (seen.has(id)) return undefined
          seen.add(id)
          const b = old.blocks.find((x) => x.id === id)
          if (b?.essence) return b.essence
          for (const l of links.filter((x) => x.to === id)) {
            const e = feed(l.from, seen)
            if (e) return e
          }
          return undefined
        }
        const blocks = old.blocks.map((b) => {
          const f = getFeature(b.feature)
          const e = f && feedOptions(f) ? (b.essence ?? feed(b.id)) : undefined
          return e ? { ...b, essence: e } : b
        })
        const design: ModuleDesign = { blocks, moduleFeatures: old.moduleFeatures ?? [], ...(old.layout ? { layout: old.layout as ModuleDesign['layout'] } : {}) }
        this.db.prepare('UPDATE modules SET document = ? WHERE id = ? AND version = ?').run(JSON.stringify(withDerived({ ...m, design })), r.id, r.version)
      }
    })
  }

  private maxModuleNumber(catalogId: string): number {
    const rows = this.db.prepare('SELECT id FROM modules WHERE catalog_id = ?').all(catalogId) as { id: string }[]
    return Math.max(0, ...rows.map((r) => Number(r.id.slice(catalogId.length + 1))).filter((x) => Number.isInteger(x)))
  }

  // ---- Feature library: a versioned file in git, recorded here on startup ----

  // Records the library version shipped with this build. A changed file must carry a new version.
  private recordLibrary(lib: FeatureLibrary) {
    const document = JSON.stringify(lib)
    const hash = createHash('sha256').update(document).digest('hex')
    const row = this.db.prepare('SELECT hash FROM primitive_library WHERE version = ?').get(lib.metadata.version) as { hash: string } | undefined
    if (row && row.hash !== hash)
      throw new Error(
        `src/model/library.json changed but its metadata.version (${lib.metadata.version}) did not. Bump the version.`,
      )
    if (!row)
      this.db
        .prepare('INSERT INTO primitive_library (version, hash, document, loaded_at) VALUES (?, ?, ?, ?)')
        .run(lib.metadata.version, hash, document, new Date().toISOString())
  }

  libraryVersions() {
    return this.db.prepare('SELECT version, hash, loaded_at AS loadedAt FROM primitive_library ORDER BY loaded_at DESC').all()
  }

  getLibrary(version: string): FeatureLibrary {
    const row = this.db.prepare('SELECT document FROM primitive_library WHERE version = ?').get(version) as { document: string } | undefined
    if (!row) throw new HttpError(404, `library version ${version} not found`)
    return JSON.parse(row.document)
  }

  // v2 -> v3: catalog entries became vendor modules (table renamed); the generic catalog is gone.
  private migrateFrom2() {
    this.tx(() => {
      this.db.exec('ALTER TABLE primitives RENAME TO modules')
      this.db.exec('DROP INDEX IF EXISTS workload_type_refs_by_module')
      this.db.exec("DELETE FROM catalogs WHERE id = 'generic' AND NOT EXISTS (SELECT 1 FROM modules WHERE catalog_id = 'generic')")
    })
  }

  // v3 -> v4: catalogs carry their vendor (existing catalogs take their name as vendor).
  private migrateFrom3() {
    this.tx(() => {
      this.db.exec("ALTER TABLE catalogs ADD COLUMN vendor TEXT NOT NULL DEFAULT ''")
      this.db.exec("UPDATE catalogs SET vendor = name WHERE vendor = ''")
    })
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---- Parts ----

  listModules(): VendorModule[] {
    const rows = this.db.prepare('SELECT document FROM modules ORDER BY name, id, version').all() as {
      document: string
    }[]
    return rows.map((r) => JSON.parse(r.document))
  }

  catalog(): Catalog {
    return new Catalog(this.listModules())
  }

  listCatalogs() {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.version, c.vendor, c.updated_at AS updatedAt, COUNT(t.id) AS moduleCount
         FROM catalogs c LEFT JOIN modules t ON t.catalog_id = c.id
         GROUP BY c.id ORDER BY c.name`,
      )
      .all()
  }

  exportCatalog(id: string): ModuleCatalog {
    const c = this.db.prepare('SELECT id, name, version, vendor FROM catalogs WHERE id = ?').get(id) as
      | { id: string; name: string; version: string; vendor: string }
      | undefined
    if (!c) throw new HttpError(404, `catalog ${id} not found`)
    const rows = this.db.prepare('SELECT document FROM modules WHERE catalog_id = ? ORDER BY id, version').all(id) as {
      document: string
    }[]
    return {
      apiVersion: API_VERSION,
      kind: 'ModuleCatalog',
      metadata: c,
      spec: { modules: rows.map((r) => JSON.parse(r.document)) },
    }
  }

  // Only empty catalogs can be deleted (delete their modules first).
  deleteCatalog(id: string) {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM modules WHERE catalog_id = ?').get(id) as { n: number }
    if (n) throw new HttpError(409, `catalog ${id} still has ${n} module version(s)`)
    const { changes } = this.db.prepare('DELETE FROM catalogs WHERE id = ?').run(id)
    if (!changes) throw new HttpError(404, `catalog ${id} not found`)
  }

  // Upsert a whole catalog. Fails (nothing written) if it would change a part version that is
  // used by a saved workload, or take over a part id owned by another catalog.
  importCatalog(doc: ModuleCatalog): CatalogImportResult {
    return this.tx(() => {
      const { id, name, version, vendor } = doc.metadata
      const sameVendor = this.db.prepare('SELECT id FROM catalogs WHERE vendor = ? AND id <> ?').get(vendor, id) as { id: string } | undefined
      if (sameVendor) throw new HttpError(409, `vendor "${vendor}" already has catalog "${sameVendor.id}"`)
      const current = this.db.prepare('SELECT vendor FROM catalogs WHERE id = ?').get(id) as { vendor: string } | undefined
      if (current && current.vendor !== vendor) throw new HttpError(409, `catalog ${id} belongs to vendor "${current.vendor}"`)
      this.db
        .prepare(
          `INSERT INTO catalogs (id, name, version, vendor, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(id, name, version, vendor, new Date().toISOString())

      const result: CatalogImportResult = { added: [], updated: [], unchanged: [] }
      const conflicts: string[] = []
      for (const t of doc.spec.modules) {
        const outcome = this.writePrimitive(id, t)
        if ('conflict' in outcome) conflicts.push(outcome.conflict)
        else result[outcome.result].push(`${t.id}@${t.version}`)
      }
      if (conflicts.length) throw new HttpError(409, 'catalog import conflicts', conflicts)
      return result
    })
  }

  // Create or update one module version in a catalog (the modules editor).
  saveModule(catalogId: string, t: VendorModule): { result: keyof CatalogImportResult } {
    return this.tx(() => {
      const cat = this.db.prepare('SELECT id, vendor FROM catalogs WHERE id = ?').get(catalogId) as { id: string; vendor: string } | undefined
      if (!cat) throw new HttpError(404, `catalog ${catalogId} not found`)
      const problems = catalogProblems(t, cat)
      if (problems.length) throw new HttpError(400, 'module does not match its catalog', problems)
      const outcome = this.writePrimitive(catalogId, t)
      if ('conflict' in outcome) throw new HttpError(409, outcome.conflict)
      this.db.prepare('UPDATE catalogs SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), catalogId)
      return { result: outcome.result }
    })
  }

  private writePrimitive(
    catalogId: string,
    t: VendorModule,
  ): { result: keyof CatalogImportResult } | { conflict: string } {
    const key = `${t.id}@${t.version}`
    const owner = this.db.prepare('SELECT catalog_id AS catalogId FROM modules WHERE id = ? LIMIT 1').get(t.id) as
      | { catalogId: string }
      | undefined
    if (owner && owner.catalogId !== catalogId) return { conflict: `${t.id} belongs to catalog "${owner.catalogId}"` }
    const existing = this.db.prepare('SELECT document FROM modules WHERE id = ? AND version = ?').get(t.id, t.version) as
      | { document: string }
      | undefined
    const document = JSON.stringify(t)
    if (existing?.document === document) return { result: 'unchanged' }
    if (existing && this.isReferenced(t.id, t.version))
      return { conflict: `${key} is used by saved workloads; publish it as a new version instead` }
    this.db
      .prepare(
        `INSERT INTO modules (id, version, catalog_id, categories, vendor, name, document, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id, version) DO UPDATE SET categories = excluded.categories, vendor = excluded.vendor, name = excluded.name,
           document = excluded.document`,
      )
      .run(t.id, t.version, catalogId, (t.categories ?? []).join(','), t.vendor ?? null, t.name, document, new Date().toISOString())
    return { result: existing ? 'updated' : 'added' }
  }

  // One row per module version with its catalog and how many saved workloads use it.
  listParts() {
    return this.db
      .prepare(
        `SELECT t.id, t.version, t.catalog_id AS catalogId, t.name, t.categories, t.vendor,
                (SELECT COUNT(DISTINCT r.workload_id) FROM workload_type_refs r
                 WHERE r.type_id = t.id AND r.type_version = t.version) AS usedBy
         FROM modules t ORDER BY t.catalog_id, t.name, t.id, t.version`,
      )
      .all()
  }

  deleteModule(id: string, version: string) {
    if (this.isReferenced(id, version)) throw new HttpError(409, `${id}@${version} is used by saved workloads`)
    const { changes } = this.db.prepare('DELETE FROM modules WHERE id = ? AND version = ?').run(id, version)
    if (!changes) throw new HttpError(404, `${id}@${version} not found`)
  }

  private isReferenced(id: string, version: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM workload_type_refs WHERE type_id = ? AND type_version = ? LIMIT 1').get(id, version)
  }

  // ---- Workloads ----

  listWorkloads() {
    return this.db.prepare('SELECT id, name, revision, updated_at AS updatedAt FROM workloads ORDER BY updated_at DESC').all()
  }

  getWorkload(id: string, revision?: number): { revision: number; document: WorkloadDescription } {
    const row = (
      revision === undefined
        ? this.db
            .prepare(
              `SELECT r.revision, r.document FROM workloads w
               JOIN workload_revisions r ON r.workload_id = w.id AND r.revision = w.revision WHERE w.id = ?`,
            )
            .get(id)
        : this.db.prepare('SELECT revision, document FROM workload_revisions WHERE workload_id = ? AND revision = ?').get(id, revision)
    ) as { revision: number; document: string } | undefined
    if (!row) throw new HttpError(404, `workload ${id}${revision === undefined ? '' : ` revision ${revision}`} not found`)
    return { revision: row.revision, document: JSON.parse(row.document) }
  }

  listRevisions(id: string) {
    return this.db
      .prepare('SELECT revision, created_at AS createdAt FROM workload_revisions WHERE workload_id = ? ORDER BY revision DESC')
      .all(id)
  }

  // Save as a new revision. If baseRevision is given and the workload has moved on since, reject.
  saveWorkload(doc: WorkloadDescription, baseRevision?: number): { revision: number } {
    return this.tx(() => {
      const id = doc.metadata.id
      const now = new Date().toISOString()
      const cur = this.db.prepare('SELECT revision FROM workloads WHERE id = ?').get(id) as { revision: number } | undefined
      if (baseRevision !== undefined && (cur?.revision ?? 0) !== baseRevision)
        throw new HttpError(409, `workload ${id} is at revision ${cur?.revision ?? 0} on the server, not ${baseRevision}`)
      const revision = (cur?.revision ?? 0) + 1
      this.db
        .prepare(
          `INSERT INTO workloads (id, name, revision, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(id, doc.metadata.name, revision, now)
      this.db
        .prepare('INSERT INTO workload_revisions (workload_id, revision, document, created_at) VALUES (?, ?, ?, ?)')
        .run(id, revision, JSON.stringify(doc), now)
      const ref = this.db.prepare(
        `INSERT INTO workload_type_refs (workload_id, revision, type_id, type_version) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      for (const f of doc.spec.functions) ref.run(id, revision, f.type, f.typeVersion)
      return { revision }
    })
  }

  deleteWorkload(id: string) {
    const { changes } = this.db.prepare('DELETE FROM workloads WHERE id = ?').run(id)
    if (!changes) throw new HttpError(404, `workload ${id} not found`)
  }
}

// Old Receiver modules (v5) -> a design: <protocol> input -> decoder -> MXL output,
// plus the latency budget. Core parameter paths in the vendor-settings mapping move with them.
function convertReceiver(old: LegacyModule, id: string): LegacyModule {
  const ext = old.ports.find((p) => p.transport !== 'mxl')
  const protocol = ext && ext.transport !== 'mxl' ? ext.transport.external : 'srt'
  const input = `${protocol.replace(/[^a-z0-9]/g, '')}1`
  const design: ModuleDesign = {
    blocks: [
      { id: input, feature: `input.${protocol}`, addons: [], essence: ext?.essence },
      { id: 'decoder1', feature: 'decoder', addons: ['codec.h264', 'codec.hevc', 'codec.aac'] },
      { id: 'mxl1', feature: 'output.mxl', addons: [], essence: ext?.essence },
    ],
    moduleFeatures: ['module.latency'],
  }
  const move = (path: string) =>
    path.startsWith('video.') || path.startsWith('audio.')
      ? `mxl1.format.${path}`
      : ['srt.', 'network.', 'payload.'].some((p) => path.startsWith(p))
        ? `${input}.${path}`
        : path
  const { role: _role, ...rest } = old
  return withDerived({
    ...rest,
    id,
    categories: ['acquisition'],
    design,
    ...(old.vendorSettings ? { vendorSettings: { ...old.vendorSettings, mapping: old.vendorSettings.mapping.map((m) => ({ ...m, core: move(m.core) })) } } : {}),
  } as VendorModule)
}

// Module documents before v8 carried the vendor's settings schema + mapping, control, dependencies
// and resources (now per instance).
type LegacyModule = VendorModule & {
  role?: string
  vendorSettings?: { schema: unknown; mapping: { core: string; vendor: string; values?: Record<string, JsonValue> }[] }
  control?: ControlSpec
  dependencies?: Dependency[]
  resources?: ResourceProfile
}

// The instance's vendor configuration as the old mapping produced it: its settings plus the mapped
// core values (translated by the value maps).
function legacyVendorConfig(m: LegacyModule, parameters: JsonValue, settings: { [k: string]: JsonValue }): { [k: string]: JsonValue } {
  const out = structuredClone(settings)
  for (const { core, vendor, values } of m.vendorSettings?.mapping ?? []) {
    const v = getPath(parameters, core)
    if (v === undefined) continue
    const keys = vendor.split('.')
    let cur = out
    for (const k of keys.slice(0, -1)) {
      if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
      cur = cur[k] as { [k: string]: JsonValue }
    }
    cur[keys[keys.length - 1]] = values && String(v) in values ? values[String(v)] : v
  }
  return out
}
