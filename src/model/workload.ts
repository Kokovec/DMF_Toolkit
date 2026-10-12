import type { Edge, Node } from '@xyflow/react'
import { currentCatalog, isRequired, KNOWN_FORMATS, resolvePorts, wireMismatch, type Catalog, type ResolvedPort } from './catalog'
import { EXTERNALS } from './externals'
import { settingsSchema } from './modules'
import { defaultsFor, getPath, leafPaths, validateValue, withoutInapplicable } from './schema'
import { uuidV5 } from './uuid'
import {
  API_VERSION,
  type Discovery,
  type Essence,
  type Expectations,
  type ExternalKind,
  type ExternalReference,
  type FlowDef,
  type FlowFormat,
  type FlowOptions,
  type FunctionInstance,
  type JsonSchema,
  type JsonValue,
  type PlacementConstraints,
  type Rational,
  type VendorModule,
  type Wire,
  type WorkloadDefaults,
  type WorkloadDescription,
} from './types'

// ---- Canvas representation ----

export type FnData = {
  kind: 'fn'
  type: string
  typeVersion: string
  name: string
  domain: string
  parameters: { [key: string]: JsonValue } // core parameters
  settings: { [key: string]: JsonValue } // vendor settings (mapped keys excluded)
  bindings?: Record<string, string>
  expectations?: Expectations
  placement?: PlacementConstraints
  discovery?: Discovery
  flowOptions?: Record<string, FlowOptions>
}
export type ExtData = { kind: 'ext'; extKind: ExternalKind; name: string; notes?: string; reference?: ExternalReference }
export type FnNode = Node<FnData, 'fn'>
export type ExtNode = Node<ExtData, 'ext'>
export type CanvasNode = FnNode | ExtNode

// React Flow edges are a view of the wires: one edge per wire, or one bundle edge for
// several wires between the same two time-context groups.
export type WireEdge = Edge<{ wires: Wire[]; essence?: Essence }>

export type WorkloadMeta = WorkloadDescription['metadata']

export const DEFAULT_DOMAIN = 'main'
export const DEFAULTS: WorkloadDefaults = {
  video: { grainRate: { num: 50, den: 1 }, frameSize: { width: 1920, height: 1080 }, colorspace: 'BT709' },
  audio: { sampleRate: { num: 48000, den: 1 }, channelCount: 2 },
}

export const DEFAULT_HISTORY_MS = 200 // default MXL flow history (ring buffer) the readers need

export const BUNDLE = '@' // handle id prefix for a time-context group

export function moduleOf(data: FnData, cat: Catalog = currentCatalog()): VendorModule | undefined {
  return cat.get(data.type, data.typeVersion)
}

export function portsOf(data: FnData | ExtData, cat: Catalog = currentCatalog()): ResolvedPort[] {
  if (data.kind === 'ext') return resolvePorts(EXTERNALS[data.extKind]?.ports ?? [], {})
  const prim = moduleOf(data, cat)
  return prim ? resolvePorts(prim.ports, data.parameters) : []
}

export function ref(node: string, port: string) {
  return `${node}/${port}`
}

export function splitRef(r: string): { node: string; port: string } {
  const i = r.indexOf('/')
  return { node: r.slice(0, i), port: r.slice(i + 1) }
}

