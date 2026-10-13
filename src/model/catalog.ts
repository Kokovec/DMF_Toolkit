import { catalogProblems, coreSchemaFor, portChoiceOf, portsFor, protocolsFor } from './modules'
import { getPrimitive } from './primitives'
import { EXTERNAL_TRANSPORTS, TRANSPORT_LABELS } from './vocabulary'
import { applies, checkParameterSchema, getPath, leafPaths, schemaAt } from './schema'
import {
  API_VERSION,
  CARDINALITIES,
  DEPENDENCY_KINDS,
  ESSENCES,
  ID_RE,
  type Essence,
  type JsonSchema,
  type ModuleCatalog,
  type PrimitiveDef,
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

  // Latest version of every module implementing a primitive, by vendor then name.
  forRole(role: string): VendorModule[] {
    return this.latest()
      .filter((p) => p.role === role)
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
  const primitive = getPrimitive(p.role)
  if (!primitive) err(`role must name a primitive (e.g. acquisition.receiver), not "${String(p.role)}"`)
  if (!p.vendor) err('vendor is required')
  if (!['singleton', 'scalable'].includes(p.capability?.scaling)) err('capability.scaling must be singleton or scalable')


  const schemaErrors = checkParameterSchema(p.parameters?.schema)
  errors.push(...schemaErrors.map((e) => `core parameters: ${e}`))
  errors.push(...vendorSettingsProblems(p, schemaErrors.length === 0))

  if (!Array.isArray(p.ports)) err('ports must be an array')
  else {
    const ids = new Set<string>()
    for (const port of p.ports) {
      const at = `port ${String(port?.id)}`
      if (!port?.id || !ID_RE.test(port.id)) err(`${at}: id must be lowercase letters, digits, . _ -`)
      if (ids.has(port.id)) err(`${at}: duplicate id`)
      ids.add(port.id)
      if (!['in', 'out'].includes(port.direction)) err(`${at}: direction must be in or out`)
      if (!ESSENCES.includes(port.essence)) err(`${at}: invalid essence`)
      if (!CARDINALITIES.includes(port.cardinality)) err(`${at}: invalid cardinality`)
      if (port.arraySize) {
        if (!port.cardinality?.endsWith('n')) err(`${at}: array size needs cardinality 0..n or 1..n`)
        if (!schemaErrors.length && schemaAt(p.parameters.schema, port.arraySize)?.type !== 'integer')
          err(`${at}: array size "${port.arraySize}" must name an integer parameter`)
      }
      if (!Array.isArray(port.formats)) err(`${at}: formats must be a list`)
      else if (port.formats.length === 0) err(`${at}: declare at least one format`)
      const t = port.transport
      if (t !== 'mxl' && !EXTERNAL_TRANSPORTS.includes(t?.external)) err(`${at}: invalid transport`)
    }
  }

  const c = p.control
  if (!c || typeof c !== 'object') err('missing control')
  else if (!c.health || !['http', 'tcp', 'grpc', 'exec'].includes(c.health.type))
    err('control: a health check is required (http, tcp, grpc or exec)')
  if (c?.api && (!['nmos-is12', 'rest', 'grpc', 'websocket'].includes(c.api.type) || !(c.api.port > 0)))
    err('control: API needs a type and port')
  if (c?.nmos && !['node', 'device'].includes(c.nmos.registers)) err('control: NMOS registers must be node or device')

  if (!Array.isArray(p.dependencies)) err('dependencies must be a list')
  else {
    const names = new Set<string>()
    for (const d of p.dependencies) {
      if (!d?.name || names.has(d.name)) err('dependency names must be present and unique')
      names.add(d?.name)
      if (!DEPENDENCY_KINDS.includes(d?.kind)) err(`dependency ${d?.name}: invalid kind`)
      if (d?.kind === 'function' && !d.role) err(`dependency ${d.name}: kind function needs a role`)
    }
  }
  if (primitive && Array.isArray(p.ports) && p.parameters?.schema && !schemaErrors.length) errors.push(...conformance(p, primitive))
  return errors
}

// A module must keep the shape of its primitive: ports it declares exist on the primitive with the
// same direction, essence and side (external transport vs MXL), required primitive ports are
// present, and every primitive parameter exists with the same type (enums may only narrow).
// Modules may add their own parameters.
export function conformance(m: VendorModule, prim: PrimitiveDef): string[] {
  const errors: string[] = []
  // Ports are fixed by the primitive; the author only chooses the input essence and the protocol.
  const choice = portChoiceOf(m)
  const expected = portsFor(prim, choice)
  for (const e of expected) {
    const port = m.ports.find((x) => x.id === e.id)
    if (!port) errors.push(`port ${e.id} of ${prim.name} is missing`)
    else if (port.direction !== e.direction || port.essence !== e.essence || (port.transport === 'mxl') !== (e.transport === 'mxl'))
      errors.push(`port ${e.id} must be ${e.direction} ${e.essence} over ${e.transport === 'mxl' ? 'MXL' : 'the external protocol'}, as on ${prim.name}`)
    else if (port.arraySize !== e.arraySize) errors.push(`port ${e.id} must be an array sized by "${e.arraySize}"`)
    else if (JSON.stringify(port.dualWhen) !== JSON.stringify(e.dualWhen)) errors.push(`port ${e.id} must keep the primitive's second-path rule`)
  }
  for (const port of m.ports)
    if (!expected.some((e) => e.id === port.id)) errors.push(`port ${port.id} is not a port of ${prim.name}`)
  const protocols = new Set(m.ports.flatMap((p) => (p.transport === 'mxl' ? [] : [p.transport.external])))
  if (protocols.size > 1) errors.push('all external ports must use the same protocol (one per module)')
  if (choice.protocol && !protocolsFor(prim).includes(choice.protocol))
    errors.push(`protocol ${TRANSPORT_LABELS[choice.protocol] ?? choice.protocol} is not offered by ${prim.name}`)
  errors.push(...schemaConformance(coreSchemaFor(prim, choice.protocol), m.parameters.schema, 'core'))
  return errors
}

function schemaConformance(base: JsonSchema, mod: JsonSchema | undefined, at: string): string[] {
  if (!mod) return [`${at}: missing (defined by the primitive)`]
  if (base.type && mod.type !== base.type) return [`${at}: must be ${base.type}, as in the primitive`]
  if (base.enum && mod.enum?.some((v) => !base.enum!.includes(v)))
    return [`${at}: options may only narrow the primitive's (${base.enum.join(', ')})`]
  if (base.enum && !mod.enum) return [`${at}: must keep the primitive's options (a subset is fine)`]
  const extra = Object.keys(mod.properties ?? {})
    .filter((k) => !base.properties?.[k])
    .map((k) => `${at}.${k}: not a core parameter of the primitive; put vendor-specific settings under Vendor settings`)
  return [...extra, ...Object.entries(base.properties ?? {}).flatMap(([k, s]) => schemaConformance(s, mod.properties?.[k], `${at}.${k}`))]
}

// Vendor settings: a valid object schema, and every mapping goes from a core leaf to a vendor leaf,
// each used at most once; value maps may only translate the core parameter's options.
function vendorSettingsProblems(p: VendorModule, coreOk: boolean): string[] {
  const vs = p.vendorSettings
  if (!vs || typeof vs !== 'object') return ['vendor settings missing']
  const errors = checkParameterSchema(vs.schema).map((e) => `vendor settings: ${e}`)
  if (!Array.isArray(vs.mapping)) return [...errors, 'vendor settings: mapping must be a list']
  if (errors.length || !coreOk) return errors
  const coreLeaves = leafPaths(p.parameters.schema)
  const vendorLeaves = leafPaths(vs.schema)
  const seenCore = new Set<string>()
  const seenVendor = new Set<string>()
  for (const m of vs.mapping) {
    const at = `mapping ${m?.core} → ${m?.vendor}`
    if (!coreLeaves.includes(m?.core)) errors.push(`${at}: "${m?.core}" is not a core parameter`)
    if (!vendorLeaves.includes(m?.vendor)) errors.push(`${at}: "${m?.vendor}" is not a vendor setting`)
    if (seenCore.has(m?.core)) errors.push(`${at}: core parameter mapped twice`)
    if (seenVendor.has(m?.vendor)) errors.push(`${at}: vendor setting targeted twice`)
    seenCore.add(m?.core)
    seenVendor.add(m?.vendor)
    const options = schemaAt(p.parameters.schema, m?.core)?.enum
    if (m?.values && options)
      for (const k of Object.keys(m.values))
        if (!options.map(String).includes(k)) errors.push(`${at}: "${k}" is not an option of ${m.core}`)
  }
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
    [...checkModule(p), ...(p?.id && p?.role ? catalogProblems(p, c.metadata) : [])].map((e) => `${p?.id}@${p?.version}: ${e}`),
  )
  const keys = new Set<string>()
  for (const p of c.spec.modules) {
    const key = `${p.id}@${p.version}`
    if (keys.has(key)) errors.push(`duplicate module ${key}`)
    keys.add(key)
  }
  return errors
}
