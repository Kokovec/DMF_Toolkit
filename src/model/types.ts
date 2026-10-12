// Core data model: primitives (base types per category), vendor modules (deployable catalog entries)
// and the published workload graph. Specs: docs/media-primitive.md, docs/primitives/.

export const API_VERSION = 'dmf-toolkit/v1alpha2'

// Ids of primitives, modules, ports, catalogs: lowercase letters, digits, . _ -
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

export type Essence = 'video' | 'audio' | 'data'
export const ESSENCES: Essence[] = ['video', 'audio', 'data']

export type Rational = { num: number; den: number }

// in: how many wires the port needs/accepts; 'n' = port array sized by a parameter.
export type Cardinality = '1' | '0..1' | '0..n' | '1..n'
export const CARDINALITIES: Cardinality[] = ['1', '0..1', '0..n', '1..n']

// IP-based only: the facility has no baseband (SDI) signals.
// Transports of external ports (streams entering or leaving the facility). Inside the facility,
// between functions, media only travels as MXL flows.
export type ExternalTransport =
  | 'srt'
  | 'zixi'
  | 'rist'
  | 'st2022-7'
  | 'rtp'
  | 'udp' // raw UDP (e.g. MPEG-TS over UDP): no packet recovery
  | 'rtmp'
  | 'st2110'
  | 'ndi'
  | 'file'
  | 'tams'
export const EXTERNAL_TRANSPORTS: ExternalTransport[] = ['srt', 'zixi', 'rist', 'st2022-7', 'rtp', 'udp', 'rtmp', 'st2110', 'ndi', 'file', 'tams']
export const TRANSPORT_LABELS: Record<ExternalTransport, string> = {
  srt: 'SRT',
  zixi: 'ZIXI',
  rist: 'RIST',
  'st2022-7': '2022-7',
  rtp: 'RTP',
  udp: 'Raw UDP',
  rtmp: 'RTMP',
  st2110: 'ST 2110',
  ndi: 'NDI',
  file: 'File',
  tams: 'TAMS',
}
export type Transport = 'mxl' | { external: ExternalTransport }

// A parameter value naming a protocol ("Raw UDP", "2022-7", or an id like "udp-ts") -> transport id.
// (JPEG XS is a codec, not a protocol: ST 2110-22 carries it over the ST 2110 / RTP family.)
const TRANSPORT_ALIASES: Record<string, ExternalTransport> = {
  ...Object.fromEntries(Object.entries(TRANSPORT_LABELS).map(([id, label]) => [label, id as ExternalTransport])),
  'st2110-22': 'st2110',
  ipmx: 'st2110',
  'rtp-ts': 'rtp',
  'udp-ts': 'udp',
}
export function transportOf(value: unknown): ExternalTransport | undefined {
  const v = String(value)
  return TRANSPORT_ALIASES[v] ?? (EXTERNAL_TRANSPORTS.includes(v as ExternalTransport) ? (v as ExternalTransport) : undefined)
}

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
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Scaling = 'singleton' | 'scalable'

export type ControlApiType = 'nmos-is12' | 'rest' | 'grpc' | 'websocket'
export type HealthType = 'http' | 'tcp' | 'grpc' | 'exec'
export type DependencyKind = 'tams' | 'license-server' | 'storage' | 'device' | 'function'
export const DEPENDENCY_KINDS: DependencyKind[] = ['tams', 'license-server', 'storage', 'device', 'function']

export type Dependency = {
  name: string // slot name, bound per instance
  kind: DependencyKind
  required: boolean
  role?: string // kind 'function': primitive that must be up first
}

// Where a core parameter goes in the vendor's configuration: `core` and `vendor` are dot paths;
// `values` translates core values into the vendor's (e.g. "1920x1080" -> 3). Mapped vendor keys
// are filled from the core value, so designers never set them twice.
export type CoreMapping = { core: string; vendor: string; values?: Record<string, JsonValue> }

