// Module designer: drag functions from the sidebar onto the workspace and drop add-ons (codecs)
// onto them. A module is a generic description of a product's features: the functions it offers,
// not how they're wired or configured (both belong to the workload designer). Design rules from
// the feature library are checked live: invalid drops are refused with the reason, and unmet rules
// are listed under the workspace.
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { canAddFeature, canAttach, designProblems, feedOptions, inputBlocks, isInputFeature, MAX_SCALE_OUT, newBlockId } from '../model/compose'
import { getFeature, LIBRARY, featuresIn } from '../model/library'
import { TRANSPORT_LABELS } from '../model/vocabulary'
import type { Essence, FeatureDef, InputRule, ModuleBlock, ModuleDesign } from '../model/types'

const FEATURE_MIME = 'application/x-dmf-feature'

type Props = {
  design: ModuleDesign
  onChange: (d: ModuleDesign) => void
  locked?: boolean
}

const FEED_LABEL: Record<Essence, string> = { video: 'video feed (with its audio and ANC)', audio: 'audio-only feed', data: 'data feed' }

// One-line statement of a feature: what it does and its rules. Shown in the sidebar and below.
function ruleSummary(f: FeatureDef): string {
  if (f.kind === 'addon') {
    const targets = (f.rules?.attachTo ?? []).map((p) => (p.endsWith('.*') ? `any ${p.slice(0, -2)}` : getFeature(p)?.name ?? p))
    return `drop onto ${targets.join(' or ')}${f.rules?.maxPerBlock === 1 ? ', once each' : ''}`
  }
  if (f.kind === 'module') return `module-wide${f.rules?.maxPerModule ? `, at most ${f.rules.maxPerModule}` : ''}`
  const parts: string[] = []
  if (f.external) {
    const proto = TRANSPORT_LABELS[f.external.protocol] ?? f.external.protocol
    parts.push(`${f.external.direction === 'in' ? 'receives' : 'sends'} ${proto}${f.external.dual === 'always' ? ' (two legs)' : ''}`)
  }
  if (f.mxlInputs) parts.push('reads MXL flows')
  if (f.mxlOutputs) parts.push('publishes MXL flows')
  for (const n of f.rules?.needsAddon ?? []) parts.push(`needs ≥${n.min} ${LIBRARY.spec.featureGroups.find((g) => g.id === n.group)?.name.toLowerCase()}`)
  if (f.rules?.maxPerModule) parts.push(`at most ${f.rules.maxPerModule}`)
  return parts.join(' · ')
}

type BlockNodeData = {
  block: ModuleBlock
  problem: boolean
  locked?: boolean
  onRemove: () => void
  onRemoveAddon: (index: number) => void
}
type ModuleNodeData = { feature: string; locked?: boolean; onRemove: () => void }
type DesignNode = Node<BlockNodeData, 'block'> | Node<ModuleNodeData, 'module'>

