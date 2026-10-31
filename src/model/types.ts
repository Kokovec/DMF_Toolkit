// Core data model: primitives (base types per category), vendor modules (deployable catalog entries)
// and the published workload graph. Specs: docs/media-primitive.md, docs/primitives/.

export const API_VERSION = 'dmf-toolkit/v1alpha3'

// Ids of primitives, modules, ports, catalogs: lowercase letters, digits, . _ -
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

export type Essence = 'video' | 'audio' | 'data'
export const ESSENCES: Essence[] = ['video', 'audio', 'data']

export type Rational = { num: number; den: number }

// in: how many wires the port needs/accepts; 'n' = port array sized by a parameter.
export type Cardinality = '1' | '0..1' | '0..n' | '1..n'
export const CARDINALITIES: Cardinality[] = ['1', '0..1', '0..n', '1..n']

// IP-based only: the facility has no baseband (SDI) signals.
// Transports of external ports (streams entering or leaving the facility), by id, e.g. "srt".
// The list, labels and aliases are data: the `vocabulary` of the primitive library
// (src/model/vocabulary.ts). Inside the facility, between functions, media only travels as MXL.
export type ExternalTransport = string
export type Transport = 'mxl' | { external: ExternalTransport }

export const FLOW_FIELDS = ['frameSize', 'grainRate', 'interlace', 'colorspace', 'transfer', 'channelCount', 'sampleRate'] as const
export type FlowField = (typeof FLOW_FIELDS)[number]

export type Interlace = 'progressive' | 'interlaced_tff' | 'interlaced_bff'
export type Colorspace = 'BT709' | 'BT2020' | 'BT2100'
export type TransferCharacteristic = 'SDR' | 'HLG' | 'PQ'

export type PortConstraints = {
  grainRate?: Rational[]
  frameSize?: { width: number; height: number }[]
  interlace?: Interlace[]
  colorspace?: Colorspace[]
  transfer?: TransferCharacteristic[]
  componentLayout?: string[]
  sampleRate?: Rational[]
  channelCount?: { min: number; max: number }
  channelLayout?: string[]
}

export type PortDef = {
  id: string
  direction: 'in' | 'out'
  essence: Essence
  label?: string
  cardinality: Cardinality
  arraySize?: string // parameter path sizing a port array
  formats: string[] // media types, e.g. video/v210; empty = any (only on canvas externals)
  constraints?: PortConstraints
  timeContext?: string // ports with the same value share a time context (drawn as a bundle)
  transport: Transport
  // Second path per instance: while these parameter conditions hold (x-when style, dotted paths from
  // the parameters root), the port becomes path A (`<id>`) + path B (`<id>.b`), both required.
  dualWhen?: Record<string, (string | number | boolean)[]>
}

// The JSON Schema subset the tool understands for forms; vendors may use more.
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: (string | number)[]
  default?: JsonValue
  minimum?: number
  maximum?: number
  format?: string // 'secret-ref' marks a secret reference
  'x-protocols'?: string[] // property applies only to modules using one of these protocols
  // Shown (and, if listed in the parent's `required`, required) only while sibling properties have
  // one of the given values, e.g. { "mode": ["caller", "rendezvous"] }.
  'x-when'?: Record<string, (string | number | boolean)[]>
  // Who uses a parameter group: injected into the media function, or used by the orchestrator to
  // place, size, deploy and connect it.
  'x-audience'?: 'function' | 'orchestrator' | 'both'
  // Title used instead of `title` while a condition holds (same keys as x-when), e.g. "Path A" when bonded.
  'x-title-when'?: { when: Record<string, (string | number | boolean)[]>; title: string }[]
  // Consecutive sibling objects with the same group are laid out together (e.g. Path A | Path B).
  'x-group'?: string
  // This parameter defines part of the MXL flow format written by the function's outputs.
  'x-flow'?: FlowField
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Scaling = 'singleton' | 'scalable'

export type ControlApiType = 'nmos-is12' | 'rest' | 'grpc' | 'websocket'
export type HealthType = 'http' | 'tcp' | 'grpc' | 'exec'
export type DependencyKind = 'tams' | 'license-server' | 'storage' | 'device' | 'function'
export const DEPENDENCY_KINDS: DependencyKind[] = ['tams', 'license-server', 'storage', 'device', 'function']

// Something non-media a function instance cannot start without, and the facility resource it's bound to.
export type Dependency = {
  name: string
  kind: DependencyKind
  required: boolean
  role?: string // kind 'function': category of a function that must be up first
  binding?: string // facility resource name, e.g. "tams:main" (required ones must be bound to publish)
}

// How the orchestrator controls and health-checks a function instance.
export type ControlSpec = {
  api?: { type: ControlApiType; port: number; path?: string }
  nmos?: { registers: 'node' | 'device' }
  health?: { type: HealthType; port?: number; path?: string } // required to publish
}

