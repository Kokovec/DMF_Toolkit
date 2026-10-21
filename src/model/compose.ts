// Module design → ports + parameter schema, and the design rules. Used live by the module
// designer (drop checks, rule list) and by the server on save, so a module's derived parts can
// never drift from its design.
import { getFeature, matchesFeature } from './library'
import { KNOWN_FORMATS, TRANSPORT_LABELS } from './vocabulary'
import type { Essence, FeatureDef, JsonSchema, ModuleBlock, ModuleDesign, PortDef } from './types'

export const BLOCK_ID_RE = /^[a-z][a-z0-9-]*$/ // no dots: block ids prefix port and parameter paths

export const EMPTY_DESIGN: ModuleDesign = { blocks: [], moduleFeatures: [] }

const label = (b: ModuleBlock) => `${getFeature(b.feature)?.name ?? b.feature} (${b.id})`

// A fresh block id from the feature, e.g. "input.srt" -> "srt1", "output.mxl" -> "mxl1".
export function newBlockId(design: ModuleDesign, featureId: string): string {
  const base = featureId.slice(featureId.lastIndexOf('.') + 1).replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '') || 'block'
  const sep = /\d$/.test(base) ? '-' : '' // "st2022-7" -> "st2022-7-1"
  let n = 1
  while (design.blocks.some((b) => b.id === `${base}${sep}${n}`)) n++
  return `${base}${sep}${n}`
}

// Feed types the author can choose on a block with ports: a video feed (with its audio and ANC)
// or an audio-only feed. Blocks without ports have none.
export function feedOptions(f: FeatureDef): Essence[] | undefined {
  if (f.external) return f.external.essenceOptions
  if (f.mxlInputs || f.mxlOutputs) return ['video', 'audio']
  return undefined
}

const feedOf = (b: ModuleBlock, f: FeatureDef): Essence => b.essence ?? feedOptions(f)?.[0] ?? 'video'

// ---- Drop-time rules (the designer refuses invalid drops with the reason) ----

export function canAddFeature(design: ModuleDesign, f: FeatureDef): string | null {
  const max = f.rules?.maxPerModule
  const used = design.blocks.filter((b) => b.feature === f.id).length + design.moduleFeatures.filter((m) => m === f.id).length
  if (max !== undefined && used >= max) return `${f.name}: at most ${max} per module`
  return null
}

export function canAttach(design: ModuleDesign, addon: FeatureDef, blockId: string): string | null {
  const b = design.blocks.find((x) => x.id === blockId)
  if (!b) return 'unknown block'
  if (addon.kind !== 'addon') return `${addon.name} is not an add-on`
  if (!addon.rules?.attachTo?.some((p) => matchesFeature(p, b.feature))) {
    const targets = addon.rules?.attachTo?.map((p) => (p.endsWith('.*') ? `any ${p.slice(0, -2)}` : getFeature(p)?.name ?? p)).join(' or ')
    return `${addon.name} attaches only to ${targets}`
  }
  const count = b.addons.filter((a) => a === addon.id).length
  if (count >= (addon.rules?.maxPerBlock ?? Infinity)) return `${label(b)} already has ${addon.name}`
  return null
}

// ---- Composition ----

// Prefix block-relative dotted keys ("srt.bonding") with the block id, so they resolve from the
// root of the composed parameters ("srt1.srt.bonding").
function prefixConditions(schema: JsonSchema, blockId: string): JsonSchema {
  const fix = (when: Record<string, (string | number | boolean)[]>) =>
    Object.fromEntries(Object.entries(when).map(([k, v]) => [k.includes('.') ? `${blockId}.${k}` : k, v]))
  const out: JsonSchema = { ...schema }
  if (schema['x-when']) out['x-when'] = fix(schema['x-when'])
  if (schema['x-title-when']) out['x-title-when'] = schema['x-title-when'].map((t) => ({ ...t, when: fix(t.when) }))
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, prefixConditions(s, blockId)]))
  if (schema.items) out.items = prefixConditions(schema.items, blockId)
  return out
}

function blockSchema(b: ModuleBlock): JsonSchema | undefined {
  const f = getFeature(b.feature)
  if (!f) return undefined
  const groups: Record<string, JsonSchema> = {}
  if (f.parameters && f.key) groups[f.key] = structuredClone(f.parameters.schema)
  // built-in options first, then the add-ons the author dropped on
  for (const id of [...(f.includes ?? []), ...b.addons]) {
    const a = getFeature(id)
    if (!a?.parameters) continue
    const s = structuredClone(a.parameters.schema)
    const target = a.merge && groups[a.merge]
    if (target) {
      target.properties = { ...target.properties, ...s.properties }
      target.required = [...(target.required ?? []), ...(s.required ?? [])]
    } else if (a.key) groups[a.key] = s
  }
  if (!Object.keys(groups).length) return undefined
  return prefixConditions({ type: 'object', title: `${f.name} · ${b.id}`, properties: groups }, b.id)
}

