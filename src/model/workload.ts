import type { Edge, Node } from '@xyflow/react'
import { currentCatalog, resolvePorts, wireMismatch, type Catalog, type ResolvedPort } from './catalog'
import { EXTERNALS } from './externals'
import { KNOWN_FORMATS } from './vocabulary'
import {
  featuresOf,
  featureSelectionProblems,
  inputBlocks,
  inputCopies,
  inputsOf,
  inputSelectionProblems,
  instanceDesign,
  instanceParts,
  outputBlocks,
  outputsOf,
  outputSelectionProblems,
  requiresProblems,
  type InstanceSelection,
} from './compose'
import { currentFacility, facilityProblems, productProblems, shapeProblems } from './facility'
import { LIBRARY, matchesFeature } from './library'
import { setupSchemaProblems, uniqueProblems } from './limits'
import { defaultsFor, getPath, leafPaths, optionPaths, validateValue, withoutInapplicable } from './schema'
import { uuidV5 } from './uuid'
import { toWorkloadXml, XmlEncodeError } from './xml'
import {
  API_VERSION,
  INSTANCE_ID_MAX,
  INSTANCE_ID_RE,
  DEPENDENCY_KINDS,
  type ControlSpec,
  type Dependency,
  type Discovery,
  type Essence,
  type Expectations,
  type ExternalKind,
  type ExternalReference,
  type Facility,
  type FlowDef,
  type FlowField,
  type FlowFormatField,
  type FlowFormat,
  type FlowOptions,
  type FeatureSelection,
  type FunctionInstance,
  type InputSelection,
  type OutputSelection,
  type JsonSchema,
  type JsonValue,
  type PlacementConstraints,
  type ResourceProfile,
  type Rational,
  type VendorModule,
  type Wire,
  type WorkloadDefaults,
  type WorkloadAccess,
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
  inputs?: InputSelection // input blocks used and their copies; absent = the module's default
  outputs?: OutputSelection // output blocks used and their copies; absent = the module's default
  features?: FeatureSelection // optional functions on or off; absent = the module's default
  settings: { [key: string]: JsonValue } // the vendor's own configuration (free-form)
  control?: ControlSpec
  dependencies?: Dependency[]
  resources?: ResourceProfile
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
  return prim ? resolvePorts(instanceParts(prim, sel(data)).ports, data.parameters) : []
}

// An instance's input/output selection.
const sel = (d: InstanceSelection): InstanceSelection => ({ inputs: d.inputs, outputs: d.outputs, features: d.features })

// The core parameter schema of one instance: only what it runs, repeated when scaled out.
export function schemaOf(prim: VendorModule, data: InstanceSelection): JsonSchema {
  return instanceParts(prim, sel(data)).schema
}

// Change what an instance runs: parameters follow (new copies and functions start from defaults,
// values of blocks that stay keep theirs). Wires to ports that go away are pruned by the caller.
export function withSelection(data: FnData, prim: VendorModule, chosen: InstanceSelection): FnData {
  const next = { ...data, ...chosen }
  return { ...next, parameters: carryOver(instanceParts(prim, sel(next)).schema, data.parameters) }
}

export function ref(node: string, port: string) {
  return `${node}/${port}`
}

export function splitRef(r: string): { node: string; port: string } {
  const i = r.indexOf('/')
  return { node: r.slice(0, i), port: r.slice(i + 1) }
}

// Readable, stable ids ("vision-mixer-2") so the graph reads like source code.
// A new, unused instance id "<base>-<n>". The base is reduced to what an id allows (lowercase letters,
// digits, -) and shortened so the id stays within INSTANCE_ID_MAX.
export function nextNodeId(base: string, existing: Iterable<string>): string {
  const ids = new Set(existing)
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'fn'
  let n = 1
  const id = () => `${clean.slice(0, INSTANCE_ID_MAX - String(n).length - 1).replace(/-+$/, '')}-${n}`
  while (ids.has(id())) n++
  return id()
}