// Readable, stable ids ("vision-mixer-2") so the graph reads like source code.
export function nextNodeId(base: string, existing: Iterable<string>): string {
  const ids = new Set(existing)
  let n = 1
  while (ids.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function newFunctionData(prim: VendorModule, name: string): FnData {
  return {
    kind: 'fn',
    type: prim.id,
    typeVersion: prim.version,
    name,
    domain: DEFAULT_DOMAIN,
    parameters: (defaultsFor(prim.parameters.schema) as { [k: string]: JsonValue }) ?? {},
    settings: (defaultsFor(settingsSchema(prim)) as { [k: string]: JsonValue }) ?? {},
  }
}

// Values of `old` at the leaves `schema` still has, over the schema's defaults.
function carryOver(schema: JsonSchema, old: JsonValue | undefined): { [k: string]: JsonValue } {
  const out = ((defaultsFor(schema) as { [k: string]: JsonValue }) ?? {}) as { [k: string]: JsonValue }
  for (const path of leafPaths(schema)) {
    const v = getPath(old, path)
    if (v === undefined) continue
    const keys = path.split('.')
    let cur = out
    for (const k of keys.slice(0, -1)) cur = (cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = {})) as { [k: string]: JsonValue }
    cur[keys[keys.length - 1]] = v
  }
  return out
}

// Switch an instance to another module: core parameters carry over (same primitive, so the same
// vocabulary); vendor settings carry over only where the new module still has the same keys
// (e.g. an upgrade), otherwise they start from the new module's defaults (another vendor).
export function rebind(data: FnData, prim: VendorModule): FnData {
  const slots = new Set(prim.dependencies.map((d) => d.name))
  const bindings = Object.fromEntries(Object.entries(data.bindings ?? {}).filter(([k]) => slots.has(k)))
  return {
    ...data,
    type: prim.id,
    typeVersion: prim.version,
    parameters: carryOver(prim.parameters.schema, data.parameters),
    settings: carryOver(settingsSchema(prim), data.settings),
    bindings,
  }
}

// ---- Wiring ----

type NodeLookup = (id: string) => CanvasNode | undefined

// Turn a drag between two handles into wires. Port → port gives one wire; bundle → bundle pairs
// the members by essence (video↔video, audio↔audio, …).
export function planConnection(
  getNode: NodeLookup,
  wires: Wire[],
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  cat: Catalog = currentCatalog(),
): { wires: Wire[] } | { error: string } {
  if (source === target) return { error: 'a function cannot feed itself' }
  const src = getNode(source)
  const dst = getNode(target)
  if (!src || !dst) return { error: 'unknown node' }
  const outs = portsOf(src.data, cat).filter((p) => p.direction === 'out')
  const ins = portsOf(dst.data, cat).filter((p) => p.direction === 'in')
  const srcExt = src.data.kind === 'ext'
  const dstExt = dst.data.kind === 'ext'
  const taken = new Set(wires.map((w) => w.to))

  const srcBundle = sourceHandle.startsWith(BUNDLE)
  if (srcBundle !== targetHandle.startsWith(BUNDLE)) return { error: 'connect a bundle to a bundle, or a port to a port' }

  let pairs: [ResolvedPort, ResolvedPort][]
  if (srcBundle) {
    const sm = outs.filter((p) => p.group === sourceHandle.slice(1))
    const free = ins.filter((p) => p.group === targetHandle.slice(1))
    pairs = []
    for (const o of sm) {
      const i = free.findIndex((p) => p.essence === o.essence)
      if (i >= 0) pairs.push([o, free.splice(i, 1)[0]])
    }
    if (!pairs.length) return { error: 'the two bundles have no essence in common' }
  } else {
    const o = outs.find((p) => p.key === sourceHandle)
    const i = ins.find((p) => p.key === targetHandle)
    if (!o || !i) return { error: 'unknown port' }
    pairs = [[o, i]]
  }

  for (const [o, i] of pairs) {
    const why = wireMismatch(o, srcExt, i, dstExt)
    if (why) return { error: `${o.key} → ${i.key}: ${why}` }
    if (taken.has(ref(target, i.key))) return { error: `${i.key} is already connected` }
  }
  return { wires: pairs.map(([o, i]) => ({ from: ref(source, o.key), to: ref(target, i.key) })) }
}

// Drop wires whose ports no longer exist (port array shrank, primitive rebound, node deleted).
export function pruneWires(wires: Wire[], nodes: CanvasNode[], cat: Catalog = currentCatalog()): Wire[] {
  const ports = new Map(nodes.map((n) => [n.id, new Set(portsOf(n.data, cat).map((p) => p.key))]))
  const ok = (r: string) => {
    const { node, port } = splitRef(r)
    return !!ports.get(node)?.has(port)
  }
  return wires.filter((w) => ok(w.from) && ok(w.to))
}

export function edgesFor(wires: Wire[], nodes: CanvasNode[], selected: Set<string>, cat: Catalog = currentCatalog()): WireEdge[] {
  const portIndex = new Map<string, ResolvedPort>()
  for (const n of nodes) for (const p of portsOf(n.data, cat)) portIndex.set(ref(n.id, p.key), p)

  const bundles = new Map<string, Wire[]>()
  const singles: Wire[] = []
  for (const w of wires) {
    const f = portIndex.get(w.from)
    const t = portIndex.get(w.to)
    if (f?.group && t?.group) {
      const key = `${splitRef(w.from).node}${BUNDLE}${f.group}|${splitRef(w.to).node}${BUNDLE}${t.group}`
      bundles.set(key, [...(bundles.get(key) ?? []), w])
    } else singles.push(w)
  }

  const edges: WireEdge[] = []
  for (const [key, ws] of bundles) {
    if (ws.length < 2) {
      singles.push(...ws)
      continue
    }
    const [from, to] = key.split('|')
    const [source, sg] = from.split(BUNDLE)
    const [target, tg] = to.split(BUNDLE)
    const id = `bundle:${key}`
    edges.push({
      id,
      source,
      sourceHandle: BUNDLE + sg,
      target,
      targetHandle: BUNDLE + tg,
      data: { wires: ws },
      className: 'bundle',
      selected: selected.has(id),
    })
  }
  for (const w of singles) {
    const f = splitRef(w.from)
    const t = splitRef(w.to)
    const essence = portIndex.get(w.from)?.essence
    const id = `${w.from}->${w.to}`
    edges.push({
      id,
      source: f.node,
      sourceHandle: f.port,
      target: t.node,
      targetHandle: t.port,
      data: { wires: [w], essence },
      className: essence ? `essence-${essence}` : undefined,
      selected: selected.has(id),
    })
  }
  return edges
}

// ---- Canvas <-> Workload Description ----

export function toWorkload(
  metadata: WorkloadMeta,
  defaults: WorkloadDefaults,
  nodes: CanvasNode[],
  wires: Wire[],
): WorkloadDescription {
  const functions: FunctionInstance[] = []
  const externals: WorkloadDescription['spec']['externals'] = []
  for (const n of nodes) {
    if (n.data.kind === 'ext') {
      const e = {
        id: n.id,
        kind: n.data.extKind,
        name: n.data.name,
        ...(n.data.notes ? { notes: n.data.notes } : {}),
        ...(n.data.reference?.value ? { reference: n.data.reference } : {}),
      }
      externals.push(e)
      continue
    }
    const d = n.data
    const fn: FunctionInstance = {
      id: n.id,
      type: d.type,
      typeVersion: d.typeVersion,
      name: d.name,
      domain: d.domain || DEFAULT_DOMAIN,
      parameters: d.parameters,
    }
    if (d.settings && Object.keys(d.settings).length) fn.settings = d.settings
    if (d.bindings && Object.keys(d.bindings).length) fn.bindings = d.bindings
    if (d.expectations && Object.keys(d.expectations).length) fn.expectations = d.expectations
    if (d.placement && Object.keys(d.placement).length) fn.placement = d.placement
    if (d.discovery) fn.discovery = d.discovery
    if (d.flowOptions && Object.keys(d.flowOptions).length) fn.flowOptions = d.flowOptions
    functions.push(fn)
  }
  const domains = [...new Set(functions.map((f) => f.domain))].sort().map((id) => ({ id }))
  return {
    apiVersion: API_VERSION,
    kind: 'MediaWorkload',
    metadata,
    spec: { defaults, domains, functions, externals, wires },
    layout: { nodes: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])) },
  }
}

