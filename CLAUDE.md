# DMF Toolkit

Configurator for EBU **Dynamic Media Facility** (DMF) workloads (EBU White Paper "The Dynamic
Media Facility: Reference Architecture" v2.0, April 2026; not Dynamics 365). Users build a media
workflow on a node canvas from vendor modules and publish it as a declarative desired state
for the DMF orchestrator.

## Design rules

**`docs/design-rules.md` is the single source for design decisions: read it first.** It holds
the current rules by topic (each naming the code that enforces it), a dated decision log, and
open questions. When the user makes or changes a decision, update that file (rule + log line)
in the same change. Don't scatter decisions across other docs or this file.

In one line: the configurator is a high-level declarative language and the orchestrator is the
compiler. Express intent, requirements and constraints; never infrastructure decisions or
imperative steps. IP-based signals only; MXL only between functions.

Detail docs:
- `docs/orchestrator-contract.md`: what the published desired state contains.
- `docs/primitives/<category>.md`: per-primitive parameters.
- `docs/media-primitive.md`, `docs/orchestration-model.md`: historical (see their banners).

## Stack

- React 19 + TypeScript, Vite, oxlint; React Flow (`@xyflow/react` v12) for the canvas
- Commands:
  - `npm run dev`: UI on http://localhost:5173, proxies `/api`
  - `npm run server`: API + SQLite on :3001, `tsx watch`
  - `npm run build`: type-checks UI and server
  - `npm run lint`
- Server: Node 24 built-in `node:sqlite`, plain `node:http`; no other runtime deps. `tsx` (dev dep) runs it
- Open `DMF Toolkit.code-workspace` in VS Code

## Code map

- `src/model/types.ts`: all data types (`PrimitiveDef`, `VendorModule`, `ModuleCatalog`, `PortDef`, `WorkloadDescription`, `FlowDef`, `JsonSchema` with `x-*` extensions; `apiVersion dmf-toolkit/v1alpha2`).
- `src/model/primitives.json` + `primitives.ts`: **the primitive library**, a versioned file (bump `metadata.version` on every change; the server refuses otherwise). Holds the vocabulary, categories and primitives (port templates, protocols, core parameter schemas with `x-*` keywords incl. `x-flow`). `checkPrimitiveLibrary` validates it.
- `src/model/vocabulary.ts`: transports/labels/aliases (`transportOf`), `KNOWN_FORMATS`, External device kinds and reference kinds, all from the library's `vocabulary`.
- `src/model/modules.ts`:
  - module identity: `vendorSlug`, `nextModuleId`, `catalogProblems`;
  - ports from primitive + choices: `portsFor`, `portChoiceOf`;
  - `coreSchemaFor` (protocol-filtered core parameters);
  - vendor settings: `settingsSchema`, `vendorConfig`.
- `src/model/catalog.ts`:
  - `Catalog`;
  - `resolvePorts` (arrays, dual paths, bundle groups);
  - `wireMismatch`;
  - `checkModule` / `conformance` / `checkCatalog`.
- `src/model/schema.ts`: JSON Schema subset: defaults, `validateValue`, `applies` (`x-when`), `titleFor`, `withoutInapplicable`, secret refs.
- `src/model/workload.ts`:
  - canvas ↔ workload: `toWorkload` / `fromWorkload`;
  - wiring: `planConnection`, `edgesFor`, `pruneWires`, `rebind`;
  - checks: `checkWorkload`, `publishProblems`;
  - desired state: `flowsOf` (formats from `x-flow` tags, `parseRate`), `toPublished` (adds `libraryVersion`).
- `src/model/externals.ts`: re-exports External devices from the vocabulary. `src/model/uuid.ts`: UUID v5 for flow ids.
- `server/db.ts` (schema v5, auto-migrates; records the library version + hash at startup), `server/app.ts` (REST: `/api/library[/versions|/:version]`, `/api/modules`, `/api/parts`, `/api/catalogs`, `/api/workloads`, `GET /api/workloads/:id/published`), `server/main.ts`.
- `src/api.ts`: API client, `refreshCatalog`, `useCatalog`.
- `src/components/`:
  - `MediaNode.tsx`: nodes; collapsible MXL bundles; protocol labels.
  - `Palette.tsx`
  - `Inspector.tsx`: function, External device, workload and flow panels.
  - `SchemaForm.tsx`: forms from schemas; honours `x-when`, `x-group`, `x-title-when`, `x-audience`.
  - `PartsEditor.tsx`: Modules tab, with live node preview driven by the sandbox form.
  - `WorkloadBrowser.tsx`
- `src/App.tsx`: wires (`Wire[]`) are the source of truth, edges derived; New / Open / Save / Import / Export / Publish; draft in `localStorage` key `dmf-toolkit:workload:v2`.
- `src/index.css`: all styles; dark theme only.

## Status (2026-10-13)

- Built: canvas, library server, Modules editor, Receiver with SRT (session, network constraints, payload, bonding), published desired state with MXL flows.
- `npm run build` / `lint` pass. Model and server are tested with tsx scripts; the Inspector was exercised with a jsdom harness (kept outside the repo). There is still no real browser in this WSL environment (no libnss3 / libasound).
- Only the Receiver's SRT parameters are fully defined; other protocols and the Decoder, Synchronizer and Encoder primitives are pending (see open questions in `docs/design-rules.md`).
- No auth yet.
- Git:
  - branch `main`; repo-local identity Kokovec <6053105+Kokovec@users.noreply.github.com>;
  - remote `origin` = https://github.com/Kokovec/DMF_Toolkit (private), tracking `main`;
  - gh CLI v2.101.0 in `~/.local/bin`, logged in as Kokovec;
  - `data/` (SQLite) is git-ignored;
  - commit only when the user asks.
