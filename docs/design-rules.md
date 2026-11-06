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

- **R3.1 Every module models a real product; there is no module designer.** A product's module
  is defined in its company's catalog file (`catalogs/<company>.catalog.json`, built by
  `scripts/product-catalogs.ts`), which the server loads at every start (a catalog that can't be
  loaded is reported and skipped); other catalogs can be imported from the Palette. Its design lists the product's
  functions as library **features**:
  - *block*: one function of the product: inputs, decoder, encoder, outputs, internal features (R7);
  - *add-on*: attached to a block (codecs on a decoder or encoder; speech-to-text on captions);
  - *option*: built into a block (per-source setup, audio channel, key; network constraints,
    expected payload, SRT bonding);
  - *module-wide*: applies to the whole module (latency budget).

  There is **no wiring between a module's functions**; how the functions are used and
  configured is set per instance in the workload (R8.4).
- **R3.2 The palette is organised by company:** one heading per company (the catalog's vendor),
  with its products (modules) under it: Switchframe → Switchframe; DMF MXL → the test sources (R7.8). A module's
  categories (Acquisition, Distribution, Production…) remain descriptive tags (tooltip), not palette
  headings. *Enforced by:* `Catalog.byCompany` (`catalog.ts`), `Palette.tsx`; categories: `checkModule`.
- **R3.8 Design rules live with the features in the library:** `attachTo` (where an add-on may
  go), `maxPerBlock`, `maxPerModule`, `needsAddon` (e.g. a decoder needs at least one codec).
  A product module that breaks them is refused on import.
  *Enforced by:* `canAttach`, `designProblems` (`src/model/compose.ts`), `checkCatalog`.
- **R3.9 Ports and core parameters are derived from the design, never edited.** Each block's
  parameters sit under its block id (`srt1.srt.latencyMs`); its ports are prefixed with it
  (`srt1.in.video`, `mxl1.video`), and each MXL output block is its own time context. The server
  refuses a module whose stored ports or parameters differ from its design.
  *Enforced by:* `composeModule` (`compose.ts`), `withDerived` (`modules.ts`), `checkModule`.
- **R3.12 Input rules come with the product; each instance chooses within them.** A product with
  several inputs uses **exactly one input per instance** or **several inputs per instance** (of
  different types; the default), and each input can **scale out** up to a maximum number of copies
  per instance (1 = no scaling). In the workload, each instance picks its inputs and how many of
  each (default: the first input for "one", every input once for "several"). Unused inputs have no
  ports or settings; each copy gets its own ports and settings (`srt1`, `srt1_2`, `srt1_3`…). A
  module's `defaults.inputs` overrides that starting point (what it doesn't list starts unused). The
  published function carries the selection in force (`inputs`). Outputs: R3.15.
  *Enforced by:* `designProblems`, `inputSelectionProblems`, `instanceParts` (`compose.ts`);
  `withSelection`, `publishProblems` (`workload.ts`); Inputs tab (`FunctionDialog.tsx`).
- **R3.13 The feature library is organised in sections, each with groups:** *Common* (inputs, processing, codecs, outputs, packaging, module-wide) and
  *Production switcher* (switcher inputs, source options, outputs, features, add-ons).
  Module categories (tags): Acquisition, Distribution, Production.
  *Enforced by:* `checkLibrary` (`library.ts`).
- **R3.14 A feature can require another function in the module** (`rules.requires`: any of these
  feature ids), e.g. SRT/RTMP program outputs and recording need a program encoder; SCTE-104 needs
  an MXL source. *Enforced by:* `designProblems` (`compose.ts`).
