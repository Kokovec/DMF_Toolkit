import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react'
import { api, describeError, refreshCatalog, useCatalog, type CatalogSummary, type PartSummary } from '../api'
import { Catalog, checkModule, deriveCapability, resolvePorts } from '../model/catalog'
import { defaultsFor } from '../model/schema'
import type { JsonValue, ModuleDesign, VendorModule } from '../model/types'
import { blankModule, moduleNumber, nextModuleId, vendorSlug, withDerived } from '../model/modules'
import { getCategory, LIBRARY } from '../model/library'
import { ModulePreview } from './MediaNode'
import { ModuleDesigner } from './ModuleDesigner'

type Props = { onMessage: (msg: string, isError: boolean) => void }

// What the form is editing: an existing module version, or a new one (new, new version, duplicate).
type Target = { mode: 'existing'; id: string; version: string } | { mode: 'new'; lockId: boolean }

const BLANK: VendorModule = blankModule({ id: '', vendor: '' }, new Catalog([]))

const categoryNames = (ids: string) =>
  ids
    .split(',')
    .filter(Boolean)
    .map((c) => getCategory(c)?.name ?? c)
    .join(', ')

export function PartsEditor({ onMessage }: Props) {
  const catalog = useCatalog()
  const [parts, setParts] = useState<PartSummary[]>([])
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([])
  const [filter, setFilter] = useState('')
  const [target, setTarget] = useState<Target | null>(null)
  const [draft, setDraft] = useState<VendorModule>(BLANK)
  const [draftCatalog, setDraftCatalog] = useState('')
  const [baseline, setBaseline] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newCatalog, setNewCatalog] = useState<{ vendor: string; name: string } | null>(null)

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
    if (!draftCatalog) errors.push('choose a catalog')
    if (target?.mode === 'new' && catalog.get(draft.id, draft.version)) errors.push(`${draft.id}@${draft.version} already exists`)
    return errors
  }, [draft, draftCatalog, target, catalog])

  const edit = (next: Target, prim: VendorModule, catalogId: string) => {
    if (dirty && target && !confirm('Discard unsaved changes to this module?')) return
    setTarget(next)
    setDraft(prim)
    setDraftCatalog(catalogId)
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

  // A duplicate is a new module with the same design: next module number, version restarts.
  const duplicate = () => {
    const id = nextModuleId(catalog, draftCatalog)
    edit({ mode: 'new', lockId: false }, { ...structuredClone(draft), id, version: '1.0.0', name: `${draft.name} (copy)` }, draftCatalog)
  }

  // A new module starts blank: the designer adds its features. It gets the catalog's vendor and
  // the next free module number.
  const startModule = () => {
    const cat = catalogs[0]
    if (cat) edit({ mode: 'new', lockId: false }, blankModule(cat, catalog), cat.id)
  }

  // Every design change recomputes the derived ports and core parameter schema.
  const setDesign = (design: ModuleDesign) => setDraft((d) => withDerived({ ...d, design }))
  const toggleCategory = (id: string, on: boolean) =>
    set('categories', LIBRARY.spec.categories.map((c) => c.id).filter((c) => (c === id ? on : draft.categories.includes(c))))

  // Moving a new draft to another catalog changes its vendor and module number.
  const retarget = (catalogId: string) => {
    const cat = catalogs.find((c) => c.id === catalogId)
    if (!cat) return
    setDraftCatalog(catalogId)
    setDraft((d) => ({ ...d, vendor: cat.vendor, id: nextModuleId(catalog, catalogId) }))
  }

  const save = async () => {
    const prim: VendorModule = withDerived(draft)
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

  const set = <K extends keyof VendorModule>(key: K, value: VendorModule[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const q = filter.toLowerCase()
  const shown = parts.filter((p) => !q || `${p.name} ${p.id} ${categoryNames(p.categories)} ${p.vendor ?? ''}`.toLowerCase().includes(q))
  const cap = deriveCapability(draft)
  // The node preview uses default parameters; instance settings (e.g. SRT bonding) belong to the workload.
  const defaults = useMemo(() => (defaultsFor(draft.parameters.schema) as { [k: string]: JsonValue }) ?? {}, [draft.parameters.schema])

  return (
    <div className="parts-editor">
      <aside className="parts-list">
        <div className="parts-list-actions">
          <button onClick={startModule} disabled={!catalogs.length} title={catalogs.length ? '' : 'Create a catalog first'}>
            New module
          </button>
          <button onClick={() => setNewCatalog({ vendor: '', name: '' })}>New catalog</button>
        </div>
        {newCatalog && (
          <div className="new-catalog">
            <input placeholder="Vendor name (required), e.g. Acme Media" value={newCatalog.vendor} onChange={(e) => setNewCatalog({ ...newCatalog, vendor: e.target.value })} />
            <input placeholder="Catalog name (optional)" value={newCatalog.name} onChange={(e) => setNewCatalog({ ...newCatalog, name: e.target.value })} />
            {vendorSlug(newCatalog.vendor) && (
              <span className="hint">
                Catalog id <code>{vendorSlug(newCatalog.vendor)}</code>; module ids like <code>{vendorSlug(newCatalog.vendor)}.1</code>
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
        <input className="parts-filter" placeholder="Filter by name, id, category, vendor…" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
                      {categoryNames(p.categories) || 'uncategorised'} · {p.id}@{p.version}
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
            Select a vendor module to edit it, or create one with <strong>New module</strong>. A module starts blank: drag
            features (inputs, decoders, codecs, MXL outputs…) onto it and link them into signal chains. Its ports and core
            parameters follow from the design; you add the vendor's identity and categories. Vendor settings, control & health, dependencies and resources are set per function in the workload designer.
          </p>
        </div>
      ) : (
        <div className="part-form">
          <div className="part-form-head">
            <h2>{target.mode === 'new' ? (target.lockId ? `New version of ${draft.id}` : 'New module') : `${draft.id}@${draft.version}`}</h2>
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
              <Field label="Module number" hint={`type id: ${draft.id}`}>
                <input value={moduleNumber(draft.id) ?? draft.id} readOnly title="Assigned automatically: the next free number in this catalog" />
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
            <div className="field">
              <span>Categories</span>
              <span className="row-actions">
                {LIBRARY.spec.categories.map((c) => (
                  <label key={c.id} className="check" title={c.description}>
                    <input type="checkbox" checked={draft.categories.includes(c.id)} onChange={(e) => toggleCategory(c.id, e.target.checked)} /> {c.name}
                  </label>
                ))}
              </span>
              <span className="hint">where the module appears in the palette (one or more)</span>
            </div>
            <p className="hint">
              Capability (from ports): produces {cap.produces.join(', ') || 'nothing'} · consumes {cap.consumes.join(', ') || 'nothing'}
            </p>

            {/* 2. Design */}
            <h3>2 · Design</h3>
            <p className="hint">
              Drag features from the left onto the module and link them into signal chains (e.g. SRT input → Decoder → MXL output).
              A multi-function product gets several chains. The module's ports and core parameters follow from the design.
            </p>
            <ModuleDesigner
              design={draft.design}
              onChange={setDesign}
              locked={locked}
            />
            <p className="hint">
              Ports: {draft.ports.map((p) => p.id).join(', ') || 'none yet'}
            </p>

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
          <Preview prim={draft} params={defaults} />
          <p className="hint">
            How instances appear on the canvas with default parameters.
            {draft.ports.some((p) => p.dualWhen) && ' A second input appears when bonding is turned on for an instance in the workload.'}
          </p>
        </aside>
      )}
    </div>
  )
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

// ---- Preview ----

type PreviewNode = Node<{ prim: VendorModule; params: { [k: string]: JsonValue } }, 'preview'>

function PreviewNodeView({ id, data }: NodeProps<PreviewNode>) {
  return <ModulePreview id={id} prim={data.prim} params={data.params} />
}

const previewTypes = { preview: PreviewNodeView }

// The node as designers will see it, with default parameters.
function Preview({ prim, params }: { prim: VendorModule; params: { [k: string]: JsonValue } }) {
  const nodes: PreviewNode[] = [{ id: 'preview', type: 'preview', position: { x: 0, y: 0 }, data: { prim, params }, draggable: false, selectable: false }]
  const shape = resolvePorts(prim.ports, params)
    .map((p) => p.key)
    .join(',')
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