// What the user types as a workload id, reduced to the characters an id allows. The result can still
// be invalid while typing (e.g. a trailing -); checkWorkload says so.
export function toInstanceId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, INSTANCE_ID_MAX)
}

const idProblem = (what: string, id: string) =>
  INSTANCE_ID_RE.test(id) ? [] : [`${what} id "${id}" must be lowercase letters, digits and -, not starting or ending with -, at most ${INSTANCE_ID_MAX} characters`]

// `over` on top of `base`, object by object.
function merged(base: { [k: string]: JsonValue }, over: { [k: string]: JsonValue }): { [k: string]: JsonValue } {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    const isObject = (x: JsonValue) => !!x && typeof x === 'object' && !Array.isArray(x)
    out[k] = b !== undefined && isObject(b) && isObject(v) ? merged(b as { [k: string]: JsonValue }, v as { [k: string]: JsonValue }) : structuredClone(v)
  }
  return out
}

export function newFunctionData(prim: VendorModule, name: string): FnData {
  return {
    kind: 'fn',
    type: prim.id,
    typeVersion: prim.version,
    name,
    domain: DEFAULT_DOMAIN,
    parameters: merged((defaultsFor(instanceParts(prim, {}).schema) as { [k: string]: JsonValue }) ?? {}, prim.defaults?.parameters ?? {}),
    settings: {},
    // The module's starting values; what it doesn't say keeps the general defaults.
    ...(prim.defaults?.inputs ? { inputs: inputsOf(prim) } : {}),
    ...(prim.defaults?.outputs ? { outputs: outputsOf(prim) } : {}),
    control: structuredClone(prim.defaults?.control) ?? { health: { type: 'http', port: 8080, path: '/healthz' } },
    ...(prim.defaults?.resources ? { resources: structuredClone(prim.defaults.resources) } : {}),
    ...(prim.defaults?.discovery ? { discovery: structuredClone(prim.defaults.discovery) } : {}),
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

// Switch an instance to another module: core parameters carry over where the new module has the
// same blocks and keys (same feature vocabulary). The instance's own setup (vendor settings,
// control & health, dependencies, resources) stays as it is.
export function rebind(data: FnData, prim: VendorModule): FnData {
  // selections carry over if the new module still accepts them, else its defaults apply
  const inputs = data.inputs && !inputSelectionProblems(prim, data.inputs).length ? data.inputs : undefined
  const outputs = data.outputs && !outputSelectionProblems(prim, data.outputs).length ? data.outputs : undefined
  const features = data.features && !featureSelectionProblems(prim, data.features).length ? data.features : undefined
  return { ...data, type: prim.id, typeVersion: prim.version, inputs, outputs, features, parameters: carryOver(instanceParts(prim, { inputs, outputs, features }).schema, data.parameters) }
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
  access?: WorkloadAccess,
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
    if (d.inputs) fn.inputs = d.inputs
    if (d.outputs) fn.outputs = d.outputs
    if (d.features && Object.keys(d.features).length) fn.features = d.features
    if (d.settings && Object.keys(d.settings).length) fn.settings = d.settings
    if (d.control && Object.keys(d.control).length) fn.control = d.control
    if (d.dependencies?.length) fn.dependencies = d.dependencies
    if (d.resources && Object.keys(d.resources).length) fn.resources = d.resources
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
    spec: { defaults, domains, functions, externals, wires, ...(access?.roles && Object.keys(access.roles).length ? { access } : {}) },
    layout: { nodes: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])) },
  }
}

