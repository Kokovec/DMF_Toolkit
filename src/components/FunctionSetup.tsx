// A function instance's own setup, set in the workload designer: the vendor's configuration
// (free-form JSON, passed through unchanged), control & health endpoints, dependencies and the
// resource profile. Modules only define identity and design.
import { useRef, useState } from 'react'
import { useFacility } from '../api'
import { unavailable } from '../model/facility'
import { LIBRARY } from '../model/library'
import {
  DEPENDENCY_KINDS,
  type ControlApiType,
  type ControlSpec,
  type Dependency,
  type DependencyKind,
  type HealthType,
  type JsonValue,
  type ResourceProfile,
  type VendorModule,
} from '../model/types'
import type { FnData } from '../model/workload'

type Props = { data: FnData; vendor: string; notes?: NonNullable<VendorModule['defaults']>['notes']; update: (patch: Partial<FnData>) => void }
type Obj = { [k: string]: JsonValue }

export function FunctionSetup({ data, vendor, notes, update }: Props) {
  return (
    <>
      <VendorSettings key={data.type} value={data.settings ?? {}} vendor={vendor} onChange={(settings) => update({ settings })} />
      <Control value={data.control ?? {}} onChange={(control) => update({ control: clean(control) })} />
      <Dependencies rows={data.dependencies ?? []} onChange={(dependencies) => update({ dependencies: dependencies.length ? dependencies : undefined })} />
      <Resources value={data.resources ?? {}} note={notes?.resources} onChange={(r) => update({ resources: Object.keys(r).length ? r : undefined })} />
    </>
  )
}

// ---- Vendor settings: the product's own configuration, as JSON ----

