import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react'
import { api, describeError, refreshCatalog, useCatalog, type CatalogSummary, type PartSummary } from '../api'
import { checkModule, deriveCapability } from '../model/catalog'
import { checkParameterSchema, defaultsFor, leafPaths } from '../model/schema'
import {
  DEPENDENCY_KINDS,
  TRANSPORT_LABELS,
  type CoreMapping,
  type ControlApiType,
  type Dependency,
  type DependencyKind,
  type Essence,
  type ExternalTransport,
  type HealthType,
  type JsonSchema,
  type JsonValue,
  type VendorModule,
  type PortDef,
  type PrimitiveDef,
  type ResourceProfile,
} from '../model/types'
import { coreSchemaFor, moduleFromPrimitive, moduleNumber, nextModuleId, portChoiceOf, portsFor, protocolsFor, settingsSchema, vendorSlug } from '../model/modules'
import { getPrimitive, primitiveTree, roleLabel } from '../model/primitives'
import { ModulePreview } from './MediaNode'
import { SchemaForm } from './SchemaForm'

type Props = { onMessage: (msg: string, isError: boolean) => void }

// What the form is editing: an existing module version, or a new one (new, new version, duplicate).
type Target = { mode: 'existing'; id: string; version: string } | { mode: 'new'; lockId: boolean }

const BLANK: VendorModule = {
  id: '',
  version: '1.0.0',
  name: '',
  description: '',
  role: '',
  vendor: '',
  capability: { produces: [], consumes: [], scaling: 'singleton' },
  ports: [],
  parameters: { schema: { type: 'object', properties: {} } },
  vendorSettings: { schema: { type: 'object', properties: {} }, mapping: [] },
  control: { health: { type: 'http', port: 8080, path: '/healthz' } },
  dependencies: [],
}