export function fromWorkload(doc: WorkloadDescription): {
  metadata: WorkloadMeta
  defaults: WorkloadDefaults
  nodes: CanvasNode[]
  wires: Wire[]
  access?: WorkloadAccess
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
      inputs: f.inputs,
      outputs: f.outputs,
      features: f.features,
      settings: f.settings ?? {},
      control: f.control,
      dependencies: f.dependencies,
      resources: f.resources,
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
  return { metadata, defaults: doc.spec.defaults ?? DEFAULTS, nodes: [...fns, ...exts], wires: doc.spec.wires, access: doc.spec.access }
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
  const errors: string[] = [...idProblem('workload', doc.metadata.id)]
  for (const f of doc.spec.functions) errors.push(...idProblem('function', f.id))
  for (const x of doc.spec.externals) errors.push(...idProblem('external device', x.id))
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

// Everything the orchestrator needs to be true before it can deploy the graph, on this facility
// (what it doesn't offer; nothing with no facility set) and within the products' limits.
export function publishProblems(doc: WorkloadDescription, cat: Catalog = currentCatalog(), facility: Facility = currentFacility()): string[] {
  const errors = checkWorkload(doc, cat)
  if (errors.length) return errors
  if (!doc.spec.functions.length) return ['the workload has no functions']
  const fed = new Set(doc.spec.wires.map((w) => w.to))
  for (const f of doc.spec.functions) {
    const prim = cat.get(f.type, f.typeVersion)!
    const parts = instanceParts(prim, sel(f))
    errors.push(...inputSelectionProblems(prim, f.inputs).map((e) => `${f.id}: ${e}`))
    errors.push(...outputSelectionProblems(prim, f.outputs).map((e) => `${f.id}: ${e}`))
    errors.push(...featureSelectionProblems(prim, f.features).map((e) => `${f.id}: ${e}`))
    // what's left on must still have what it needs (e.g. SCTE-104 with no MXL copy in use)
    errors.push(...requiresProblems(instanceDesign(prim, sel(f))).map((e) => `${f.id}: features: ${e}`))
    errors.push(...optionProblems(prim, f).map((e) => `${f.id}: ${e}`))
    // what the facility doesn't offer (R8.8), and what the product can't do (e.g. RTMP with HEVC)
    errors.push(...facilityProblems(prim, f, facility).map((e) => `${f.id}: ${e}`))
    errors.push(...productProblems(prim, f).map((e) => `${f.id}: ${e}`))
    // what the product accepts beyond each value (R8.9)
    errors.push(...uniqueProblems(prim, f).map((e) => `${f.id}: ${e}`))
    errors.push(...setupSchemaProblems(prim, f).map((e) => `${f.id}: ${e}`))
    errors.push(...validateValue(parts.schema, f.parameters).map((e) => `${f.id}: ${e}`))
    errors.push(...setupProblems(f).map((e) => `${f.id}: ${e}`))
    // '1' needs its wire (each path, when a port has two); '1..n' needs at least one array element wired.
    const resolved = resolvePorts(parts.ports, f.parameters)
    for (const r of resolved)
      if (r.direction === 'in' && r.cardinality === '1' && !fed.has(ref(f.id, r.key)))
        errors.push(`${f.id}: input ${r.label && r.key !== r.id ? `${r.key} (${r.label})` : r.key} must be connected`)
    for (const p of parts.ports.filter((q) => q.direction === 'in' && q.cardinality === '1..n'))
      if (!resolved.some((r) => r.id === p.id && fed.has(ref(f.id, r.key))))
        errors.push(`${f.id}: input ${p.id} must be connected`)
    for (const other of [...(f.placement?.with ?? []), ...(f.placement?.apart ?? [])])
      if (!doc.spec.functions.some((g) => g.id === other)) errors.push(`${f.id}: placement refers to unknown function ${other}`)
  }
  errors.push(...flowRuleProblems(doc, cat))
  errors.push(...shapeProblems(doc, facility))
  errors.push(...accessProblems(doc.spec.access))
  errors.push(...historyProblems(doc))
  // What the XML can't carry (characters XML 1.0 lacks, unencodable keys, tokens not in normal form),
  // with the serialiser's own location text, so the JSON route, the XML route and the canvas agree.
  // Checked once everything else holds: the published form needs a valid document.
  if (!errors.length) {
    try {
      toWorkloadXml(toPublished(doc, doc.metadata.revision ?? 1, cat))
    } catch (e) {
      if (!(e instanceof XmlEncodeError)) throw e
      errors.push(...e.problems)
    }
  }
  return errors
}

// MXL history depth is at least 1 ms, the workload default and every flow option.
function historyProblems(doc: WorkloadDescription): string[] {
  const bad = (v: unknown) => v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1)
  return [
    ...(bad(doc.spec.defaults.mxl?.historyMs) ? [`spec.defaults.mxl.historyMs: must be a whole number ≥ 1`] : []),
    ...doc.spec.functions.flatMap((f) =>
      Object.entries(f.flowOptions ?? {}).flatMap(([port, o]) => (bad(o.historyMs) ? [`${f.id}: flow ${port}: historyMs must be a whole number ≥ 1`] : [])),
    ),
  ]
}