- **R3.15 Outputs scale out too.** An output block has a scale-out maximum like an input. Each
  instance runs every output once by default (or as the module's `defaults.outputs` says) and can
  turn an output off (0) or run several copies (e.g. several SRT destinations), each with its own
  ports and settings. The published function carries `outputs`. Functions without ports (e.g.
  recording) aren't counted: they're turned off with R3.16.
  *Enforced by:* `outputSelectionProblems`, `instanceParts` (`compose.ts`); Outputs tab (`FunctionDialog.tsx`).
- **R3.16 Other functions and add-ons can be optional** (`ModuleBlock.optional`: a default, and add-ons
  by add-on key). Each instance turns them on or off (`features`, by block id or `<block>.<add-on
  key>`); a function that's off has no tab, no parameters and isn't published, and an add-on of a
  function that's off is off. Inputs and outputs use copies instead. What's left on must still have
  what it requires (R3.14), checked per instance. The published function always carries the full
  selection in force. *Enforced by:* `featuresOf`, `featureSelectionProblems`, `instanceDesign`
  (`compose.ts`); `publishProblems`, `toPublished` (`workload.ts`); Features section (`FunctionDialog.tsx`).
- **R3.3 One catalog per vendor.** The vendor name is mandatory and unique; catalog id =
  slug of the vendor name (e.g. "Acme Media" → `acme-media`). A module's vendor is its catalog's.
  *Enforced by:* `catalogProblems` (`src/model/modules.ts`), unique `catalogs.vendor` (`server/db.ts`).
- **R3.4 Type id = `<catalog>.<number>`** (e.g. `switchframe.1`), set in the product catalog. A new
  release of the product's module keeps its number with a new version. *Enforced by:* `catalogProblems`.
- **R3.6 Three layers: engine in code, vocabulary in the library, instances in the database.**
  - *Engine* (code): what the rule keywords mean, composition, wiring rules, identity, publish
    checks, flow derivation.
  - *Feature library* (`src/model/library.json`): categories, feature groups,
    features (parameters, ports, design rules) and the shared
    **vocabulary** (protocols with labels/aliases, MXL formats, External device kinds, reference
    kinds, access roles). New features, protocols, formats or device kinds need a library change only, no code.
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

- **R4.1 A module is only identity & categories, its design** (from which ports and core
  parameters follow) **and starting values for a new instance** (`defaults`: inputs, outputs,
  control, resources, discovery, and parameters over the schema's defaults; these aren't
  infrastructure decisions, an instance can change them, and they apply only when it's created).
  *Enforced by:* `VendorModule` (`types.ts`), `checkModule`, `newFunctionData`.
- **R4.2 No placement or infrastructure on the module:** no image, licences, locality, edge
  interfaces or node constraints. Edge functions are inferred from external ports (`isEdge`).
- **R4.3 Each function instance carries its own setup**, set in the workload designer
  (function dialog, Setup tab): vendor settings, control & health endpoints, dependencies (each bound to a facility
  resource) and the resource profile. They start from the module's `defaults`, else a health check of
  `http 8080 /healthz`. A health check is required, and so is a binding for every required dependency. *Enforced by:* `setupProblems` (`workload.ts`), `FunctionSetup.tsx`.
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
- **R5.6 Buffers are budgets, not sizes:** `maxLatencyMs`, flow `historyMs`. MXL history is at least
  1 ms (whole milliseconds), as the workload default and as each flow's option.
  *Enforced by:* `historyProblems` (`workload.ts`), the Workload panel and Flow panel inputs.
- **R5.7 Required values without a default** (e.g. a port) are for the designer to fill in.
  Publishing is blocked until they're set.
- **R5.8 A parameter group can list the valid combinations of two fields** (`x-allowed`), so a choice
  that's valid alone but not together is refused with a message naming the values (e.g. "2160p24 is
  not a Switchframe format"), and the form offers only the valid values. A product can narrow a
  shared feature the same way (`ModuleBlock.allowed`, by group path); if only one combination
  is left, it becomes the default. *Enforced by:* `allowedProblem`, `validateValue`, `allowedChoices`
  (`schema.ts`); `blockSchema` (`compose.ts`); `SchemaForm`.
- **R5.9 A field's choices can come from the instance** (`x-options: "inputs"`: its input copies in
  use). It must name a copy in use; unset means the first, and is published explicitly.
  *Enforced by:* `optionPaths` (`schema.ts`), `optionProblems`, `withResolvedOptions` (`workload.ts`), `SchemaForm`.

## 6. Ports, wiring and flows

- **R6.1 Module ports come from its blocks:** an input or output block gives one external port on
  its protocol; an MXL input or output block gives video, audio and ANC flows. For each, the
  author chooses a video feed (with its audio and ANC) or an audio-only feed. A product whose MXL
  block has no data flow says so (`ModuleBlock.noData`): it has video and audio ports and no ANC port,
  so dragging a bundle can't create a data wire. *Enforced by:* `composeModule`, `designProblems`.
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
- **R6.6 The video and audio flows of every MXL output in use are always published** (a writer
  needs its flow definition whether or not anything reads it yet, so `readers` may be empty); a data
  flow only when read. Each has a stable UUID
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
  Raw UDP, RTMP, RTMPS, TSoIP, HLS (pull), ST 2110, ST 2022-6, NDI. The **MXL input** reads flows
  from inside the facility (for output or processing products). A product supporting several
  protocols gets several input blocks (in one module or several).
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
- **R7.4 Encoder** turns media into a compressed stream and needs at least one codec add-on (the
  same codec add-ons attach to a decoder or an encoder).
- **R7.5 Outputs** send the stream on one protocol each: TSoIP, MBTS (multi-bitrate TS), SRT,
  RIST, ZIXI, RTMPS; **packaging outputs**: HLS, DASH, CMAF, ATSC 3.0. They connect to External
  Destinations (reference kind *HTTP origin / CDN* for HLS, DASH and CMAF). No parameters yet.
- **R7.6 The I/O set follows the Ateme TITAN Live datasheet (2026)** as a reference product.
  Its SDI input is left out (R2.1).
- **R7.7 Production switcher features follow the open-source Switchframe switcher** (2026): inputs
  SRT (listener / caller), MoQ, MXL, ST 2110; outputs SRT (caller / listener), RTMP, MXL,
  ST 2110, recording; features switching engine (programme format and timing), program encoder,
  captions (+ AI speech-to-text), SCTE-35 (+ SCTE-104), replay, clip players, playout, control room,
  and the live-operated ones (transitions, audio mixer, keyers & DVE, graphics, colour grading,
  ST map, AI background removal, comms). Only real deploy-time settings are parameters;
  live-operated features have none. Ports, TLS, state/cache paths, DPDK, GPU builds and
  active-active pairs are the orchestrator's. Mapping to the product: `products/switchframe.md`;
  example module: `catalogs/switchframe.catalog.json`.
  Per source (every switcher input): label, multiview position, alignment delay; audio channel
  (trim, audio-follow-video, delay, high-pass, gate, 3-band EQ, compressor); upstream key
  (chroma / luma / neural). Feature settings come from Switchframe's flags and from the API calls
  that are configuration (format, captions mode, speech-to-text, master limiter, SCTE-35 default
  rule, replay shutter angle, destinations, recording); run-time calls are excluded. Security
  settings (API and invite tokens, allowed origins) are the orchestrator's, not module settings.
  An SRT source's stream ID is required in both modes (`^[A-Za-z0-9_-]{1,64}$`), and its caller
  address is `host:port` (`^[A-Za-z0-9.-]+:[0-9]{1,5}$`); recording declares its storage
  (`storageGiB`, for the orchestrator) and rotates files at least every 1 minute (the product treats
  0 as 60); the SCTE-35 default rule is `pass` or `drop` (the product can't default to `rewrite`).
  Values follow the product's request bodies, checked against its source at the pinned commit. Captions are turned off with the feature toggle,
  so their mode has no `off`. The MXL program output has no data flow (`noData`): at the pinned commit
  the product passes no data writer to it, so its attempts to write captions and SCTE-104 fail
  ("no data writer set"). MXL sources keep their optional ANC port, which it reads: that's where
  SCTE-104 comes from, translated to SCTE-35.
  Discovery defaults to `register: true` without `control.nmos`: the product doesn't register
  itself, the facility's flow agent registers every flow.
- **R7.8 Test sources are products too:** company **DMF MXL**, `dmf-mxl.1` "MXL test source"
  (`mxl-gst-testsrc`: a `test.pattern` block and an MXL output) and `dmf-mxl.2` "A/V sync test
  source" (`mxl-syncgen`: an MXL output, fixed at 1080p29.97 by R5.8). Neither writes data
  (`noData`). `dmf-mxl.1` starts at 1080p29.97 through its `defaults.parameters`, matching a new
  Switchframe engine; the shared `output.mxl` default is unchanged. Patterns are GStreamer
  `videotestsrc` nicknames, confirmed against its documentation (2026-11-02).

## 8. Workloads and publishing

- **R8.1 Every save is a new revision;** saves based on a stale revision are rejected.
- **R8.2 Publishing = a saved revision that passes every check,** served at
  `GET /api/workloads/:id/published`. *Enforced by:* `publishProblems`, `server/app.ts`.
- **R8.6 The orchestrator reads the published revision as XML** (`GET
  /api/workloads/:id/published.xml[?revision=N]`, `application/xml; charset=utf-8`; *Publish XML* in
  the app downloads `<workload id>.workload.xml`). It's a lossless rendering of the JSON route, under
  `switchframe-dmf/docs/orchestration/01-contract.md` and its XSD (the source of truth; this repo
  keeps a byte-identical copy in `schemas/`, checked against a recorded hash). The same revision
  always gives the same bytes. It has the JSON route's checks and 422s; anything XML or the XSD
  can't carry is also 422, naming each location: characters XML 1.0 lacks, keys outside
  `[A-Za-z0-9_-]`, ids, counts and tokens the XSD refuses. These are **publish problems** too, with
  the serialiser's own location text (`publishProblems` asks `toWorkloadXml`), so the JSON route, the
  XML route and the canvas agree. Secrets carry only their name. Flow options aren't published:
  they're resolved into `flows`, so the JSON and the XML carry the same document. Both repos test the
  round trip on the fixtures in `scripts/fixtures/` (`*.workload.xml` + `*.published.json`).
  *Enforced by:* `toWorkloadXml` (`src/model/xml.ts`), `publishProblems`, `toPublished`
  (`workload.ts`), `server/app.ts`, `tests/*.test.ts`.
- **R8.7 Workload, function and external device ids match the schema's `Id`:**
  `^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$` (lowercase letters, digits and `-`, not starting or ending
  with `-`, at most 42), which also fits a Kubernetes name as `wl-<id>`. Checked when saving, not only
  when publishing. New function and device ids are always valid; the workload id field keeps only
  allowed characters. Catalog and module ids keep their own rule (R3.3, R3.4). A document with an id
  that doesn't match still opens, but can't be saved, imported or published until it's renamed; the
  problem names the id. *Enforced by:* `checkWorkload`, `nextNodeId`, `toInstanceId` (`workload.ts`),
  `PUT /api/workloads/:id` (`server/app.ts`), Workload panel (`Inspector.tsx`).
- **R8.3 The workload description is the workflow intent** published to the orchestrator.
- **R8.5 A workload says who may operate it** (`spec.access.roles`: usernames per role; Inspector →
  Workload → Access). Roles come from the library's vocabulary: director, audio, graphics, captioner,
  viewer. A director is required to publish, and usernames must match `^[A-Za-z0-9._-]+$`. Whether
  a user exists is checked at deployment. *Enforced by:* `accessProblems`, `publishProblems` (`workload.ts`).
- **R8.4 A function is configured in a pop-up dialog, opened by double-clicking its node** (or
  *Configure…* in the Inspector). Header tabs:
  - **General** (name, MXL domain, and the Features section: R3.16);
  - **Inputs**: how many of each input type (within the product's input rules), then each copy's
    settings, chosen from a list;
  - **one tab per configurable feature** of the product (e.g. Switching engine, Program encoder,
    Captions);
  - **Outputs** (like Inputs);
  - **Setup** (vendor settings, control & health, dependencies, resources);
  - **Intent** (expectations, placement, discovery).

  A feature with several parameter groups shows them as sub-tabs (e.g. an SRT source: SRT
  source, Source, Audio channel, Upstream key, Network constraints, Expected payload). Tabs with
  unmet settings are marked; wiring problems stay on the canvas. Only **configuration** is exposed,
  never production run-time controls (cuts, faders, cues, playback). The Inspector shows a summary.
  *Enforced by:* `FunctionDialog.tsx`, `onNodeDoubleClick` (`App.tsx`).

## 9. Storage and deployment of the tool

- **R9.1 One install per customer** (shared by that customer's team): library server + SQLite
  (`data/`, git-ignored). Schema migrations run automatically (now schema v10; v5 modules are converted to designs; v10 drops stored module versions that no saved workload uses and that no longer match the library).
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
| 2026-10-20 | Input and output features from the Ateme TITAN Live datasheet: inputs ST 2110, ST 2022-6, NDI, TSoIP, HLS, RTMPS, MXL; Encoder; outputs TSoIP, MBTS, SRT, RIST, ZIXI, RTMPS; packaging HLS, DASH, CMAF, ATSC 3.0 (library 2.2.0). SDI excluded | R7.1, R7.4–R7.6 |
| 2026-10-20 | The module designer shows functions only: no wiring between blocks (links, chain types and layout removed; library 3.0.0, schema v9). Each port-carrying block has its own feed type. Workspace as large as possible; rule violations etc. appear below it | Supersedes signal chains (R3.1, R3.8); R3.11, R6.1 |
| 2026-10-20 | The module designer's workspace zooms and pans like the workload canvas (React Flow, positions saved in `design.layout`), still without wires | R3.11 |
| 2026-10-21 | The module's node preview is shown by default again (can be hidden) | R3.11 |
| 2026-10-21 | Input rules: the module designer sets one input vs several per instance and a scale-out maximum per input; the workload designer picks each instance's inputs and copies | R3.12 |
| 2026-10-31 | Production switcher modelled on Switchframe: library sections (Common, Production switcher with inputs / outputs / features / add-ons; library 3.1.0), palette category Production, `requires` design rule, output scale-out and per-instance output selection; example catalog and product mapping for the future Docker/Terraform compile | R3.13–R3.15, R7.7 |
| 2026-10-31 | No module designer: every module models a real product, defined in a catalog file (`scripts/product-catalogs.ts`) and imported; Modules tab removed. Functions are configured in a pop-up dialog (double-click) with a tab per feature, Inputs/Outputs tabs for how many of each and each copy's settings, and Setup/Intent tabs. Switchframe gets per-source setup, audio channel and key options and its other configuration API settings (library 3.2.1) | Supersedes R3.10, R3.11 and the module designer of R3.1; R3.1, R3.12, R8.4, R7.7 |
| 2026-10-31 | Palette headings are company names, not categories (now tags); the first company and product are Switchframe → Switchframe. Product catalogs live in `catalogs/` and load at server start | R3.1, R3.2 |
| 2026-11-02 | Stage 1 of the orchestration build (`switchframe-dmf/docs/orchestration/03-toolkit-spec.md` §1–7): `dmf-toolkit/v1alpha4`, library 4.0.0, `switchframe.1` 1.1.0, schema v10 | Below |
| 2026-11-02 | Optional functions and add-ons, on or off per instance (`features`); `scte35.enabled` removed | R3.15, R3.16 |
| 2026-11-02 | Modules carry starting values for a new instance (`defaults`) | R3.12, R4.1, R4.3 |
| 2026-11-02 | Unread MXL outputs publish their video and audio flows; a data flow only when read | Changes R6.6 |
| 2026-11-02 | Valid combinations of two fields (`x-allowed`), also narrowed per product (`ModuleBlock.allowed`). Resolves "Format presets" | R5.8 |
| 2026-11-02 | On air at start (`x-options`), recording storage, required SRT stream ID; API/invite tokens and allowed origins removed from the module | R5.9, R7.7 |
| 2026-11-02 | Workload access: usernames per role, a director required to publish | R8.5 |
| 2026-11-02 | Test sources as products under company DMF MXL | R3.2, R7.8 |
| 2026-11-02 | Blocks with no data flow (`noData`) on the test sources and Switchframe's `mxl-out`, so a bundle drag can't create a data wire the product can't serve; descriptions promising MXL VANC corrected | R6.1, R7.7, R7.8 |
| 2026-11-02 | `defaults.discovery` and `defaults.parameters` for a new instance; `dmf-mxl.1` starts at 1080p29.97. Captions mode loses `off`. Reference workload `scripts/fixtures/studio-a.ts`. Library stays 4.0.0 and modules 1.1.0 / 1.0.0: none was committed or recorded by a real server, and no saved workload uses them | R4.1, R7.7, R7.8, R3.5, R3.7 |
| 2026-11-02 | SCTE-104 only reads: it requires an MXL source, since writing to the programme fails without a data writer. Library 4.0.1: a real server had recorded 4.0.0, so R3.7 requires the bump. Modules stay 1.1.0 / 1.0.0: their stored parts don't change | R3.14, R7.7, R3.7 |
| 2026-11-05 | XML publish (stage 2 of the orchestration build, `03-toolkit-spec.md` §9): `published.xml` route, *Publish XML*, `src/model/xml.ts`, schema copy, shared fixtures and `npm test` | R8.6 |
| 2026-11-05 | Stage 2 review: XML encodability is a publish problem (the JSON route, XML route and canvas agree); workload, function and external ids follow the schema's `Id`, checked on save; MXL history ≥ 1 ms; `toPublished` drops `flowOptions` | R8.6, R8.7, R5.6 |
| 2026-11-05 | From the compiler's check of Switchframe's request bodies: SRT caller address is `host:port`, SCTE-35 default rule `pass` / `drop`, recording rotation ≥ 1 min. Library 4.0.2 (a server recorded 4.0.1); `switchframe.1` stays 1.1.0: the change narrows what's accepted without changing what a value means, and no saved workload uses it | R7.7, R3.7, R3.5 |

## Open questions

- 2022-7 inputs: which session parameters (SDP / addresses per leg, codec carried)?
- Session parameters for ZIXI, RIST, RTP, Raw UDP, RTMP.
- Should network constraints apply to every protocol, or be defined per protocol like the session?
- Features still missing: synchronizer (scope: frame-rate conversion? ANC?), processing beyond
  decoding and encoding.
- Should a module's design be visible to the orchestrator, or only its ports and parameters?
- Without wiring inside a module, the orchestrator can't tell which input feeds which output of a
  multi-function product. Is that needed (e.g. declared per instance in the workload)?
- TSoIP overlaps with the RTP and Raw UDP inputs (all carry MPEG-TS over IP). Keep all three, or
  make TSoIP the one block with UDP/RTP as an instance option?
- Datasheet codecs not in the library yet: VVC, SHVC, MPEG-2, AC-4, MPEG-H, DD+ JOC (and AAC
  profiles HE/HEv2). Processing features (branding, ad insertion, watermarking, statmux, DRM,
  HDR conversion) aren't modelled yet.
- Parameters for the new inputs and outputs (addresses, ABR ladders, packaging settings).
- With scale-out, should the copies of an input share settings (e.g. one SRT mode for all) or
  stay fully independent (current)?
- Product catalogs are regenerated from their designs after a library change. Should the server
  recompute stored modules' derived ports/parameters when the library version changes?
