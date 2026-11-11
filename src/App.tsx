import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnConnectEnd,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { api, describeError, refreshCatalog, refreshFacility, useCatalog, useFacility } from './api'
import { EXTERNALS } from './model/externals'
import { randomUuid } from './model/uuid'
import { vendorSlug } from './model/modules'
import type { ExternalKind, Wire, WorkloadAccess, WorkloadDefaults, WorkloadDescription } from './model/types'
import {
  DEFAULTS,
  checkWorkload,
  edgesFor,
  flowsOf,
  fromWorkload,
  isWorkloadEnvelope,
  newFunctionData,
  nextNodeId,
  planConnection,
  publishProblems,
  moduleOf,
  pruneWires,
  splitRef,
  toWorkload,
  type CanvasNode,
  type ExtData,
  type FnData,
  type WireEdge,
  type WorkloadMeta,
} from './model/workload'
import { ExternalNode, FunctionNode } from './components/MediaNode'
import { DRAG_MIME, Palette } from './components/Palette'
import { Inspector } from './components/Inspector'
import { FunctionDialog } from './components/FunctionDialog'
import { CAPABILITIES } from './model/facility'
import { WorkloadBrowser } from './components/WorkloadBrowser'

const nodeTypes = { fn: FunctionNode, ext: ExternalNode }
const STORAGE_KEY = 'dmf-toolkit:workload:v2'
const newMeta = (): WorkloadMeta => ({ id: 'new-workload', uid: randomUuid(), name: 'New workload' })

// Which server revision the canvas is based on (null = never saved / not from the server).
type SavedRef = { id: string; revision: number; json: string } | null
type Draft = { document: WorkloadDescription; saved: SavedRef }

// The local draft is not checked against the catalog: its modules may only exist in the server
// library, which loads after startup. Unknown modules render as placeholders.
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const draft = JSON.parse(raw) as Draft
      if (isWorkloadEnvelope(draft.document)) return { ...fromWorkload(draft.document), saved: draft.saved ?? null }
    }
  } catch {
    // ignore unreadable storage
  }
  return { metadata: newMeta(), defaults: DEFAULTS, nodes: [] as CanvasNode[], wires: [] as Wire[], access: undefined, saved: null }
}

const initial = loadDraft()

