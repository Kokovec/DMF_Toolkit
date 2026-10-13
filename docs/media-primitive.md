# Media Primitive & Published Graph — Spec (v1 draft)

> **Historical document.** Kept for context; much of it has been superseded. The current design
> rules live in [`design-rules.md`](design-rules.md) (rules by topic + decision log).

> **Terminology update (2026-10-10):** what this document calls a "primitive" (a catalog entry
> with image, ports, parameters…) is now a **vendor module** (`VendorModule`, `spec.modules`,
> `/api/modules`). *Primitives* are the base types per category (`src/model/primitives.json`,
> `docs/primitives/`); a module's `role` names its primitive and it must conform to it.
> There are **no generic models**: the "generic primitive" / "concrete only at publish" parts
> below are obsolete; every module has a vendor.
>
> **Placement removed (2026-10-10):** infrastructure requirements are an orchestrator function,
> not part of the configurator. Group 2 below ("Placement contract": image, resources,
> accelerator, licences, locality, edge interfaces, node constraints) is **no longer on the
> module**. The orchestrator resolves the image/chart from vendor + product + product version
> (or the type id), sizes and places the function, manages licences, co-locates each MXL domain,
> and infers edge needs from external ports. A module now has five groups: identity &
> capability, media ports, parameters, control & health, dependencies.
> Also removed: per-instance `placement.replicas` and dependency `mount` paths.
>
> **Core + vendor settings (2026-10-11):** a module's parameters are split. *Core parameters*
> come from the primitive (common vocabulary, may only narrow). *Vendor settings* mirror the
> vendor's own configuration (names and structure), with a `mapping` from core parameters to
> vendor keys and optional value translation. Instances publish `parameters` (core) and
> `settings` (vendor, minus mapped keys); the orchestrator merges them via the mapping and
> passes the result through. New vendor features = a new module version.
>
> **Principle:** the configurator is a high-level language and the orchestrator is its compiler.
> The published graph is the token stream; containers, paths, addresses, sizing and layout are
> the compiler's output, never the configurator's input.

Status: agreed and implemented 2026-10-09 (`apiVersion: dmf-toolkit/v1alpha2`). Supersedes the
`FunctionType` and Workload Description shapes in `orchestration-model.md` §3–§6.

Decisions (2026-10-09):

- **AV = time-context bundles.** Ports are mono-essence; ports sharing a `timeContext` are drawn
  as a bundle with one handle. Dragging bundle → bundle creates one wire per essence; dragging
  port → port splits them; merging = wiring video and audio from different sources into one
  grouped input. The AV Split/Merge nodes and the `av` essence are gone.
- **Concrete only at publish.** Generic role primitives (no vendor/image) may be used while
  drafting; publishing requires every instance bound to a vendor implementation
  (Inspector → Implementation).
- Dev database was reset to the v1 schema (`PRAGMA user_version = 2`; the server refuses an older file).

Implementation map: types `src/model/types.ts`; ports, wiring rule, primitive validation
`src/model/catalog.ts`; parameter schemas `src/model/schema.ts`; canvas ↔ graph, bundles,
publish checks `src/model/workload.ts`; externals `src/model/externals.ts`. Server:
`GET /api/workloads/:id/published[?revision=N]` returns the published graph (422 + reasons if
not publishable). Example vendor catalog: `docs/examples/example-vendor.catalog.json`.

## 0. Principle

A **primitive** is a deployable media function, not a flow. The design tool publishes a
graph of function **instances** plus the **wires** between their ports. The downstream DMF
orchestrator places the containers, creates the MXL domain(s) and flows, and applies
configuration. After that, MXL carries only the essence.

```
 Design tool (this)            DMF orchestrator                                   Runtime
 ───────────────────           ─────────────────────────────────────────          ─────────
 catalog of primitives  ─┐     1 resolve type → container spec
 instances + params      ├──►  2 place (resources, GPU class, licences,           containers
 wires port→port         │       locality per domain, edge constraints)           MXL domain
 (published graph)      ─┘     3 create MXL domain + flows {host, domain, flowId}  flows (flow_def.json)
                               4 start functions with parameters + flow bindings  essence over MXL
                               5 register control / health / NMOS
                               6 honour dependencies (start order)
```

