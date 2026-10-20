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
| **Session parameters** (SRT: mode, bonding, latency, encryption, passphrase, stream ID, MTU; per path `pathA` / `pathB` {port, remote address}), *injected into the function* | `functions[].parameters.<block>.srt`, e.g. `parameters.srt1.srt` (one group per block of the module's design; fields shown/required by `x-when`); secrets as `{"$secret": name}` | Inspector → function → SRT session |
| **Incoming stream bitrate + payload** (MPEG-TS, codecs) | `functions[].parameters.<block>.payload.pathA` / `.pathB` {bitrateMbps (required), container, videoCodec, audioCodec} | Inspector → function → Expected payload |
| **Network constraints** (exposure; per path `pathA` / `pathB` {network, zone, VLAN}), *for the orchestrator* | `functions[].parameters.<block>.network` (`x-audience: orchestrator`) | Inspector → function → Network constraints |
| **MXL flow definition**: domain, flow ID/UUID, essence formats, grain rate, history depth | `spec.flows[]`: `id` (UUID v5, stable across revisions), `domain`, `essence`, `format` (media type `video/v210` / `audio/float32` / `video/smpte291`, grain rate, frame size, interlace, colorspace, sample rate, channels), `historyMs` | Derived from the writer's output settings + workload defaults; overrides on the wire (Flow panel) |
| **Connection graph**: MXL writer and readers, multi-hop | `spec.flows[].writer` / `.readers` (and `spec.wires` port → port, including external edges) | Canvas wiring |
| **Resource profile**: CPU/GPU, memory, network, storage | `functions[].resources` (per instance) | Inspector → function → Resource profile |
| **Scaling / resilience expectations** | `functions[].expectations` (`resilience`: none / 1+1 / N+1; `scaling`: fixed / elastic) | Inspector → function → Expectations |
| **Placement / constraints**: host/cluster, affinity, on-prem vs cloud, licensing | `functions[].placement` (`site`, `cluster`, `environment`, `with`, `apart`, `licensing`) | Inspector → function → Placement constraints |
| **Discovery / control metadata**: NMOS registration, tags, labels | `functions[].discovery`, `spec.flows[].discovery` (`register`, `labels`); default `register` = the instance's control declares NMOS | Inspector → function → Discovery; Flow panel |
| Domain | `functions[].domain`, `spec.domains[]` | Inspector → function → MXL domain |
| **Vendor settings** (the product's own configuration) | `functions[].settings` (free-form JSON, passed through) | Inspector → function → *vendor* settings |
| **Control & health** | `functions[].control` (`api`, `nmos`, `health`; health required) | Inspector → function → Control & health |
| **Dependencies** | `functions[].dependencies[]` (`name`, `kind`, `required`, `role`, `binding`) | Inspector → function → Dependencies |
| Library version | `metadata.libraryVersion`: the feature library the state was designed against; fetch it from `GET /api/library/:version` | automatic |

These are **requirements and constraints, not decisions**: e.g. `placement.site` is a
preference, `resources` is what the function needs, and `expectations.resilience: "1+1"` says
what the operator wants. The orchestrator chooses hosts, replicas, licences and resources.

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
