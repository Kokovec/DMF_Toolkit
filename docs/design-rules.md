# DMF Toolkit — Design Rules

**The single source for current design decisions.** When a rule changes, update it here and add
a line to the [decision log](#decision-log). Other docs hold detail: the orchestrator contract
(`orchestrator-contract.md`) and per-feature parameter detail (`primitives/*.md`, written when
primitives still existed; the parameters now live on features). `media-primitive.md` and
`orchestration-model.md` are historical.

"Enforced by" names the code that checks the rule. If a rule isn't enforced in code, it says so.

---

## 1. Roles

- **R1.1 The configurator is a high-level, declarative language; the DMF orchestrator is the
  compiler.** The configurator expresses the operator's intent as a desired state. The
  orchestrator reconciles that state with the running system. *(contract: `orchestrator-contract.md`)*
- **R1.2 The configurator never decides or does imperative work:** no container deployment,
  shared-memory mounting, connection setup, host choice, replica counts, licence assignment,
  addresses chosen for the facility, or buffer sizes.
- **R1.3 It does pass what the orchestrator needs to do that work:** workflow intent, parameters,
  MXL flow definitions, connection topology, resource **requirements**, scaling/resilience
  **expectations**, placement **constraints**, discovery metadata. These are requirements and
  preferences, never decisions.
- **R1.4 Only applicable settings are published.** Values hidden by a condition (e.g. path B
  while bonding is off) stay on the canvas but are dropped from the published state.
  *Enforced by:* `withoutInapplicable` in `toPublished` (`src/model/workload.ts`).

## 2. Scope

- **R2.1 IP-based signals only.** No SDI or other baseband anywhere.
  *Enforced by:* `ExternalTransport` (`src/model/types.ts`).
- **R2.2 Inside the facility, media travels only as MXL flows** between functions (containers).
  External protocols exist only on edge ports that face External devices.
  *Enforced by:* `wireMismatch` (`src/model/catalog.ts`).
- **R2.3 Codecs are not transports.** E.g. JPEG XS is a codec choice, not a protocol.

## 3. Hierarchy and identity

- **R3.1 Modules are designed from features; there are no primitives.** A vendor module starts
  blank and the author drags **features** from the library onto it (Modules tab → Design):
  - *block*: a stage of a signal chain: inputs (SRT, ZIXI, RIST, 2022-7, RTP, Raw UDP, RTMP),
    Decoder, MXL output;
  - *add-on*: dropped onto a block (codecs on a decoder);
  - *option*: built into a block, not placed by the author; its settings are chosen per instance
    in the workload designer (on every input: network constraints and expected payload; on SRT
    inputs also bonding). See R3.10;
  - *module-wide*: applies to the whole module (latency budget).

  Blocks are linked into **signal chains** (e.g. SRT input → Decoder → MXL output). A
  multi-function product has several chains in one module.
- **R3.2 A module is in one or more categories** (Acquisition, Distribution, …), which decide where
  it appears in the palette. *Enforced by:* `checkModule` (`src/model/catalog.ts`).
- **R3.8 Design rules live with the features in the library:** a link joins matching chain
  types (compressed stream → decoder → decoded media → MXL output), one input per block, no
  loops; `attachTo` (where an add-on may go), `maxPerBlock`, `maxPerModule`, `needsAddon` (e.g.
  a decoder needs at least one codec). Invalid drops and links are refused with the reason; unmet
  rules are listed live and block saving.
  *Enforced by:* `canAddFeature`, `canAttach`, `canLink`, `designProblems` (`src/model/compose.ts`).
- **R3.9 Ports and core parameters are derived from the design, never edited.** Each block's
  parameters sit under its block id (`srt1.srt.latencyMs`); its ports are prefixed with it
  (`srt1.in.video`, `mxl1.video`), and each MXL output block is its own time context. The server
  refuses a module whose stored ports or parameters differ from its design.
  *Enforced by:* `composeModule` (`compose.ts`), `withDerived` (`modules.ts`), `checkModule`.
- **R3.10 The module designer defines structure, not configuration.** It chooses features,
  add-ons, links and each input's feed type; it never sets parameter values (SRT session, bonding,
  network constraints, payload, formats…). Those are set per instance in the workload designer
  (Inspector). The designer only names the settings each block adds, and its node preview uses
  default parameters. *Enforced by:* `ModuleDesigner.tsx` (no parameter forms).
- **R3.3 One catalog per vendor.** The vendor name is mandatory and unique; catalog id =
  slug of the vendor name (e.g. "Acme Media" → `acme-media`). A module's vendor is its catalog's.
  *Enforced by:* `catalogProblems` (`src/model/modules.ts`), unique `catalogs.vendor` (`server/db.ts`).