// A media function product from one vendor (catalog entry), designed from library features. It
// describes what the function is and how it connects. Vendor settings, control & health,
// dependencies and resources are per instance (FunctionInstance); how and where it runs is the
// orchestrator's job. `ports` and `parameters` are derived from
// `design` (composeModule) and stored for the orchestrator's convenience.
export type VendorModule = {
  // 1. Identity & capability
  id: string
  version: string
  name: string
  description: string
  categories: string[] // palette headings it appears under (one or more)
  vendor: string
  product?: string
  productVersion?: string
  capability: { produces: Essence[]; consumes: Essence[]; scaling: Scaling }
  // 2. Design: the functions (blocks with add-ons) and module-wide features
  design: ModuleDesign
  // Derived from the design: ports and the core parameter schema (one group per block)
  ports: PortDef[]
  parameters: { schema: JsonSchema }
}

export type ModuleCatalog = {
  apiVersion: typeof API_VERSION
  kind: 'ModuleCatalog'
  metadata: { id: string; name: string; version: string; vendor: string } // one catalog per vendor
  spec: { modules: VendorModule[] }
}

// ---- Workload (the published graph) ----

// ---- Desired-state contract with the orchestrator (docs/orchestrator-contract.md) ----
// The configurator declares intent, requirements and constraints; the orchestrator decides and acts.

// What a function instance needs to run well (a requirement, not an allocation).
export type ResourceProfile = {
  cpu?: number // cores
  memoryMiB?: number
  gpu?: { class: string; count: number }
  networkMbps?: number
  storageGiB?: number
}

// What the operator expects of an instance; the orchestrator decides how to achieve it.
export type Expectations = {
  resilience?: 'none' | '1+1' | 'n+1'
  scaling?: 'fixed' | 'elastic'
}

// Placement preferences and constraints (never concrete hosts or addresses).
export type PlacementConstraints = {
  site?: string // preferred site / facility, e.g. "studio-a" or "venue"
  cluster?: string // preferred cluster
  environment?: 'any' | 'on-prem' | 'cloud'
  with?: string[] // instance ids to co-locate with (affinity)
  apart?: string[] // instance ids to keep apart from (anti-affinity)
  licensing?: string // e.g. "use site licence pool A"
}

// Discovery / control metadata: whether to register (e.g. NMOS IS-04) and labels/tags to publish.
export type Discovery = { register: boolean; labels?: string[] }

// Per-flow overrides set by the designer (everything else is derived).
export type FlowOptions = { historyMs?: number; register?: boolean; labels?: string[] }

// NMOS-flow-like format of an MXL flow (becomes flow_def.json).
export type FlowFormat = {
  mediaType: string
  grainRate?: Rational
  frameWidth?: number
  frameHeight?: number
  interlace?: 'progressive' | 'interlaced'
  colorspace?: string
  transfer?: string
  sampleRate?: Rational
  channelCount?: number
}

// One MXL flow of the desired state: a stable id, who writes it, who reads it, and its format.
export type FlowDef = {
  id: string // UUID, stable across revisions
  label: string // "<writer instance>/<port>"
  domain: string
  essence: Essence
  writer: string // "<instance>/<port>"
  readers: string[]
  format: FlowFormat
  historyMs: number // ring-buffer history the readers need
  discovery: Discovery
}

export type FunctionInstance = {
  id: string
  type: string
  typeVersion: string
  name: string
  domain: string
  parameters: { [key: string]: JsonValue } // core parameters
  inputs?: InputSelection // which input blocks this instance uses, and how many copies of each
  outputs?: OutputSelection // how many copies of each output block this instance runs (0 = off)
  settings?: { [key: string]: JsonValue } // the vendor's own configuration (free-form), passed through unchanged
  control?: ControlSpec
  dependencies?: Dependency[]
  expectations?: Expectations
  placement?: PlacementConstraints
  discovery?: Discovery
  flowOptions?: Record<string, FlowOptions> // by output port
  resources?: ResourceProfile // what this instance needs (a requirement for the orchestrator's sizing)
}

// Canvas-only devices outside the facility (not deployed).
export type ExternalKind = string // vocabulary.externals[].kind
// Logical identity of what is on the other end of an edge function. The orchestrator resolves it
// to addresses, SDP files and connections.
export type ExternalRefKind = string // vocabulary.references[].id
export type ExternalReference = {
  kind: ExternalRefKind
  value: string // NMOS sender/receiver id, SDP name/address, remote SRT/RIST host:port, Zixi stream, RTMP stream, NDI name
}
export type ExternalInstance = { id: string; kind: ExternalKind; name: string; notes?: string; reference?: ExternalReference }

// "instance/portId", e.g. "replay/rec.video[0]"
export type Wire = { from: string; to: string }

export type WorkloadDefaults = {
  video: { grainRate: Rational; frameSize: { width: number; height: number }; colorspace: Colorspace }
  audio: { sampleRate: Rational; channelCount: number }
  mxl?: { historyMs: number } // default flow history depth
}

