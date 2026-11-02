// Configuring one function instance: a pop-up with a tab per feature of its product (opened by
// double-clicking the node). General turns optional functions on and off. Inputs and Outputs tabs
// set how many of each the instance runs and configure each copy; every configurable feature that's
// on has its own tab; Setup and Intent hold the instance's deployment setup and the operator's expectations.
import { useEffect, useMemo, useState } from 'react'
import { addonKey, copyId, featuresOf, inputBlocks, inputCopies, inputsOf, inputSelectionProblems, outputBlocks, outputsOf, outputSelectionProblems } from '../model/compose'
import { getFeature } from '../model/library'
import type { Expectations, FeatureSelection, JsonSchema, JsonValue, ModuleBlock, PlacementConstraints, VendorModule } from '../model/types'
import { discoveryOf, schemaOf, withSelection, type FnData } from '../model/workload'
import { FunctionSetup } from './FunctionSetup'
import { SchemaForm, type SchemaChoices } from './SchemaForm'

type Obj = { [k: string]: JsonValue }

type Props = {
  id: string
  data: FnData
  prim: VendorModule
  others: string[] // other function instance ids (placement affinity)
  problems: string[] // publish problems of the whole workload; this function's are shown per tab
  onChange: (data: FnData) => void
  onClose: () => void
}

type Tab =
  | { key: string; label: string; kind: 'general' | 'inputs' | 'outputs' | 'setup' | 'intent' }
  | { key: string; label: string; kind: 'block'; group: string } // a feature: its parameter group(s)

const AUDIENCE: Record<string, string> = {
  function: 'injected into the media function',
  orchestrator: 'for the orchestrator',
  both: 'media function + orchestrator',
}