function download(name: string, data: unknown, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function Editor() {
  const catalog = useCatalog()
  const facility = useFacility()
  const [metadata, setMetadata] = useState<WorkloadMeta>(initial.metadata)
  const [defaults, setDefaults] = useState<WorkloadDefaults>(initial.defaults)
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial.nodes)
  const [wires, setWires] = useState<Wire[]>(initial.wires)
  const [access, setAccess] = useState<WorkloadAccess | undefined>(initial.access)
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<SavedRef>(initial.saved)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [online, setOnline] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [configuring, setConfiguring] = useState<string | null>(null) // function node whose dialog is open
  const { screenToFlowPosition, getNode, fitView } = useReactFlow<CanvasNode, WireEdge>()
  const fileInput = useRef<HTMLInputElement>(null)

  const showMessage = useCallback((text: string, isError: boolean) => setMessage({ text, isError }), [])

  const edges = useMemo(() => edgesFor(wires, nodes, selectedEdges, catalog), [wires, nodes, selectedEdges, catalog])
  const workload = useMemo(() => toWorkload(metadata, defaults, nodes, wires, access), [metadata, defaults, nodes, wires, access])
  const json = useMemo(() => JSON.stringify(workload), [workload])
  const problems = useMemo(() => publishProblems(workload, catalog, facility), [workload, catalog, facility])
  // MXL flows carried by the selected wire(s), for the Flow panel.
  const selectedFlows = useMemo(() => {
    const writers = new Set(edges.filter((e) => selectedEdges.has(e.id)).flatMap((e) => e.data?.wires.map((w) => w.from) ?? []))
    return writers.size ? flowsOf(workload, catalog).filter((f) => writers.has(f.writer)) : []
  }, [edges, selectedEdges, workload, catalog])
  const savedHere = saved?.id === metadata.id ? saved : null
  const dirty = savedHere?.json !== json

  // Load the vendor module library from the server (the palette is empty while offline).
  useEffect(() => {
    refreshCatalog().then(
      () => setOnline(true),
      () => setOnline(false),
    )
    // No answer (offline, older server): no facility, everything stays offered.
    refreshFacility().catch(() => undefined)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ document: workload, saved } satisfies Draft))
    } catch {
      // storage full or blocked; the canvas still works
    }
  }, [workload, saved])

  const load = useCallback(
    (doc: WorkloadDescription, revision: number | null) => {
      const loaded = fromWorkload(doc)
      setMetadata(loaded.metadata)
      setDefaults(loaded.defaults)
      setNodes(loaded.nodes)
      setWires(loaded.wires)
      setAccess(loaded.access)
      setSelectedEdges(new Set())
      // Snapshot in canvas-normalised form so "modified" compares like with like.
      const json = JSON.stringify(toWorkload(loaded.metadata, loaded.defaults, loaded.nodes, loaded.wires, loaded.access))
      setSaved(revision === null ? null : { id: loaded.metadata.id, revision, json })
      requestAnimationFrame(() => fitView())
    },
    [fitView, setNodes],
  )

  // ---- Canvas events ----

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes)
      const removed = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])))
      if (removed.size)
        setWires((ws) => ws.filter((w) => !removed.has(splitRef(w.from).node) && !removed.has(splitRef(w.to).node)))
    },
    [onNodesChange],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<WireEdge>[]) => {
      setSelectedEdges((prev) => {
        const next = new Set(prev)
        for (const c of changes) {
          if (c.type !== 'select') continue
          if (c.selected) next.add(c.id)
          else next.delete(c.id)
        }
        return next
      })
      const removed = changes.flatMap((c) => (c.type === 'remove' ? (edges.find((e) => e.id === c.id)?.data?.wires ?? []) : []))
      if (removed.length) setWires((ws) => ws.filter((w) => !removed.some((r) => r.from === w.from && r.to === w.to)))
    },
    [edges],
  )

  const plan = useCallback(
    (c: Connection) =>
      c.sourceHandle && c.targetHandle
        ? planConnection(getNode, wires, c.source, c.sourceHandle, c.target, c.targetHandle, catalog)
        : { error: 'unknown port' },
    [getNode, wires, catalog],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      const r = plan(c)
      if ('wires' in r) setWires((ws) => [...ws, ...r.wires])
    },
    [plan],
  )

  const isValidConnection: IsValidConnection<WireEdge> = useCallback((c) => 'wires' in plan(c as Connection), [plan])

  // Explain why a drop on a port was refused.
  const onConnectEnd: OnConnectEnd = useCallback(
    (_e, state) => {
      if (state.isValid || !state.toHandle || !state.fromHandle || !state.fromNode || !state.toNode) return
      const fromIsSource = state.fromHandle.type === 'source'
      const r = plan({
        source: fromIsSource ? state.fromNode.id : state.toNode.id,
        sourceHandle: (fromIsSource ? state.fromHandle.id : state.toHandle.id) ?? null,
        target: fromIsSource ? state.toNode.id : state.fromNode.id,
        targetHandle: (fromIsSource ? state.toHandle.id : state.fromHandle.id) ?? null,
      })
      if ('error' in r) showMessage(`Cannot connect: ${r.error}`, true)
    },
    [plan, showMessage],
  )

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      const [what, key] = e.dataTransfer.getData(DRAG_MIME).split(':')
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setNodes((nds) => {
        let node: CanvasNode
        if (what === 'fn') {
          const prim = catalog.get(key)
          if (!prim) return nds
          const base = vendorSlug(prim.name).slice(0, 24) || 'fn'
          const id = nextNodeId(base, nds.map((n) => n.id))
          node = { id, type: 'fn', position, selected: true, data: newFunctionData(prim, `${prim.name} ${id.slice(base.length + 1)}`) }
        } else if (what === 'ext' && EXTERNALS[key as ExternalKind]) {
          const t = EXTERNALS[key as ExternalKind]
          const id = nextNodeId(t.kind, nds.map((n) => n.id))
          node = { id, type: 'ext', position, selected: true, data: { kind: 'ext', extKind: t.kind, name: `${t.name} ${id.slice(t.kind.length + 1)}` } }
        } else return nds
        return [...nds.map((n) => ({ ...n, selected: false })), node]
      })
    },
    [screenToFlowPosition, setNodes, catalog],
  )

  const updateNode = useCallback(
    (id: string, data: FnData | ExtData) => {
      const next = nodes.map((n) => (n.id === id ? ({ ...n, data } as CanvasNode) : n))
      setNodes(next)
      // Ports may have changed (port array size, rebinding): drop wires to ports that are gone.
      setWires((ws) => pruneWires(ws, next, catalog))
    },
    [nodes, setNodes, catalog],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setWires((ws) => ws.filter((w) => splitRef(w.from).node !== id && splitRef(w.to).node !== id))
    },
    [setNodes],
  )

  // ---- Commands ----

  const clear = () => {
    if (confirm(dirty ? 'Discard unsaved changes and start a new workload?' : 'Start a new, empty workload?')) {
      setMetadata(newMeta())
      setDefaults(DEFAULTS)
      setNodes([])
      setWires([])
      setAccess(undefined)
      setSaved(null)
    }
  }

  const save = async (): Promise<number | null> => {
    try {
      const { revision } = await api.saveWorkload(workload, savedHere?.revision ?? 0)
      setSaved({ id: metadata.id, revision, json })
      showMessage(`Saved ${metadata.id} as revision ${revision}`, false)
      return revision
    } catch (e) {
      showMessage(`Save failed: ${describeError(e)}`, true)
      return null
    }
  }

  // Publishing = a saved revision that passes every check, served to the orchestrator at
  // /api/workloads/:id/published. A copy is downloaded for reference.
  const publish = async () => {
    const revision = dirty || !savedHere ? await save() : savedHere.revision
    if (revision === null) return
    try {
      const published = await api.published(metadata.id, revision)
      download(`${metadata.id}.r${revision}.published.json`, published)
      showMessage(`Published revision ${revision}. Orchestrator endpoint: /api/workloads/${metadata.id}/published`, false)
    } catch (e) {
      showMessage(`Publish failed: ${describeError(e)}`, true)
    }
  }

  // The same, as the XML the orchestrator reads (`make import XML=…`).
  const publishXml = async () => {
    const revision = dirty || !savedHere ? await save() : savedHere.revision
    if (revision === null) return
    try {
      const xml = await api.publishedXml(metadata.id, revision)
      download(`${metadata.id}.workload.xml`, xml, 'application/xml')
      showMessage(`Published revision ${revision} as XML. Orchestrator endpoint: /api/workloads/${metadata.id}/published.xml`, false)
    } catch (e) {
      showMessage(`Publish XML failed: ${describeError(e)}`, true)
    }
  }

  const open = async (id: string) => {
    if (dirty && nodes.length && !confirm('Discard unsaved changes on the canvas?')) return
    try {
      const { revision, document: doc } = await api.workload(id)
      load(doc, revision)
      setBrowsing(false)
      setMessage(null)
    } catch (e) {
      showMessage(`Open failed: ${describeError(e)}`, true)
    }
  }

  const importJson = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const doc = JSON.parse(await file.text())
      const errors = checkWorkload(doc, catalog)
      if (errors.length) {
        showMessage(`Cannot import ${file.name}: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ' …' : ''}`, true)
        return
      }
      load(doc as WorkloadDescription, null)
      setMessage(null)
    } catch {
      showMessage(`Cannot import ${file.name}: not valid JSON`, true)
    }
  }

  const configuringNode = nodes.find((n) => n.id === configuring)
  const configuringModule = configuringNode?.data.kind === 'fn' ? moduleOf(configuringNode.data, catalog) : undefined

  return (
    <div className="app">
      <header className="topbar">
        <h1>DMF Toolkit</h1>
        <span className="workload-name">
          {metadata.name} · {savedHere ? `rev ${savedHere.revision}${dirty ? ' (modified)' : ''}` : 'not saved'}
        </span>
        <span className="spacer" />
        {facility.capabilities && (
          <span
            className="status facility"
            title={`What facility ${facility.name} doesn't offer is disabled: ${
              CAPABILITIES.filter((c) => facility.capabilities![c.id] !== true)
                .map((c) => c.label)
                .join(', ') || 'nothing'
            }`}
          >
            Facility {facility.name}
          </span>
        )}
        <span className={`status ${online ? 'online' : 'offline'}`} title={online ? 'Library server connected' : 'Library server not reachable'}>
          {online ? 'Library connected' : 'Offline'}
        </span>
        <button onClick={clear}>New</button>
        <button onClick={() => setBrowsing(true)} disabled={!online}>
          Open…
        </button>
        <button onClick={save} disabled={!online || !dirty}>
          Save
        </button>
        <button onClick={() => fileInput.current?.click()}>Import</button>
        <button onClick={() => download(`${metadata.id || 'workload'}.workload.json`, workload)}>Export</button>
        <button
          className="primary"
          onClick={publish}
          disabled={!online || problems.length > 0}
          title={problems.length ? `${problems.length} issue(s): see Publish readiness (click empty canvas)` : 'Save and publish to the orchestrator'}
        >
          Publish{problems.length ? ` (${problems.length})` : ''}
        </button>
        <button
          onClick={publishXml}
          disabled={!online || problems.length > 0}
          title={problems.length ? `${problems.length} issue(s): see Publish readiness (click empty canvas)` : 'Save, publish and download the XML the orchestrator reads'}
        >
          Publish XML
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={importJson} />
      </header>
      {message && (
        <div className={message.isError ? 'error-bar' : 'info-bar'} role={message.isError ? 'alert' : 'status'}>
          {message.text}
          <button onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}
      {browsing && <WorkloadBrowser onOpen={open} onClose={() => setBrowsing(false)} />}
      <div className="workspace">
        <Palette online={online} onMessage={showMessage} />
        <div className="canvas" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeDoubleClick={(_e, n) => n.data.kind === 'fn' && setConfiguring(n.id)}
            zoomOnDoubleClick={false}
            deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.1}
            maxZoom={4}
            snapToGrid
            snapGrid={[16, 16]}
            fitView
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <Inspector
          selected={nodes.filter((n) => n.selected)}
          metadata={metadata}
          onMetadataChange={setMetadata}
          defaults={defaults}
          onDefaultsChange={setDefaults}
          access={access}
          onAccessChange={setAccess}
          problems={problems}
          onNodeChange={updateNode}
          onDelete={deleteNode}
          onConfigure={setConfiguring}
          flows={selectedFlows}
          nodes={nodes}
        />
        {configuringNode?.data.kind === 'fn' && configuringModule && (
          <FunctionDialog
            id={configuringNode.id}
            data={configuringNode.data}
            prim={configuringModule}
            others={nodes.filter((n) => n.data.kind === 'fn' && n.id !== configuringNode.id).map((n) => n.id)}
            problems={problems}
            onChange={(data) => updateNode(configuringNode.id, data)}
            onClose={() => setConfiguring(null)}
          />
        )}
      </div>

    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  )
}
