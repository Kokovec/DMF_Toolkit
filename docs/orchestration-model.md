# Orchestration Model — Design Proposal (v0)

> **Historical document.** Kept for context; much of it has been superseded. The current design
> rules live in [`design-rules.md`](design-rules.md) (rules by topic + decision log).

> **Superseded in part (2026-10-09):** the node kinds, ports, essences, catalog and workload
> shapes (§3–§6) are replaced by `docs/media-primitive.md` (v1). §1–§2 (layering, lifecycle),
> §7 (build plan) and §8 (storage) still apply; §8 tables are now `primitives` (was `function_types`).

Status: v0 agreed 2026-10-08; part 1 (model core) implemented in `src/model/`.

## Decisions (2026-10-08)

1. Wires are **logical flows**; the transport (MXL, ST 2110, SRT, …) is chosen at compile time.
2. Audio travels **with** its video as an `av` group by default, and can be split off
   (AV Split), processed separately, and merged back (AV Merge). Each flow in a group is
   still mono-essence, so split and merge only regroup flows; they compile to no containers.
3. The Facility Description comes later (part 5).
4. The catalog stays **generic**: no vendor or deployment specifics in the starter
   catalog. Customers supply their own catalogs and compile targets, so no first target is fixed.

## Decisions (2026-10-09)