export function FunctionDialog({ id, data, prim, others, problems, onChange, onClose }: Props) {
  const schema = schemaOf(prim, data)
  const params = data.parameters
  const update = (patch: Partial<FnData>) => onChange({ ...data, ...patch })
  const setGroup = (group: string, v: Obj) => update({ parameters: { ...params, [group]: v } })
  // Fields whose choices come from the instance, e.g. which input is on air at start.
  const choices: SchemaChoices = { inputs: inputCopies(prim, data).map((c) => ({ value: c.id, label: c.name })) }

  // One tab per feature with settings, in the product's order; inputs and outputs get one tab each.
  const tabs = useMemo((): Tab[] => {
    const io = new Set([...inputBlocks(prim.design), ...outputBlocks(prim.design)].map((b) => b.id))
    const t: Tab[] = [{ key: 'general', label: 'General', kind: 'general' }]
    if (inputBlocks(prim.design).length) t.push({ key: 'inputs', label: 'Inputs', kind: 'inputs' })
    for (const b of prim.design.blocks)
      if (!io.has(b.id) && schema.properties?.[b.id]) t.push({ key: b.id, label: getFeature(b.feature)?.name ?? b.id, kind: 'block', group: b.id })
    for (const m of prim.design.moduleFeatures) {
      const f = getFeature(m)
      if (f?.key && schema.properties?.[f.key]) t.push({ key: f.key, label: f.name, kind: 'block', group: f.key })
    }
    if (outputBlocks(prim.design).length) t.push({ key: 'outputs', label: 'Outputs', kind: 'outputs' })
    t.push({ key: 'setup', label: 'Setup', kind: 'setup' }, { key: 'intent', label: 'Intent', kind: 'intent' })
    return t
  }, [prim, schema])

  const [tab, setTab] = useState('general')
  const current = tabs.find((t) => t.key === tab) ?? tabs[0]

  // This function's problems, and which tab each belongs to (by the parameter path it names).
  // (wiring problems, "input … must be connected", belong to the canvas, not to this dialog)
  const mine = problems
    .filter((p) => p.startsWith(`${id}: `))
    .map((p) => p.slice(id.length + 2))
    .filter((p) => !p.endsWith('must be connected'))
  const tabOf = (p: string): string => {
    if (p.startsWith('inputs:')) return 'inputs'
    if (p.startsWith('outputs:')) return 'outputs'
    if (p.startsWith('features:')) return 'general'
    const head = p.split(/[.:\s]/)[0]
    const block = head.replace(/_\d+$/, '')
    if (inputBlocks(prim.design).some((b) => b.id === block)) return 'inputs'
    if (outputBlocks(prim.design).some((b) => b.id === block)) return 'outputs'
    if (tabs.some((t) => t.key === head)) return head
    if (p.startsWith('placement')) return 'intent'
    if (/health|dependency|control|resources|settings/.test(p)) return 'setup'
    return 'general'
  }
  const flagged = new Set(mine.map(tabOf))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal function-dialog" role="dialog" aria-label={`Configure ${data.name}`}>
        <header className="modal-head">
          <div>
            <h2>{data.name}</h2>
            <span className="hint">
              {prim.name} · {prim.vendor} · {prim.id}@{prim.version} · {id}
            </span>
          </div>
          <button onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </header>
        <nav className="dialog-tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`${t.key === current.key ? 'active' : ''}${flagged.has(t.key) ? ' flagged' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="dialog-body">
          {current.kind === 'general' && (
            <>
              <General id={id} data={data} update={update} />
              <Features prim={prim} data={data} onChange={(features) => onChange(withSelection(data, prim, { features }))} />
            </>
          )}
          {current.kind === 'inputs' && (
            <Copies
              which="inputs"
              blocks={inputBlocks(prim.design)}
              counts={inputsOf(prim, data.inputs)}
              rule={prim.design.inputRule ?? 'several'}
              problems={inputSelectionProblems(prim, data.inputs)}
              onCounts={(inputs) => onChange(withSelection(data, prim, { inputs }))}
              schema={schema}
              params={params}
              onGroup={setGroup}
            />
          )}
          {current.kind === 'outputs' && (
            <Copies
              which="outputs"
              blocks={outputBlocks(prim.design)}
              counts={outputsOf(prim, data.outputs)}
              problems={outputSelectionProblems(prim, data.outputs)}
              onCounts={(outputs) => onChange(withSelection(data, prim, { outputs }))}
              schema={schema}
              params={params}
              onGroup={setGroup}
            />
          )}
          {current.kind === 'block' && (
            <GroupTabs key={current.group} schema={schema.properties![current.group]} value={(params[current.group] as Obj) ?? {}} root={params} choices={choices} onChange={(v) => setGroup(current.group, v)} />
          )}
          {current.kind === 'setup' && <FunctionSetup key={id} data={data} vendor={prim.vendor} update={update} />}
          {current.kind === 'intent' && <Intent data={data} prim={prim} others={others} update={update} />}
        </div>
        {mine.length > 0 && (
          <ul className="problems compact dialog-problems">
            {mine.map((p) => (
              <li key={p}>
                <button className="link" onClick={() => setTab(tabOf(p))}>
                  {p}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---- General ----

function General({ id, data, update }: { id: string; data: FnData; update: (p: Partial<FnData>) => void }) {
  return (
    <div className="dialog-form">
      <label className="field">
        <span>Instance ID</span>
        <input value={id} readOnly />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={data.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>MXL domain</span>
        <input value={data.domain} placeholder="main" onChange={(e) => update({ domain: e.target.value })} />
        <span className="hint">Logical isolation group for this function's flows; the orchestrator creates and places it.</span>
      </label>
    </div>
  )
}

// ---- Optional functions: on or off. An add-on is offered only while its function is on. ----

function Features({ prim, data, onChange }: { prim: VendorModule; data: FnData; onChange: (features: FeatureSelection) => void }) {
  const blocks = prim.design.blocks.filter((b) => b.optional)
  if (!blocks.length) return null
  const on = featuresOf(prim, data.features)
  const set = (key: string, v: boolean) => onChange({ ...data.features, [key]: v })
  const name = (feature: string) => getFeature(feature)?.name ?? feature
  return (
    <div className="dialog-form features">
      <h3>Features</h3>
      <p className="hint">What this instance runs. A feature that's off has no tab and isn't published.</p>
      {blocks.map((b) => (
        <div key={b.id}>
          <label className="field field-check" title={getFeature(b.feature)?.description}>
            <input type="checkbox" checked={on[b.id]} onChange={(e) => set(b.id, e.target.checked)} />
            <span>{name(b.feature)}</span>
          </label>
          {on[b.id] &&
            b.addons
              .filter((a) => addonKey(a) in (b.optional?.addons ?? {}))
              .map((a) => {
                const key = `${b.id}.${addonKey(a)}`
                return (
                  <label key={key} className="field field-check feature-addon" title={getFeature(a)?.description}>
                    <input type="checkbox" checked={on[key]} onChange={(e) => set(key, e.target.checked)} />
                    <span>{name(a)}</span>
                  </label>
                )
              })}
        </div>
      ))}
    </div>
  )
}

// ---- A feature's settings: one sub-tab per parameter group when it has several ----

type GroupTabsProps = { schema: JsonSchema; value: Obj; root: Obj; choices?: SchemaChoices; onChange: (v: Obj) => void }

function GroupTabs({ schema, value, root, choices, onChange }: GroupTabsProps) {
  const groups = Object.entries(schema.properties ?? {}).filter(([, s]) => s.type === 'object' && s.properties)
  const [sub, setSub] = useState(groups[0]?.[0])
  // a single group (or loose fields): show it directly
  if (groups.length < 2 || groups.length !== Object.keys(schema.properties ?? {}).length)
    return (
      <div className="dialog-form">
        <SchemaForm schema={groups.length === 1 ? groups[0][1] : schema} value={groups.length === 1 ? ((value[groups[0][0]] as Obj) ?? {}) : value} root={root} choices={choices} onChange={(v) => onChange(groups.length === 1 ? { ...value, [groups[0][0]]: v } : v)} />
      </div>
    )
  const active = groups.find(([k]) => k === sub) ?? groups[0]
  const audience = active[1]['x-audience']
  return (
    <>
      <nav className="dialog-subtabs">
        {groups.map(([k, s]) => (
          <button key={k} className={k === active[0] ? 'active' : ''} onClick={() => setSub(k)}>
            {s.title ?? k}
          </button>
        ))}
      </nav>
      <div className="dialog-form">
        {active[1].description && <p className="hint">{active[1].description}</p>}
        {audience && <p className={`audience ${audience}`}>{AUDIENCE[audience]}</p>}
        <SchemaForm key={active[0]} schema={active[1]} value={(value[active[0]] as Obj) ?? {}} root={root} choices={choices} onChange={(v) => onChange({ ...value, [active[0]]: v })} />
      </div>
    </>
  )
}

// ---- Inputs / Outputs: how many of each, then each copy's settings ----

type CopiesProps = {
  which: 'inputs' | 'outputs'
  blocks: ModuleBlock[]
  counts: Record<string, number>
  rule?: 'one' | 'several'
  problems: string[]
  onCounts: (c: Record<string, number>) => void
  schema: JsonSchema
  params: Obj
  onGroup: (group: string, v: Obj) => void
}

function Copies({ which, blocks, counts, rule, problems, onCounts, schema, params, onGroup }: CopiesProps) {
  const one = which === 'inputs' && rule === 'one'
  // every copy that has settings, e.g. "SRT source 1", "SRT source 2"
  const copies = blocks.flatMap((b) =>
    Array.from({ length: counts[b.id] ?? 0 }, (_, i) => {
      const id = copyId(b.id, i + 1)
      const label = ((params[id] as Obj)?.source as Obj)?.label
      return { id, name: `${getFeature(b.feature)?.name ?? b.id} ${i + 1}`, label: typeof label === 'string' && label ? label : undefined }
    }),
  ).filter((c) => schema.properties?.[c.id])
  const [selected, setSelected] = useState<string | undefined>(copies[0]?.id)
  const current = copies.find((c) => c.id === selected) ?? copies[0]
  const set = (id: string, n: number) => onCounts({ ...counts, [id]: n })
  const pick = (id: string) => onCounts(Object.fromEntries(blocks.map((b) => [b.id, b.id === id ? Math.max(1, counts[id] ?? 0) : 0])))

  return (
    <div className="copies">
      <table className="edit-table counts">
        <thead>
          <tr>
            <th>{which === 'inputs' ? 'Input type' : 'Output'}</th>
            <th>Used</th>
            <th>How many</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => {
            const n = counts[b.id] ?? 0
            const max = b.scaleOut ?? 1
            return (
              <tr key={b.id}>
                <td title={getFeature(b.feature)?.description}>{getFeature(b.feature)?.name ?? b.id}</td>
                <td>
                  <input
                    type={one ? 'radio' : 'checkbox'}
                    name={`${which}-used`}
                    checked={n > 0}
                    onChange={(e) => (one ? pick(b.id) : set(b.id, e.target.checked ? Math.max(1, n) : 0))}
                  />
                </td>
                <td>
                  {max > 1 ? (
                    <>
                      <input type="number" min={0} max={max} value={n} onChange={(e) => set(b.id, Math.min(max, Math.max(one ? 1 : 0, Math.floor(e.target.valueAsNumber) || 0)))} />{' '}
                      <span className="hint">of {max}</span>
                    </>
                  ) : (
                    <span className="hint">{n}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="hint">
        {which === 'inputs'
          ? one
            ? 'This product uses exactly one of its inputs per instance.'
            : 'This product can use several inputs at once, of different types and several of each.'
          : 'Turn outputs off, or run several of one (e.g. several destinations).'}
      </p>
      {problems.length > 0 && <p className="error-text">{problems.join('; ')}</p>}
      {copies.length > 0 && current && (
        <div className="copy-editor">
          <nav className="copy-list">
            {copies.map((c) => (
              <button key={c.id} className={c.id === current.id ? 'active' : ''} onClick={() => setSelected(c.id)}>
                {c.name}
                {c.label && <span className="hint"> · {c.label}</span>}
              </button>
            ))}
          </nav>
          <div className="copy-form">
            <GroupTabs key={current.id} schema={schema.properties![current.id]} value={(params[current.id] as Obj) ?? {}} root={params} onChange={(v) => onGroup(current.id, v)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Desired-state metadata for one function: expectations, placement constraints, discovery ----

function Intent({ data, prim, others, update }: { data: FnData; prim: VendorModule; others: string[]; update: (p: Partial<FnData>) => void }) {
  const ex = data.expectations ?? {}
  const pl = data.placement ?? {}
  const disc = discoveryOf(prim, data)
  const setEx = (patch: Partial<Expectations>) => update({ expectations: clean({ ...ex, ...patch }) })
  const setPl = (patch: Partial<PlacementConstraints>) => update({ placement: clean({ ...pl, ...patch }) })
  const ids = (v: string) => {
    const list = v.split(',').map((x) => x.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  return (
    <>
      <h3>Expectations</h3>
      <div className="field-row">
        <label className="field">
          <span>Resilience</span>
          <select value={ex.resilience ?? 'none'} onChange={(e) => setEx({ resilience: e.target.value === 'none' ? undefined : (e.target.value as Expectations['resilience']) })}>
            <option value="none">none</option>
            <option value="1+1">1+1</option>
            <option value="n+1">N+1</option>
          </select>
        </label>
        <label className="field">
          <span>Scaling</span>
          <select
            value={ex.scaling ?? 'fixed'}
            disabled={prim.capability.scaling === 'singleton'}
            onChange={(e) => setEx({ scaling: e.target.value === 'fixed' ? undefined : 'elastic' })}
          >
            <option value="fixed">fixed</option>
            <option value="elastic">elastic</option>
          </select>
        </label>
      </div>

      <h3>Placement constraints</h3>
      <div className="field-row">
        <label className="field">
          <span>Site</span>
          <input value={pl.site ?? ''} placeholder="any" onChange={(e) => setPl({ site: e.target.value || undefined })} />
        </label>
        <label className="field">
          <span>Cluster</span>
          <input value={pl.cluster ?? ''} placeholder="any" onChange={(e) => setPl({ cluster: e.target.value || undefined })} />
        </label>
      </div>
      <label className="field">
        <span>Environment</span>
        <select value={pl.environment ?? 'any'} onChange={(e) => setPl({ environment: e.target.value === 'any' ? undefined : (e.target.value as PlacementConstraints['environment']) })}>
          <option value="any">any</option>
          <option value="on-prem">on-prem</option>
          <option value="cloud">cloud</option>
        </select>
      </label>
      <label className="field">
        <span>Run with (affinity)</span>
        <input list="instance-ids" value={(pl.with ?? []).join(', ')} placeholder="instance ids" onChange={(e) => setPl({ with: ids(e.target.value) })} />
      </label>
      <label className="field">
        <span>Keep apart from</span>
        <input list="instance-ids" value={(pl.apart ?? []).join(', ')} placeholder="instance ids" onChange={(e) => setPl({ apart: ids(e.target.value) })} />
      </label>
      <datalist id="instance-ids">
        {others.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <label className="field">
        <span>Licensing constraint</span>
        <input value={pl.licensing ?? ''} placeholder="e.g. site licence pool A" onChange={(e) => setPl({ licensing: e.target.value || undefined })} />
      </label>

      <h3>Discovery</h3>
      <label className="field field-check">
        <input type="checkbox" checked={disc.register} onChange={(e) => update({ discovery: { ...disc, register: e.target.checked } })} />
        <span>Register for discovery (NMOS)</span>
      </label>
      <label className="field">
        <span>Labels / tags</span>
        <input
          value={(disc.labels ?? []).join(', ')}
          placeholder="e.g. studio-a, news"
          onChange={(e) => update({ discovery: clean({ ...disc, labels: ids(e.target.value) }) as FnData['discovery'] })}
        />
      </label>
    </>
  )
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