- **R3.4 Type id = `<catalog>.<number>`**, numbered automatically with the next free number in
  the vendor's catalog (e.g. `acme-media.2`). *Duplicate* gets a new
  number; *New version* keeps it. *Enforced by:* `nextModuleId`, `catalogProblems`.
- **R3.6 Three layers: engine in code, vocabulary in the library, instances in the database.**
  - *Engine* (code): what the rule keywords mean, composition, wiring rules, identity, publish
    checks, flow derivation.
  - *Feature library* (`src/model/library.json`): categories, chain types, feature groups,
    features (parameters, ports, design rules) and the shared
    **vocabulary** (protocols with labels/aliases, MXL formats, External device kinds, reference
    kinds). New features, protocols, formats or device kinds need a library change only, no code.
    *Loaded by:* `src/model/library.ts`, `src/model/vocabulary.ts`.
  - *Database*: vendor catalogs and modules, workloads.
- **R3.7 The feature library is a versioned file in git, not editable in the UI.** It's the
  shared language with the orchestrator, so it changes deliberately and under review.
  `metadata.version` must be bumped on every change. The server records each version in the
  database at startup, refuses a changed file with an unchanged version, and serves it at
  `GET /api/library` (and `/api/library/:version`). Published workloads carry `libraryVersion`.
  *Enforced by:* `checkLibrary`, `Store.recordLibrary` (`server/db.ts`).
- **R3.5 Module versions are immutable once a saved workload uses them.** Changes go into a new
  version; instances can upgrade. *Enforced by:* `server/db.ts` (`isReferenced`).

## 4. What a module contains

- **R4.1 A module is only identity & categories and its design** (from which ports and core
  parameters follow). *Enforced by:* `VendorModule` (`types.ts`), `checkModule`.
- **R4.2 No placement or infrastructure on the module:** no image, licences, locality, edge
  interfaces or node constraints. Edge functions are inferred from external ports (`isEdge`).
- **R4.3 Each function instance carries its own setup**, set in the workload designer
  (Inspector): vendor settings, control & health endpoints, dependencies (each bound to a facility
  resource) and the resource profile. A health check is required, and so is a binding for every
  required dependency. *Enforced by:* `setupProblems` (`workload.ts`), `FunctionSetup.tsx`.
- **R4.4 Core parameters** are the features' common vocabulary: minimal, understood by the
  configurator (wiring, flow formats, vendor swaps).
- **R4.5 Vendor settings are free-form JSON in the vendor's own names and structure** (typed in or
  loaded from a file), passed through unchanged by the orchestrator. No schema and no core → vendor
  mapping: the orchestrator gets core parameters and vendor settings side by side.
- **R4.7 Resource profile = what the instance needs** (CPU, memory, GPU, network, storage): a
  requirement for the orchestrator's sizing, not an allocation.
- **R4.6 New vendor features = a new module version.** Instances upgrade explicitly; the
  Inspector shows added and removed parameters. An instance's own setup is kept on upgrade.

## 5. Parameters

- **R5.1 Core parameters follow the design:** each block contributes its feature's group plus
  its built-in options' and add-ons' groups (one with `merge` joins the block's group, e.g.
  bonding inside the SRT session). *Enforced by:* `composeModule` (`compose.ts`).
- **R5.2 Every parameter group says who uses it** (`x-audience`): *injected into the media
  function*, *for the orchestrator*, or *both*.
- **R5.3 Conditional fields** (`x-when`) are shown, and required if listed as required, only
  while their condition holds. Dotted keys (`srt.bonding`) refer to another group of the same
  block; composition prefixes them with the block id (`srt1.srt.bonding`).
  *Enforced by:* `applies`, `validateValue` (`src/model/schema.ts`), `SchemaForm`.
- **R5.4 Dual paths are laid out as separate, parallel boxes** (Path A | Path B) in every group
  they affect (session, network constraints, payload), via `x-group` and `x-title-when`. Without
  a second path there is a single box (Connection / Network / Stream).
- **R5.5 Secrets are references** (`{"$secret": "name"}`), never values.
- **R5.6 Buffers are budgets, not sizes:** `maxLatencyMs`, flow `historyMs`.
- **R5.7 Required values without a default** (e.g. a port) are for the designer to fill in.
  Publishing is blocked until they're set.

## 6. Ports, wiring and flows

- **R6.1 Module ports come from its blocks:** an input block gives one external port on its
  protocol (the author chooses video feed or audio-only feed); an MXL output block gives video,
  audio and ANC flows for a video feed upstream, audio only for an audio feed.
  *Enforced by:* `composeModule`.