Never on the primitive or in the published graph: grain payloads, ring-buffer files,
routing state, flow ids. Those are created by the orchestrator at publish time.

## 1. The primitive (catalog entry) — six groups

The first three groups are what the orchestrator cannot infer.

```ts
type MediaPrimitive = {
  // ── 1. Identity & capability ──────────────────────────────────────────────
  id: string               // stable type id, e.g. "acme.replay"
  version: string          // version of this catalog entry (semver)
  name: string
  description: string
  role: string             // generic function: ingest | playout | replay | keyer | mixer
                           //   | multiview | convert | encode | decode | record | graphics | audio-process ...
  vendor?: string          // absent = generic (abstract) primitive for that role
  product?: string
  productVersion?: string  // vendor software version the image contains
  capability: {
    produces: Essence[]    // derived from output ports; published for the orchestrator's convenience
    consumes: Essence[]    // derived from input ports
    scaling: 'singleton' | 'scalable'
  }

  // ── 2. Placement contract ────────────────────────────────────────────────
  placement: {
    image?: string                       // OCI ref, ideally pinned by digest; absent on generic primitives
    resources: {
      cpu: number                        // cores
      memoryMiB: number
      accelerator?: { class: string; count: number }   // e.g. "gpu.nvidia.ada", "fpga.jpegxs"
    }
    licenses?: { feature: string; count: number }[]
    locality: 'domain' | 'none'          // 'domain': must land where every function of its MXL
                                         //   domain sees the same tmpfs, or on fabric-joined hosts
    edge?: {                             // set only for functions that touch the outside world;
      interfaces: ('st2110' | 'ndi' | 'srt' | 'device')[]   // these cannot go on an arbitrary node
    }
    constraints?: { requireLabels?: Record<string, string>; antiAffinity?: 'replicas' }
  }

  // ── 3. Media ports (the graph) ───────────────────────────────────────────
  ports: Port[]

  // ── 4. Parameters (applied at start; not live control) ───────────────────
  parameters: {
    schema: JSONSchema       // the schema the vendor function itself validates (JSON Schema 2020-12)
    // secrets: a property with `"format": "secret-ref"`; instance value is { "$secret": "<name>" }
  }

  // ── 5. Control & health endpoints ───────────────────────────────────────
  control: {
    api?: { type: 'nmos-is12' | 'rest' | 'grpc' | 'websocket'; port: number; path?: string }
    nmos?: { registers: 'node' | 'device' }            // registers with an NMOS registry once running
    health: { type: 'http' | 'tcp' | 'grpc' | 'exec'; port?: number; path?: string }
  }

  // ── 6. Dependencies (lifecycle edges, not media wires) ──────────────────
  dependencies: {
    name: string             // slot name, bound per instance, e.g. "clip-store"
    kind: 'tams' | 'license-server' | 'storage' | 'device' | 'function'
    required: boolean
    role?: string            // kind 'function': which role must be up first
    mount?: string           // kind 'storage': mount path inside the container
  }[]
}
```

### Ports