const moduleNodeId = (feature: string) => `module:${feature}`
// Where a node goes when it has no saved position: a grid, left to right.
const defaultPosition = (i: number) => ({ x: 40 + (i % 5) * 230, y: 40 + Math.floor(i / 5) * 140 })

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
  const [nodes, setNodes] = useState<DesignNode[]>([])
  const { screenToFlowPosition } = useReactFlow()
  const problems = useMemo(() => designProblems(design), [design])

  const update = (patch: Partial<ModuleDesign>) => onChange({ ...design, ...patch })
  const setBlock = (id: string, patch: Partial<ModuleBlock>) => update({ blocks: design.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) })
  const removeAddon = (blockId: string, index: number) => {
    const b = design.blocks.find((x) => x.id === blockId)
    if (b) setBlock(blockId, { addons: b.addons.filter((_, i) => i !== index) })
  }
  // Remove blocks and module-wide features by node id.
  const removeNodes = (ids: string[]) => {
    const layout = { ...design.layout }
    for (const id of ids) delete layout[id]
    update({
      blocks: design.blocks.filter((b) => !ids.includes(b.id)),
      moduleFeatures: design.moduleFeatures.filter((m) => !ids.includes(moduleNodeId(m))),
      layout,
    })
    if (selected && ids.includes(selected)) setSelected(null)
  }

  // The canvas nodes follow the design; React Flow keeps their measured size between renders.
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      const ids = [...design.blocks.map((b) => b.id), ...design.moduleFeatures.map(moduleNodeId)]
      return ids.map((id, i): DesignNode => {
        const base = { ...old.get(id), id, position: old.get(id)?.position ?? design.layout?.[id] ?? defaultPosition(i), selected: id === selected, deletable: !locked, draggable: !locked }
        const b = design.blocks.find((x) => x.id === id)
        if (b)
          return {
            ...base,
            type: 'block',
            data: {
              block: b,
              problem: problems.some((p) => p.includes(`(${b.id})`)),
              locked,
              onRemove: () => removeNodes([b.id]),
              onRemoveAddon: (index: number) => removeAddon(b.id, index),
            },
          }
        const feature = id.slice('module:'.length)
        return { ...base, type: 'module', data: { feature, locked, onRemove: () => removeNodes([id]) } }
      })
    })
    // removeNodes / removeAddon close over the current design, which is in the deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, selected, locked, problems])

  const onNodesChange = (changes: NodeChange<DesignNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
    const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []))
    if (removed.length) return removeNodes(removed)
    for (const c of changes) if (c.type === 'select' && c.selected) setSelected(c.id.startsWith('module:') ? null : c.id)
    // save positions when a drag ends
    const dropped = changes.filter((c) => c.type === 'position' && c.dragging === false && c.position)
    if (dropped.length) {
      const layout = { ...design.layout }
      for (const c of dropped) if (c.type === 'position' && c.position) layout[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) }
      update({ layout })
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    if (locked) return
    const f = getFeature(e.dataTransfer.getData(FEATURE_MIME))
    if (!f || f.kind === 'option') return // options are built into blocks
    if (f.kind === 'addon') {
      // an add-on goes onto the function it was dropped on
      const targetId = (e.target as Element).closest?.('[data-block]')?.getAttribute('data-block')
      if (!targetId) return setNotice(`Drop ${f.name} onto a function (${ruleSummary(f)})`)
      const why = canAttach(design, f, targetId)
      if (why) return setNotice(why)
      const b = design.blocks.find((x) => x.id === targetId)!
      setBlock(b.id, { addons: [...b.addons, f.id] })
      setSelected(b.id)
      return setNotice(null)
    }
    const why = canAddFeature(design, f)
    if (why) return setNotice(why)
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const at = { x: Math.round(pos.x - 90), y: Math.round(pos.y - 20) }
    if (f.kind === 'module') {
      update({ moduleFeatures: [...design.moduleFeatures, f.id], layout: { ...design.layout, [moduleNodeId(f.id)]: at } })
      return setNotice(null)
    }
    const id = newBlockId(design, f.id)
    update({ blocks: [...design.blocks, { id, feature: f.id, addons: [] }], layout: { ...design.layout, [id]: at } })
    setSelected(id)
    setNotice(null)
  }

  const block = design.blocks.find((b) => b.id === selected)

  return (
    <div className="designer">
      <FeatureSidebar design={design} locked={locked} />
      <div className="designer-main">
        {/* Zoom and pan like the workload canvas; everything else lives below it and grows downward. */}
        <div
          className="designer-workspace"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onPaneClick={() => setSelected(null)}
            nodesConnectable={false}
            deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
            minZoom={0.1}
            maxZoom={4}
            snapToGrid
            snapGrid={[16, 16]}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {!design.blocks.length && !design.moduleFeatures.length && (
            <p className="designer-empty">Drag the product's functions here: inputs, decoders, encoders, outputs…</p>
          )}
        </div>

        <div className="designer-below">
          {notice && (
            <p className="error-text designer-notice">
              {notice}{' '}
              <button className="link" onClick={() => setNotice(null)}>
                dismiss
              </button>
            </p>
          )}
          {block && (
            <BlockDetails
              block={block}
              locked={locked}
              onEssence={(e) => setBlock(block.id, { essence: e })}
              onScaleOut={(n) => setBlock(block.id, { scaleOut: n > 1 ? n : undefined })}
              onRemoveAddon={(i) => removeAddon(block.id, i)}
            />
          )}
          <InputRules design={design} locked={locked} onRule={(inputRule) => update({ inputRule })} onScaleOut={(id, n) => setBlock(id, { scaleOut: n > 1 ? n : undefined })} />
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
      </div>
    </div>
  )
}

