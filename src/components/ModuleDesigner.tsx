// Module designer: drag features from the sidebar onto the module canvas, attach add-ons to blocks,
// and link blocks into signal chains. Design rules (from the feature library) are checked live:
// invalid drops and links are refused with the reason; unmet rules are listed below the canvas.
import { useCallback, useMemo, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
} from '@xyflow/react'
import { canAddFeature, canAttach, canLink, designProblems, newBlockId } from '../model/compose'
import { getFeature, LIBRARY, featuresIn } from '../model/library'
import { TRANSPORT_LABELS } from '../model/vocabulary'
import type { Essence, FeatureDef, ModuleBlock, ModuleDesign } from '../model/types'

const FEATURE_MIME = 'application/x-dmf-feature'

type Props = {
  design: ModuleDesign
  onChange: (d: ModuleDesign) => void
  locked?: boolean
}

const chainName = (id?: string) => LIBRARY.spec.chainTypes.find((c) => c.id === id)?.name.toLowerCase()

// One-line statement of a feature's rules, shown in the sidebar and the block panel.
function ruleSummary(f: FeatureDef): string {
  if (f.kind === 'addon') {
    const targets = (f.rules?.attachTo ?? []).map((p) => (p.endsWith('.*') ? `any ${p.slice(0, -2)}` : getFeature(p)?.name ?? p))
    return `attaches to ${targets.join(' or ')}${f.rules?.maxPerBlock === 1 ? ', once per block' : ''}`
  }
  if (f.kind === 'module') return `module-wide${f.rules?.maxPerModule ? `, at most ${f.rules.maxPerModule}` : ''}`
  const parts: string[] = []
  if (f.external) {
    const proto = TRANSPORT_LABELS[f.external.protocol] ?? f.external.protocol
    parts.push(`${f.external.direction === 'in' ? 'receives' : 'sends'} ${proto}${f.external.dual === 'always' ? ' (two legs)' : ''}`)
  }
  parts.push(f.input ? `takes a ${chainName(f.input)}` : 'starts a chain')
  if (f.output) parts.push(`gives ${chainName(f.output)}`)
  if (f.mxlOutputs) parts.push('publishes MXL flows')
  for (const n of f.rules?.needsAddon ?? []) parts.push(`needs ≥${n.min} ${LIBRARY.spec.featureGroups.find((g) => g.id === n.group)?.name.toLowerCase()}`)
  return parts.join(' · ')
}

export function ModuleDesigner(props: Props) {
  return (
    <ReactFlowProvider>
      <Designer {...props} />
    </ReactFlowProvider>
  )
}