5. Parts and workloads live in a **database**, one install per customer (shared by
   that customer's team). SQLite for now, schema kept portable for Postgres. See §8.

Source: EBU White Paper *The Dynamic Media Facility: Reference Architecture* v2.0 (April 2026).

## 1. What this layer is

The canvas produces a **Workload Description**: a declarative, vendor-neutral
document that says *what* a production needs: which Media Functions, which
external devices, which media flows between them. It does not say *how* or
*where* any of it runs.

This corresponds to the **Design** stage of the EBU Media Workload lifecycle
(Design → Plan → Provision → Configure → Operate → Finalise & Review). The
later stages are the "compiler":

| Stage | Input | Output (examples) |
|---|---|---|
| **Design** (this tool) | user on canvas | Workload Description (JSON) |
| Plan | Workload + Facility Description | resource profile, placement, Flow Domain plan, licence check |
| Provision | placed workload | Helm charts / k8s manifests, MXL domains + flows, licences |
| Configure | provisioned workload | initial connections (MXL API, NMOS IS-05), function params |

Each customer's infrastructure is different, so it is **not** part of the
Workload Description. It goes in a separate **Facility Description**
(sites, clusters, hosts, capabilities), which acts as the compile target.
The same workload can then be compiled against a different facility, for example
for outsourcing peaks, resilience, or shipping compute to an event.

```
 Function Catalog ─┐
                   ├─► Workload Description ─┐
 Canvas (user)  ───┘                         ├─► Plan/Compile ─► Deployment artefacts
                     Facility Description ───┘
```

## 2. The three documents

1. **Function Catalog**: the vocabulary of block types. These are data, not code,
   so each customer can load their own (vendor functions, in-house tools).
2. **Workload Description**: what the canvas produces. A graph of instances
   of catalog types.
3. **Facility Description**: the customer's infrastructure. This comes later and
   is out of scope for the first part.

All three share an envelope so they can be versioned and validated:

```json
{ "apiVersion": "dmf-toolkit/v1alpha1", "kind": "MediaWorkload", "metadata": { ... }, "spec": { ... } }
```

## 3. What the widgets represent

There are three kinds of node on the canvas, and every catalog type is one of them:

| Node kind | RA concept | Inside the DMF? | Examples |
|---|---|---|---|
| **Media Function** (`function`) | Media Functions layer | yes, runs as 1..n containers | Video Process, Vision Mixer, Audio Mixer, GFX Render, Multiviewer, Clip Play/Record, Encoder |
| **Gateway** (`gateway`, edge I/O) | Input/Output Media Function (Fig. 13) | yes, but bridges to a stream protocol | Camera Input (ST 2110), SRT Input, ST 2110 Output, WebRTC Output |
| **External Endpoint** (`endpoint`) | External Source / Destination | no, it's a physical or remote device | Camera, Microphone, Event feed, Programme Out, Control position / UI |

A fourth, built-in kind, `virtual`, covers AV Split / AV Merge, which regroup flows and deploy nothing.

Gateways are kept separate from processing functions because the RA gives them
different duties. Ingress functions timestamp grains (JT-NM / MS-04 timing).
Both ingress and egress need ST 2110-21 pacing, PTP, and NMOS IS-04/IS-05
registration. The compiler treats them differently.

**Grouping frames** are not nodes. They are canvas regions that add metadata to the
nodes inside them:

- **Workload**: the boundary of one production. A canvas may hold several,
  as in RA Annex B2 (studio + shared remote feeds).
- **Flow Domain**: the isolation group for flows (MXL Domain). Functions can only
  read flows in domains they are authorised for.
- **Placement hint** (later): "keep at site X" or "co-locate", used by Plan.

### Node instance fields (every kind)

```
id            stable unique id (token)
type          catalog type id, e.g. "vision-mixer"
typeVersion   catalog version the instance was made from
name          user label, e.g. "Cam 1 Input"
params        values for the type's parameter schema
```

Media/Edge Functions add:

```
resources?    override of the type's default resource profile (cpu, gpu, memoryGiB)
resilience?   "none" | "1+1" | "n+1"
placement?    hints only (site, affinity/anti-affinity); never concrete hosts
```

## 4. What the connections represent

A wire is a **logical media connection**, not a specific network link.

The RA is explicit that inside a cluster, functions exchange media through the
**Media Exchange** (asynchronous shared memory / RDMA, i.e. MXL), not through network
streams. Streams (ST 2110, SRT, NDI, …) are only used at the edge. Which one a wire
becomes depends on where both ends land, and that is only known after Plan.
So the canvas records the intent and the compiler picks the transport:

| Wire between | Compiles to |
|---|---|
| Function → Function, same cluster | MXL flow (shared memory or RDMA) |
| Function → Function, different clusters/sites | stream across WAN (inter-cluster media exchange is an RA open topic) |
| External Endpoint ↔ Edge Function | the stream protocol of the edge function (ST 2110, SRT, …) |

### Flows, not cables

Following JT-NM and the RA, media is a uniquely identified **Flow** of timestamped
grains. In the model:

- Each **output port** produces one Flow.
- Wiring that output to several inputs is **fan-out of the same Flow** (one sender,
  many receivers). It does not create several flows. This matches MXL and NMOS
  (sender/flow/receivers).
- An input port receives at most one Flow. The canvas already enforces this.

### Ports are typed by essence

Payloads are **mono-essence by default**. A camera therefore has a video output and an
audio output, not a single "AV" port.

```
port: { name, essence: "av" | "video" | "audio" | "data", label?, repeat?: "<count param>" }
```

- `video`: e.g. 1080p50, YUV 4:2:2 10-bit (the RA's initial MXL format), later UHD, alpha, HDR
- `audio`: channel count (1/2/6/…), sample rate (48 kHz), sample format (float32 inside the DMF)
- `data`: schema id (timecode, subtitles, SCTE, tally …)

`av` = one video flow + its associated audio flow(s), sharing a time context.
`repeat` expands a port into N numbered ports from a param (e.g. a mixer's `inputs`).

Wiring is only allowed when essences match, and external endpoints may only connect to gateways. Format compatibility is a validation
warning rather than a hard block, because conversion functions exist.

### Control is not media

Control positions and UIs (vision mixer panel, camera CCU, audio desk) connect to
functions over control APIs (NMOS IS-12, REST, WebSocket). They are drawn as a
**second edge kind** (`control`, dashed), separate from media flows and from
media type-checking.

## 5. Workload Description — shape

```json
{
  "apiVersion": "dmf-toolkit/v1alpha1",
  "kind": "MediaWorkload",
  "metadata": {
    "id": "news-studio-a",
    "name": "Two camera news studio",
    "schedule": { "start": "2026-11-01T17:00:00Z", "end": "2026-11-01T19:00:00Z" },
    "labels": { "template": "news-2cam" }
  },
  "spec": {
    "defaults": { "video": { "raster": "1920x1080", "rate": "50/1", "scan": "p" }, "audio": { "rate": 48000 } },
    "domains":   [ { "id": "studio-a" } ],
    "nodes": [
      { "id": "cam1",     "kind": "endpoint", "type": "camera",       "name": "Camera 1" },
      { "id": "cam1-in",  "kind": "function", "type": "st2110-input", "name": "Cam 1 Input", "domain": "studio-a", "params": { } },
      { "id": "mixer",    "kind": "function", "type": "vision-mixer", "name": "Vision Mixer", "domain": "studio-a",
        "params": { "inputs": 8 }, "resilience": "1+1" }
    ],
    "flows": [
      { "id": "cam1-in.video", "from": { "node": "cam1-in", "port": "video" }, "essence": "video",
        "to": [ { "node": "mixer", "port": "in1" }, { "node": "mv", "port": "in1" } ] }
    ],
    "controls": [
      { "from": { "node": "td-panel" }, "to": { "node": "mixer" } }
    ]
  }
}
```

Canvas-only data (x/y positions, colours, zoom) is stored next to `spec` under `layout`,
so the description is unaffected when blocks are moved around.

## 6. Function Catalog — shape

```json
{
  "apiVersion": "dmf-toolkit/v1alpha1",
  "kind": "FunctionType",
  "metadata": { "id": "vision-mixer", "version": "1.0.0", "vendor": "generic", "category": "Video" },
  "spec": {
    "nodeKind": "function",
    "inputs":  [ { "name": "in",  "essence": "video", "multiple": true } ],
    "outputs": [ { "name": "pgm", "essence": "video" }, { "name": "pvw", "essence": "video" } ],
    "params":  [ { "key": "inputs", "type": "number", "default": 8, "min": 2, "max": 64 } ],
    "resources": { "cpu": 4, "gpu": 1, "memoryGiB": 8 },
    "implementation": { "image": "registry.example/vendor/mixer:2.3", "chart": "vendor/mixer" }
  }
}
```

`implementation` is optional. A generic catalog leaves it out, and a customer- or
vendor-specific catalog fills it in for the compiler. The current `registry.ts`
`BlockDef` becomes this type, and `BLOCKS` becomes a default catalog loaded from JSON.

## 7. Build plan (manageable parts)

1. ✅ **Model core**: TypeScript types + JSON Schema for the three envelopes; convert
   the canvas state to and from a Workload Description; export/import buttons.
2. **Catalog**: replace the placeholders with a generic starter catalog (endpoints,
   edge functions, processing functions from RA Annex B1); essence-typed ports;
   load a custom catalog from JSON.
3. **Canvas semantics**: three node kinds styled differently; fan-out flows;
   essence-checked wiring; control edges; Workload and Domain frames.
4. **Validation**: unconnected required inputs, essence/format mismatches, missing
   params, cycles, flows crossing domains without permission.
5. **Facility Description**: separate view for sites/clusters/hosts/capabilities.
6. **Plan/compile** (first target to be chosen: e.g. Kubernetes + MXL domains, or an
   NMOS connection list).

## 8. Storage (parts library and workloads)

One API server + database per customer install (`server/`, `npm run server`, port 3001;
the Vite dev server proxies `/api`). SQLite file `data/dmf-toolkit.db` (override with `DMF_DB`).

| Table | Holds |
|---|---|
| `catalogs` | catalog id, name, version |
| `function_types` | one row per part **version** `(id, version)`, owning catalog, full JSON document |
| `workloads` | workload id, name, current revision |
| `workload_revisions` | every saved revision of a Workload Description (immutable) |
| `workload_type_refs` | which part versions each revision uses |

Rules:

- **Parts are versioned.** Nodes pin `type@typeVersion`. A part version used by any saved
  workload revision cannot be changed or deleted; publish a new version instead. The
  Inspector offers "Upgrade to version N" per node.
- A part id belongs to one catalog; another catalog cannot take it over. (Customer
  catalogs should namespace their ids, e.g. `acme.vision-mixer`.)
- The generic catalog is seeded on first start.
- **Saving creates a new revision.** Saves carry the base revision; if someone else saved
  in between, the server rejects it (409) instead of overwriting.
- Workloads are validated against the library on save (types exist, ports, essences, wiring rules).

API: `GET /api/types` (full documents), `GET /api/parts` (summary + `usedBy`), `PUT|DELETE /api/types/:id/:version`
(`PUT` body `{catalogId, type}`), `GET|POST /api/catalogs`,
`GET /api/catalogs/:id` (export), `GET /api/workloads`, `GET|PUT|DELETE /api/workloads/:id`
(`PUT ?baseRevision=N`), `GET /api/workloads/:id/revisions[/:rev]`.

**Parts editor** (Parts tab): create catalogs and parts; edit ports (essence, repeat-by
setting), settings (text/number/select/checkbox with defaults, ranges, options) and default
resources, with a live node preview. Locked (in-use) versions are read-only: use
"New version" (bumps the version) or "Duplicate as new part".

Not yet: authentication/users (needed before a team shares one install), revision history UI.

