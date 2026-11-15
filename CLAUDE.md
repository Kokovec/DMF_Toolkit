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
- `docs/products/<product>.md`: how a modelled product's settings map to its real configuration (for the orchestrator's compile to Docker/Terraform).
- `docs/primitives/<category>.md`: parameter detail (SRT etc.), written for the old primitives (see banners).
- `docs/media-primitive.md`, `docs/orchestration-model.md`: historical (see their banners).

## Stack

- React 19 + TypeScript, Vite, oxlint; React Flow (`@xyflow/react` v12) for the canvas
- Commands:
  - `npm run dev`: UI on http://localhost:5173, proxies `/api`
  - `npm run server`: API + SQLite on :3001, `tsx watch`
  - `npm run build`: type-checks UI and server
  - `npm run lint`
  - `npm test`: `tsx --test tests/*.test.ts` (XML encoding, XSD validation with `xmllint` when installed, the XML route)
- Node 24 is under nvm and not on `PATH` in non-interactive shells: `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- Server: Node 24 built-in `node:sqlite`, plain `node:http`; no other runtime deps. `tsx` (dev dep) runs it
- Open `DMF Toolkit.code-workspace` in VS Code

## Code map

- `src/model/types.ts`: all data types (`FeatureDef`, `FeatureLibrary`, `ModuleDesign`/`ModuleBlock`, `VendorModule` (identity, `categories`, `design`, derived ports/parameters, `defaults` for a new instance incl. discovery and parameters), `FunctionInstance` (incl. per-instance `inputs`, `outputs`, `features`, `settings`, `control`, `dependencies`, `resources`), `ModuleCatalog`, `PortDef`, `WorkloadDescription`, `FlowDef`, `JsonSchema` with `x-*` extensions; `apiVersion dmf-toolkit/v1alpha4`; `spec.access`).
- `src/model/library.json` + `library.ts`: **the feature library**, a versioned file (bump `metadata.version` on every change; the server refuses otherwise). Holds the vocabulary (incl. access roles), categories, feature sections and groups (Common, Production switcher) and features (blocks, add-ons, module-wide, and options built into blocks via `includes`; parameters with `x-*` keywords incl. `x-flow`; external ports; design rules `attachTo` / `maxPerBlock` / `maxPerModule` / `needsAddon` / `requires`). `checkLibrary` validates it. There are no primitives.
- `src/model/compose.ts`: design → module. Rules `canAttach`, `designProblems`, `requiresProblems`; `feedOptions`; `composeModule` (ports and core schema, namespaced by block id; `ModuleBlock.allowed` narrows a feature per product, `noData` drops a block's ANC port). What an instance runs: `inputBlocks` / `outputBlocks`, `inputsOf` / `outputsOf` / `featuresOf`, `inputSelectionProblems` / `outputSelectionProblems` / `featureSelectionProblems`, `inputCopies`, `instanceDesign` / `instanceParts` (an instance's ports and schema for its selection).
- `src/model/vocabulary.ts`: transports/labels/aliases (`transportOf`), `KNOWN_FORMATS`, External device kinds and reference kinds, all from the library's `vocabulary`.
- `src/model/modules.ts`:
  - module identity: `vendorSlug`, `nextModuleId` (`<catalog>.<n>`), `catalogProblems`;
  - `blankModule`, `withDerived` (recomputes ports, schema, capability from the design);
- `src/model/catalog.ts`:
  - `Catalog` (`byCompany`: palette headings);
  - `resolvePorts` (arrays, dual paths, bundle groups);
  - `wireMismatch`;
  - `checkModule` (categories, design rules, derived parts match the design) / `checkCatalog`.
- `src/model/schema.ts`: JSON Schema subset: defaults, `validateValue`, `pattern`, `applies` (`x-when`), `allowedProblem` / `allowedChoices` (`x-allowed`), `optionPaths` (`x-options`), `titleFor`, `withoutInapplicable`, secret refs.
- `src/model/workload.ts`:
  - canvas ↔ workload: `toWorkload` / `fromWorkload`;
  - wiring: `planConnection`, `edgesFor`, `pruneWires`, `rebind`, `withSelection`; `portsOf` / `schemaOf` (per instance);
  - checks: `checkWorkload` (incl. instance ids, `INSTANCE_ID_RE`), `publishProblems` (incl. what the XML can't carry, history ≥ 1), `setupProblems` (per-instance setup), `accessProblems`; ids: `nextNodeId`, `toInstanceId`;
  - desired state: `flowsOf` (formats from `x-flow` tags, `parseRate`; video and audio of every MXL output in use), `toPublished` (adds `libraryVersion`).
- `src/model/xml.ts`: the published desired state as XML for the orchestrator: `toWorkloadXml` (deterministic; refuses what XML or the XSD can't carry with `XmlEncodeError`, every location named), `fromWorkloadXml` / `parseXml` (round-trip tests). `schemas/dmf-workload-v1.xsd`: byte-identical copy of the orchestrator's schema (source of truth: `DMF_Orchestrator/schemas/`).
- `tests/`: `xml.test.ts` (schema hash, fixtures current, XSD validation, round trips, determinism, refusals), `xml-route.test.ts` (the routes on an in-memory server), `publish-checks.test.ts` (XML encodability as a publish problem, instance ids, history ≥ 1), `switchframe-module.test.ts` (settings that follow the product's request bodies), `facility.test.ts` (capability list = the export's keys, gating with and without a facility, product limits, `/api/facility`), `compiler-checks.test.ts` (one test per value the compiler refuses, cases in `compiler-cases.ts`); `orchestrator.ts`: where the orchestrator checkout is, `DMF_ORCHESTRATOR` or the WSL default; the checks against it are skipped when it isn't there).
- `src/model/limits.ts`: what a product accepts beyond each value (R8.9): `uniqueProblems` (`x-unique`), `setupSchemaProblems` (`VendorModule.setupSchema`); flow formats and writers (`ModuleBlock.flowFormat` / `readsFrom`) are `flowRuleProblems` in `workload.ts`.
- `src/model/facility.ts`: what the facility can run (R8.8): `CAPABILITIES` (from the vocabulary), the UI's `currentFacility` / `setFacility`, `checkFacility`, `unavailable` / `valueUnavailable` (why not, as text), `facilityProblems` (`needs`, `x-enumNeeds`, GPU), `productProblems` / `conflictsOf` (`rules.conflictsWith`, with or without a facility).
- `src/model/externals.ts`: re-exports External devices from the vocabulary. `src/model/uuid.ts`: UUID v5 for flow ids.
- `DMF_FACILITY`: path to the orchestrator's facility export (`make facility-export` in `DMF_Orchestrator` → `.state/facility-local.json`), read by `server/main.ts` at start; unset = everything offered.
- `server/db.ts` (schema v10, auto-migrates; v5 receivers become designs; v8 moves module setup onto instances; v9 drops design links; v10 drops stale unused module versions; records the library version + hash at startup), `server/app.ts` (REST: `/api/facility`, `/api/library[/versions|/:version]`, `/api/modules`, `/api/parts`, `/api/catalogs`, `/api/workloads`, `GET /api/workloads/:id/published` and `/published.xml`), `server/main.ts`.
- `src/api.ts`: API client, `refreshCatalog`, `useCatalog`.
- `src/components/`:
  - `MediaNode.tsx`: nodes; collapsible MXL bundles; protocol labels.
  - `Palette.tsx`: products grouped by company; External devices; catalog import/export
  - `Inspector.tsx`: function summary (+ Configure…), External device, workload (incl. access) and flow panels.
  - `FunctionDialog.tsx`: configuring a function (double-click the node): tabs General (with the Features on/off section), Inputs (how many of each + each copy's settings), one per configurable feature that's on (parameter groups as sub-tabs), Outputs, Setup, Intent.
  - `SchemaForm.tsx`: forms from schemas; honours `x-when`, `x-group`, `x-title-when`, `x-audience`, `x-allowed`, `x-options`.
  - `FunctionSetup.tsx`: per-instance vendor settings (JSON), control & health, dependencies, resource profile (Setup tab).
  - `WorkloadBrowser.tsx`
- `src/App.tsx`: the workload editor (no Modules tab: modules are product models imported as catalogs); double-click a function opens its dialog; wires (`Wire[]`) are the source of truth, edges derived; New / Open / Save / Import / Export / Publish / Publish XML; draft in `localStorage` key `dmf-toolkit:workload:v2`.
- `src/index.css`: all styles; dark theme only.
- `catalogs/<company>.catalog.json`: the product catalogs, one per company, loaded by the server at every start (`server/main.ts`). Built by `npx tsx scripts/product-catalogs.ts` (re-run after a library change). `scripts/fixtures/studio-a.ts`: the reference workload, built through the model like a user would, matching the orchestrator's `examples/studio-a.workload.xml`; `every-value.ts`: every value type and optional element. `scripts/fixtures/write-xml.ts` writes their `.workload.xml` + `.published.json`, the round-trip fixtures both repos test (tests check they're current). Companies: Switchframe → Switchframe (`switchframe.1`; product mapping in `docs/products/switchframe.md`), DMF MXL → MXL test source, A/V sync test source.

## Status (2026-11-02)

- Built: canvas, library server, product modules imported as catalogs (no module designer), function configuration dialog with feature tabs, SRT input fully defined (session, bonding, network constraints, payload), inputs/outputs from the Ateme TITAN Live datasheet (ST 2110, 2022-6, NDI, TSoIP, HLS, RTMPS, MXL in; TSoIP, MBTS, SRT, RIST, ZIXI, RTMPS, HLS, DASH, CMAF, ATSC 3.0 out), Decoder and Encoder with codec add-ons, MXL output, production switcher features modelled on Switchframe (example catalog), input/output selection and scale-out per instance, published desired state with MXL flows. Model stage of the orchestration build done (optional features, instance defaults, unread flows, format combinations, access, test sources). XML publish done (stage 2). Next: the compiler, in the orchestrator repo (stage 3 in `DMF_Orchestrator/docs/orchestration/`, the definition, read-only from here).
- `npm run build` / `lint` pass. Model and server are tested with tsx scripts, and the XML with `npm test`; the Inspector and the function dialog were exercised with a jsdom harness (kept outside the repo). There is still no real browser in this WSL environment (no libnss3 / libasound).
- Only SRT parameters are fully defined; parameters for the other inputs and the outputs, more codecs and synchronizers are pending (see open questions in `docs/design-rules.md`).
- No auth yet.
- Git:
  - branch `main`; commits use the GitHub noreply address (Kokovec), set as the repo-local identity;
  - remote `origin` = https://github.com/Kokovec/DMF_Toolkit (public), tracking `main`;
  - `data/` (SQLite) is git-ignored;
  - commit only when the user asks.