- **R6.2 Flows are mono-essence;** a feed's video, audio and ANC flows share a time context and
  are drawn as one connection (expandable, to split audio from video).
- **R6.3 A wire is source port → destination port.** An output can feed many inputs (one flow,
  many readers); an input takes one wire. *Enforced by:* `planConnection`, `checkWorkload`.
- **R6.4 Wires are logical.** The configurator doesn't choose transports inside the facility; MXL
  connections are the orchestrator's job.
- **R6.5 External devices** (camera, microphone, source, destination) have one stream port, a
  video feed or an audio-only feed. They're never deployed. They're identified by a logical
  **reference** (NMOS id, SDP name/address, SRT party, ZIXI stream, RTMP stream, NDI name).
  External devices connect only to an edge function's external port.
- **R6.6 Every MXL output that's read becomes a published flow** with a stable UUID
  (`uuidV5(workload uid, writer)`), writer, readers, domain, an NMOS-style format, history depth
  and discovery metadata. The format comes from the writer's parameters tagged **`x-flow`**
  (frameSize, grainRate, interlace, colorspace, transfer, channelCount, sampleRate), else the
  workload defaults; no parameter names are hard-coded. Rates parse generically ("59.94" →
  60000/1001).
  *Enforced by:* `flowsOf` (`workload.ts`).
- **R6.7 A port can have two paths:**
  - **per module:** a 2022-7 input block gets legs `.a` / `.b` (feature `external.dual: always`);
  - **per instance:** an SRT input gets path B when bonding is turned on in the workload
    (`srt1.in.video` + `srt1.in.video.b`, `dualWhen`). Path A keeps its wire when bonding is toggled.

  Both paths are required. *Enforced by:* `composeModule`, `resolvePorts`, `publishProblems`.

## 7. Features defined so far

- **R7.1 Inputs** take one external stream on one protocol each: SRT, ZIXI, RIST, 2022-7, RTP,
  Raw UDP, RTMP. A product supporting several protocols gets several input blocks (in one module
  or several).
- **R7.2 SRT is fully defined:**
  - **SRT input** session (*function*): mode, latency, encryption, passphrase (if encrypted),
    stream ID, MTU, port and remote address (if caller/rendezvous);
  - **Bonding** option (merged into the session): none / broadcast / main-backup, with path B;
  - **Network constraints** option (*orchestrator*, every input): exposure, plus per path network,
    zone, VLAN;
  - **Expected payload** option (*both*, every input): per path bitrate (required), container, codecs.

  The other protocols have no session parameters yet. Details: `primitives/acquisition.md`.
- **R7.3 Decoder** turns a compressed stream into decoded media and needs at least one codec
  add-on (H.264, HEVC, JPEG XS, JPEG 2000, AV1, uncompressed; AAC, MPEG-1 Layer II, AC-3, E-AC-3,
  Opus, PCM). **MXL output** publishes decoded media as MXL flows with its format (`x-flow`).
  **Latency budget** is module-wide.

## 8. Workloads and publishing

- **R8.1 Every save is a new revision;** saves based on a stale revision are rejected.
- **R8.2 Publishing = a saved revision that passes every check,** served at
  `GET /api/workloads/:id/published`. *Enforced by:* `publishProblems`, `server/app.ts`.
- **R8.3 The workload description is the workflow intent** published to the orchestrator.

## 9. Storage and deployment of the tool