export type WorkloadDescription = {
  apiVersion: typeof API_VERSION
  kind: 'MediaWorkload'
  // description = the workflow intent, e.g. "SRT ingress -> MXL -> switcher + multiviewer"
  // uid = stable identity of this workload (namespace for flow ids)
  // libraryVersion = primitive library version the published state was designed against
  metadata: { id: string; uid?: string; name: string; description?: string; revision?: number; libraryVersion?: string }
  spec: {
    defaults: WorkloadDefaults
    domains: { id: string }[]
    functions: FunctionInstance[]
    externals: ExternalInstance[]
    wires: Wire[] // connection graph, port -> port
    flows?: FlowDef[] // published only: the MXL flows derived from the wires
  }
  // Canvas-only presentation; stripped from the published graph.
  layout?: { nodes: Record<string, { x: number; y: number }> }
}

// ---- Feature library: the building blocks modules are designed from (src/model/library.json) ----

export type CategoryDef = { id: string; name: string; description: string }

// A building block or add-on, with its design rules. Data in the versioned library.
export type FeatureDef = {
  id: string // e.g. "input.srt", "option.bonding", "decoder", "codec.hevc", "output.mxl", "module.latency"
  name: string
  description: string
  group: string // sidebar group (featureGroups)
  // block: one function of the module; addon: dropped onto a block; module: module-wide;
  // option: built into the blocks that include it, set per instance in the workload designer
  kind: 'block' | 'addon' | 'module' | 'option'
  // block facing the outside world: one external port per block, protocol fixed by the feature
  external?: {
    direction: 'in' | 'out'
    protocol: ExternalTransport
    essenceOptions: Essence[] // the author picks per block: video feed (with its audio/ANC) or audio-only
    dual?: 'always' // two legs .a/.b (e.g. 2022-7)
    dualWhen?: Record<string, (string | number | boolean)[]> // second path per instance (block-relative keys)
  }
  mxlOutputs?: boolean // block publishes MXL flows (video/audio/ANC for a video feed)
  mxlInputs?: boolean // block reads MXL flows
  essence?: Essence // codec add-ons: video or audio codec
  includes?: string[] // block: options always part of it (e.g. SRT bonding, network constraints, payload)
  key?: string // parameter group name inside the block (e.g. "srt", "network")
  merge?: string // add-on / option: merge its parameters into this group of the block instead (e.g. bonding -> "srt")
  parameters?: { schema: JsonSchema }
  rules?: {
    attachTo?: string[] // add-on: feature ids it can attach to ("input.*" = any input)
    maxPerBlock?: number // add-on: how many times per block
    maxPerModule?: number
    needsAddon?: { group: string; min: number; message: string }[] // block: required add-ons
    // the module must also have a block matching one of these feature ids ("input.*" patterns),
    // e.g. SRT program outputs need a program encoder
    requires?: { anyOf: string[]; message: string }[]
  }
}

// One block of a module's design.
export type ModuleBlock = {
  id: string // e.g. "srt1"; prefixes the block's ports and parameters
  feature: string
  addons: string[]
  essence?: Essence // blocks with ports: video feed (with its audio/ANC) or audio-only feed
  scaleOut?: number // input and output blocks: up to this many copies per instance (default 1)
}

export type InputRule = 'one' | 'several'

// Copies of each input block an instance uses (block id -> count; 0 = not used).
export type InputSelection = Record<string, number>
// Copies of each output block an instance uses (block id -> count; 0 = not used).
export type OutputSelection = Record<string, number>

// The module's design: the functions it offers (blocks with their add-ons) and module-wide
// features. No wiring: how functions are used and configured is up to the workload.
export type ModuleDesign = {
  blocks: ModuleBlock[]
  moduleFeatures: string[]
  // Which inputs an instance may use: exactly one input block, or several (default). Each used
  // input can be scaled out up to its block's `scaleOut`. Chosen per instance in the workload.
  inputRule?: InputRule
  layout?: Record<string, { x: number; y: number }> // workspace positions (block id, or "module:<feature>")
}

// Shared vocabulary of the library: data, so new protocols, formats or device kinds need no code.
export type Vocabulary = {
  transports: { id: ExternalTransport; label: string; aliases?: string[] }[]
  formats: Record<Essence, string[]> // MXL media types per essence; the first is the default
  externals: { kind: ExternalKind; name: string; description: string; direction: 'in' | 'out'; essence: Essence }[]
  references: { id: ExternalRefKind; label: string; source: string; destination: string }[]
}

export type FeatureLibrary = {
  apiVersion: typeof API_VERSION
  kind: 'FeatureLibrary'
  metadata: { version: string; description?: string } // bump on every change
  spec: {
    vocabulary: Vocabulary
    categories: CategoryDef[]
    // Sidebar of the module designer: sections (e.g. Common, Production switcher), each with groups
    featureSections: { id: string; name: string; description?: string }[]
    featureGroups: { id: string; name: string; section: string; description?: string }[]
    features: FeatureDef[]
  }
}