function Designer({ design, onChange, locked }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  const problems = useMemo(() => designProblems(design), [design])

  const update = useCallback((patch: Partial<ModuleDesign>) => onChange({ ...design, ...patch }), [design, onChange])
  const setBlock = useCallback(
    (id: string, patch: Partial<ModuleBlock>) => update({ blocks: design.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
    [design, update],
  )
  const removeAddon = useCallback(
    (blockId: string, index: number) => {
      const b = design.blocks.find((x) => x.id === blockId)
      if (b) setBlock(blockId, { addons: b.addons.filter((_, i) => i !== index) })
    },
    [design, setBlock],
  )
  const removeBlocks = useCallback(
    (ids: string[]) => {
      const layout = { ...design.layout }
      for (const id of ids) delete layout[id]
      update({
        blocks: design.blocks.filter((b) => !ids.includes(b.id)),
        links: design.links.filter((l) => !ids.includes(l.from) && !ids.includes(l.to)),
        layout,
      })
      if (selected && ids.includes(selected)) setSelected(null)
    },
    [design, update, selected],
  )

  // ---- canvas ----
  const nodes: Node<BlockData, 'block'>[] = design.blocks.map((b, i) => ({
    id: b.id,
    type: 'block',
    position: design.layout?.[b.id] ?? { x: 40 + (i % 4) * 220, y: 40 + Math.floor(i / 4) * 160 },
    selected: b.id === selected,
    data: { block: b, problem: problems.some((p) => p.includes(`(${b.id})`)), onRemoveAddon: removeAddon, locked },
    deletable: !locked,
    draggable: !locked,
  }))
  const edges: Edge[] = design.links.map((l) => ({ id: `${l.from}->${l.to}`, source: l.from, target: l.to, deletable: !locked, className: 'chain-link' }))

  const onNodesChange = (changes: NodeChange[]) => {
    const layout = { ...design.layout }
    let moved = false
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        layout[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) }
        moved = true
      }
      if (c.type === 'select' && c.selected) setSelected(c.id)
    }
    const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []))
    if (removed.length) removeBlocks(removed)
    else if (moved) update({ layout })
  }
  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])))
    if (removed.size) update({ links: design.links.filter((l) => !removed.has(`${l.from}->${l.to}`)) })
  }
  const onConnect = (c: Connection) => {
    const why = canLink(design, c.source, c.target)
    if (why) setNotice(why)
    else {
      update({ links: [...design.links, { from: c.source, to: c.target }] })
      setNotice(null)
    }
  }
  const onConnectEnd: OnConnectEnd = (_e, s) => {
    if (s.isValid || !s.fromNode || !s.toNode) return
    const [from, to] = s.fromHandle?.type === 'source' ? [s.fromNode.id, s.toNode.id] : [s.toNode.id, s.fromNode.id]
    setNotice(canLink(design, from, to))
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    if (locked) return
    const f = getFeature(e.dataTransfer.getData(FEATURE_MIME))
    if (!f) return
    if (f.kind === 'option') return // built into blocks; not placed by the author
    if (f.kind === 'addon') {
      // an add-on goes onto the block it was dropped on
      const targetId = (e.target as Element).closest?.('.react-flow__node')?.getAttribute('data-id')
      if (!targetId) return setNotice(`Drop ${f.name} onto a block (${ruleSummary(f)})`)
      const why = canAttach(design, f, targetId)
      if (why) return setNotice(why)
      const b = design.blocks.find((x) => x.id === targetId)!
      setBlock(b.id, { addons: [...b.addons, f.id] })
      setSelected(b.id)
      return setNotice(null)
    }
    const why = canAddFeature(design, f)
    if (why) return setNotice(why)
    if (f.kind === 'module') {
      update({ moduleFeatures: [...design.moduleFeatures, f.id] })
      setSelected(null)
      return setNotice(null)
    }
    const id = newBlockId(design, f.id)
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    update({
      blocks: [...design.blocks, { id, feature: f.id, addons: [] }],
      layout: { ...design.layout, [id]: { x: Math.round(pos.x - 80), y: Math.round(pos.y - 30) } },
    })
    setSelected(id)
    setNotice(null)
  }

  const block = design.blocks.find((b) => b.id === selected)

  return (
    <div className="designer">
      <FeatureSidebar design={design} locked={locked} />
      <div className="designer-main">
        <div
          className="designer-canvas"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onPaneClick={() => setSelected(null)}
            isValidConnection={(c) => canLink(design, c.source, c.target) === null}
            deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
            nodesConnectable={!locked}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
            snapToGrid
            snapGrid={[10, 10]}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          </ReactFlow>
          {!design.blocks.length && <p className="designer-empty">Drag features here: start with an input.</p>}
        </div>
        {notice && (
          <p className="error-text designer-notice">
            {notice}{' '}
            <button className="link" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </p>
        )}
        {design.moduleFeatures.length > 0 && (
          <div className="module-features">
            <span className="hint">Module-wide:</span>
            {design.moduleFeatures.map((m, i) => (
              <span key={m} className="chip">
                {getFeature(m)?.name ?? m}
                {!locked && (
                  <button title="Remove" onClick={() => update({ moduleFeatures: design.moduleFeatures.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className={`rules ${problems.length ? 'open' : 'ok'}`}>
          {problems.length ? (
            <>
              <strong>Design rules not yet met</strong>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : (
            <span className="ok-text">All design rules met.</span>
          )}
        </div>
      </div>
      <BlockPanel
        block={block}
        design={design}
        onEssence={(e) => block && setBlock(block.id, { essence: e })}
        onRemoveAddon={(i) => block && removeAddon(block.id, i)}
        onRemove={() => block && removeBlocks([block.id])}
        problems={block ? problems.filter((p) => p.includes(`(${block.id})`)) : []}
        locked={locked}
      />
    </div>
  )
}

// ---- Sidebar ----

function FeatureSidebar({ design, locked }: { design: ModuleDesign; locked?: boolean }) {
  return (
    <aside className="feature-sidebar">
      {LIBRARY.spec.featureGroups.map((g) => ({ g, features: featuresIn(g.id).filter((f) => f.kind !== 'option') })).filter((x) => x.features.length).map(({ g, features }) => (
        <section key={g.id}>
          <h4>{g.name}</h4>
          {features.map((f) => {
            const full = f.kind !== 'addon' && canAddFeature(design, f) !== null
            return (
              <div
                key={f.id}
                className={`feature-item group-${f.group} kind-${f.kind}${full ? ' full' : ''}`}
                draggable={!locked && !full}
                title={`${f.description}\n\nRule: ${ruleSummary(f)}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(FEATURE_MIME, f.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <span>{f.name}</span>
                <span className="feature-rule">{ruleSummary(f)}</span>
              </div>
            )
          })}
        </section>
      ))}
    </aside>
  )
}

// ---- Canvas block ----

type BlockData = { block: ModuleBlock; problem: boolean; onRemoveAddon: (blockId: string, index: number) => void; locked?: boolean }

function BlockCard({ data, selected }: NodeProps<Node<BlockData, 'block'>>) {
  const { block: b, problem, onRemoveAddon, locked } = data
  const f = getFeature(b.feature)
  if (!f) return <div className="design-block unknown">unknown feature {b.feature}</div>
  const essence = b.essence ?? f.external?.essenceOptions[0]
  return (
    <div className={`design-block group-${f.group}${selected ? ' selected' : ''}${problem ? ' has-problem' : ''}`}>
      {f.input && <Handle type="target" position={Position.Left} title={`takes a ${chainName(f.input)}`} />}
      <div className="design-block-head">
        <strong>{f.name}</strong>
        <span className="hint">{b.id}</span>
      </div>
      {f.external && (
        <div className="design-block-io">
          {f.external.direction === 'in' ? '◀ ' : ''}
          {TRANSPORT_LABELS[f.external.protocol] ?? f.external.protocol}
          {f.external.dual === 'always' ? ' ×2' : ''} · {essence === 'audio' ? 'audio feed' : 'video feed'}
        </div>
      )}
      {f.mxlOutputs && <div className="design-block-io">MXL ▶</div>}
      {b.addons.length > 0 && (
        <div className="chips">
          {b.addons.map((a, i) => (
            <span key={`${a}${i}`} className="chip">
              {getFeature(a)?.name ?? a}
              {!locked && (
                <button
                  className="nodrag"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveAddon(b.id, i)
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {f.output && <Handle type="source" position={Position.Right} title={`gives ${chainName(f.output)}`} />}
    </div>
  )
}

const nodeTypes = { block: BlockCard }

// ---- Selected block ----

type PanelProps = {
  block?: ModuleBlock
  design: ModuleDesign
  onEssence: (e: Essence) => void
  onRemoveAddon: (index: number) => void
  onRemove: () => void
  problems: string[]
  locked?: boolean
}

function BlockPanel({ block, design, onEssence, onRemoveAddon, onRemove, problems, locked }: PanelProps) {
  if (!block)
    return (
      <aside className="block-panel">
        <h4>Module</h4>
        <p className="hint">
          {design.blocks.length} block{design.blocks.length === 1 ? '' : 's'}, {design.links.length} link{design.links.length === 1 ? '' : 's'}. Select
          a block to see its rules and what it adds.
        </p>
        <p className="hint">
          Drag <strong>blocks</strong> onto the canvas, drop <strong>add-ons</strong> (codecs) onto a block, drop <strong>module-wide</strong> features
          anywhere. Link blocks by dragging from a block's right handle to another block's left handle.
        </p>
      </aside>
    )
  const f = getFeature(block.feature)
  // Names only: the values (e.g. the SRT session) are configured per instance in the workload.
  const groups = [block.feature, ...(f?.includes ?? []), ...block.addons].map(getFeature).flatMap((x) => (x?.parameters ? [x.parameters.schema.title ?? x.name] : []))
  return (
    <aside className="block-panel">
      <h4>
        {f?.name} <span className="hint">{block.id}</span>
      </h4>
      <p className="hint">{f?.description}</p>
      {f && <p className="feature-rule">Rule: {ruleSummary(f)}</p>}
      {f?.external && (
        <label className="field">
          <span>Feed</span>
          <select value={block.essence ?? f.external.essenceOptions[0]} disabled={locked} onChange={(e) => onEssence(e.target.value as Essence)}>
            {f.external.essenceOptions.map((e) => (
              <option key={e} value={e}>
                {e === 'audio' ? 'audio-only feed' : e === 'video' ? 'video feed (with its audio and ANC)' : e}
              </option>
            ))}
          </select>
        </label>
      )}
      {block.addons.length > 0 && (
        <div className="field">
          <span>Add-ons</span>
          <div className="chips">
            {block.addons.map((a, i) => (
              <span key={`${a}${i}`} className="chip" title={getFeature(a) ? ruleSummary(getFeature(a)!) : ''}>
                {getFeature(a)?.name ?? a}
                {!locked && <button onClick={() => onRemoveAddon(i)}>×</button>}
              </span>
            ))}
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="problems compact">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="field">
          <span>Settings it adds</span>
          <span className="hint">{groups.join(', ')}: set per instance in the workload designer, not here.</span>
        </div>
      )}
      {!locked && (
        <button className="danger" onClick={onRemove}>
          Remove block
        </button>
      )}
    </aside>
  )
}
