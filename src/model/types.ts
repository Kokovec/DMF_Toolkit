// Core data model: primitives (base types per category), vendor modules (deployable catalog entries)
// and the published workload graph. Specs: docs/media-primitive.md, docs/primitives/.

export const API_VERSION = 'dmf-toolkit/v1alpha4'

// Ids of primitives, modules, ports, catalogs: lowercase letters, digits, . _ -
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/ // catalogs and modules (e.g. switchframe.1)
// Workloads, function instances and external devices: the XML schema's `Id`, which also fits a
// Kubernetes name as `wl-<id>`. At most 42 characters.
export const INSTANCE_ID_RE = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/
export const INSTANCE_ID_MAX = 42

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
  exclusiveMinimum?: number // numbers must be greater than this
  'x-maxBytes'?: number // text: at most this many bytes as UTF-8 (a product's limit, not characters)
  'x-patternMessage'?: string // what to say when `pattern` doesn't match, instead of the expression
  format?: string // 'secret-ref' marks a secret reference
  pattern?: string // string values must match this regular expression
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
  // On a parameter group: which combinations of two of its fields are valid (see XAllowed).
  'x-allowed'?: XAllowed
  // The choices aren't fixed: they come from the instance. "inputs" = its input copies in use.
  'x-options'?: 'inputs'
  // With x-options: unset (or empty) is allowed and means this, e.g. "This source"; it isn't
  // resolved to the first choice when publishing.
  'x-emptyLabel'?: string
  // The value must differ between the copies of this block in one function, e.g. an SRT stream ID.
  'x-unique'?: boolean
  // At most the facility's limit of this name (its export's `limits`), checked only while a facility
  // is set, e.g. "maxRecordingGiB".
  'x-facilityLimit'?: string
  // Values that need facility capabilities (vocabulary.capabilities), e.g. { "neural": ["neural-key"] }.
  // A facility that lacks one doesn't offer the value; with no facility set, every value is offered.
  'x-enumNeeds'?: Record<string, string[]>
}

// Valid combinations of two fields of a group: values[<first field's value>] = the second field's
// valid values. `message` is the refusal, with {field} replaced by a field's value and
// {field.height} by the height of a WxH value, e.g. "{resolution.height}p{rate} is not a format".
export type XAllowed = { fields: [string, string]; values: Record<string, string[]>; message?: string }

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
  // Starting values for a new instance (not infrastructure decisions). Inputs and outputs not
  // listed start unused.
  defaults?: {
    inputs?: InputSelection
    outputs?: OutputSelection
    control?: ControlSpec
    resources?: ResourceProfile
    discovery?: Discovery
    parameters?: { [block: string]: JsonValue } // over the schema's defaults, for a new instance only
    // Help shown with a starting value, e.g. what the default resource profile covers
    notes?: { resources?: string }
  }
  // What the product accepts in an instance's own setup: known vendor settings keys (other keys
  // pass through unchecked, R4.5) and the resource profile, e.g. at least 512 MiB of memory.
  setupSchema?: { settings?: JsonSchema; resources?: JsonSchema }
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
  features?: FeatureSelection // which optional functions and add-ons are on
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

// Usernames per role. Whether a user exists is checked at deployment.
export type WorkloadAccess = { roles?: Record<string, string[]> }