// An instance's own setup: vendor settings, control & health, dependencies, resources.
export function setupProblems(f: Pick<FunctionInstance, 'settings' | 'control' | 'dependencies' | 'resources'>): string[] {
  const errors: string[] = []
  if (f.settings !== undefined && (typeof f.settings !== 'object' || f.settings === null || Array.isArray(f.settings)))
    errors.push('vendor settings must be a JSON object')
  const c = f.control ?? {}
  if (!c.health || !['http', 'tcp', 'grpc', 'exec'].includes(c.health.type)) errors.push('a health check is required (http, tcp, grpc or exec)')
  if (c.api && (!['nmos-is12', 'rest', 'grpc', 'websocket'].includes(c.api.type) || !(c.api.port > 0))) errors.push('control API needs a type and port')
  if (c.nmos && !['node', 'device'].includes(c.nmos.registers)) errors.push('NMOS registers must be node or device')
  const names = new Set<string>()
  for (const d of f.dependencies ?? []) {
    if (!d?.name || names.has(d.name)) errors.push('dependency names must be present and unique')
    names.add(d?.name)
    if (!DEPENDENCY_KINDS.includes(d?.kind)) errors.push(`dependency ${d?.name}: invalid kind`)
    if (d?.kind === 'function' && !d.role) errors.push(`dependency ${d.name}: kind function needs a category`)
    if (d?.required && !d.binding) errors.push(`dependency "${d.name}" (${d.kind}) must be bound`)
  }
  for (const [k, v] of Object.entries(f.resources ?? {}))
    if (k === 'gpu' ? !(v as { class?: string })?.class : typeof v !== 'number' || v < 0) errors.push(`resources: invalid ${k}`)
  return errors
}

// An instance's discovery settings: its own, else the module's starting values, else whether it
// registers itself.
export function discoveryOf(prim: VendorModule | undefined, f: Pick<FunctionInstance, 'discovery' | 'control'>): Discovery {
  return f.discovery ?? prim?.defaults?.discovery ?? { register: !!f.control?.nmos }
}

// Fields whose choices are the instance's input copies must name a copy in use.
function optionProblems(prim: VendorModule, f: FunctionInstance): string[] {
  const parts = instanceParts(prim, sel(f))
  const copies = inputCopies(prim, sel(f)).map((c) => c.id)
  return optionPaths(parts.schema).flatMap(({ path, emptyLabel }) => {
    const v = getPath(f.parameters, path)
    // with an empty meaning (e.g. "this source"), empty is allowed too
    return v === undefined || (emptyLabel && v === '') || copies.includes(String(v)) ? [] : [`${path}: "${String(v)}" isn't an input copy in use (${copies.join(', ') || 'none'})`]
  })
}

// Only what the instance runs and what applies: a group for something it doesn't run is dropped.
function publishedParameters(schema: JsonSchema, parameters: FunctionInstance['parameters']): FunctionInstance['parameters'] {
  const running = Object.fromEntries(Object.entries(parameters).filter(([k]) => schema.properties?.[k]))
  return withoutInapplicable(schema, running) as FunctionInstance['parameters']
}