export function PartsEditor({ onMessage }: Props) {
  const catalog = useCatalog()
  const [parts, setParts] = useState<PartSummary[]>([])
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([])
  const [filter, setFilter] = useState('')
  const [target, setTarget] = useState<Target | null>(null)
  const [draft, setDraft] = useState<VendorModule>(BLANK)
  const [draftCatalog, setDraftCatalog] = useState('')
  // JSON text editors report parse errors here; the draft only changes when their text parses.
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({})
  const [editKey, setEditKey] = useState(0) // remounts the JSON editors when another module is opened
  const [vendorImports, setVendorImports] = useState(0)
  const vendorFile = useRef<HTMLInputElement>(null)
  const [baseline, setBaseline] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newCatalog, setNewCatalog] = useState<{ vendor: string; name: string } | null>(null)
  const [choosing, setChoosing] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.parts(), api.catalogs()])
      setParts(p)
      setCatalogs(c)
      await refreshCatalog()
    } catch (e) {
      onMessage(describeError(e), true)
    }
  }, [onMessage])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.parts(), api.catalogs(), refreshCatalog()]).then(
      ([p, c]) => {
        if (cancelled) return
        setParts(p)
        setCatalogs(c)
      },
      (e) => onMessage(describeError(e), true),
    )
    return () => {
      cancelled = true
    }
  }, [onMessage])

  const snapshot = JSON.stringify({ draft, draftCatalog })
  const dirty = snapshot !== baseline
  const summary = target?.mode === 'existing' ? parts.find((p) => p.id === target.id && p.version === target.version) : undefined
  const locked = (summary?.usedBy ?? 0) > 0
  const problems = useMemo(() => {
    const errors = checkModule(draft)
    for (const [what, msg] of Object.entries(jsonErrors)) errors.unshift(`${what} is not valid JSON: ${msg}`)
    if (!draftCatalog) errors.push('choose a catalog')
    if (target?.mode === 'new' && catalog.get(draft.id, draft.version)) errors.push(`${draft.id}@${draft.version} already exists`)
    return errors
  }, [draft, draftCatalog, target, catalog, jsonErrors])

  const edit = (next: Target, prim: VendorModule, catalogId: string) => {
    if (dirty && target && !confirm('Discard unsaved changes to this module?')) return
    setTarget(next)
    setDraft(prim)
    setDraftCatalog(catalogId)
    setJsonErrors({})
    setEditKey((k) => k + 1)
    setConfirmDelete(false)
    // A new draft is always "dirty" so it can be saved; an existing module starts clean.
    setBaseline(next.mode === 'existing' ? JSON.stringify({ draft: prim, draftCatalog: catalogId }) : '')
  }

  const select = (p: PartSummary) => {
    const prim = catalog.get(p.id, p.version)
    if (prim) edit({ mode: 'existing', id: p.id, version: p.version }, structuredClone(prim), p.catalogId)
  }

  const newVersion = () => {
    let version = bumpVersion(draft.version)
    while (catalog.get(draft.id, version)) version = bumpVersion(version)
    edit({ mode: 'new', lockId: true }, { ...structuredClone(draft), version }, draftCatalog)
  }

  // A duplicate is a new module of the same primitive: next module number, version restarts.
  const duplicate = () => {
    const id = nextModuleId(catalog, draftCatalog, draft.role)
    edit({ mode: 'new', lockId: false }, { ...structuredClone(draft), id, version: '1.0.0', name: `${draft.name} (copy)` }, draftCatalog)
  }

  // A new module starts from its primitive: ports and parameter schema are copied in, and it
  // gets the catalog's vendor and the next free module number.
  const startModule = (primitiveId: string) => {
    const prim = primitiveTree().flatMap((c) => c.primitives).find((p) => p.id === primitiveId)
    const cat = catalogs[0]
    if (!prim || !cat) return
    setChoosing(false)
    edit({ mode: 'new', lockId: false }, moduleFromPrimitive(prim, cat, catalog), cat.id)
  }

  // Moving a new draft to another catalog changes its vendor and module number.
  const retarget = (catalogId: string) => {
    const cat = catalogs.find((c) => c.id === catalogId)
    if (!cat) return
    setDraftCatalog(catalogId)
    setDraft((d) => ({ ...d, vendor: cat.vendor, id: nextModuleId(catalog, catalogId, d.role) }))
  }

  const save = async () => {
    const prim: VendorModule = { ...draft, capability: { ...draft.capability, ...deriveCapability(draft) } }
    try {
      const { result } = await api.saveModule(draftCatalog, prim)
      await reload()
      setTarget({ mode: 'existing', id: prim.id, version: prim.version })
      setDraft(prim)
      setBaseline(JSON.stringify({ draft: prim, draftCatalog }))
      onMessage(`${prim.id}@${prim.version} ${result}`, false)
    } catch (e) {
      onMessage(`Save failed: ${describeError(e)}`, true)
    }
  }

  const remove = async () => {
    try {
      await api.deleteModule(draft.id, draft.version)
      onMessage(`Deleted ${draft.id}@${draft.version}`, false)
      setTarget(null)
      setBaseline('')
      await reload()
    } catch (e) {
      onMessage(`Delete failed: ${describeError(e)}`, true)
    }
  }

  const createCatalog = async () => {
    if (!newCatalog) return
    try {
      await api.createCatalog(newCatalog.vendor.trim(), newCatalog.name.trim())
      setNewCatalog(null)
      await reload()
      onMessage(`Created catalog ${vendorSlug(newCatalog.vendor)} for ${newCatalog.vendor.trim()}`, false)
    } catch (e) {
      onMessage(`Cannot create catalog: ${describeError(e)}`, true)
    }
  }

  const deleteCatalog = async (id: string) => {
    try {
      await api.deleteCatalog(id)
      await reload()
    } catch (e) {
      onMessage(`Cannot delete catalog: ${describeError(e)}`, true)
    }
  }

  const setJsonError = (what: string, msg: string | null) =>
    setJsonErrors((errs) => {
      const next = { ...errs }
      if (msg) next[what] = msg
      else delete next[what]
      return next
    })

  // Load a vendor-published JSON Schema (a bare `properties` object is accepted too).
  const importVendorSchema = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const doc = JSON.parse(await file.text())
      const schema: JsonSchema = doc?.type === 'object' ? doc : doc?.properties ? { ...doc, type: 'object' } : { type: 'object', properties: doc }
      const problems = checkParameterSchema(schema)
      if (problems.length) return onMessage(`${file.name}: ${problems.slice(0, 3).join('; ')}`, true)
      set('vendorSettings', { ...draft.vendorSettings, schema })
      setVendorImports((n) => n + 1)
      onMessage(`Imported ${leafPaths(schema).length} vendor settings from ${file.name}`, false)
    } catch {
      onMessage(`${file.name} is not valid JSON`, true)
    }
  }

  const setResources = (patch: Partial<ResourceProfile>) =>
    setDraft((d) => {
      const resources = cleanObject({ ...d.resources, ...patch })
      return Object.keys(resources).length ? { ...d, resources } : (({ resources: _r, ...rest }) => rest)(d)
    })

  const set = <K extends keyof VendorModule>(key: K, value: VendorModule[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const setControl = (patch: Partial<VendorModule['control']>) => setDraft((d) => ({ ...d, control: { ...d.control, ...patch } }))
  const q = filter.toLowerCase()
  const shown = parts.filter((p) => !q || `${p.name} ${p.id} ${p.role} ${p.vendor ?? ''}`.toLowerCase().includes(q))
  const cap = deriveCapability(draft)
  const coreLeaves = leafPaths(draft.parameters.schema)

  return (
    <div className="parts-editor">
      <aside className="parts-list">
        <div className="parts-list-actions">
          <button onClick={() => setChoosing(!choosing)} disabled={!catalogs.length} title={catalogs.length ? '' : 'Create a catalog first'}>
            New module…
          </button>
          <button onClick={() => setNewCatalog({ vendor: '', name: '' })}>New catalog</button>
        </div>
        {newCatalog && (
          <div className="new-catalog">
            <input placeholder="Vendor name (required), e.g. Acme Media" value={newCatalog.vendor} onChange={(e) => setNewCatalog({ ...newCatalog, vendor: e.target.value })} />
            <input placeholder="Catalog name (optional)" value={newCatalog.name} onChange={(e) => setNewCatalog({ ...newCatalog, name: e.target.value })} />
            {vendorSlug(newCatalog.vendor) && (
              <span className="hint">
                Catalog id <code>{vendorSlug(newCatalog.vendor)}</code>; module ids like <code>{vendorSlug(newCatalog.vendor)}.receiver.1</code>
              </span>
            )}
            <span className="row-actions">
              <button onClick={createCatalog} disabled={!vendorSlug(newCatalog.vendor)}>
                Create
              </button>
              <button onClick={() => setNewCatalog(null)}>Cancel</button>
            </span>
          </div>
        )}
        {choosing && (
          <div className="new-catalog choose-primitive">
            <span className="hint">Build a {catalogs[0]?.vendor} module from a primitive (change the catalog in the form):</span>
            {primitiveTree().map(({ category, primitives }) => (
              <div key={category.id}>
                <strong>{category.name}</strong>
                {primitives.map((p) => (
                  <button key={p.id} className="part-row fn" title={p.description} onClick={() => startModule(p.id)}>
                    {p.name}
                  </button>
                ))}
              </div>
            ))}
            <button onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        )}
        <input className="parts-filter" placeholder="Filter by name, id, role, vendor…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {catalogs.map((c) => {
          const inCatalog = shown.filter((p) => p.catalogId === c.id)
          return (
            <section key={c.id}>
              <h3 className="catalog-head">
                <span>
                  {c.name} <span className="hint">{c.vendor !== c.name ? `${c.vendor} · ` : ''}{c.id}</span>
                </span>
                {c.moduleCount === 0 && (
                  <button className="link" title="Delete this empty catalog" onClick={() => deleteCatalog(c.id)}>
                    delete
                  </button>
                )}
              </h3>
              {inCatalog.length === 0 && <p className="hint">No modules{q ? ' match' : ' yet'}.</p>}
              {inCatalog.map((p) => {
                const active = target?.mode === 'existing' && target.id === p.id && target.version === p.version
                return (
                  <button
                    key={`${p.id}@${p.version}`}
                    className={`part-row fn${active ? ' active' : ''}`}
                    onClick={() => select(p)}
                  >
                    <span>{p.name}</span>
                    <span className="hint">
                      {roleLabel(p.role)} · {p.id}@{p.version}
                      {p.usedBy > 0 ? ` · used by ${p.usedBy}` : ''}
                    </span>
                  </button>
                )
              })}
            </section>
          )
        })}
      </aside>

      {!target ? (
        <div className="part-form empty">
          <p className="hint">
            Select a vendor module to edit it, or create one with <strong>New module…</strong>. A module is built from a primitive
            (its ports and parameters) and adds the vendor's identity, formats, control/health endpoints and
            dependencies.
          </p>
        </div>
      ) : (
        <div className="part-form">
          <div className="part-form-head">
            <h2>{target.mode === 'new' ? (target.lockId ? `New version of ${draft.id}` : `New ${roleLabel(draft.role)} module`) : `${draft.id}@${draft.version}`}</h2>
            {locked && (
              <p className="notice">
                Used by {summary!.usedBy} saved workload{summary!.usedBy > 1 ? 's' : ''}, so this version is locked. Create a new version to
                change it.
              </p>
            )}
          </div>

          <fieldset disabled={locked}>
            {/* 1. Identity & capability */}
            <h3>1 · Identity & capability</h3>
            <div className="form-grid">
              <Field label="Catalog" hint="one catalog per vendor">
                <select value={draftCatalog} disabled={target.mode === 'existing' || target.lockId} onChange={(e) => retarget(e.target.value)}>
                  {catalogs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vendor" hint="from the catalog">
                <input value={draft.vendor} readOnly />
              </Field>
              <Field label="Primitive" hint="set when the module is created">
                <select value={draft.role} disabled>
                  <option value="">—</option>
                  {primitiveTree().map(({ category, primitives }) => (
                    <optgroup key={category.id} label={category.name}>
                      {primitives.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Module number" hint={`type id: ${draft.id}`}>
                <input value={moduleNumber(draft.id) ?? draft.id} readOnly title="Assigned automatically: the next free number for this vendor and primitive" />
              </Field>
              <Field label="Version" hint="of this catalog entry">
                <input value={draft.version} readOnly={target.mode === 'existing'} onChange={(e) => set('version', e.target.value)} />
              </Field>
              <Field label="Name">
                <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Scaling">
                <select
                  value={draft.capability.scaling}
                  onChange={(e) => set('capability', { ...draft.capability, scaling: e.target.value as 'singleton' | 'scalable' })}
                >
                  <option value="singleton">singleton</option>
                  <option value="scalable">scalable</option>
                </select>
              </Field>
              <Field label="Product">
                <input value={draft.product ?? ''} onChange={(e) => set('product', e.target.value || undefined)} />
              </Field>
              <Field label="Product version">
                <input value={draft.productVersion ?? ''} onChange={(e) => set('productVersion', e.target.value || undefined)} />
              </Field>
            </div>
            <Field label="Description">
              <textarea rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <p className="hint">
              Capability (from ports): produces {cap.produces.join(', ') || 'nothing'} · consumes {cap.consumes.join(', ') || 'nothing'}
            </p>

            {/* 2. Media ports */}
            <h3>2 · Media ports</h3>
            <PortChoices
              prim={getPrimitive(draft.role)}
              ports={draft.ports}
              onChange={(ports) => {
                // The protocol decides which core parameters apply (e.g. the SRT ingress block).
                const prim = getPrimitive(draft.role)
                setDraft((d) => ({
                  ...d,
                  ports,
                  parameters: prim ? { schema: coreSchemaFor(prim, portChoiceOf({ ports }).protocol, d.parameters.schema) } : d.parameters,
                }))
                setEditKey((k) => k + 1)
              }}
            />

            {/* 3. Core parameters */}
            <h3>3 · Core parameters (from the primitive)</h3>
            <p className="hint">
              The primitive's common vocabulary, which the configurator understands (wiring checks, flow formats, swapping vendors).
              Options may be narrowed to what this product supports; nothing may be added here, since product-specific settings go
              under Vendor settings. Mark secrets with <code>"format": "secret-ref"</code>.
            </p>
            <div className="schema-editor">
              <SchemaText
                key={`core:${editKey}`}
                value={draft.parameters.schema}
                onChange={(schema) => set('parameters', { schema })}
                onError={(msg) => setJsonError('core parameter schema', msg)}
              />
              <SchemaPreview schema={draft.parameters.schema} />
            </div>

            {/* 4. Vendor settings */}
            <h3>4 · Vendor settings ({draft.vendor || 'vendor'}'s own names)</h3>
            <p className="hint">
              The product's configuration, mirrored with the vendor's own names and structure (as in its configuration tool or API
              docs). The orchestrator passes it through unchanged. Import the vendor's JSON Schema if they publish one.
            </p>
            <span className="row-actions">
              <button className="add-row" onClick={() => vendorFile.current?.click()}>
                Import JSON Schema…
              </button>
              <input ref={vendorFile} type="file" accept=".json,application/json" hidden onChange={importVendorSchema} />
            </span>
            <div className="schema-editor">
              <SchemaText
                key={`vendor:${editKey}:${vendorImports}`}
                value={draft.vendorSettings.schema}
                onChange={(schema) => set('vendorSettings', { ...draft.vendorSettings, schema })}
                onError={(msg) => setJsonError('vendor settings schema', msg)}
              />
              <SchemaPreview schema={settingsSchema(draft)} label="Designer form, mapped keys hidden (try it; not saved)" />
            </div>
            <h4>Core → vendor mapping</h4>
            <p className="hint">
              Where each core parameter lands in the vendor's settings, with value translation if the vendor uses other values
              (e.g. <code>1920x1080=3, 3840x2160=5</code>). Mapped keys are filled from the core value, so designers set them once.
            </p>
            <TableEditor<CoreMapping>
              title="Mappings"
              rows={draft.vendorSettings.mapping}
              onChange={(mapping) => set('vendorSettings', { ...draft.vendorSettings, mapping })}
              newRow={() => ({ core: coreLeaves.find((c) => !draft.vendorSettings.mapping.some((m) => m.core === c)) ?? '', vendor: '' })}
              columns={[
                {
                  label: 'Core parameter',
                  cell: (m, up) => (
                    <select value={m.core} onChange={(e) => up({ ...m, core: e.target.value })}>
                      <option value="">—</option>
                      {coreLeaves.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  ),
                },
                {
                  label: 'Vendor setting',
                  cell: (m, up) => (
                    <select value={m.vendor} onChange={(e) => up({ ...m, vendor: e.target.value })}>
                      <option value="">—</option>
                      {leafPaths(draft.vendorSettings.schema).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ),
                },
                {
                  label: 'Value translation',
                  cell: (m, up) => (
                    <ListInput
                      value={m.values ?? {}}
                      placeholder="same values"
                      format={formatValueMap}
                      parse={parseValueMap}
                      onChange={(values) => up(cleanObject({ ...m, values: Object.keys(values).length ? values : undefined }))}
                    />
                  ),
                },
              ]}
            />

            {/* 5. Control & health */}
            <h3>5 · Control & health endpoints</h3>
            <div className="form-grid">
              <Field label="Parameter / control API">
                <select
                  value={draft.control.api?.type ?? ''}
                  onChange={(e) =>
                    setControl({ api: e.target.value ? { port: 8080, ...draft.control.api, type: e.target.value as ControlApiType } : undefined })
                  }
                >
                  <option value="">none</option>
                  <option value="rest">REST</option>
                  <option value="nmos-is12">NMOS IS-12</option>
                  <option value="grpc">gRPC</option>
                  <option value="websocket">WebSocket</option>
                </select>
              </Field>
              {draft.control.api && (
                <>
                  <Field label="API port">
                    <input type="number" min={1} value={draft.control.api.port} onChange={(e) => setControl({ api: { ...draft.control.api!, port: e.target.valueAsNumber || 0 } })} />
                  </Field>
                  <Field label="API path">
                    <input value={draft.control.api.path ?? ''} placeholder="/api/v1" onChange={(e) => setControl({ api: { ...draft.control.api!, path: e.target.value || undefined } })} />
                  </Field>
                </>
              )}
              <Field label="NMOS registration">
                <select
                  value={draft.control.nmos?.registers ?? ''}
                  onChange={(e) => setControl({ nmos: e.target.value ? { registers: e.target.value as 'node' | 'device' } : undefined })}
                >
                  <option value="">does not register</option>
                  <option value="node">as a node</option>
                  <option value="device">as a device</option>
                </select>
              </Field>
              <Field label="Health check" hint="required">
                <select
                  value={draft.control.health?.type ?? ''}
                  onChange={(e) => setControl({ health: e.target.value ? { ...draft.control.health, type: e.target.value as HealthType } : undefined })}
                >
                  <option value="">none</option>
                  <option value="http">HTTP</option>
                  <option value="tcp">TCP</option>
                  <option value="grpc">gRPC</option>
                  <option value="exec">exec</option>
                </select>
              </Field>
              {draft.control.health && draft.control.health.type !== 'exec' && (
                <Field label="Health port">
                  <input
                    type="number"
                    min={1}
                    value={draft.control.health.port ?? ''}
                    onChange={(e) => setControl({ health: { ...draft.control.health!, port: numOrUndef(e.target.valueAsNumber) } })}
                  />
                </Field>
              )}
              {draft.control.health && (draft.control.health.type === 'http' || draft.control.health.type === 'exec') && (
                <Field label={draft.control.health.type === 'exec' ? 'Command' : 'Health path'}>
                  <input
                    value={draft.control.health.path ?? ''}
                    placeholder={draft.control.health.type === 'exec' ? '/bin/healthcheck' : '/healthz'}
                    onChange={(e) => setControl({ health: { ...draft.control.health!, path: e.target.value || undefined } })}
                  />
                </Field>
              )}
            </div>

            {/* 6. Dependencies */}
            <h3>6 · Dependencies</h3>
            <p className="hint">Non-media things the function cannot start without. Bound to facility resources per instance; not media wires.</p>
            <TableEditor<Dependency>
              title="Dependencies"
              rows={draft.dependencies}
              onChange={(dependencies) => set('dependencies', dependencies)}
              newRow={() => ({ name: uniqueName(draft.dependencies.map((d) => d.name), 'dep'), kind: 'tams', required: true })}
              columns={[
                { label: 'Slot name', cell: (d, up) => <input value={d.name} onChange={(e) => up({ ...d, name: e.target.value })} /> },
                {
                  label: 'Kind',
                  cell: (d, up) => (
                    <select value={d.kind} onChange={(e) => up({ ...d, kind: e.target.value as DependencyKind })}>
                      {DEPENDENCY_KINDS.map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  ),
                },
                { label: 'Required', cell: (d, up) => <input type="checkbox" checked={d.required} onChange={(e) => up({ ...d, required: e.target.checked })} /> },
                {
                  label: 'Must be up first',
                  cell: (d, up) =>
                    d.kind === 'function' ? (
                      <select value={d.role ?? ''} onChange={(e) => up(cleanObject({ ...d, role: e.target.value || undefined }))}>
                        <option value="">— primitive —</option>
                        {primitiveTree().flatMap(({ primitives }) => primitives).map((p) => (
                          <option key={p.id} value={p.id}>
                            {roleLabel(p.id)}
                          </option>
                        ))}
                      </select>
                    ) : null,
                },
              ]}
            />

            {/* 7. Resource profile */}
            <h3>7 · Resource profile</h3>
            <p className="hint">
              What the vendor says this function needs (a requirement for the orchestrator's sizing, not an allocation). Leave empty
              if unknown.
            </p>
            <div className="form-grid">
              {(
                [
                  ['cpu', 'CPU (cores)'],
                  ['memoryMiB', 'Memory (MiB)'],
                  ['networkMbps', 'Network (Mbit/s)'],
                  ['storageGiB', 'Storage (GiB)'],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label}>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={draft.resources?.[k] ?? ''}
                    onChange={(e) => setResources({ [k]: Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber })}
                  />
                </Field>
              ))}
              <Field label="GPU class" hint="empty = none">
                <input
                  value={draft.resources?.gpu?.class ?? ''}
                  placeholder="e.g. nvidia-l4"
                  onChange={(e) => setResources({ gpu: e.target.value ? { class: e.target.value, count: draft.resources?.gpu?.count ?? 1 } : undefined })}
                />
              </Field>
              {draft.resources?.gpu && (
                <Field label="GPU count">
                  <input
                    type="number"
                    min={1}
                    value={draft.resources.gpu.count}
                    onChange={(e) => setResources({ gpu: { ...draft.resources!.gpu!, count: Math.max(1, e.target.valueAsNumber || 1) } })}
                  />
                </Field>
              )}
            </div>
          </fieldset>

          {problems.length > 0 && (
            <ul className="problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <div className="part-actions">
            {!locked && (
              <button className="primary" onClick={save} disabled={!dirty || problems.length > 0}>
                Save
              </button>
            )}
            {target.mode === 'existing' && (
              <>
                <button onClick={newVersion} disabled={dirty}>
                  New version
                </button>
                <button onClick={duplicate} disabled={dirty}>
                  Duplicate
                </button>
                {confirmDelete ? (
                  <>
                    <button className="danger" onClick={remove}>
                      Delete {draft.id}@{draft.version}
                    </button>
                    <button onClick={() => setConfirmDelete(false)}>Keep</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDelete(true)} disabled={locked}>
                    Delete
                  </button>
                )}
              </>
            )}
            {dirty && target.mode === 'existing' && (
              <button onClick={() => edit(target, structuredClone(catalog.get(target.id, target.version)!), draftCatalog)}>Revert</button>
            )}
          </div>
        </div>
      )}

      {target && (
        <aside className="part-preview">
          <h2>Preview</h2>
          <Preview prim={draft} />
          <p className="hint">How instances appear on the canvas with default parameters.</p>
        </aside>
      )}
    </div>
  )
}

// ---- Ports ----

const ESSENCE_FEED: Record<Essence, string> = { video: 'video feed (with its audio and ANC)', audio: 'audio-only feed', data: 'data feed' }

// Ports are defined by the primitive. The author only chooses the input (video or audio-only feed,
// where the primitive offers both) and the one protocol of the external side; MXL is locked.
function PortChoices({ prim, ports, onChange }: { prim: PrimitiveDef | undefined; ports: PortDef[]; onChange: (p: PortDef[]) => void }) {
  if (!prim) return <p className="hint">Unknown primitive.</p>
  const choice = portChoiceOf({ ports })
  const option = prim.ports.find((t) => t.essenceOptions?.length)
  const external = ports.filter((p) => p.transport !== 'mxl')
  const mxl = ports.filter((p) => p.transport === 'mxl')
  const mxlIn = mxl.filter((p) => p.direction === 'in')
  const mxlOut = mxl.filter((p) => p.direction === 'out')
  const flows = (list: PortDef[]) => [...new Set(list.map((p) => (p.essence === 'data' ? 'ANC' : p.essence)))].join(', ')
  return (
    <table className="edit-table ports port-choices">
      <thead>
        <tr>
          <th>Port id</th>
          <th>Protocol</th>
        </tr>
      </thead>
      <tbody>
        {mxlIn.length > 0 && (
          <tr>
            <td>{mxlIn.map((p) => p.id).join(', ')}</td>
            <td>
              <span className="locked">MXL</span> <span className="hint">{flows(mxlIn)} flows (locked)</span>
            </td>
          </tr>
        )}
        {external.length > 0 && (
          <tr>
            <td>
              {option ? (
                <select
                  value={choice.essence}
                  onChange={(e) => onChange(portsFor(prim, { ...choice, essence: e.target.value as Essence }))}
                  title={option.essenceOptions!.map((x) => `${option.id}.${x}: ${ESSENCE_FEED[x]}`).join('\n')}
                >
                  {option.essenceOptions!.map((x) => (
                    <option key={x} value={x}>
                      {option.id}.{x}
                    </option>
                  ))}
                </select>
              ) : (
                external.map((p) => p.id).join(', ')
              )}
              <div className="hint">
                {option && choice.essence && ESSENCE_FEED[choice.essence]}
                {external.length > 1 && (
                  <>
                    {option ? ' · ' : ''}
                    {external.length} inputs: {external.map((p) => p.id).join(' + ')} (both legs required)
                  </>
                )}
              </div>
            </td>
            <td>
              <select value={choice.protocol} onChange={(e) => onChange(portsFor(prim, { ...choice, protocol: e.target.value as ExternalTransport }))}>
                {protocolsFor(prim).map((t) => (
                  <option key={t} value={t}>
                    {TRANSPORT_LABELS[t]}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        )}
        {mxlOut.length > 0 && (
          <tr>
            <td>{mxlOut.map((p) => p.id).join(', ')}</td>
            <td>
              <span className="locked">MXL</span> <span className="hint">{flows(mxlOut)} flows (locked)</span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

// ---- JSON Schema editing ----

// JSON text for a schema. Reports parse errors instead of changing the draft, and resyncs when the
// schema changes from outside (e.g. an import) while the text is valid.
function SchemaText({ value, onChange, onError }: { value: JsonSchema; onChange: (s: JsonSchema) => void; onError: (msg: string | null) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined && JSON.stringify(parsed) !== JSON.stringify(value)) setText(JSON.stringify(value, null, 2))
  return (
    <textarea
      className="json"
      rows={Math.min(24, Math.max(6, text.split('\n').length))}
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value)
        try {
          onChange(JSON.parse(e.target.value))
          onError(null)
        } catch (err) {
          onError((err as Error).message)
        }
      }}
    />
  )
}

// A working copy of the form designers will get, to try it out (values aren't saved anywhere).
// It restarts from the defaults whenever the schema changes.
function SchemaPreview({ schema, label = 'Designer form preview (try it; not saved)' }: { schema: JsonSchema; label?: string }) {
  const ok = checkParameterSchema(schema).length === 0
  return (
    <div className="schema-preview">
      <span className="hint">{label}</span>
      {ok && <PreviewForm key={JSON.stringify(schema)} schema={schema} />}
    </div>
  )
}

function PreviewForm({ schema }: { schema: JsonSchema }) {
  const [value, setValue] = useState(() => (defaultsFor(schema) as { [k: string]: JsonValue }) ?? {})
  return <SchemaForm schema={schema} value={value} onChange={setValue} />
}

// "1920x1080=3, 3840x2160=5" <-> { "1920x1080": 3, "3840x2160": 5 } (values parsed as JSON when possible).
function formatValueMap(v: Record<string, JsonValue>): string {
  return Object.entries(v)
    .map(([k, x]) => `${k}=${typeof x === 'string' ? x : JSON.stringify(x)}`)
    .join(', ')
}

function parseValueMap(t: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const pair of splitList(t)) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const raw = pair.slice(i + 1).trim()
    let v: JsonValue = raw
    try {
      v = JSON.parse(raw)
    } catch {
      // plain text value
    }
    out[pair.slice(0, i).trim()] = v
  }
  return out
}

// ---- Generic small editors ----

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

type Column<T> = { label: string; cell: (row: T, update: (row: T) => void) => React.ReactNode }

function TableEditor<T>({ title, rows, columns, newRow, onChange }: { title: string; rows: T[]; columns: Column<T>[]; newRow: () => T; onChange: (rows: T[]) => void }) {
  return (
    <>
      {rows.length > 0 && (
        <table className="edit-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.label}>{c.cell(r, (nr) => onChange(rows.map((x, j) => (j === i ? nr : x))))}</td>
                ))}
                <td>
                  <RowButtons index={i} items={rows} onChange={onChange} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="add-row" onClick={() => onChange([...rows, newRow()])}>
        Add {title.toLowerCase().replace(/s$/, '')}
      </button>
    </>
  )
}

// Text input for a list value; keeps the raw text while typing and resyncs when the value
// changes from outside.
function ListInput<T>({ value, format, parse, onChange, placeholder }: { value: T; format: (v: T) => string; parse: (t: string) => T; onChange: (v: T) => void; placeholder?: string }) {
  const [text, setText] = useState(format(value))
  if (format(parse(text)) !== format(value)) setText(format(value))
  return (
    <input
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parse(e.target.value))
      }}
    />
  )
}

function RowButtons<T>({ index, items, onChange }: { index: number; items: T[]; onChange: (items: T[]) => void }) {
  const move = (to: number) => {
    const next = [...items]
    const [item] = next.splice(index, 1)
    next.splice(to, 0, item)
    onChange(next)
  }
  return (
    <span className="row-buttons">
      <button title="Move up" disabled={index === 0} onClick={() => move(index - 1)}>
        ↑
      </button>
      <button title="Move down" disabled={index === items.length - 1} onClick={() => move(index + 1)}>
        ↓
      </button>
      <button title="Remove" onClick={() => onChange(items.filter((_, j) => j !== index))}>
        ×
      </button>
    </span>
  )
}

// ---- Preview ----

type PreviewNode = Node<{ prim: VendorModule }, 'preview'>

function PreviewNodeView({ id, data }: NodeProps<PreviewNode>) {
  return <ModulePreview id={id} prim={data.prim} />
}

const previewTypes = { preview: PreviewNodeView }

function Preview({ prim }: { prim: VendorModule }) {
  const nodes: PreviewNode[] = [{ id: 'preview', type: 'preview', position: { x: 0, y: 0 }, data: { prim }, draggable: false, selectable: false }]
  const shape = `${prim.ports.length}|${JSON.stringify(defaultsFor(prim.parameters.schema))}`
  return (
    <div className="preview-canvas">
      <ReactFlowProvider>
        <ReactFlow
          key={shape}
          nodes={nodes}
          edges={[]}
          nodeTypes={previewTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          nodesConnectable={false}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  )
}

// ---- Helpers ----

function bumpVersion(v: string): string {
  const parts = v.split('.')
  const last = Number(parts.at(-1))
  if (Number.isInteger(last)) return [...parts.slice(0, -1), String(last + 1)].join('.')
  return `${v}.1`
}

function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base}${n}`)) n++
  return `${base}${n}`
}

// Drop keys whose value is undefined so documents stay minimal and comparisons stable.
function cleanObject<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function splitList(t: string): string[] {
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function numOrUndef(n: number): number | undefined {
  return Number.isNaN(n) ? undefined : n
}