```ts
type Port = {
  id: string                         // stable within the primitive, e.g. "pgm.video"
  direction: 'in' | 'out'
  essence: 'video' | 'audio' | 'data'
  label?: string
  cardinality: '1' | '0..1' | '0..n' | '1..n'
                                     // in: how many wires it needs/accepts; 'n' = port array
  arraySize?: string                 // parameter path that sizes a port array, e.g. "inputs"
  formats: string[]                  // accepted (in) / producible (out) media types:
                                     //   video/v210, video/v210a, audio/float32, video/smpte291
  constraints?: {
    grainRate?: Rational[]           // e.g. [{num:50,den:1},{num:60000,den:1001}]; absent = any
    frameSize?: { width: number; height: number }[]
    interlace?: ('progressive' | 'interlaced_tff' | 'interlaced_bff')[]
    colorspace?: ('BT709' | 'BT2020' | 'BT2100')[]
    transfer?: ('SDR' | 'HLG' | 'PQ')[]
    componentLayout?: string[]       // e.g. "YCbCr-4:2:2-10", "YCbCrA-4:2:2:4-10"
    sampleRate?: Rational[]          // audio
    channelCount?: { min: number; max: number }
    channelLayout?: string[]         // e.g. "M", "ST", "51"
  }
  timeContext?: string               // ports with the same value must share a time context
  transport: 'mxl' | { external: 'st2110' | 'ndi' | 'srt' | 'file' | 'tams' }   // IP only, no SDI
}
// Grain model follows essence: video and data (ANC) are discrete grains; audio is continuous.
```

### Wiring rules (design-time checks)

A wire `A.out → B.in` is valid when:

- essences are equal;
- both ports are `mxl` (functions in the facility), or the wire runs between an external
  port and an external endpoint on the canvas;
- `formats` intersect, and every constraint present on both sides intersects;
- the input's cardinality is not exceeded. Outputs can fan out without limit; MXL readers
  share one flow.

If the intersection leaves more than one choice, the workload's defaults decide (e.g. 1080p50,
BT709). The orchestrator records the result in `flow_def.json`.

## 2. Worked example — a vendor replay primitive

```json
{
  "id": "acme.replay", "version": "2.1.0",
  "name": "Acme Replay", "description": "Multi-channel record/replay server.",
  "role": "replay", "vendor": "Acme", "product": "ReplayPro", "productVersion": "7.4.2",
  "capability": { "produces": ["video", "audio"], "consumes": ["video", "audio"], "scaling": "singleton" },
  "placement": {
    "image": "registry.acme.example/replaypro@sha256:…",
    "resources": { "cpu": 8, "memoryMiB": 32768, "accelerator": { "class": "gpu.nvidia", "count": 1 } },
    "licenses": [{ "feature": "replaypro.channel", "count": 4 }],
    "locality": "domain"
  },
  "ports": [
    { "id": "rec.video", "direction": "in",  "essence": "video", "cardinality": "0..n", "arraySize": "recordChannels",
      "formats": ["video/v210"], "constraints": { "grainRate": [{ "num": 50, "den": 1 }] }, "timeContext": "rec", "transport": "mxl" },
    { "id": "rec.audio", "direction": "in",  "essence": "audio", "cardinality": "0..n", "arraySize": "recordChannels",
      "formats": ["audio/float32"], "constraints": { "channelCount": { "min": 2, "max": 16 } }, "timeContext": "rec", "transport": "mxl" },
    { "id": "out.video", "direction": "out", "essence": "video", "cardinality": "1",
      "formats": ["video/v210"], "timeContext": "out", "transport": "mxl" },
    { "id": "out.audio", "direction": "out", "essence": "audio", "cardinality": "1",
      "formats": ["audio/float32"], "timeContext": "out", "transport": "mxl" }
  ],
  "parameters": { "schema": {
    "type": "object",
    "properties": {
      "recordChannels": { "type": "integer", "minimum": 1, "maximum": 8, "default": 4 },
      "clipList":       { "type": "array", "items": { "type": "object",
                          "properties": { "id": { "type": "string" }, "in": { "type": "string" }, "out": { "type": "string" } } } },
      "storageKey":     { "type": "string", "format": "secret-ref" }
    },
    "required": ["recordChannels"] } },
  "control": {
    "api": { "type": "rest", "port": 8080, "path": "/api/v1" },
    "nmos": { "registers": "device" },
    "health": { "type": "http", "port": 8080, "path": "/healthz" }
  },
  "dependencies": [
    { "name": "clip-store", "kind": "tams", "required": true },
    { "name": "licenses", "kind": "license-server", "required": true }
  ]
}
```

## 3. The published graph (what the design tool hands over)

This is the minimum: function instances (type, placement, parameters), their ports
(implied by type + parameters), and the wires between ports.

