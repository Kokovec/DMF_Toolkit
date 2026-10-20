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
- `docs/primitives/<category>.md`: parameter detail (SRT etc.), written for the old primitives (see banners).
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

- `src/model/types.ts`: all data types (`FeatureDef`, `FeatureLibrary`, `ModuleDesign`/`ModuleBlock`, `VendorModule` (identity, `categories`, `design`, derived ports/parameters), `FunctionInstance` (incl. per-instance `settings`, `control`, `dependencies`, `resources`), `ModuleCatalog`, `PortDef`, `WorkloadDescription`, `FlowDef`, `JsonSchema` with `x-*` extensions; `apiVersion dmf-toolkit/v1alpha3`).
- `src/model/library.json` + `library.ts`: **the feature library**, a versioned file (bump `metadata.version` on every change; the server refuses otherwise). Holds the vocabulary, categories, chain types, feature groups and features (blocks, add-ons, module-wide, and options built into blocks via `includes`; parameters with `x-*` keywords incl. `x-flow`; external ports; design rules `attachTo` / `maxPerBlock` / `maxPerModule` / `needsAddon`). `checkLibrary` validates it. There are no primitives.
- `src/model/compose.ts`: design → module. Rules `canAddFeature`, `canAttach`, `canLink`, `designProblems`; `composeModule` (ports and core schema, namespaced by block id); `newBlockId`.
- `src/model/vocabulary.ts`: transports/labels/aliases (`transportOf`), `KNOWN_FORMATS`, External device kinds and reference kinds, all from the library's `vocabulary`.
- `src/model/modules.ts`:
  - module identity: `vendorSlug`, `nextModuleId` (`<catalog>.<n>`), `catalogProblems`;
  - `blankModule`, `withDerived` (recomputes ports, schema, capability from the design);
- `src/model/catalog.ts`:
  - `Catalog` (`forCategory`);
  - `resolvePorts` (arrays, dual paths, bundle groups);
  - `wireMismatch`;
  - `checkModule` (categories, design rules, derived parts match the design) / `checkCatalog`.
- `src/model/schema.ts`: JSON Schema subset: defaults, `validateValue`, `applies` (`x-when`), `titleFor`, `withoutInapplicable`, secret refs.
- `src/model/workload.ts`:
  - canvas ↔ workload: `toWorkload` / `fromWorkload`;
  - wiring: `planConnection`, `edgesFor`, `pruneWires`, `rebind`;
  - checks: `checkWorkload`, `publishProblems`, `setupProblems` (per-instance setup);
  - desired state: `flowsOf` (formats from `x-flow` tags, `parseRate`), `toPublished` (adds `libraryVersion`).
- `src/model/externals.ts`: re-exports External devices from the vocabulary. `src/model/uuid.ts`: UUID v5 for flow ids.
- `server/db.ts` (schema v8, auto-migrates; v5 receivers become designs; v8 moves module setup onto instances; records the library version + hash at startup), `server/app.ts` (REST: `/api/library[/versions|/:version]`, `/api/modules`, `/api/parts`, `/api/catalogs`, `/api/workloads`, `GET /api/workloads/:id/published`), `server/main.ts`.
- `src/api.ts`: API client, `refreshCatalog`, `useCatalog`.
- `src/components/`:
  - `MediaNode.tsx`: nodes; collapsible MXL bundles; protocol labels.
  - `Palette.tsx`
  - `Inspector.tsx`: function, External device, workload and flow panels.
  - `SchemaForm.tsx`: forms from schemas; honours `x-when`, `x-group`, `x-title-when`, `x-audience`.
  - `PartsEditor.tsx`: Modules tab (1 identity & categories, 2 design), with live node preview.
  - `FunctionSetup.tsx`: per-instance vendor settings (JSON), control & health, dependencies, resource profile (in the Inspector).
  - `ModuleDesigner.tsx`: drag-and-drop module design: feature sidebar, chain canvas (React Flow), block panel (rules and the settings each block adds; no parameter values), live design rules.
  - `WorkloadBrowser.tsx`
- `src/App.tsx`: wires (`Wire[]`) are the source of truth, edges derived; New / Open / Save / Import / Export / Publish; draft in `localStorage` key `dmf-toolkit:workload:v2`.
- `src/index.css`: all styles; dark theme only.

## Status (2026-10-20)

- Built: canvas, library server, Modules tab with the drag-and-drop module designer (features, signal chains, design rules), SRT input fully defined (session, bonding, network constraints, payload), Decoder with codec add-ons, MXL output, published desired state with MXL flows.
- `npm run build` / `lint` pass. Model and server are tested with tsx scripts; the Inspector and the designer were exercised with a jsdom harness (kept outside the repo). There is still no real browser in this WSL environment (no libnss3 / libasound).
- Only SRT parameters are fully defined; other protocols, MXL inputs, encoders and synchronizers are pending (see open questions in `docs/design-rules.md`).
- No auth yet.
- Git:
  - branch `main`; repo-local identity Kokovec <6053105+Kokovec@users.noreply.github.com>;
  - remote `origin` = https://github.com/Kokovec/DMF_Toolkit (private), tracking `main`;
  - gh CLI v2.101.0 in `~/.local/bin`, logged in as Kokovec;
  - `data/` (SQLite) is git-ignored;
  - commit only when the user asks.
