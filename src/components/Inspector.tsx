import { useCatalog } from '../api'
import { EXTERNALS, REFERENCE_KINDS } from '../model/externals'
import { settingsSchema, vendorConfig } from '../model/modules'
import { roleLabel } from '../model/primitives'
import { leafPaths } from '../model/schema'
import type {
  Colorspace,
  Expectations,
  ExternalRefKind,
  ExternalReference,
  FlowDef,
  FlowOptions,
  PlacementConstraints,
  VendorModule,
  WorkloadDefaults,
} from '../model/types'
import { DEFAULT_HISTORY_MS, moduleOf, rebind, type CanvasNode, type ExtData, type FnData, type WorkloadMeta } from '../model/workload'
import { SchemaForm } from './SchemaForm'

type Props = {
  selected: CanvasNode[]
  metadata: WorkloadMeta
  onMetadataChange: (m: WorkloadMeta) => void
  defaults: WorkloadDefaults
  onDefaultsChange: (d: WorkloadDefaults) => void
  problems: string[]
  onNodeChange: (id: string, data: FnData | ExtData) => void
  onDelete: (id: string) => void
  flows: FlowDef[] // flows of the selected wire(s), when a wire is selected
  nodes: CanvasNode[]
}

export function Inspector(props: Props) {
  const { selected } = props
  if (!selected.length && props.flows.length) return <FlowPanel {...props} />
  if (selected.length !== 1) return <WorkloadPanel {...props} />
  const node = selected[0]
  return node.data.kind === 'fn' ? (
    <FunctionPanel id={node.id} data={node.data} {...props} />
  ) : (
    <ExternalPanel id={node.id} data={node.data} {...props} />
  )
}

// ---- Workload (nothing selected) ----

const RATES = [
  { label: '25', num: 25, den: 1 },
  { label: '29.97', num: 30000, den: 1001 },
  { label: '50', num: 50, den: 1 },
  { label: '59.94', num: 60000, den: 1001 },
  { label: '60', num: 60, den: 1 },
]
const SIZES = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
]