export type WorkloadDescription = {
  apiVersion: typeof API_VERSION
  kind: 'MediaWorkload'
  // description = the workflow intent, e.g. "SRT ingress -> MXL -> switcher + multiviewer"
  // uid = stable identity of this workload (namespace for flow ids)
  // libraryVersion = feature library version the published state was designed against
  metadata: { id: string; uid?: string; name: string; description?: string; revision?: number; libraryVersion?: string }
  spec: {
    defaults: WorkloadDefaults
    domains: { id: string }[]
    functions: FunctionInstance[]
    externals: ExternalInstance[]
    wires: Wire[] // connection graph, port -> port
    flows?: FlowDef[] // published only: the MXL flows derived from the wires
    access?: WorkloadAccess // who may operate the workload
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
  // Facility capabilities (vocabulary.capabilities) this feature needs to run. A facility that
  // lacks one doesn't offer it; with no facility set, it's offered.
  needs?: string[]
  rules?: {
    attachTo?: string[] // add-on: feature ids it can attach to ("input.*" = any input)
    maxPerBlock?: number // add-on: how many times per block
    maxPerModule?: number
    needsAddon?: { group: string; min: number; message: string }[] // block: required add-ons
    // the module must also have a block matching one of these feature ids ("input.*" patterns),
    // e.g. SRT program outputs need a program encoder
    requires?: { anyOf: string[]; message: string }[]
    // Product limits: the block can't run while another function of the instance has one of these
    // values (its block-relative parameter `path`, default if unset). `message` may use {value}.
    conflictsWith?: { feature: string; path: string; values: (string | number | boolean)[]; message: string }[]
  }
}

// One block of a module's design.
export type ModuleBlock = {
  id: string // e.g. "srt1"; prefixes the block's ports and parameters
  feature: string
  addons: string[]
  essence?: Essence // blocks with ports: video feed (with its audio/ANC) or audio-only feed
  scaleOut?: number // input and output blocks: up to this many copies per instance (default 1)
  noData?: boolean // MXL blocks: a video feed has video and audio flows and no data flow
  // Other functions an instance can turn off: the block itself, and add-ons by add-on key.
  optional?: { default: boolean; addons?: Record<string, boolean> }
  // Narrows a parameter group of this product, by its path in the block (e.g. "format.video"):
  // the product only offers these combinations of what the shared feature allows.
  allowed?: Record<string, XAllowed>
  // MXL input blocks: the functions it can read from, by module type pattern ("dmf-mxl.*").
  readsFrom?: string[]
  // MXL blocks: the formats of the flows it reads or writes (see FlowFormatRule).
  flowFormat?: Partial<Record<'video' | 'audio', FlowFormatRule>>
}

// Per flow field: the values allowed (as text: "progressive", "48000", 2), or "function": the same
// as the function's own format (its parameters tagged x-flow, e.g. a switcher's programme format).
// A transfer the flow doesn't state passes. Fields: mediaType, frameSize ("WxH"), grainRate,
// interlace, colorspace, transfer, sampleRate, channelCount.
export type FlowFormatRule = Partial<Record<FlowFormatField, (string | number)[] | 'function'>>
export type FlowFormatField = 'mediaType' | 'frameSize' | 'grainRate' | 'interlace' | 'colorspace' | 'transfer' | 'sampleRate' | 'channelCount'

export type InputRule = 'one' | 'several'

// Copies of each input block an instance uses (block id -> count; 0 = not used).
export type InputSelection = Record<string, number>
// Copies of each output block an instance uses (block id -> count; 0 = not used).
export type OutputSelection = Record<string, number>
// Optional functions of an instance, on or off, by block id or "<block>.<add-on key>".
export type FeatureSelection = Record<string, boolean>

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
  // Who can be given access to a workload: the roles offered (at least one user each if required)
  access: { roles: { id: string; label: string; required?: boolean }[]; usernamePattern: string }
  // What a facility can declare it runs (the keys of its export, `make facility-export`). Features
  // and values that need one are offered only if the facility has it (or no facility is set).
  capabilities: { id: string; label: string; description: string }[]
}

// What the facility declares it can run, from the orchestrator's export (DMF_FACILITY on the
// server, GET /api/facility). Empty = no facility set: everything is offered.
export type Facility = { name?: string; capabilities?: Record<string, boolean>; limits?: FacilityLimits }
// The facility's limits: numbers named by parameters (`x-facilityLimit`, e.g. maxRecordingGiB) and the
// workload's shape: how many functions of a type ({min, max}) and how many MXL domains.
export type FacilityLimits = {
  functionsPerWorkload?: Record<string, { min?: number; max?: number }>
  domainsPerWorkload?: number
  [name: string]: number | Record<string, { min?: number; max?: number }> | undefined
}

export type FeatureLibrary = {
  apiVersion: typeof API_VERSION
  kind: 'FeatureLibrary'
  metadata: { version: string; description?: string } // bump on every change
  spec: {
    vocabulary: Vocabulary
    categories: CategoryDef[]
    // How features are organised: sections (e.g. Common, Production switcher), each with groups
    featureSections: { id: string; name: string; description?: string }[]
    featureGroups: { id: string; name: string; section: string; description?: string }[]
    features: FeatureDef[]
  }
}
