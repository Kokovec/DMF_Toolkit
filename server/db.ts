// Parts library + workload store on SQLite (node:sqlite). The schema sticks to
// portable SQL (TEXT JSON documents, ISO timestamps) so it can move to Postgres.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Catalog } from '../src/model/catalog'
import { catalogProblems } from '../src/model/modules'
import { API_VERSION, type ModuleCatalog, type VendorModule, type WorkloadDescription } from '../src/model/types'

// Bump when the schema or the stored document shapes change incompatibly.
const SCHEMA_VERSION = 4

const SCHEMA = `
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
  role        TEXT NOT NULL,
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
    if (tables > 0 && version === 2) this.migrateFrom2()
    if (tables > 0 && (version === 2 || version === 3)) this.migrateFrom3()
    else if (tables > 0 && version !== SCHEMA_VERSION)
      throw new Error(`${path} has schema version ${version}, expected ${SCHEMA_VERSION}. It holds dev data only: delete it to reset.`)
    this.db.exec(SCHEMA)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
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
    const rows = this.db.prepare('SELECT document FROM modules ORDER BY role, name, id, version').all() as {
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
        `INSERT INTO modules (id, version, catalog_id, role, vendor, name, document, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id, version) DO UPDATE SET role = excluded.role, vendor = excluded.vendor, name = excluded.name,
           document = excluded.document`,
      )
      .run(t.id, t.version, catalogId, t.role, t.vendor ?? null, t.name, document, new Date().toISOString())
    return { result: existing ? 'updated' : 'added' }
  }

  // One row per module version with its catalog and how many saved workloads use it.
  listParts() {
    return this.db
      .prepare(
        `SELECT t.id, t.version, t.catalog_id AS catalogId, t.name, t.role, t.vendor,
                (SELECT COUNT(DISTINCT r.workload_id) FROM workload_type_refs r
                 WHERE r.type_id = t.id AND r.type_version = t.version) AS usedBy
         FROM modules t ORDER BY t.catalog_id, t.role, t.name, t.id, t.version`,
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