function blockPorts(b: ModuleBlock): PortDef[] {
  const f = getFeature(b.feature)
  if (!f) return []
  const ports: PortDef[] = []
  if (f.external) {
    const dir = f.external.direction
    const essence = feedOf(b, f)
    const base: PortDef = {
      id: `${b.id}.${dir}.${essence}`,
      direction: dir,
      essence,
      cardinality: '1',
      formats: KNOWN_FORMATS[essence].slice(0, 1),
      transport: { external: f.external.protocol },
    }
    if (f.external.dual === 'always') {
      const name = TRANSPORT_LABELS[f.external.protocol] ?? f.external.protocol
      for (const leg of ['a', 'b']) ports.push({ ...base, id: `${base.id}.${leg}`, label: `${name} ${leg.toUpperCase()}` })
    } else {
      if (f.external.dualWhen)
        base.dualWhen = Object.fromEntries(Object.entries(f.external.dualWhen).map(([k, v]) => [`${b.id}.${k}`, v]))
      ports.push(base)
    }
  }
  if (f.mxlInputs) {
    const essence = feedOf(b, f)
    const flows: Essence[] = essence === 'video' ? ['video', 'audio', 'data'] : [essence]
    for (const e of flows)
      ports.push({
        id: `${b.id}.${e === 'data' ? 'anc' : e}`,
        direction: 'in',
        essence: e,
        cardinality: e === essence ? '1' : '0..1', // the feed's main flow is required
        formats: KNOWN_FORMATS[e].slice(0, 1),
        timeContext: b.id,
        transport: 'mxl',
      })
  }
  if (f.mxlOutputs) {
    const essence = feedOf(b, f)
    const flows: Essence[] = essence === 'video' ? ['video', 'audio', 'data'] : [essence]
    for (const e of flows)
      ports.push({
        id: `${b.id}.${e === 'data' ? 'anc' : e}`,
        direction: 'out',
        essence: e,
        cardinality: '0..1',
        formats: KNOWN_FORMATS[e].slice(0, 1),
        timeContext: b.id,
        transport: 'mxl',
      })
  }
  return ports
}

// The module's ports and core parameter schema, derived from its design.
export function composeModule(design: ModuleDesign): { ports: PortDef[]; schema: JsonSchema } {
  const properties: Record<string, JsonSchema> = {}
  for (const b of design.blocks) {
    const s = blockSchema(b)
    if (s) properties[b.id] = s
  }
  for (const id of design.moduleFeatures) {
    const f = getFeature(id)
    if (f?.parameters && f.key) properties[f.key] = structuredClone(f.parameters.schema)
  }
  return { ports: design.blocks.flatMap(blockPorts), schema: { type: 'object', properties } }
}

// ---- Whole-design rules (listed until fixed; saving is blocked while any remain) ----

export function designProblems(design: ModuleDesign): string[] {
  const errors: string[] = []
  if (!design || !Array.isArray(design.blocks) || !Array.isArray(design.moduleFeatures))
    return ['design must have blocks and moduleFeatures']
  if (!design.blocks.length) errors.push('Drag a feature onto the module to start (e.g. an input)')
  const ids = new Set<string>()
  for (const b of design.blocks) {
    const f = getFeature(b.feature)
    if (!BLOCK_ID_RE.test(b.id) || ids.has(b.id)) errors.push(`block id "${b.id}" must be unique: lowercase letters, digits, -`)
    ids.add(b.id)
    if (!f || f.kind !== 'block') {
      errors.push(`${b.id}: "${b.feature}" is not a block feature`)
      continue
    }
    if (b.essence && !feedOptions(f)?.includes(b.essence)) errors.push(`${label(b)}: feed type ${b.essence} not offered`)
    // add-ons
    const seen: string[] = []
    for (const a of b.addons) {
      const af = getFeature(a)
      if (!af) {
        errors.push(`${label(b)}: unknown add-on ${a}`)
        continue
      }
      const why = canAttach({ ...design, blocks: design.blocks.map((x) => (x.id === b.id ? { ...x, addons: seen } : x)) }, af, b.id)
      if (why) errors.push(why)
      seen.push(a)
    }
    for (const n of f.rules?.needsAddon ?? [])
      if (b.addons.filter((a) => getFeature(a)?.group === n.group).length < n.min) errors.push(`${label(b)}: ${n.message}`)
  }
  for (const id of new Set([...design.blocks.map((b) => b.feature), ...design.moduleFeatures])) {
    const f = getFeature(id)
    const used = design.blocks.filter((b) => b.feature === id).length + design.moduleFeatures.filter((m) => m === id).length
    if (f?.rules?.maxPerModule !== undefined && used > f.rules.maxPerModule) errors.push(`${f.name}: at most ${f.rules.maxPerModule} per module`)
  }
  for (const m of design.moduleFeatures) if (getFeature(m)?.kind !== 'module') errors.push(`"${m}" is not a module-wide feature`)
  if (design.blocks.length && !composeModule(design).ports.length) errors.push('The module has no inputs or outputs yet')
  return errors
}