- **R9.1 One install per customer** (shared by that customer's team): library server + SQLite
  (`data/`, git-ignored). Schema migrations run automatically (now schema v8; v5 modules are converted to designs).
- **R9.2 Dark theme only.**

---

## Decision log

| Date | Decision | Notes / supersedes |
|---|---|---|
| 2026-10-08 | DMF = EBU Dynamic Media Facility (not Dynamics 365). The tool is the Design stage; its output is a vendor-neutral workload description | |
| 2026-10-08 | Wires are logical flows; transport is chosen downstream | Now R6.4 |
| 2026-10-08 | Audio travels with video as an `av` group | Superseded 10-09 by time-context bundles (R6.2) |
| 2026-10-09 | Library database: one install per customer, SQLite now (Postgres later), parts + workloads | R9.1 |
| 2026-10-09 | Media primitive spec v1 (six groups) adopted | Partly superseded 10-10 / 10-11; see `media-primitive.md` banner |
| 2026-10-09 | Generic placeholders allowed while drafting; concrete modules required to publish | Superseded 10-10 (no generic layer) |
| 2026-10-10 | Categories: Acquisition (Receivers, Decoders, Synchronizers), Distribution (Encoders) | Encoders moved from Acquisition; Decoders added |
| 2026-10-10 | Category → Primitive → Vendor module; no generic models | R3.1 |
| 2026-10-10 | One catalog per vendor; type id `<catalog>.<primitive>.<n>`, auto-numbered | R3.3, R3.4 |
| 2026-10-10 | Configurator = high-level language, orchestrator = compiler | R1.1 |
| 2026-10-10 | Placement removed from modules (image, compute, licences, locality, edge); replicas and mount paths removed | Resource needs return 10-11 as *requirements* (R4.3, R1.3) |
| 2026-10-10 | Infrastructure parameters removed from primitives (NICs, addresses for the facility, SDI cards, PTP domain, buffers, acceleration); sources identified by references on External devices | R1.2, R6.5 |
| 2026-10-10 | IP-based signals only; SDI removed | R2.1 |
| 2026-10-11 | Core parameters + vendor settings mirroring the vendor's own names, with mapping | R4.4, R4.5 |
| 2026-10-11 | Media between functions is MXL only | R2.2 |
| 2026-10-11 | Receiver: one input, one protocol per module; output locked to MXL; 2022-7 = two inputs | R6.1, R6.7, R7 |
| 2026-10-11 | Protocols: SRT, ZIXI, RIST, 2022-7, RTP, Raw UDP, RTMP. JPEG XS removed (a codec); "rUDP" corrected to Raw UDP | R7.2, R2.3 |
| 2026-10-11 | Roles refined: the desired state includes flow definitions with stable UUIDs, resource requirements, expectations, placement constraints and discovery | Reverses part of 10-10 (as requirements and constraints only) |
| 2026-10-11 | Parameters follow the protocol; split into function / orchestrator groups; SRT defined first | R5.1, R5.2, R7.3 |
| 2026-10-11 | SRT bonding (broadcast / main-backup) inside the SRT session, with per-path boxes in session, network constraints and payload | Replaced the "Dual-path" checkbox; R5.4 |
| 2026-10-11 | Incoming stream bitrate is required, per path, in Expected payload | Moved from network constraints |
| 2026-10-11 | Bonding adds a second input to the node (SRT A / SRT B) | R6.7 |
| 2026-10-13 | Design rules consolidated into this document | |
| 2026-10-13 | Engine in code, vocabulary in the library, instances in the database. Protocols, MXL formats, External device kinds and reference kinds moved into the library's `vocabulary`; flow formats come from `x-flow` tags | R3.6, R6.6 |
| 2026-10-13 | The primitive library stays a versioned file in git (not editable in the UI), recorded in the database at startup (schema v5), served at `/api/library`; published workloads carry `libraryVersion` | R3.7 |
| 2026-10-20 | Primitives removed. Modules are designed from drag-and-drop features (blocks, add-ons, module-wide) linked into signal chains inside the module, so multi-function products can be built from scratch | Supersedes Category → Primitive → Module and conformance (old R3.1, R3.2, R5.1, R6.1, R7); R3.1, R3.9 |
| 2026-10-20 | A module is in one or more categories (replaces `role`) | R3.2 |
| 2026-10-20 | Features and their design rules live in the versioned library file (`library.json` v2.0.0, `dmf-toolkit/v1alpha3`) | R3.6, R3.7, R3.8 |
| 2026-10-20 | Type id `<catalog>.<n>`; schema v6 converts existing receivers into SRT → Decoder (H.264, HEVC, AAC) → MXL designs | R3.4, R9.1 |
| 2026-10-20 | The module designer doesn't expose configuration (e.g. SRT settings); values are set in the workload designer | Removed the block try-out form; R3.10 |
| 2026-10-20 | Bonding, network constraints and expected payload are options of the input, chosen per instance in the workload designer, not add-ons placed in the module designer (library 2.1.0, schema v7) | R3.1, R7.2 |
| 2026-10-20 | Vendor settings, control & health, dependencies and resource profile moved from the module (Modules tab sections 3–6) to each function instance in the workload designer. Vendor settings become free-form JSON (no schema, no core → vendor mapping). Schema v8 copies each module's values onto its instances | Supersedes R4.1, R4.3, R4.5 as of 10-11; R4.3, R4.5, R4.7 |

## Open questions

- 2022-7 inputs: which session parameters (SDP / addresses per leg, codec carried)?
- Session parameters for ZIXI, RIST, RTP, Raw UDP, RTMP.
- Should network constraints apply to every protocol, or be defined per protocol like the session?
- Features still missing: MXL input, encoder and outputs (Distribution), synchronizer (scope:
  frame-rate conversion? ANC?), processing beyond decoding.
- Should a module's design be visible to the orchestrator (e.g. to place chains separately), or
  only its ports and parameters?