export function fromWorkload(doc: WorkloadDescription): {
  metadata: WorkloadMeta
  defaults: WorkloadDefaults
  nodes: CanvasNode[]
  wires: Wire[]
} {
  const pos = (id: string, i: number) => doc.layout?.nodes[id] ?? { x: (i % 5) * 260, y: Math.floor(i / 5) * 200 }
  const fns: CanvasNode[] = doc.spec.functions.map((f, i) => ({
    id: f.id,
    type: 'fn',
    position: pos(f.id, i),
    data: {
      kind: 'fn',
      type: f.type,
      typeVersion: f.typeVersion,
      name: f.name,
      domain: f.domain,
      parameters: f.parameters ?? {},
      settings: f.settings ?? {},
      bindings: f.bindings,
      expectations: f.expectations,
      placement: f.placement,
      discovery: f.discovery,
      flowOptions: f.flowOptions,
    },
  }))
  const exts: CanvasNode[] = doc.spec.externals.map((e, i) => ({
    id: e.id,
    type: 'ext',
    position: pos(e.id, fns.length + i),
    data: { kind: 'ext', extKind: e.kind, name: e.name, notes: e.notes, reference: e.reference },
  }))
  const { revision: _revision, ...metadata } = doc.metadata
  return { metadata, defaults: doc.spec.defaults ?? DEFAULTS, nodes: [...fns, ...exts], wires: doc.spec.wires }
}

