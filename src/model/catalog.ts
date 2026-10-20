import { composeModule, designProblems } from './compose'
import { getCategory } from './library'
import { catalogProblems } from './modules'
import { TRANSPORT_LABELS } from './vocabulary'
import { applies, checkParameterSchema, getPath } from './schema'
import {
  API_VERSION,
  ESSENCES,
  ID_RE,
  type Essence,
  type ModuleCatalog,
  type JsonValue,
  type VendorModule,
  type PortConstraints,
  type PortDef,
  type Rational,
} from './types'

export { KNOWN_FORMATS } from './vocabulary'

// A set of vendor modules, all versions. get(id) without a version returns the latest.
export class Catalog {
  readonly modules: VendorModule[]
  private byKey = new Map<string, VendorModule>()
  private latestById = new Map<string, VendorModule>()

  constructor(modules: VendorModule[]) {
    this.modules = modules
    for (const p of modules) {
      this.byKey.set(`${p.id}@${p.version}`, p)
      const prev = this.latestById.get(p.id)
      if (!prev || compareVersions(p.version, prev.version) > 0) this.latestById.set(p.id, p)
    }
  }

  get(id: string, version?: string): VendorModule | undefined {
    return version ? this.byKey.get(`${id}@${version}`) : this.latestById.get(id)
  }

  latest(): VendorModule[] {
    return [...this.latestById.values()]
  }

  // Latest version of every module listed under a category (palette heading), by vendor then name.
  forCategory(category: string): VendorModule[] {
    return this.latest()
      .filter((p) => p.categories?.includes(category))
      .sort((a, b) => (a.vendor ?? '').localeCompare(b.vendor ?? '') || a.name.localeCompare(b.name))
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    const c = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny
    if (c !== 0) return Math.sign(c)
  }
  return 0
}

// Edge function = has a port facing the outside world (external transport). The orchestrator
// uses this to place it on a host with the right interface.
export function isEdge(m: Pick<VendorModule, 'ports'>): boolean {
  return m.ports.some((p) => p.transport !== 'mxl')
}

export function deriveCapability(p: Pick<VendorModule, 'ports'>): { produces: Essence[]; consumes: Essence[] } {
  const of = (dir: 'in' | 'out') => ESSENCES.filter((e) => p.ports.some((q) => q.direction === dir && q.essence === e))
  return { produces: of('out'), consumes: of('in') }
}

// ---- Current catalog for the UI (empty until the server's library loads) ----

let current = new Catalog([])
const listeners = new Set<() => void>()

export function currentCatalog(): Catalog {
  return current
}

export function setCatalog(next: Catalog) {
  current = next
  listeners.forEach((l) => l())
}

export function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---- Ports of an instance ----

export type ResolvedPort = PortDef & {
  key: string // instance port id: "out.video" or "rec.video[2]"
  group?: string // bundle key: timeContext, plus "[i]" for port-array elements
}

// Concrete ports for an instance, expanding port arrays from their size parameter.
export function resolvePorts(ports: PortDef[], params: JsonValue | undefined): ResolvedPort[] {
  return ports.flatMap((p) => {
    // A port with a per-instance second path (e.g. SRT bonding) becomes path A + path B.
    if (p.dualWhen && applies({ 'x-when': p.dualWhen }, params, params)) {
      const name = p.transport === 'mxl' ? p.id : (TRANSPORT_LABELS[p.transport.external] ?? p.transport.external)
      return [
        { ...p, key: p.id, label: `${name} A`, cardinality: '1' as const, group: p.timeContext },
        { ...p, key: `${p.id}.b`, label: `${name} B`, cardinality: '1' as const, group: p.timeContext },
      ]
    }
    if (!p.cardinality.endsWith('n')) return [{ ...p, key: p.id, group: p.timeContext }]
    const n = p.arraySize ? Math.max(0, Math.floor(Number(getPath(params, p.arraySize)) || 0)) : 1
    return Array.from({ length: n }, (_, i) => ({
      ...p,
      key: `${p.id}[${i}]`,
      group: p.timeContext ? `${p.timeContext}[${i}]` : undefined,
    }))
  })
}

export function isRequired(p: PortDef): boolean {
  return p.cardinality === '1' || p.cardinality === '1..n'
}

export function transportLabel(p: PortDef): string {
  return p.transport === 'mxl' ? 'MXL' : (TRANSPORT_LABELS[p.transport.external] ?? p.transport.external)
}

// ---- Wiring rule: can output `a` feed input `b`? Returns the reason if not. ----

const sameRational = (x: Rational, y: Rational) => x.num * y.den === y.num * x.den

function intersects<T>(a: T[] | undefined, b: T[] | undefined, eq: (x: T, y: T) => boolean = (x, y) => x === y) {
  return !a?.length || !b?.length || a.some((x) => b.some((y) => eq(x, y)))
}

