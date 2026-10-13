# DMF Toolkit — Design Rules

**The single source for current design decisions.** When a rule changes, update it here and add
a line to the [decision log](#decision-log). Other docs hold detail: the orchestrator contract
(`orchestrator-contract.md`) and per-category primitive definitions (`primitives/*.md`).
`media-primitive.md` and `orchestration-model.md` are historical.

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

- **R3.1 Category → Primitive → Vendor module.** No generic layer.
  - *Category*: heading, e.g. Acquisition, Distribution.
  - *Primitive*: the base type of a function, with port templates and core parameters
    (`src/model/primitives.json`).
  - *Vendor module*: a deployable function from one vendor, built from a primitive.
- **R3.2 A module names its primitive in `role` and must conform to it:** exactly the
  primitive's ports for the chosen input type and protocol, and every core parameter kept with
  the same type (options may only narrow, nothing added).
  *Enforced by:* `conformance` (`src/model/catalog.ts`).
- **R3.3 One catalog per vendor.** The vendor name is mandatory and unique; catalog id =
  slug of the vendor name (e.g. "Acme Media" → `acme-media`). A module's vendor is its catalog's.
  *Enforced by:* `catalogProblems` (`src/model/modules.ts`), unique `catalogs.vendor` (`server/db.ts`).
- **R3.4 Type id = `<catalog>.<primitive>.<number>`**, numbered automatically with the next free
  number for that vendor and primitive (e.g. `acme-media.receiver.2`). *Duplicate* gets a new
  number; *New version* keeps it. *Enforced by:* `nextModuleId`, `catalogProblems`.
- **R3.5 Module versions are immutable once a saved workload uses them.** Changes go into a new
  version; instances can upgrade. *Enforced by:* `server/db.ts` (`isReferenced`).

## 4. What a module contains

- **R4.1 A module is:** identity & capability, media ports, core parameters, vendor settings
  (+ core → vendor mapping), control & health endpoints, dependencies, and an optional vendor
  resource profile.
- **R4.2 No placement or infrastructure on the module:** no image, licences, locality, edge
  interfaces or node constraints. Edge functions are inferred from external ports (`isEdge`).
- **R4.3 Resource profile = the vendor's declared needs** (CPU, memory, GPU, network, storage).
  It is a requirement for the orchestrator's sizing, not an allocation.
- **R4.4 Core parameters** are the primitive's common vocabulary: minimal, understood by the
  configurator (wiring, flow formats, vendor swaps).
- **R4.5 Vendor settings mirror the vendor's own configuration names and structure.** A mapping
  says where each core parameter lands, with optional value translation. Mapped keys are filled
  from the core value, so designers set each value once. The orchestrator passes the merged result
  through. *Enforced by:* `vendorSettingsProblems` (`catalog.ts`); `settingsSchema`, `vendorConfig` (`modules.ts`).
- **R4.6 New vendor features = a new module version.** Instances upgrade explicitly; the
  Inspector shows added and removed settings.

## 5. Parameters

- **R5.1 Core parameters follow the module's protocol.** Blocks marked `x-protocols` exist only
  on modules of that protocol. *Enforced by:* `coreSchemaFor` (`modules.ts`).
- **R5.2 Every parameter group says who uses it** (`x-audience`): *injected into the media
  function*, *for the orchestrator*, or *both*.
- **R5.3 Conditional fields** (`x-when`) are shown, and required if listed as required, only
  while their condition holds. Dotted keys (`srt.bonding`) refer to another group.
  *Enforced by:* `applies`, `validateValue` (`src/model/schema.ts`), `SchemaForm`.
- **R5.4 Dual paths are laid out as separate, parallel boxes** (Path A | Path B) in every group
  they affect (session, network constraints, payload), via `x-group` and `x-title-when`. Without
  a second path there is a single box (Connection / Network / Stream).
- **R5.5 Secrets are references** (`{"$secret": "name"}`), never values.
- **R5.6 Buffers are budgets, not sizes:** `maxLatencyMs`, flow `historyMs`.
- **R5.7 Required values without a default** (e.g. a port) are for the designer to fill in.
  Publishing is blocked until they're set.

## 6. Ports, wiring and flows

- **R6.1 Module ports are fixed by the primitive.** The author chooses only the input type
  (video feed or audio-only feed) and the one protocol. *Enforced by:* `portsFor`, `conformance`.
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
  (`uuidV5(workload uid, writer)`), writer, readers, domain, an NMOS-style format derived from the
  writer's settings and workload defaults, history depth and discovery metadata.
  *Enforced by:* `flowsOf` (`workload.ts`).
- **R6.7 A port can have two paths:**
  - **per module:** a 2022-7 receiver gets legs `.a` / `.b` (`dualFor`);
  - **per instance:** SRT bonding adds path B (`in.video` "SRT A" + `in.video.b` "SRT B",
    `dualWhen`). Path A keeps its wire when bonding is toggled.

  Both paths are required. *Enforced by:* `portsFor`, `resolvePorts`, `publishProblems`.

## 7. Receiver (Acquisition)

- **R7.1 A Receiver takes one external stream on one protocol and outputs MXL** (decoded and
  normalized): video, audio and ANC flows for a video feed, audio only for an audio feed.
- **R7.2 Protocols:** SRT, ZIXI, RIST, 2022-7, RTP, Raw UDP, RTMP. **One protocol per module**;
  a vendor supporting several protocols has one module per protocol.
- **R7.3 Parameters are defined per protocol, one at a time.** SRT is defined:
  - **SRT session** (*function*): mode, bonding, latency, encryption, passphrase (if
    encrypted), stream ID, MTU, plus per path port and remote address (if caller/rendezvous).
  - **Network constraints** (*orchestrator*): exposure, plus per path network, zone, VLAN.
  - **Expected payload** (*both*): per path bitrate (required), container, codecs.
  - The other protocols have no session parameters yet.

  Details: `primitives/acquisition.md`.

## 8. Workloads and publishing

- **R8.1 Every save is a new revision;** saves based on a stale revision are rejected.
- **R8.2 Publishing = a saved revision that passes every check,** served at
  `GET /api/workloads/:id/published`. *Enforced by:* `publishProblems`, `server/app.ts`.
- **R8.3 The workload description is the workflow intent** published to the orchestrator.

## 9. Storage and deployment of the tool

- **R9.1 One install per customer** (shared by that customer's team): library server + SQLite
  (`data/`, git-ignored). Schema migrations run automatically (now schema v4).
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

## Open questions

- Receiver vs Decoder: the Receiver now decodes compressed protocols. Is a separate Decoder
  still needed, and for what?
- 2022-7 receivers: which session parameters (SDP / addresses per leg, codec carried)?
- Session parameters for ZIXI, RIST, RTP, Raw UDP, RTMP.
- Should network constraints apply to every protocol, or be defined per protocol like the session?
- Decoder and Encoder still use the older three-port external bundles.
- Synchronizer scope (frame-rate conversion? ANC?).