// ---- Sidebar ----

function FeatureSidebar({ design, locked }: { design: ModuleDesign; locked?: boolean }) {
  return (
    <aside className="feature-sidebar">
      {LIBRARY.spec.featureGroups
        .map((g) => ({ g, features: featuresIn(g.id).filter((f) => f.kind !== 'option') }))
        .filter((x) => x.features.length)
        .map(({ g, features }) => (
          <section key={g.id}>
            <h4>{g.name}</h4>
            {features.map((f) => {
              const full = f.kind !== 'addon' && canAddFeature(design, f) !== null
              return (
                <div
                  key={f.id}
                  className={`feature-item group-${f.group} kind-${f.kind}${full ? ' full' : ''}`}
                  draggable={!locked && !full}
                  title={`${f.description}\n\n${ruleSummary(f)}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FEATURE_MIME, f.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  {f.name}
                </div>
              )
            })}
          </section>
        ))}
    </aside>
  )
}

// ---- Nodes on the workspace ----

function BlockNode({ data, selected }: NodeProps<Node<BlockNodeData, 'block'>>) {
  const { block: b, problem, locked, onRemove, onRemoveAddon } = data
  const f = getFeature(b.feature)
  if (!f) return <div className="design-block unknown">unknown feature {b.feature}</div>
  const feeds = feedOptions(f)
  const feed = b.essence ?? feeds?.[0]
  const io = [
    f.external && `${f.external.direction === 'in' ? '◀ ' : ''}${TRANSPORT_LABELS[f.external.protocol] ?? f.external.protocol}${f.external.dual === 'always' ? ' ×2' : ''}${f.external.direction === 'out' ? ' ▶' : ''}`,
    f.mxlInputs && '◀ MXL',
    f.mxlOutputs && 'MXL ▶',
  ].filter(Boolean)
  return (
    <div
      data-block={b.id}
      className={`design-block group-${f.group}${selected ? ' selected' : ''}${problem ? ' has-problem' : ''}`}
    >
      <div className="design-block-head">
        <strong>{f.name}</strong>
        {!locked && (
          <button
            className="link nodrag"
            title="Remove"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            ×
          </button>
        )}
      </div>
      {(io.length > 0 || feeds) && (
        <div className="design-block-io">
          {io.join(' · ')}
          {feeds && ` · ${feed === 'audio' ? 'audio' : 'video'}`}
          {(b.scaleOut ?? 1) > 1 && ` · up to ×${b.scaleOut}`}
        </div>
      )}
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
                    onRemoveAddon(i)
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ModuleNode({ data, selected }: NodeProps<Node<ModuleNodeData, 'module'>>) {
  return (
    <div className={`design-block module-wide group-module${selected ? ' selected' : ''}`}>
      <div className="design-block-head">
        <strong>{getFeature(data.feature)?.name ?? data.feature}</strong>
        {!data.locked && (
          <button className="link nodrag" title="Remove" onClick={data.onRemove}>
            ×
          </button>
        )}
      </div>
      <div className="design-block-io">module-wide</div>
    </div>
  )
}

const nodeTypes = { block: BlockNode, module: ModuleNode }

// ---- The selected function (under the workspace) ----

type DetailsProps = {
  block: ModuleBlock
  locked?: boolean
  onEssence: (e: Essence) => void
  onScaleOut: (n: number) => void
  onRemoveAddon: (i: number) => void
}

function BlockDetails({ block, locked, onEssence, onScaleOut, onRemoveAddon }: DetailsProps) {
  const f = getFeature(block.feature)
  if (!f) return null
  const feeds = feedOptions(f)
  // Names only: the values (e.g. the SRT session) are configured per instance in the workload.
  const groups = [block.feature, ...(f.includes ?? []), ...block.addons].map(getFeature).flatMap((x) => (x?.parameters ? [x.parameters.schema.title ?? x.name] : []))
  return (
    <div className="block-details">
      <div className="block-details-head">
        <strong>{f.name}</strong> <span className="hint">{block.id}</span>
        <span className="feature-rule">{ruleSummary(f)}</span>
      </div>
      <p className="hint">{f.description}</p>
      <div className="block-details-row">
        {feeds && (
          <label className="field">
            <span>Feed</span>
            <select value={block.essence ?? feeds[0]} disabled={locked} onChange={(e) => onEssence(e.target.value as Essence)}>
              {feeds.map((e) => (
                <option key={e} value={e}>
                  {FEED_LABEL[e]}
                </option>
              ))}
            </select>
          </label>
        )}
        {isInputFeature(f) && (
          <label className="field">
            <span>Scale out</span>
            <ScaleOut value={block.scaleOut ?? 1} locked={locked} onChange={onScaleOut} />
            <span className="hint">copies of this input one instance may run (1 = no scaling)</span>
          </label>
        )}
        {block.addons.length > 0 && (
          <div className="field">
            <span>Add-ons</span>
            <div className="chips">
              {block.addons.map((a, i) => (
                <span key={`${a}${i}`} className="chip">
                  {getFeature(a)?.name ?? a}
                  {!locked && <button onClick={() => onRemoveAddon(i)}>×</button>}
                </span>
              ))}
            </div>
          </div>
        )}
        {groups.length > 0 && (
          <div className="field">
            <span>Settings it adds</span>
            <span className="hint">{groups.join(', ')}: set per instance in the workload designer.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function ScaleOut({ value, locked, onChange }: { value: number; locked?: boolean; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      min={1}
      max={MAX_SCALE_OUT}
      value={value}
      disabled={locked}
      onChange={(e) => onChange(Math.min(MAX_SCALE_OUT, Math.max(1, Math.floor(e.target.valueAsNumber) || 1)))}
    />
  )
}

// ---- Input rules (under the workspace): which inputs an instance may use, and scale-out ----

type RulesProps = { design: ModuleDesign; locked?: boolean; onRule: (r: InputRule) => void; onScaleOut: (id: string, n: number) => void }

function InputRules({ design, locked, onRule, onScaleOut }: RulesProps) {
  const inputs = inputBlocks(design)
  if (!inputs.length) return null
  const rule = design.inputRule ?? 'several'
  return (
    <div className="block-details input-rules">
      <div className="block-details-head">
        <strong>Input rules</strong>
        <span className="feature-rule">what each instance may choose in the workload designer</span>
      </div>
      {inputs.length > 1 && (
        <div className="row-actions">
          <label className="field-check">
            <input type="radio" name="input-rule" checked={rule === 'one'} disabled={locked} onChange={() => onRule('one')} /> Exactly one input per instance
          </label>
          <label className="field-check">
            <input type="radio" name="input-rule" checked={rule === 'several'} disabled={locked} onChange={() => onRule('several')} /> Several inputs per instance
            (of different types)
          </label>
        </div>
      )}
      <table className="edit-table">
        <thead>
          <tr>
            <th>Input</th>
            <th>Scale out (max copies per instance)</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((b) => (
            <tr key={b.id}>
              <td>
                {getFeature(b.feature)?.name ?? b.feature} <span className="hint">{b.id}</span>
              </td>
              <td>
                <ScaleOut value={b.scaleOut ?? 1} locked={locked} onChange={(n) => onScaleOut(b.id, n)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