function VendorSettings({ value, vendor, onChange }: { value: Obj; vendor: string; onChange: (v: Obj) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const apply = (t: string) => {
    setText(t)
    try {
      const v = t.trim() ? JSON.parse(t) : {}
      if (!v || typeof v !== 'object' || Array.isArray(v)) return setError('must be a JSON object')
      setError(null)
      onChange(v)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const load = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) apply(await f.text())
  }
  return (
    <>
      <h3>{vendor} settings</h3>
      <p className="hint">
        The product's own configuration in {vendor}'s names and structure (as in its configuration tool or API). The orchestrator
        passes it through unchanged.
      </p>
      <textarea className="json" rows={Math.min(16, Math.max(4, text.split('\n').length))} spellCheck={false} value={text} onChange={(e) => apply(e.target.value)} />
      {error && <p className="error-text">Not applied: {error}</p>}
      <span className="row-actions">
        <button className="add-row" onClick={() => file.current?.click()}>
          Load from file…
        </button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={load} />
      </span>
    </>
  )
}

// ---- Control & health ----

function Control({ value: c, onChange }: { value: ControlSpec; onChange: (c: ControlSpec) => void }) {
  const set = (patch: Partial<ControlSpec>) => onChange({ ...c, ...patch })
  const h = c.health
  return (
    <>
      <h3>Control & health</h3>
      <div className="field-row">
        <label className="field">
          <span>Control API</span>
          <select value={c.api?.type ?? ''} onChange={(e) => set({ api: e.target.value ? { port: 8080, ...c.api, type: e.target.value as ControlApiType } : undefined })}>
            <option value="">none</option>
            <option value="rest">REST</option>
            <option value="nmos-is12">NMOS IS-12</option>
            <option value="grpc">gRPC</option>
            <option value="websocket">WebSocket</option>
          </select>
        </label>
        <label className="field">
          <span>NMOS registration</span>
          <select value={c.nmos?.registers ?? ''} onChange={(e) => set({ nmos: e.target.value ? { registers: e.target.value as 'node' | 'device' } : undefined })}>
            <option value="">does not register</option>
            <option value="node">as a node</option>
            <option value="device">as a device</option>
          </select>
        </label>
      </div>
      {c.api && (
        <div className="field-row">
          <label className="field">
            <span>API port</span>
            <input type="number" min={1} value={c.api.port} onChange={(e) => set({ api: { ...c.api!, port: e.target.valueAsNumber || 0 } })} />
          </label>
          <label className="field">
            <span>API path</span>
            <input value={c.api.path ?? ''} placeholder="/api/v1" onChange={(e) => set({ api: { ...c.api!, path: e.target.value || undefined } })} />
          </label>
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>
            Health check<span className="required">*</span>
          </span>
          <select value={h?.type ?? ''} onChange={(e) => set({ health: e.target.value ? { ...h, type: e.target.value as HealthType } : undefined })}>
            <option value="">none</option>
            <option value="http">HTTP</option>
            <option value="tcp">TCP</option>
            <option value="grpc">gRPC</option>
            <option value="exec">exec</option>
          </select>
        </label>
        {h && h.type !== 'exec' && (
          <label className="field">
            <span>Health port</span>
            <input type="number" min={1} value={h.port ?? ''} onChange={(e) => set({ health: { ...h, port: num(e.target.valueAsNumber) } })} />
          </label>
        )}
      </div>
      {h && (h.type === 'http' || h.type === 'exec') && (
        <label className="field">
          <span>{h.type === 'exec' ? 'Command' : 'Health path'}</span>
          <input
            value={h.path ?? ''}
            placeholder={h.type === 'exec' ? '/bin/healthcheck' : '/healthz'}
            onChange={(e) => set({ health: { ...h, path: e.target.value || undefined } })}
          />
        </label>
      )}
    </>
  )
}

// ---- Dependencies, each bound to a facility resource ----

function Dependencies({ rows, onChange }: { rows: Dependency[]; onChange: (rows: Dependency[]) => void }) {
  const up = (i: number, d: Dependency) => onChange(rows.map((x, j) => (j === i ? clean(d) : x)))
  const name = () => {
    let n = 1
    while (rows.some((d) => d.name === `dep${n}`)) n++
    return `dep${n}`
  }
  return (
    <>
      <h3>Dependencies</h3>
      <p className="hint">Non-media things this function cannot start without, and the facility resource each is bound to. Not media wires.</p>
      {rows.map((d, i) => (
        <fieldset key={i} className="nested">
          <div className="field-row">
            <label className="field">
              <span>Name</span>
              <input value={d.name} onChange={(e) => up(i, { ...d, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={d.kind} onChange={(e) => up(i, { ...d, kind: e.target.value as DependencyKind })}>
                {DEPENDENCY_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>
          {d.kind === 'function' && (
            <label className="field">
              <span>Must be up first (category)</span>
              <select value={d.role ?? ''} onChange={(e) => up(i, { ...d, role: e.target.value || undefined })}>
                <option value="">—</option>
                {LIBRARY.spec.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>
              Bound to{d.required && <span className="required">*</span>}
            </span>
            <input
              placeholder={`${d.kind === 'function' ? 'instance' : d.kind}:name`}
              value={d.binding ?? ''}
              onChange={(e) => up(i, { ...d, binding: e.target.value || undefined })}
            />
          </label>
          <span className="row-actions">
            <label className="field-check">
              <input type="checkbox" checked={d.required} onChange={(e) => up(i, { ...d, required: e.target.checked })} /> required
            </label>
            <button className="link" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              remove
            </button>
          </span>
        </fieldset>
      ))}
      <button className="add-row" onClick={() => onChange([...rows, { name: name(), kind: 'tams', required: true }])}>
        Add dependency
      </button>
    </>
  )
}

// ---- Resource profile ----

const RESOURCE_FIELDS = [
  ['cpu', 'CPU (cores)'],
  ['memoryMiB', 'Memory (MiB)'],
  ['networkMbps', 'Network (Mbit/s)'],
  ['storageGiB', 'Storage (GiB)'],
] as const

function Resources({ value: r, note, onChange }: { value: ResourceProfile; note?: string; onChange: (r: ResourceProfile) => void }) {
  const set = (patch: Partial<ResourceProfile>) => onChange(clean({ ...r, ...patch }))
  // A GPU is offered only if the facility has the capability (or no facility is set).
  const noGpu = unavailable(['gpu'], useFacility())
  return (
    <>
      <h3>Resource profile</h3>
      <p className="hint">What this function needs (a requirement for the orchestrator's sizing, not an allocation). Leave empty if unknown.</p>
      {note && <p className="hint">{note}</p>}
      <div className="field-row">
        {RESOURCE_FIELDS.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input type="number" min={0} step="any" value={r[k] ?? ''} onChange={(e) => set({ [k]: num(e.target.valueAsNumber) })} />
          </label>
        ))}
        <label className="field">
          <span>GPU class</span>
          <input
            value={r.gpu?.class ?? ''}
            disabled={!!noGpu && !r.gpu}
            placeholder="none, or e.g. nvidia-l4"
            onChange={(e) => set({ gpu: e.target.value ? { class: e.target.value, count: r.gpu?.count ?? 1 } : undefined })}
          />
          {noGpu && <span className={r.gpu ? 'error-text' : 'unavailable'}>{r.gpu ? `Set, but a GPU ${noGpu}: clear it to publish` : `Not offered: a GPU ${noGpu}`}</span>}
        </label>
        {r.gpu && (
          <label className="field">
            <span>GPU count</span>
            <input type="number" min={1} value={r.gpu.count} onChange={(e) => set({ gpu: { ...r.gpu!, count: Math.max(1, e.target.valueAsNumber || 1) } })} />
          </label>
        )}
      </div>
    </>
  )
}

// ---- Helpers ----

function num(n: number): number | undefined {
  return Number.isNaN(n) ? undefined : n
}

// Drop keys whose value is undefined so documents stay minimal.
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