// A media function from one vendor, built from a primitive (catalog entry). It describes what the
// function is and how it connects; how and where it runs (image, compute, licences, placement)
// is the orchestrator's job (decision 2026-10-10).
export type VendorModule = {
  // 1. Identity & capability
  id: string
  version: string
  name: string
  description: string
  role: string
  vendor: string
  product?: string
  productVersion?: string
  capability: { produces: Essence[]; consumes: Essence[]; scaling: Scaling }
  // 2. Media ports
  ports: PortDef[]
  // 3. Core parameters: the primitive's common vocabulary (may only narrow). The configurator
  //    understands these (wiring, formats, vendor swaps).
  parameters: { schema: JsonSchema }
  // 4. Vendor settings: the vendor's own configuration, mirrored with its own names and structure,
  //    plus how core parameters land in it. The orchestrator passes settings through unchanged.
  vendorSettings: { schema: JsonSchema; mapping: CoreMapping[] }
  // 5. Control & health
  control: {
    api?: { type: ControlApiType; port: number; path?: string }
    nmos?: { registers: 'node' | 'device' }
    health: { type: HealthType; port?: number; path?: string }
  }
  // Vendor-declared resource profile (requirement for the orchestrator's sizing)
  resources?: ResourceProfile
  // 6. Dependencies
  dependencies: Dependency[]
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

// What a function needs to run well, as declared by the vendor (a requirement, not an allocation).
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
  settings?: { [key: string]: JsonValue } // vendor settings (vendor's own names); mapped keys omitted
  bindings?: Record<string, string> // dependency slot -> facility resource name
  expectations?: Expectations
  placement?: PlacementConstraints
  discovery?: Discovery
  flowOptions?: Record<string, FlowOptions> // by output port
  resources?: ResourceProfile // published: the module's profile, for the orchestrator's sizing
}

// Canvas-only devices outside the facility (not deployed).
export type ExternalKind = 'camera' | 'microphone' | 'source' | 'destination'
// Logical identity of what is on the other end of an edge function. The orchestrator resolves it
// to addresses, SDP files and connections.
export type ExternalRefKind = 'nmos' | 'sdp' | 'srt' | 'zixi' | 'rtmp' | 'ndi'
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
  metadata: { id: string; uid?: string; name: string; description?: string; revision?: number }
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

// ---- Primitives: base types per category, from which vendor modules are built ----
// (A VendorModule is built from a primitive; its `role` names the primitive.)

export type CategoryDef = { id: string; name: string; description: string }

// Port shape of a primitive. `side: 'external'` = faces the outside world; the module picks
// the transport (ST 2110, SRT, …) and formats.
export type PortTemplate = {
  id: string
  direction: 'in' | 'out'
  essence: Essence
  label?: string
  cardinality: Cardinality
  arraySize?: string
  timeContext?: string
  side: 'external' | 'mxl'
  // External port whose essence the module author picks: the module's port id becomes
  // "<id>.<essence>", e.g. "in" -> "in.video" (video feed with its audio/ANC) or "in.audio".
  essenceOptions?: Essence[]
  // Protocols that need two legs on this port (seamless protection, e.g. ST 2022-7): the port
  // becomes "<id>.a" and "<id>.b", both required.
  dualFor?: ExternalTransport[]
  // Only present when the module's chosen input essence is one of these (e.g. out.video only
  // for video feeds).
  whenInput?: Essence[]
}

export type PrimitiveDef = {
  id: string // "<category>.<name>", e.g. "acquisition.receiver"; models use it as their role
  category: string
  name: string // singular, e.g. "Receiver"
  plural: string // sub-heading, e.g. "Receivers"
  description: string
  ports: PortTemplate[]
  // Protocols a module may choose for its external ports (one per module); default: all.
  protocols?: ExternalTransport[]
  parameters: { schema: JsonSchema } // shared by every module of this primitive
}

export type PrimitiveLibrary = {
  apiVersion: typeof API_VERSION
  kind: 'PrimitiveLibrary'
  spec: { categories: CategoryDef[]; primitives: PrimitiveDef[] }
}