function WorkloadPanel({ selected, metadata, onMetadataChange, defaults, onDefaultsChange, problems }: Props) {
  const rate = RATES.find((r) => r.num * defaults.video.grainRate.den === defaults.video.grainRate.num * r.den)
  const setVideo = (patch: Partial<WorkloadDefaults['video']>) => onDefaultsChange({ ...defaults, video: { ...defaults.video, ...patch } })
  const setAudio = (patch: Partial<WorkloadDefaults['audio']>) => onDefaultsChange({ ...defaults, audio: { ...defaults.audio, ...patch } })
  return (
    <aside className="inspector">
      <h2>Workload</h2>
      {selected.length > 1 && <p className="hint">{selected.length} blocks selected.</p>}
      <label className="field">
        <span>ID</span>
        <input value={metadata.id} onChange={(e) => onMetadataChange({ ...metadata, id: e.target.value })} />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={metadata.name} onChange={(e) => onMetadataChange({ ...metadata, name: e.target.value })} />
      </label>
      <label className="field">
        <span>Workflow intent</span>
        <textarea
          rows={3}
          placeholder="e.g. SRT ingress from venue → decode/normalize → MXL → switcher and multiviewer"
          value={metadata.description ?? ''}
          onChange={(e) => onMetadataChange({ ...metadata, description: e.target.value })}
        />
        <span className="hint">Passed to the orchestrator as the description of the path.</span>
      </label>

      <h3>Flow defaults</h3>
      <p className="hint">Used by the orchestrator where port formats leave a choice.</p>
      <div className="field-row">
        <label className="field">
          <span>Frame rate</span>
          <select value={rate?.label ?? ''} onChange={(e) => {
            const r = RATES.find((x) => x.label === e.target.value)!
            setVideo({ grainRate: { num: r.num, den: r.den } })
          }}>
            {RATES.map((r) => (
              <option key={r.label}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Frame size</span>
          <select
            value={`${defaults.video.frameSize.width}x${defaults.video.frameSize.height}`}
            onChange={(e) => {
              const [width, height] = e.target.value.split('x').map(Number)
              setVideo({ frameSize: { width, height } })
            }}
          >
            {SIZES.map((s) => (
              <option key={s.width}>{`${s.width}x${s.height}`}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Colorspace</span>
          <select value={defaults.video.colorspace} onChange={(e) => setVideo({ colorspace: e.target.value as Colorspace })}>
            <option>BT709</option>
            <option>BT2020</option>
            <option>BT2100</option>
          </select>
        </label>
        <label className="field">
          <span>Audio channels</span>
          <input
            type="number"
            min={1}
            max={64}
            value={defaults.audio.channelCount}
            onChange={(e) => setAudio({ channelCount: Math.max(1, e.target.valueAsNumber || 1) })}
          />
        </label>
      </div>
      <label className="field">
        <span>MXL flow history (ms)</span>
        <input
          type="number"
          min={0}
          value={defaults.mxl?.historyMs ?? DEFAULT_HISTORY_MS}
          onChange={(e) => onDefaultsChange({ ...defaults, mxl: { historyMs: Math.max(0, e.target.valueAsNumber || 0) } })}
        />
        <span className="hint">How much of each flow readers need buffered; per-flow overrides on the wire.</span>
      </label>

      <h3>Publish readiness</h3>
      {problems.length ? (
        <ul className="problems compact">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : (
        <p className="ok-text">Ready to publish.</p>
      )}
    </aside>
  )
}

// ---- Function instance ----

function FunctionPanel({ id, data, nodes, onNodeChange, onDelete }: Props & { id: string; data: FnData }) {
  const catalog = useCatalog()
  const prim = moduleOf(data, catalog)
  const update = (patch: Partial<FnData>) => onNodeChange(id, { ...data, ...patch })

  if (!prim)
    return (
      <aside className="inspector">
        <h2>{data.name}</h2>
        <p className="error-text">
          Primitive {data.type}@{data.typeVersion} is not in the library.
        </p>
        <button className="danger" onClick={() => onDelete(id)}>
          Delete
        </button>
      </aside>
    )

  const implementations = catalog.forRole(prim.role)
  const latest = catalog.get(prim.id)

  return (
    <aside className="inspector">
      <h2>{prim.name}</h2>
      <p className="hint">
        {roleLabel(prim.role)} · {prim.vendor}{prim.product ? ` ${prim.product}` : ''} — {prim.description}
      </p>

      <label className="field">
        <span>Instance ID</span>
        <input value={id} readOnly />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={data.name} onChange={(e) => update({ name: e.target.value })} />
      </label>

      <label className="field">
        <span>Module ({roleLabel(prim.role)})</span>
        <select
          value={prim.id}
          onChange={(e) => {
            const next = catalog.get(e.target.value)
            if (next) onNodeChange(id, rebind(data, next))
          }}
        >
          {!implementations.some((p) => p.id === prim.id) && <option value={prim.id}>{prim.name}</option>}
          {implementations.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.vendor}
            </option>
          ))}
        </select>
      </label>
      {latest && latest.version !== prim.version && <UpgradeOffer from={prim} to={latest} onUpgrade={() => onNodeChange(id, rebind(data, latest))} />}

      <label className="field">
        <span>MXL domain</span>
        <input value={data.domain} placeholder="main" onChange={(e) => update({ domain: e.target.value })} />
        <span className="hint">Logical isolation group for this function's flows; the orchestrator creates and places it.</span>
      </label>

      <h3>Core parameters</h3>
      <SchemaForm
        key={`${id}:${prim.id}@${prim.version}`}
        schema={prim.parameters.schema}
        value={data.parameters}
        onChange={(parameters) => update({ parameters })}
      />

      <h3>{prim.vendor} settings</h3>
      <SchemaForm
        key={`${id}:${prim.id}@${prim.version}:settings`}
        schema={settingsSchema(prim)}
        value={data.settings ?? {}}
        onChange={(settings) => update({ settings })}
      />

      {prim.dependencies.length > 0 && (
        <>
          <h3>Dependencies</h3>
          {prim.dependencies.map((d) => (
            <label key={d.name} className="field">
              <span>
                {d.name} ({d.kind}
                {d.role ? `: ${d.role}` : ''}){d.required && <span className="required">*</span>}
              </span>
              <input
                placeholder={`${d.kind === 'function' ? 'instance' : d.kind}:name`}
                value={data.bindings?.[d.name] ?? ''}
                onChange={(e) => {
                  const bindings = { ...data.bindings }
                  if (e.target.value) bindings[d.name] = e.target.value
                  else delete bindings[d.name]
                  update({ bindings })
                }}
              />
            </label>
          ))}
        </>
      )}

      <Intent data={data} prim={prim} others={nodes.filter((n) => n.data.kind === 'fn' && n.id !== id).map((n) => n.id)} update={update} />

      <Contract prim={prim} data={data} />

      <button className="danger" onClick={() => onDelete(id)}>
        Delete function
      </button>
    </aside>
  )
}

// Read-only summary of what the orchestrator gets from the module. Image, compute, licences
// and placement are the orchestrator's own decisions.
function Contract({ prim, data }: { prim: VendorModule; data: FnData }) {
  const c = prim.control
  const external = [...new Set(prim.ports.flatMap((p) => (p.transport === 'mxl' ? [] : [p.transport.external])))]
  const rows: [string, string][] = [
    ['Module', `${prim.id}@${prim.version}`],
    ['Product', [prim.vendor, prim.product, prim.productVersion].filter(Boolean).join(' ')],
    ['Scaling', prim.capability.scaling],
  ]
  if (external.length) rows.push(['Edge', external.join(', ')])
  const r = prim.resources
  if (r)
    rows.push([
      'Resources',
      [
        r.cpu && `${r.cpu} CPU`,
        r.memoryMiB && `${r.memoryMiB} MiB`,
        r.gpu && `${r.gpu.count}× ${r.gpu.class}`,
        r.networkMbps && `${r.networkMbps} Mbit/s`,
        r.storageGiB && `${r.storageGiB} GiB`,
      ]
        .filter(Boolean)
        .join(' · ') + ' (vendor profile)',
    ])
  if (c.api) rows.push(['Control API', `${c.api.type} :${c.api.port}${c.api.path ?? ''}`])
  if (c.nmos) rows.push(['NMOS', `registers as ${c.nmos.registers}`])
  if (c.health) rows.push(['Health', `${c.health.type}${c.health.port ? ` :${c.health.port}` : ''}${c.health.path ?? ''}`])
  return (
    <details className="contract">
      <summary>Orchestration contract</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">Configuration in {prim.vendor}'s terms, as the orchestrator will apply it:</p>
      <pre className="json-preview">{JSON.stringify(vendorConfig(prim, data.parameters, data.settings ?? {}), null, 2)}</pre>
    </details>
  )
}

// ---- External device ----

function ExternalPanel({ id, data, onNodeChange, onDelete }: Props & { id: string; data: ExtData }) {
  const t = EXTERNALS[data.extKind]
  return (
    <aside className="inspector">
      <h2>{t?.name ?? data.extKind}</h2>
      <p className="hint">External device — {t?.description} Not deployed; edge functions connect to it.</p>
      <label className="field">
        <span>ID</span>
        <input value={id} readOnly />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={data.name} onChange={(e) => onNodeChange(id, { ...data, name: e.target.value })} />
      </label>
      <ReferenceFields data={data} onChange={(reference) => onNodeChange(id, { ...data, reference })} />
      <label className="field">
        <span>Notes</span>
        <textarea
          rows={3}
          placeholder="location, contact, anything the operators should know…"
          value={data.notes ?? ''}
          onChange={(e) => onNodeChange(id, { ...data, notes: e.target.value || undefined })}
        />
      </label>
      <button className="danger" onClick={() => onDelete(id)}>
        Delete device
      </button>
    </aside>
  )
}

// What is on the other end, as a logical reference the orchestrator resolves (no addresses).
function ReferenceFields({ data, onChange }: { data: ExtData; onChange: (r: ExternalReference | undefined) => void }) {
  const ref = data.reference
  const side = data.extKind === 'destination' ? 'destination' : 'source'
  return (
    <>
      <h3>Reference</h3>
      <label className="field">
        <span>Identified by</span>
        <select
          value={ref?.kind ?? ''}
          onChange={(e) =>
            onChange(e.target.value ? { kind: e.target.value as ExternalRefKind, value: ref?.value ?? '' } : undefined)
          }
        >
          <option value="">— not set —</option>
          {(Object.keys(REFERENCE_KINDS) as ExternalRefKind[]).map((k) => (
            <option key={k} value={k}>
              {REFERENCE_KINDS[k].label}
            </option>
          ))}
        </select>
      </label>
      {ref && (
        <label className="field">
          <span>{REFERENCE_KINDS[ref.kind][side]}</span>
          <input value={ref.value} onChange={(e) => onChange({ ...ref, value: e.target.value })} />
        </label>
      )}
      <p className="hint">
        The orchestrator turns this into addresses, SDP files and connections. Caller/listener mode, latency and secrets are set
        on the receiver (its ingress parameters).
      </p>
    </>
  )
}

// What a newer version of the module changes, shown before upgrading an instance.
function UpgradeOffer({ from, to, onUpgrade }: { from: VendorModule; to: VendorModule; onUpgrade: () => void }) {
  const before = new Set([...leafPaths(from.parameters.schema), ...leafPaths(settingsSchema(from))])
  const after = new Set([...leafPaths(to.parameters.schema), ...leafPaths(settingsSchema(to))])
  const added = [...after].filter((p) => !before.has(p))
  const removed = [...before].filter((p) => !after.has(p))
  return (
    <div className="upgrade-offer">
      <button className="upgrade" onClick={onUpgrade}>
        Upgrade to version {to.version}
      </button>
      {(added.length > 0 || removed.length > 0) && (
        <p className="hint">
          {added.length > 0 && <>New settings: {added.join(', ')}. </>}
          {removed.length > 0 && <>Removed (values dropped): {removed.join(', ')}.</>}
        </p>
      )}
    </div>
  )
}

// ---- Desired-state metadata for one function: expectations, placement constraints, discovery ----

function Intent({ data, prim, others, update }: { data: FnData; prim: VendorModule; others: string[]; update: (p: Partial<FnData>) => void }) {
  const ex = data.expectations ?? {}
  const pl = data.placement ?? {}
  const disc = data.discovery ?? { register: !!prim.control.nmos }
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

// ---- A selected wire: the MXL flow(s) it carries ----

function FlowPanel({ flows, nodes, onNodeChange }: Props) {
  return (
    <aside className="inspector">
      <h2>{flows.length > 1 ? `${flows.length} MXL flows` : 'MXL flow'}</h2>
      {flows.map((f) => {
        const [writer, port] = [f.writer.slice(0, f.writer.indexOf('/')), f.writer.slice(f.writer.indexOf('/') + 1)]
        const node = nodes.find((n) => n.id === writer)
        if (!node || node.data.kind !== 'fn') return null
        const data = node.data
        const opts = data.flowOptions?.[port] ?? {}
        const setOpts = (patch: FlowOptions) =>
          onNodeChange(writer, { ...data, flowOptions: { ...data.flowOptions, [port]: clean({ ...opts, ...patch }) } })
        const fmt = f.format
        return (
          <section key={f.id} className="flow-card">
            <h3>{f.label}</h3>
            <dl className="kv">
              <dt>Flow id</dt>
              <dd className="mono">{f.id}</dd>
              <dt>Domain</dt>
              <dd>{f.domain}</dd>
              <dt>Writer</dt>
              <dd>{f.writer}</dd>
              <dt>Readers</dt>
              <dd>{f.readers.join(', ')}</dd>
              <dt>Format</dt>
              <dd>
                {fmt.mediaType}
                {fmt.frameWidth ? ` · ${fmt.frameWidth}x${fmt.frameHeight} ${fmt.interlace === 'interlaced' ? 'i' : 'p'}` : ''}
                {fmt.grainRate ? ` · ${(fmt.grainRate.num / fmt.grainRate.den).toFixed(2).replace(/\.00$/, '')} grains/s` : ''}
                {fmt.colorspace ? ` · ${fmt.colorspace}` : ''}
                {fmt.channelCount ? ` · ${fmt.channelCount} ch @ ${fmt.sampleRate!.num / fmt.sampleRate!.den} Hz` : ''}
              </dd>
            </dl>
            <label className="field">
              <span>History (ms)</span>
              <input
                type="number"
                min={0}
                value={opts.historyMs ?? ''}
                placeholder={`${f.historyMs} (workload default)`}
                onChange={(e) => setOpts({ historyMs: Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber })}
              />
            </label>
            <label className="field field-check">
              <input type="checkbox" checked={f.discovery.register} onChange={(e) => setOpts({ register: e.target.checked })} />
              <span>Register for discovery (NMOS)</span>
            </label>
            <label className="field">
              <span>Labels / tags</span>
              <input
                value={(opts.labels ?? []).join(', ')}
                onChange={(e) => {
                  const labels = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)
                  setOpts({ labels: labels.length ? labels : undefined })
                }}
              />
            </label>
          </section>
        )
      })}
      <p className="hint">Format comes from the writer's output settings and the workload defaults; the id is stable across revisions.</p>
    </aside>
  )
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
