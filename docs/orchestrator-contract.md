# Configurator ↔ Orchestrator Contract

> Design rules and their history: [`design-rules.md`](design-rules.md). This document holds the
> detail of the configurator ↔ orchestrator contract.

Status: agreed 2026-10-11 (user brief). Applies to schemas, API contracts, data structures and UI.

## Roles

| | Configurator (this tool) | DMF orchestrator |
|---|---|---|
| Expresses | The operator's **intent** as a **declarative desired state**: workflow graph + parameters, requirements, constraints | — |
| Does | Nothing imperative: no container deployment, no shared-memory mounting, no connection setup | Reconciles desired state with running state: resource allocation, container deployment, MXL domain/flow lifecycle, configuration injection into media functions, connection management (NMOS IS-04/IS-05 or equivalent), monitoring, teardown |
| Decides | What the system is and what it needs | How and where it runs |

**Design principle:** the configurator stays declarative. The interface carries workflow
intent, flow definitions, connection topology, and resource requirements/constraints,
never low-level implementation details (host names, mount paths, container specs,
imperative steps).

## What the configurator passes (the published desired state)

`GET /api/workloads/:id/published` returns a `MediaWorkload` document. Each item of the
brief maps to a field:

| Brief | Field | Set where |
|---|---|---|
| **Workflow intent** | `metadata.description` | Inspector → Workload → *Workflow intent* |
| **Session parameters** (SRT: mode, bonding, latency, encryption, passphrase, stream ID, MTU; per path `pathA` / `pathB` {port, remote address}), *injected into the function* | `functions[].parameters.<block>.srt`, e.g. `parameters.srt1.srt` (one group per block of the module's design; fields shown/required by `x-when`); secrets as `{"$secret": name}` | Function dialog → SRT session |
| **Incoming stream bitrate + payload** (MPEG-TS, codecs) | `functions[].parameters.<block>.payload.pathA` / `.pathB` {bitrateMbps (required), container, videoCodec, audioCodec} | Function dialog → Expected payload |
| **Network constraints** (exposure; per path `pathA` / `pathB` {network, zone, VLAN}), *for the orchestrator* | `functions[].parameters.<block>.network` (`x-audience: orchestrator`) | Function dialog → Network constraints |
| **MXL flow definition**: domain, flow ID/UUID, essence formats, grain rate, history depth | `spec.flows[]`: `id` (UUID v5, stable across revisions), `domain`, `essence`, `format` (media type `video/v210` / `audio/float32` / `video/smpte291`, grain rate, frame size, interlace, colorspace, sample rate, channels), `historyMs` | Derived from the writer's output settings + workload defaults; overrides on the wire (Flow panel) |
| **Connection graph**: MXL writer and readers, multi-hop | `spec.flows[].writer` / `.readers`, where `readers` may be empty: the video and audio flows of every MXL output in use are always published, a data flow only when read and only on a block that has one (and `spec.wires` port → port, including external edges) | Canvas wiring |
| **Resource profile**: CPU/GPU, memory, network, storage | `functions[].resources` (per instance) | Function dialog → Resource profile |
| **Scaling / resilience expectations** | `functions[].expectations` (`resilience`: none / 1+1 / N+1; `scaling`: fixed / elastic) | Function dialog → Expectations |
| **Placement / constraints**: host/cluster, affinity, on-prem vs cloud, licensing | `functions[].placement` (`site`, `cluster`, `environment`, `with`, `apart`, `licensing`) | Function dialog → Placement constraints |
| **Discovery / control metadata**: NMOS registration, tags, labels | `functions[].discovery`, `spec.flows[].discovery` (`register`, `labels`); default `register` = the module's `defaults.discovery`, else whether the instance's control declares NMOS | Function dialog → Discovery; Flow panel |
| Domain | `functions[].domain`, `spec.domains[]` | Function dialog → MXL domain |
| **Inputs used** (which input functions run, and how many copies) | `functions[].inputs` (input block id → copies; 0 = not used); parameters and ports follow (copies: `srt1`, `srt1_2`, …) | Function dialog → Inputs |
| **Outputs used** (which outputs run, and how many copies; 0 = off) | `functions[].outputs` (output block id → copies); parameters and ports follow (copies: `srt-out`, `srt-out_2`, …) | Function dialog → Outputs |
| **Features used** (optional functions and add-ons on or off) | `functions[].features` (block id or `<block>.<add-on key>` → boolean): the full selection in force, including what's off. A function that's off has no parameters or tab | Function dialog → General → Features |
| **Who may operate it** | `spec.access.roles` (role → usernames); roles offered come from the library; a `director` is required to publish. Whether a user exists is checked at deployment | Inspector → Workload → Access |
| **Vendor settings** (the product's own configuration) | `functions[].settings` (free-form JSON, passed through) | Function dialog → *vendor* settings |
| **Control & health** | `functions[].control` (`api`, `nmos`, `health`; health required) | Function dialog → Control & health |
| **Dependencies** | `functions[].dependencies[]` (`name`, `kind`, `required`, `role`, `binding`) | Function dialog → Dependencies |
| Library version | `metadata.libraryVersion`: the feature library the state was designed against; fetch it from `GET /api/library/:version` | automatic |

These are **requirements and constraints, not decisions**: e.g. `placement.site` is a
preference, `resources` is what the function needs, and `expectations.resilience: "1+1"` says
what the operator wants. The orchestrator chooses hosts, replicas, licences and resources.

## As XML (what the orchestrator reads)

`GET /api/workloads/:id/published.xml[?revision=N]` returns the same document as XML
(`application/xml; charset=utf-8`), namespace `urn:dmf:workload:v1`, schema
[`../schemas/dmf-workload-v1.xsd`](../schemas/dmf-workload-v1.xsd). *Publish XML* in the app downloads
it. The definition is `switchframe-dmf/docs/orchestration/01-contract.md`; the XSD there is the source
of truth and the copy here is byte-identical (a test checks its hash). In short:

- **Mapping:** metadata as attributes of `<workload>` (plus `schemaVersion="1"`); `defaults` with each
  rational as `…Num`/`…Den`; `access` as `<role name><member>`; per function `<inputs>`/`<outputs>`
  (`<use block copies>`, zeros included), `<features>`, `<parameters>`, `<settings>`, then `control`,
  `dependencies`, `resources`, `expectations`, `placement`, `discovery`; `flows` with `<reader>`,
  `<format>`, `<discovery>`; `wires`. Canvas layout isn't carried, and `flowOptions` aren't published
  at all (JSON or XML): they're already resolved into `flows`.
- **Values:** every leaf of `parameters` and `settings` is `<value path="a.b[0].c" type>` with type
  `string`, `integer`, `number` (no exponent), `boolean`, `secret` (the name only), `null`,
  `emptyObject` or `emptyArray`. A missing value means "not set".
- **Bytes:** UTF-8, declaration, 2-space indent, LF, trailing newline, no DOCTYPE or comments; element
  order from the XSD, document order otherwise. `& < > " '` are escaped everywhere; so are CR (in
  text and attributes) and tab and LF in attributes, as character references, so readers get them back.
- **Refused (every location named):** characters XML 1.0 can't carry, keys outside `[A-Za-z0-9_-]`
  (so a `$secret` object with any other key), and values the XSD refuses: ids, port refs, block ids,
  UUIDs, whole numbers, and tokens not in normal form (an `xs:token` is read collapsed). These are
  publish problems, so both routes give the same 422 and the canvas shows them before publishing.
- **Ids:** workload, function and external device ids match `^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$`,
  checked when saving (a save with another id is refused with 400).
- **History:** `historyMs` is at least 1, as the workload default and as each flow's option.
- **Fixtures:** `scripts/fixtures/studio-a` and `every-value` (`.workload.xml` + `.published.json`, from
  `npx tsx scripts/fixtures/write-xml.ts`) are the round-trip fixtures both repos test.

## What the facility can run (input from the orchestrator)

The one thing the configurator reads from the orchestrator is what the facility declares it can
run, so users don't design what can't deploy. It's never part of the published state.

- **Source:** `make facility-export` in `switchframe-dmf` writes `.state/facility-<name>.json`
  (`kind: FacilityExport`, `name`, `capabilities` id → boolean, `limits`). The server reads the file
  named by `DMF_FACILITY` at start (it refuses to start if that file is unreadable or invalid) and
  serves `{name, capabilities, limits}` at `GET /api/facility`, or `{}` when it's unset. Limits are
  used by parameters that name one (`x-facilityLimit`, e.g. recording storage ≤ `maxRecordingGiB`)
  and for the workload's shape: `functionsPerWorkload` (`{<type>: {min, max}}`) and
  `domainsPerWorkload`, with every function in a workload domain.
- **Capabilities** are the library's `vocabulary.capabilities`, exactly the export's keys (a test
  checks): `mxl`, `srt-in`, `srt-caller-out`, `rtmp-out`, `recording`, `srt-listener-out`, `st2110`,
  `moq`, `gpu`, `asr`, `neural-key`, `ai-segment`, `scte104`. A capability the file doesn't list counts
  as unavailable, as in the compiler.
- **What needs what** is library data: a feature's `needs` (its options' needs count too), an enum
  value's `x-enumNeeds`, and the engine's rule that a resource profile with a GPU needs `gpu`. For
  `switchframe.1` this mirrors the compiler's gates (`tools/dmf_compile/products/switchframe.py`).
- **Effect:** the function dialog doesn't offer what the facility lacks and says why; a workload
  that already uses it (saved earlier, or imported) can still be saved, but each such option is a
  publish problem naming it, so both publish routes answer 422. With no facility set, everything is
  offered. The configurator decides nothing here: it only mirrors the facility's declaration, and the
  compiler stays the authority.
- **Product limits** are separate (`rules.conflictsWith`): no facility can honour them, so they are
  publish problems with or without a facility, e.g. an RTMP output with colour profile
  `standard-hevc` or `professional`.
- **Everything else the compiler refuses** is refused at publish too, naming the compiler's parameter
  path (design rule R8.9): function and domain counts within the facility's limits, MXL flow formats and writers, unique SRT stream IDs, label bytes, address,
  URL and file-name forms, resources, `settings.extraArgs`. Only the checks that need a facility's
  limits are skipped without one. The compiler keeps every check for hand-edited XML.

## What the orchestrator configures

- Creates and manages the lifecycle of **MXL domains and flows**, using the flow ids and formats
  given (writes `flow_def.json`). It chooses domain paths and buffer sizes from `historyMs`.
- Deploys the correct **container images** for each module (from vendor / product / product
  version or the type id).
- **Allocates and places** compute and handles **licensing**.
- **Injects configuration** into the running containers: core parameters and the instance's
  vendor settings (free-form, in the vendor's own terms), ingress parameters, MXL domain path and
  flow ids, with secrets resolved.
- Establishes the actual **MXL writer/reader connections** and the external connections.
- **Registers** functions and flows for discovery, and handles dynamic changes, health and
  teardown.

## Example (SRT → MXL → synchronizer)

```json
{
  "metadata": { "id": "news-a", "uid": "0b1c2d3e-…", "name": "News A", "revision": 1,
                "description": "SRT ingress from venue -> decode/normalize -> MXL -> synchronizer" },
  "spec": {
    "externals": [{ "id": "venue", "kind": "source", "name": "Venue",
                    "reference": { "kind": "srt", "value": "venue-truck-1" } }],
    "functions": [{
      "id": "receiver-1", "type": "acme.1", "typeVersion": "1.0.0", "domain": "main",
      "parameters": {
        "srt1": {
          "srt": { "mode": "caller", "bonding": "none", "latencyMs": 120, "encryption": "aes-256", "passphrase": { "$secret": "venue-srt" }, "streamId": "venue1", "mtu": 1500,
                   "pathA": { "port": 9000, "remoteAddress": "venue.example.net" } },
          "network": { "exposure": "wan-facing", "pathA": { "network": "contribution" } },
          "payload": { "pathA": { "bitrateMbps": 20, "container": "mpeg-ts", "videoCodec": "h264", "audioCodec": "aac" } } },
        "decoder1": { "decoder": { "deinterlace": "off", "errorConcealment": true } },
        "mxl1": { "format": { "video": { "frameSize": "3840x2160", "rate": "59.94", "scan": "progressive", "colorspace": "BT709", "transfer": "SDR" },
                              "audio": { "channels": 2 } } },
        "timing": { "maxLatencyMs": 20 } },
      "resources": { "cpu": 4, "memoryMiB": 8192, "gpu": { "class": "nvidia-l4", "count": 1 }, "networkMbps": 200 },
      "expectations": { "resilience": "1+1" },
      "placement": { "site": "studio-a", "environment": "on-prem", "with": ["sync-1"] },
      "discovery": { "register": true, "labels": ["news"] }
    }],
    "flows": [{
      "id": "45b772b5-8706-56b4-9ed6-d16fb7838045", "label": "receiver-1/mxl1.video", "domain": "main",
      "essence": "video", "writer": "receiver-1/mxl1.video", "readers": ["sync-1/in.video[0]"],
      "format": { "mediaType": "video/v210", "grainRate": { "num": 60000, "den": 1001 },
                  "frameWidth": 3840, "frameHeight": 2160, "interlace": "progressive", "colorspace": "BT709" },
      "historyMs": 500, "discovery": { "register": true }
    }],
    "wires": [{ "from": "venue/stream", "to": "receiver-1/srt1.in.video" }, { "from": "receiver-1/mxl1.video", "to": "sync-1/in.video[0]" }]
  }
}
```

## Changes from earlier decisions

- **Flow ids** are now assigned by the configurator (stable UUIDs), not the orchestrator.
- **Resource profile, scaling/resilience expectations and placement constraints** are back,
  as declared requirements and constraints (they were removed on 2026-10-10 as "orchestrator
  decisions"). The orchestrator still makes every decision.
- **SRT session** (mode, port, remote address, …) is a receiver parameter group; the External
  device only names the remote party. Parameter groups carry `x-audience` (function vs
  orchestrator) and conditional fields use `x-when`.
- Only **applicable** settings are published: values hidden by an `x-when` condition (e.g. path B
  while bonding is off, a passphrase with encryption off) are dropped by `toPublished`.
- **Designed modules** (2026-10-20): a module's parameters are grouped by the blocks of its design
  (`srt1`, `decoder1`, `mxl1`, plus module-wide groups such as `timing`), and its port ids are
  prefixed with the block (`srt1.in.video`, `mxl1.video`). An MXL flow's format comes from the
  writing block's `x-flow` parameters.
- **Per-instance setup** (2026-10-20): vendor settings, control & health, dependencies and the
  resource profile are set on each function instance (no longer on the module). Vendor settings
  are free-form JSON; there is no core → vendor mapping.
- **Selections, access, unread flows** (2026-11-02, `dmf-toolkit/v1alpha4`, library 4.0.0): functions
  carry `features` next to `inputs` and `outputs`, always the full selection in force; `spec.access`
  says who may operate the workload; unread MXL outputs publish their video and audio flows with
  empty `readers`; a field with `x-options` (e.g. `engine.engine.onAirAtStart`) is always published
  with an explicit value.
- **XML handover** (2026-11-05): the published revision is also served as XML
  (`/published.xml`), the format the orchestrator reads; the JSON route stays.
- **Facility capabilities and product limits** (2026-11-11, library 4.1.0): publishing refuses what
  the facility set by `DMF_FACILITY` doesn't offer, and what the product can't do (RTMP with an HEVC
  colour profile) on any facility, and every value the compiler refuses (R8.9). A key's
  `fillSource` is an input copy id (it was a label) and stays unset for "this source". The published
  document's shape is otherwise unchanged.