```json
{
  "apiVersion": "dmf-toolkit/v1alpha2",
  "kind": "MediaWorkload",
  "metadata": { "id": "news-studio-a", "name": "Two camera news studio", "revision": 7 },
  "spec": {
    "defaults": { "video": { "grainRate": { "num": 50, "den": 1 }, "frameSize": { "width": 1920, "height": 1080 },
                             "colorspace": "BT709" },
                  "audio": { "sampleRate": { "num": 48000, "den": 1 }, "channelCount": 2 } },
    "domains": [{ "id": "studio-a" }],
    "functions": [
      { "id": "cam1-in", "type": "acme.st2110-rx", "typeVersion": "1.0.0", "domain": "studio-a",
        "placement": { "replicas": 1 },
        "parameters": { "sdp": { "$ref": "endpoint:camera-1" } } },
      { "id": "replay", "type": "acme.replay", "typeVersion": "2.1.0", "domain": "studio-a",
        "parameters": { "recordChannels": 2, "storageKey": { "$secret": "replay-storage" } },
        "bindings": { "clip-store": "tams:main", "licenses": "license:acme" } }
    ],
    "wires": [
      { "from": "cam1-in/out.video", "to": "replay/rec.video[0]" },
      { "from": "cam1-in/out.audio", "to": "replay/rec.audio[0]" }
    ],
    "externals": [
      { "id": "camera-1", "kind": "device", "to": "cam1-in/in.2110" }
    ]
  }
}
```

- `wires` are just source port id → destination port id (`instance/port[index]`).
- `bindings` fill a primitive's dependency slots with facility resources by name. The
  orchestrator resolves them; the design tool doesn't know addresses.
- `externals` are the canvas endpoints (cameras, programme destinations). They are not
  deployed. They tell edge functions what they connect to.
- Canvas layout is kept separately and is not part of what gets published.

## 4. What the orchestrator produces (for reference; not our output)

For each output port with at least one wire, it creates one MXL flow, addressed
`{hostId, domainId, flowId}`, with an NMOS IS-04-style `flow_def.json`:

```json
{
  "id": "5fbec3b1-1b0c-417c-9059-8b94a47197ed",
  "label": "cam1-in/out.video",
  "format": "urn:x-nmos:format:video",
  "media_type": "video/v210",
  "grain_rate": { "numerator": 50, "denominator": 1 },
  "frame_width": 1920, "frame_height": 1080,
  "interlace_mode": "progressive",
  "colorspace": "BT709",
  "components": [
    { "name": "Y",  "width": 1920, "height": 1080, "bit_depth": 10 },
    { "name": "Cb", "width": 960,  "height": 1080, "bit_depth": 10 },
    { "name": "Cr", "width": 960,  "height": 1080, "bit_depth": 10 }
  ],
  "tags": { "urn:x-dmf-toolkit:workload": ["news-studio-a"] }
}
```

Every value in it comes from the port's formats and constraints, intersected across the
wire and resolved with the workload defaults. Functions sharing a `timeContext` get
flows with the same time base, so audio stays aligned with its video.

## 5. Changes from v0 (orchestration-model.md)

| v0 | v1 |
|---|---|
| `FunctionType` with ports + simple param list | `MediaPrimitive` with the six groups |
| `kind`: endpoint / gateway / function / virtual | Primitives are functions only; `placement.edge` marks edge functions; endpoints are canvas-only `externals`; `virtual` goes away |
| Essence `av` + AV Split / AV Merge nodes | Mono-essence ports grouped by `timeContext`; the canvas draws a group as one bundle wire; splitting = wiring members individually; merging = wiring video and audio from different sources into one grouped input |
| Ports: name + essence | Ports: stable id, direction, cardinality, formats, constraints, time context, transport |
| Params: text/number/select/checkbox list | JSON Schema the vendor validates; secrets are references |
| Published `flows` (one per output, with receivers) | Published `wires` (port → port); flows are the orchestrator's job |
| — | Control/health endpoints, dependencies + per-instance bindings |