// An unset field of that kind means the first copy: published explicitly.
function withResolvedOptions(prim: VendorModule, f: FunctionInstance, parameters: FunctionInstance['parameters']): FunctionInstance['parameters'] {
  const first = inputCopies(prim, sel(f))[0]?.id
  if (!first) return parameters
  const out = structuredClone(parameters)
  for (const { path, emptyLabel } of optionPaths(instanceParts(prim, sel(f)).schema)) {
    // unset means something of its own (e.g. this source), not the first copy
    if (emptyLabel || getPath(out, path) !== undefined) continue
    const keys = path.split('.')
    let cur = out
    for (const k of keys.slice(0, -1)) {
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
      cur = cur[k] as { [k: string]: JsonValue }
    }
    cur[keys[keys.length - 1]] = first
  }
  return out
}

// Who may operate the workload: required roles filled, known roles, valid usernames.
export function accessProblems(access: WorkloadAccess | undefined): string[] {
  const { roles, usernamePattern } = LIBRARY.spec.vocabulary.access
  const pattern = new RegExp(usernamePattern)
  const errors: string[] = []
  for (const r of roles) if (r.required && !access?.roles?.[r.id]?.length) errors.push(`access: a ${r.id} is required`)
  for (const [role, users] of Object.entries(access?.roles ?? {})) {
    if (!roles.some((r) => r.id === role)) errors.push(`access: unknown role "${role}"`)
    for (const u of users) if (!pattern.test(u)) errors.push(`access: "${u}" (${role}) isn't a valid username`)
  }
  return errors
}

// ---- Desired state for the orchestrator ----

const DMF_NAMESPACE = '9e6d3b0a-7c1f-5d4e-8a2b-1f0c3d5e7a9b' // fixed namespace for workloads without a uid

export function workloadUid(meta: WorkloadMeta): string {
  return meta.uid ?? uuidV5(DMF_NAMESPACE, meta.id)
}

// A rate from a parameter value: "50" -> 50/1, "59.94" -> 60000/1001 (NTSC-style rates are
// x/1.001), "60000/1001" -> as given. Undefined if the value isn't a rate (e.g. "source").
export function parseRate(value: unknown): Rational | undefined {
  const text = String(value ?? '').trim()
  const frac = text.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (frac) return { num: Number(frac[1]), den: Number(frac[2]) }
  const v = Number(text)
  if (!text || !Number.isFinite(v) || v <= 0) return undefined
  if (Number.isInteger(v)) return { num: v, den: 1 }
  const ntsc = Math.round(v * 1.001) // 59.94 -> 60, 29.97 -> 30, 23.976 -> 24
  if (Math.abs(ntsc / 1.001 - v) < 0.01) return { num: ntsc * 1000, den: 1001 }
  return { num: Math.round(v * 1000), den: 1000 }
}