export function isWorkloadEnvelope(doc: unknown): doc is WorkloadDescription {
  const d = doc as WorkloadDescription
  return (
    d?.apiVersion === API_VERSION &&
    d.kind === 'MediaWorkload' &&
    typeof d.metadata?.id === 'string' &&
    Array.isArray(d.spec?.functions) &&
    Array.isArray(d.spec?.externals) &&
    Array.isArray(d.spec?.wires)
  )
}

// ---- Checks ----

// Problems that make a document invalid even as a draft (unknown parts, broken or illegal wires).
export function checkWorkload(doc: unknown, cat: Catalog = currentCatalog()): string[] {
  if (!isWorkloadEnvelope(doc)) {
    const v = (doc as WorkloadDescription)?.apiVersion
    return [v && v !== API_VERSION ? `unsupported apiVersion: ${v} (expected ${API_VERSION})` : 'not a MediaWorkload document']
  }
  const errors: string[] = []
  const nodes = new Map<string, CanvasNode>()
  const add = (n: CanvasNode) => {
    if (nodes.has(n.id)) errors.push(`duplicate id: ${n.id}`)
    nodes.set(n.id, n)
  }
  const { nodes: canvas } = fromWorkload(doc)
  for (const n of canvas) {
    add(n)
    if (n.data.kind === 'fn' && !moduleOf(n.data, cat)) errors.push(`${n.id}: unknown primitive ${n.data.type}@${n.data.typeVersion}`)
    if (n.data.kind === 'ext' && !EXTERNALS[n.data.extKind]) errors.push(`${n.id}: unknown external kind ${n.data.extKind}`)
  }
  const fed = new Set<string>()
  for (const w of doc.spec.wires) {
    if (typeof w?.from !== 'string' || typeof w?.to !== 'string' || !w.from.includes('/') || !w.to.includes('/')) {
      errors.push(`malformed wire ${JSON.stringify(w)}`)
      continue
    }
    const f = splitRef(w.from)
    const t = splitRef(w.to)
    const src = nodes.get(f.node)
    const dst = nodes.get(t.node)
    if (!src || !dst) {
      errors.push(`wire ${w.from} → ${w.to}: unknown node`)
      continue
    }
    if (fed.has(w.to)) errors.push(`${w.to} receives more than one wire`)
    fed.add(w.to)
    const o = portsOf(src.data, cat).find((p) => p.key === f.port)
    const i = portsOf(dst.data, cat).find((p) => p.key === t.port)
    if (!o || !i) {
      // Unknown primitives are already reported above.
      if ((src.data.kind === 'ext' || moduleOf(src.data, cat)) && (dst.data.kind === 'ext' || moduleOf(dst.data, cat)))
        errors.push(`wire ${w.from} → ${w.to}: unknown port`)
      continue
    }
    const why = wireMismatch(o, src.data.kind === 'ext', i, dst.data.kind === 'ext')
    if (why) errors.push(`wire ${w.from} → ${w.to}: ${why}`)
  }
  return errors
}

// Everything the orchestrator needs to be true before it can deploy the graph.
export function publishProblems(doc: WorkloadDescription, cat: Catalog = currentCatalog()): string[] {
  const errors = checkWorkload(doc, cat)
  if (errors.length) return errors
  if (!doc.spec.functions.length) return ['the workload has no functions']
  const fed = new Set(doc.spec.wires.map((w) => w.to))
  for (const f of doc.spec.functions) {
    const prim = cat.get(f.type, f.typeVersion)!
    errors.push(...validateValue(prim.parameters.schema, f.parameters).map((e) => `${f.id}: ${e}`))
    errors.push(...validateValue(settingsSchema(prim), f.settings ?? {}, 'settings').map((e) => `${f.id}: ${e}`))
    // '1' needs its wire; '1..n' needs at least one element of the array wired.
    const resolved = resolvePorts(prim.ports, f.parameters)
    for (const p of prim.ports.filter((q) => q.direction === 'in' && isRequired(q)))
      if (!resolved.some((r) => r.id === p.id && fed.has(ref(f.id, r.key))))
        errors.push(`${f.id}: input ${p.id} must be connected`)
    for (const d of prim.dependencies)
      if (d.required && !f.bindings?.[d.name]) errors.push(`${f.id}: dependency "${d.name}" (${d.kind}) must be bound`)
    for (const other of [...(f.placement?.with ?? []), ...(f.placement?.apart ?? [])])
      if (!doc.spec.functions.some((g) => g.id === other)) errors.push(`${f.id}: placement refers to unknown function ${other}`)
  }
  return errors
}

// ---- Desired state for the orchestrator ----

