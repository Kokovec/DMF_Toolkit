import { useEffect, useState } from 'react'
import { Handle, Position, useEdges, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useCatalog } from '../api'
import { isEdge, isRequired, resolvePorts, transportLabel, type ResolvedPort } from '../model/catalog'
import { EXTERNALS } from '../model/externals'
import { instanceParts } from '../model/compose'
import { getCategory } from '../model/library'
import { defaultsFor } from '../model/schema'
import type { JsonValue, VendorModule } from '../model/types'
import { BUNDLE, portsOf, moduleOf, type ExtNode, type FnNode } from '../model/workload'

export function FunctionNode({ id, data, selected }: NodeProps<FnNode>) {
  const catalog = useCatalog()
  const prim = moduleOf(data, catalog)
  if (!prim)
    return (
      <div className="block block-unknown">
        {data.name}: module {data.type}@{data.typeVersion} is not in the library
      </div>
    )
  return (
    <NodeView
      id={id}
      className={nodeClass(prim)}
      title={data.name}
      subtitle={`${prim.name} · ${prim.vendor}${data.domain ? ` · ${data.domain}` : ''}`}
      ports={portsOf(data, catalog)}
      selected={selected}
    />
  )
}

export function ExternalNode({ id, data, selected }: NodeProps<ExtNode>) {
  const t = EXTERNALS[data.extKind]
  return (
    <NodeView id={id} className="ext" title={data.name} subtitle={`${t?.name ?? data.extKind} · external`} ports={portsOf(data)} selected={selected} />
  )
}

// A module as a new instance would appear on the canvas: default inputs and parameters (parts editor preview).
export function ModulePreview({ id, prim, params }: { id: string; prim: VendorModule; params?: { [k: string]: JsonValue } }) {
  return (
    <NodeView
      id={id}
      className={nodeClass(prim)}
      title={prim.name || 'Unnamed'}
      subtitle={`${prim.categories.map((c) => getCategory(c)?.name ?? c).join(', ') || 'no category'} · ${prim.vendor || 'vendor?'}`}
      ports={resolvePorts(instanceParts(prim).ports, params ?? defaultsFor(instanceParts(prim).schema))}
    />
  )
}

function nodeClass(prim: VendorModule) {
  return `fn${isEdge(prim) ? ' edge' : ''}`
}

type ViewProps = { id: string; className: string; title: string; subtitle: string; ports: ResolvedPort[]; selected?: boolean }

function NodeView({ id, className, title, subtitle, ports, selected }: ViewProps) {
  const updateNodeInternals = useUpdateNodeInternals()
  const [open, setOpen] = useState<Set<string>>(new Set())
  // Member ports wired on their own (split bundles) must stay visible.
  const edges = useEdges()
  const wired = new Set(
    edges.flatMap((e) => [e.source === id ? e.sourceHandle : null, e.target === id ? e.targetHandle : null]).filter((h): h is string => !!h),
  )
  const expanded = (group: string, members: ResolvedPort[]) => open.has(group) || members.some((m) => wired.has(m.key))
  const toggle = (group: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  const shape = ports.map((p) => p.key).join(',') + '|' + [...open].join(',') + '|' + [...wired].join(',')
  // Handles appear and disappear (port arrays, rebinding, expanding bundles); React Flow must re-measure.
  useEffect(() => updateNodeInternals(id), [id, shape, updateNodeInternals])

  const column = (direction: 'in' | 'out') => (
    <PortColumn ports={ports.filter((p) => p.direction === direction)} direction={direction} expanded={expanded} onToggle={toggle} />
  )
  return (
    <div className={`block ${className}${selected ? ' selected' : ''}`}>
      <div className="block-header">
        <span className="block-name">{title}</span>
        <span className="block-type">{subtitle}</span>
      </div>
      <div className="block-ports">
        {column('in')}
        {column('out')}
      </div>
    </div>
  )
}

type ColumnProps = {
  ports: ResolvedPort[]
  direction: 'in' | 'out'
  expanded: (group: string, members: ResolvedPort[]) => boolean
  onToggle: (group: string) => void
}

// Ports in declaration order. A time-context group (e.g. the MXL video + audio + ANC flows of one
// feed) is one connection; expand it to wire its flows separately (split audio from video).
function PortColumn({ ports, direction, expanded, onToggle }: ColumnProps) {
  const type = direction === 'in' ? 'target' : 'source'
  const position = direction === 'in' ? Position.Left : Position.Right
  const rows: React.ReactNode[] = []
  const seen = new Set<string>()
  for (const p of ports) {
    if (!p.group) {
      rows.push(<PortRow key={p.key} port={p} type={type} position={position} />)
      continue
    }
    if (seen.has(p.group)) continue
    seen.add(p.group)
    const members = ports.filter((q) => q.group === p.group)
    if (members.length === 1) {
      rows.push(<PortRow key={p.key} port={p} type={type} position={position} />)
      continue
    }
    const open = expanded(p.group, members)
    const allMxl = members.every((m) => m.transport === 'mxl')
    const index = p.key.match(/\[\d+\]$/)?.[0] ?? ''
    rows.push(
      <div key={BUNDLE + p.group} className="port-group">
        <span className={`port bundle port-${direction}`} title={`${members.map((m) => m.essence).join(' + ')} flows, one time context`}>
          <Handle id={BUNDLE + p.group} type={type} position={position} />
          {allMxl ? `MXL${index}` : p.group}
          <span className="flows">{members.map((m) => (m.essence === 'data' ? 'anc' : m.essence)).join('·')}</span>
          <button className="nodrag expand" title={open ? 'Collapse' : 'Expand to wire flows separately'} onClick={() => onToggle(p.group!)}>
            {open ? '▾' : '▸'}
          </button>
        </span>
        {open && members.map((m) => <PortRow key={m.key} port={m} type={type} position={position} member />)}
      </div>,
    )
  }
  return <div className={`port-column port-column-${direction}`}>{rows}</div>
}

// External ports are labelled with their protocol (e.g. "SRT"); MXL ports with their id.
function PortRow({ port, type, position, member }: { port: ResolvedPort; type: 'source' | 'target'; position: Position; member?: boolean }) {
  const external = port.transport !== 'mxl'
  const label = port.label
    ? port.label + port.key.slice(port.id.length)
    : external
      ? `${transportLabel(port)}${port.essence === 'audio' ? ' audio' : ''}`
      : member
        ? port.essence === 'data' ? 'anc' : port.essence
        : port.key
  return (
    <span
      className={`port port-${port.direction} essence-${port.essence}${member ? ' member' : ''}`}
      title={`${port.key} · ${port.essence} · ${transportLabel(port)} · ${port.cardinality}`}
    >
      <Handle id={port.key} type={type} position={position} />
      {label}
      {port.direction === 'in' && isRequired(port) && <span className="required">*</span>}
    </span>
  )
}