// The writer's parameter values tagged with x-flow, e.g. { frameSize: "3840x2160", grainRate: "59.94" }.
export function flowValues(schema: JsonSchema, params: JsonValue): Partial<Record<FlowField, JsonValue>> {
  const out: Partial<Record<FlowField, JsonValue>> = {}
  const walk = (node: JsonSchema, path: string) => {
    const field = node['x-flow']
    if (field) {
      const v = getPath(params, path)
      if (v !== undefined) out[field] = v
    }
    for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${k}` : k)
  }
  walk(schema, '')
  return out
}

// Format of the flow written by `port`: the writer's parameters tagged with `x-flow` (e.g. a
// receiver's output video format), else the workload defaults. Becomes the NMOS-style flow_def.json.
function flowFormat(port: ResolvedPort, schema: JsonSchema, params: JsonValue, defaults: WorkloadDefaults): FlowFormat {
  // A designed module's MXL output port "<block>.<essence>" takes its format from its own block.
  const block = port.id.slice(0, port.id.indexOf('.'))
  const own = block && schema.properties?.[block]
  const v = own ? flowValues(own, getPath(params, block) ?? {}) : flowValues(schema, params)
  const mediaType = port.formats[0] ?? KNOWN_FORMATS[port.essence][0]
  const grainRate = parseRate(v.grainRate) ?? defaults.video.grainRate
  if (port.essence === 'audio') {
    const channels = Number(v.channelCount)
    return {
      mediaType,
      sampleRate: parseRate(v.sampleRate) ?? defaults.audio.sampleRate,
      channelCount: channels > 0 ? channels : defaults.audio.channelCount,
    }
  }
  if (port.essence === 'data') return { mediaType, grainRate }
  const [w, h] = String(v.frameSize ?? '').split('x').map(Number)
  return {
    mediaType,
    grainRate,
    frameWidth: w > 0 ? w : defaults.video.frameSize.width,
    frameHeight: h > 0 ? h : defaults.video.frameSize.height,
    interlace: String(v.interlace ?? '').startsWith('interlaced') ? 'interlaced' : 'progressive',
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
    const parts = instanceParts(prim, sel(f))
    for (const port of resolvePorts(parts.ports, f.parameters)) {
      if (port.direction !== 'out' || port.transport !== 'mxl') continue
      const writer = ref(f.id, port.key)
      const readers = doc.spec.wires.filter((w) => w.from === writer).map((w) => w.to)
      // The writer needs the definition of its video and audio flows even if nobody reads them yet;
      // a data flow exists only when read.
      if (!readers.length && port.essence === 'data') continue
      const opts = f.flowOptions?.[port.key] ?? {}
      flows.push({
        id: uuidV5(uid, writer),
        label: writer,
        domain: f.domain,
        essence: port.essence,
        writer,
        readers,
        format: flowFormat(port, parts.schema, f.parameters, doc.spec.defaults),
        historyMs: opts.historyMs ?? historyMs,
        discovery: {
          register: opts.register ?? discoveryOf(prim, f).register,
          ...(opts.labels?.length ? { labels: opts.labels } : {}),
        },
      })
    }
  }
  return flows
}

// A rate as people write it: 30000/1001 → "29.97", 25/1 → "25".
function rateName(r: Rational | undefined): string {
  if (!r) return 'missing'
  if (r.den === 1) return String(r.num)
  if (r.den === 1001) return String(Number((r.num / 1001).toFixed(3)))
  return `${r.num}/${r.den}`
}

const FORMAT_NAMES: Record<FlowFormatField, string> = {
  mediaType: 'media type',
  frameSize: 'frame size',
  grainRate: 'rate',
  interlace: 'scan',
  colorspace: 'colorspace',
  transfer: 'transfer',
  sampleRate: 'sample rate',
  channelCount: 'channel count',
}

// MXL blocks with `readsFrom` / `flowFormat` (R8.9): the flows each copy reads or writes have a format
// it accepts (a field "function" = the function's own x-flow value, e.g. a switcher's programme
// format), and what it reads comes from a function of an allowed type. Named on the copy, as the
// compiler does: "vision-mixer: mxl-src_2: flow cam2/mxl.video rate is 29.97, the function's is 25".
export function flowRuleProblems(doc: WorkloadDescription, cat: Catalog = currentCatalog()): string[] {
  const flows = new Map(flowsOf(doc, cat).map((f) => [f.writer, f]))
  const types = new Map(doc.spec.functions.map((f) => [f.id, f.type]))
  const errors: string[] = []
  for (const f of doc.spec.functions) {
    const prim = cat.get(f.type, f.typeVersion)
    if (!prim) continue
    const parts = instanceParts(prim, sel(f))
    const own = flowValues(parts.schema, f.parameters)
    for (const b of instanceDesign(prim, sel(f)).blocks) {
      if (!b.flowFormat && !b.readsFrom) continue
      for (const port of parts.ports.filter((p) => p.transport === 'mxl' && p.id.startsWith(`${b.id}.`))) {
        const at = (msg: string) => errors.push(`${f.id}: ${msg}`)
        let flow: FlowDef | undefined
        if (port.direction === 'in') {
          const wire = doc.spec.wires.find((w) => w.to === ref(f.id, port.id))
          if (!wire) continue
          flow = flows.get(wire.from)
          const writer = splitRef(wire.from).node
          if (b.readsFrom && port.essence === 'video' && !b.readsFrom.some((p) => matchesFeature(p, types.get(writer) ?? '')))
            at(`${port.id}: is wired from ${writer} (${types.get(writer) ?? 'an external device'}), and ${b.id} reads only from ${b.readsFrom.join(', ')}`)
        } else flow = flows.get(ref(f.id, port.id))
        const rule = flow && b.flowFormat?.[flow.essence as 'video' | 'audio']
        if (!flow || !rule) continue
        const fmt = flow.format
        const actual: Record<FlowFormatField, string | undefined> = {
          mediaType: fmt.mediaType,
          frameSize: fmt.frameWidth !== undefined ? `${fmt.frameWidth}x${fmt.frameHeight}` : undefined,
          grainRate: fmt.grainRate && rateName(fmt.grainRate),
          interlace: fmt.interlace,
          colorspace: fmt.colorspace,
          transfer: fmt.transfer,
          sampleRate: fmt.sampleRate && rateName(fmt.sampleRate),
          channelCount: fmt.channelCount?.toString(),
        }
        for (const [field, allowed] of Object.entries(rule) as [FlowFormatField, (string | number)[] | 'function'][]) {
          const value = actual[field]
          if (value === undefined && field === 'transfer') continue // not stated: SDR
          if (allowed === 'function') {
            const mine = own[field as FlowField]
            if (mine === undefined) continue
            const same = field === 'grainRate' ? rateName(parseRate(mine)) === value : String(mine) === value
            if (!same) at(`${b.id}: flow ${flow.label} ${FORMAT_NAMES[field]} is ${value ?? 'missing'}, the function's is ${field === 'grainRate' ? rateName(parseRate(mine)) : String(mine)}`)
          } else {
            const ok = allowed.map((a) => (field === 'grainRate' || field === 'sampleRate' ? rateName(parseRate(a)) : String(a)))
            if (value === undefined || !ok.includes(value)) at(`${b.id}: flow ${flow.label} ${FORMAT_NAMES[field]} is ${value ?? 'missing'}, must be ${ok.join(' or ')}`)
          }
        }
      }
    }
  }
  return errors
}