export function constraintMismatch(a: PortConstraints = {}, b: PortConstraints = {}): string | null {
  if (!intersects(a.grainRate, b.grainRate, sameRational)) return 'grain rate'
  if (!intersects(a.frameSize, b.frameSize, (x, y) => x.width === y.width && x.height === y.height)) return 'frame size'
  if (!intersects(a.interlace, b.interlace)) return 'interlace'
  if (!intersects(a.colorspace, b.colorspace)) return 'colorspace'
  if (!intersects(a.transfer, b.transfer)) return 'transfer characteristic'
  if (!intersects(a.componentLayout, b.componentLayout)) return 'component layout'
  if (!intersects(a.sampleRate, b.sampleRate, sameRational)) return 'sample rate'
  if (a.channelCount && b.channelCount && (a.channelCount.max < b.channelCount.min || b.channelCount.max < a.channelCount.min))
    return 'channel count'
  if (!intersects(a.channelLayout, b.channelLayout)) return 'channel layout'
  return null
}

// `outExternal`/`inExternal` mark ports on canvas externals (camera, destination): those can
// only meet an edge function's external port.
export function wireMismatch(out: PortDef, outExternal: boolean, inp: PortDef, inExternal: boolean): string | null {
  if (out.direction !== 'out' || inp.direction !== 'in') return 'wires run from an output to an input'
  if (out.essence !== inp.essence) return `essence mismatch: ${out.essence} → ${inp.essence}`
  if (outExternal && inExternal) return 'two external devices cannot be wired to each other'
  if (outExternal || inExternal) {
    const fnPort = outExternal ? inp : out
    if (fnPort.transport === 'mxl') return 'external devices connect only to an edge function’s external port'
  } else if (out.transport === 'mxl' || inp.transport === 'mxl') {
    if (out.transport !== inp.transport) return 'MXL ports connect only to MXL ports'
  } else if (out.transport.external !== inp.transport.external)
    return `transport mismatch: ${out.transport.external} → ${inp.transport.external}`
  if (!intersects(out.formats, inp.formats)) return `no common format (${out.formats.join(', ')} → ${inp.formats.join(', ')})`
  const c = constraintMismatch(out.constraints, inp.constraints)
  return c ? `incompatible ${c}` : null
}

// ---- Structural checks (shared by server and UI) ----

export { ID_RE }

export function checkModule(x: unknown): string[] {
  const p = x as VendorModule
  if (!p || typeof p !== 'object') return ['not an object']
  const errors: string[] = []
  const err = (m: string) => errors.push(m)
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) err('id must be lowercase letters, digits, . _ -')
  if (typeof p.version !== 'string' || !p.version) err('missing version')
  if (!p.name) err('missing name')
  if (typeof p.description !== 'string') err('missing description')
  if (!p.vendor) err('vendor is required')
  if (!Array.isArray(p.categories) || !p.categories.length) err('choose at least one category (palette heading)')
  else for (const c of p.categories) if (!getCategory(c)) err(`unknown category ${c}`)
  if (!['singleton', 'scalable'].includes(p.capability?.scaling)) err('capability.scaling must be singleton or scalable')

  // The design and its rules; ports and core parameters must be what the design produces.
  const design = designProblems(p.design)
  errors.push(...design)
  if (!design.length || p.design?.blocks) {
    const derived = composeModule(p.design)
    if (JSON.stringify(derived.ports) !== JSON.stringify(p.ports) || JSON.stringify(derived.schema) !== JSON.stringify(p.parameters?.schema))
      err('ports / parameters do not match the design (recompute them from the design)')
  }
  const schemaErrors = checkParameterSchema(p.parameters?.schema)
  errors.push(...schemaErrors.map((e) => `core parameters: ${e}`))
  return errors
}


export function checkCatalog(doc: unknown): string[] {
  const c = doc as ModuleCatalog
  if (!c || typeof c !== 'object') return ['not a JSON object']
  if (c.apiVersion !== API_VERSION) return [`unsupported apiVersion: ${String(c.apiVersion)} (expected ${API_VERSION})`]
  if (c.kind !== 'ModuleCatalog') return [`unsupported kind: ${String(c.kind)}`]
  if (!c.metadata?.id || !c.metadata?.name || !c.metadata?.vendor || !Array.isArray(c.spec?.modules))
    return ['missing metadata.id, metadata.name, metadata.vendor or spec.modules']
  const errors = c.spec.modules.flatMap((p) =>
    [...checkModule(p), ...(p?.id ? catalogProblems(p, c.metadata) : [])].map((e) => `${p?.id}@${p?.version}: ${e}`),
  )
  const keys = new Set<string>()
  for (const p of c.spec.modules) {
    const key = `${p.id}@${p.version}`
    if (keys.has(key)) errors.push(`duplicate module ${key}`)
    keys.add(key)
  }
  return errors
}