const DMF_NAMESPACE = '9e6d3b0a-7c1f-5d4e-8a2b-1f0c3d5e7a9b' // fixed namespace for workloads without a uid

export function workloadUid(meta: WorkloadMeta): string {
  return meta.uid ?? uuidV5(DMF_NAMESPACE, meta.id)
}

const RATES: Record<string, Rational> = {
  '25': { num: 25, den: 1 },
  '29.97': { num: 30000, den: 1001 },
  '50': { num: 50, den: 1 },
  '59.94': { num: 60000, den: 1001 },
  '60': { num: 60, den: 1 },
}

// Format of the flow written by `port`, from the writer's core parameters (e.g. a receiver's
// output video format) and the workload defaults. Becomes the NMOS-style flow_def.json.
function flowFormat(port: ResolvedPort, params: JsonValue, defaults: WorkloadDefaults): FlowFormat {
  const v = (getPath(params, 'video') ?? {}) as { [k: string]: JsonValue }
  const grainRate = RATES[String(v.rate)] ?? defaults.video.grainRate
  const mediaType = port.formats[0] ?? KNOWN_FORMATS[port.essence][0]
  if (port.essence === 'audio') {
    const channels = Number(getPath(params, 'audio.channels'))
    return { mediaType, sampleRate: defaults.audio.sampleRate, channelCount: channels > 0 ? channels : defaults.audio.channelCount }
  }
  if (port.essence === 'data') return { mediaType, grainRate }
  const [w, h] = String(v.frameSize ?? '').split('x').map(Number)
  return {
    mediaType,
    grainRate,
    frameWidth: w > 0 ? w : defaults.video.frameSize.width,
    frameHeight: h > 0 ? h : defaults.video.frameSize.height,
    interlace: v.scan === 'interlaced' ? 'interlaced' : 'progressive',
    colorspace: typeof v.colorspace === 'string' ? v.colorspace : defaults.video.colorspace,
    ...(typeof v.transfer === 'string' ? { transfer: v.transfer } : {}),
  }
}

// The MXL flows of the desired state: one per MXL output that something reads, with a stable id,
// its writer and readers, domain, format, history depth and discovery metadata.
export function flowsOf(doc: WorkloadDescription, cat: Catalog = currentCatalog()): FlowDef[] {
  const uid = workloadUid(doc.metadata)
  const historyMs = doc.spec.defaults.mxl?.historyMs ?? DEFAULT_HISTORY_MS
  const flows: FlowDef[] = []
  for (const f of doc.spec.functions) {
    const prim = cat.get(f.type, f.typeVersion)
    if (!prim) continue
    for (const port of resolvePorts(prim.ports, f.parameters)) {
      if (port.direction !== 'out' || port.transport !== 'mxl') continue
      const writer = ref(f.id, port.key)
      const readers = doc.spec.wires.filter((w) => w.from === writer).map((w) => w.to)
      if (!readers.length) continue
      const opts = f.flowOptions?.[port.key] ?? {}
      flows.push({
        id: uuidV5(uid, writer),
        label: writer,
        domain: f.domain,
        essence: port.essence,
        writer,
        readers,
        format: flowFormat(port, f.parameters, doc.spec.defaults),
        historyMs: opts.historyMs ?? historyMs,
        discovery: {
          register: opts.register ?? f.discovery?.register ?? !!prim.control.nmos,
          ...(opts.labels?.length ? { labels: opts.labels } : {}),
        },
      })
    }
  }
  return flows
}

// The desired state handed to the orchestrator: no canvas layout, stamped with its revision,
// with the MXL flow definitions and each function's resource profile and discovery settings.
export function toPublished(doc: WorkloadDescription, revision: number, cat: Catalog = currentCatalog()): WorkloadDescription {
  const { layout: _layout, ...rest } = doc
  const functions = doc.spec.functions.map((f) => {
    const prim = cat.get(f.type, f.typeVersion)
    return {
      ...f,
      ...(prim ? { parameters: withoutInapplicable(prim.parameters.schema, f.parameters) as FunctionInstance['parameters'] } : {}),
      discovery: f.discovery ?? { register: !!prim?.control.nmos },
      ...(prim?.resources ? { resources: prim.resources } : {}),
    }
  })
  return {
    ...rest,
    metadata: { ...doc.metadata, uid: workloadUid(doc.metadata), revision },
    spec: { ...doc.spec, functions, flows: flowsOf(doc, cat) },
  }
}