// The desired state handed to the orchestrator: no canvas layout, stamped with its revision,
// with the MXL flow definitions and each function's resource profile and discovery settings.
export function toPublished(doc: WorkloadDescription, revision: number, cat: Catalog = currentCatalog()): WorkloadDescription {
  const { layout: _layout, ...rest } = doc
  // flowOptions are resolved into `flows`, so they aren't published (and the XML doesn't carry them)
  const functions = doc.spec.functions.map(({ flowOptions: _flowOptions, ...f }) => {
    const prim = cat.get(f.type, f.typeVersion)
    return {
      ...f,
      ...(prim
        ? {
            parameters: withResolvedOptions(prim, f, publishedParameters(instanceParts(prim, sel(f)).schema, f.parameters)),
            // the selections in force, so the orchestrator knows what to run and how many
            ...(inputBlocks(prim.design).length ? { inputs: inputsOf(prim, f.inputs) } : {}),
            ...(outputBlocks(prim.design).length ? { outputs: outputsOf(prim, f.outputs) } : {}),
            ...(Object.keys(featuresOf(prim)).length ? { features: featuresOf(prim, f.features) } : {}),
          }
        : {}),
      discovery: discoveryOf(prim, f),
    }
  })
  return {
    ...rest,
    metadata: { ...doc.metadata, uid: workloadUid(doc.metadata), revision, libraryVersion: LIBRARY.metadata.version },
    spec: { ...doc.spec, functions, flows: flowsOf(doc, cat) },
  }
}
