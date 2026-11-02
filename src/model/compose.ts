// Module design → ports + parameter schema, and the design rules. A product's module is defined
// by its design (scripts/product-catalogs.ts); the server checks it on import and save, so a
// module's derived parts never drift from its design. Also: which inputs and outputs an instance runs.
import { getFeature, matchesFeature } from './library'
import { KNOWN_FORMATS, TRANSPORT_LABELS } from './vocabulary'
import type { Essence, FeatureDef, FeatureSelection, InputSelection, JsonSchema, ModuleBlock, ModuleDesign, OutputSelection, PortDef, VendorModule, XAllowed } from './types'

export const BLOCK_ID_RE = /^[a-z][a-z0-9-]*$/ // no dots: block ids prefix port and parameter paths

export const EMPTY_DESIGN: ModuleDesign = { blocks: [], moduleFeatures: [] }

const label = (b: ModuleBlock) => `${getFeature(b.feature)?.name ?? b.feature} (${b.id})`

// Feed types a block with ports offers: a video feed (with its audio and ANC)
// or an audio-only feed. Blocks without ports have none.
export function feedOptions(f: FeatureDef): Essence[] | undefined {
  if (f.external) return f.external.essenceOptions
  if (f.mxlInputs || f.mxlOutputs) return ['video', 'audio']
  return undefined
}

const feedOf = (b: ModuleBlock, f: FeatureDef): Essence => b.essence ?? feedOptions(f)?.[0] ?? 'video'

// ---- Add-on rules ----

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

// A block's parameter groups: its feature's, its built-in options' and its add-ons'.
function baseGroups(b: ModuleBlock): Record<string, JsonSchema> {
  const f = getFeature(b.feature)
  const groups: Record<string, JsonSchema> = {}
  if (!f) return groups
  if (f.parameters && f.key) groups[f.key] = structuredClone(f.parameters.schema)
  // built-in options first, then the add-ons
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
  return groups
}

function groupAt(groups: Record<string, JsonSchema>, path: string): JsonSchema | undefined {
  const [head, ...rest] = path.split('.')
  let node: JsonSchema | undefined = groups[head]
  for (const k of rest) node = node?.properties?.[k]
  return node
}

// A product narrows a shared feature: the group gets `x-allowed`, and when only one combination
// is left its values become the defaults, so a new instance starts valid.
function narrow(group: JsonSchema, allowed: XAllowed) {
  group['x-allowed'] = allowed
  const firsts = Object.keys(allowed.values)
  const seconds = allowed.values[firsts[0]]
  const [a, b] = allowed.fields.map((n) => group.properties?.[n])
  if (firsts.length === 1 && seconds?.length === 1 && a && b) {
    a.default = firsts[0]
    b.default = seconds[0]
  }
}

function blockSchema(b: ModuleBlock): JsonSchema | undefined {
  const f = getFeature(b.feature)
  if (!f) return undefined
  const groups = baseGroups(b)
  if (!Object.keys(groups).length) return undefined
  for (const [path, allowed] of Object.entries(b.allowed ?? {})) {
    const group = groupAt(groups, path)
    if (group) narrow(group, allowed)
  }
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
    const flows: Essence[] = essence === 'video' ? (b.noData ? ['video', 'audio'] : ['video', 'audio', 'data']) : [essence]
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
    const flows: Essence[] = essence === 'video' ? (b.noData ? ['video', 'audio'] : ['video', 'audio', 'data']) : [essence]
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

// ---- What an instance runs: its inputs, outputs (with scale-out) and optional functions ----

export const MAX_SCALE_OUT = 64

// The parts of a module that decide what an instance runs.
type ModuleParts = Pick<VendorModule, 'design' | 'defaults'>

export function isInputFeature(f: FeatureDef | undefined): boolean {
  return !!f && (f.external?.direction === 'in' || !!f.mxlInputs)
}

export function isOutputFeature(f: FeatureDef | undefined): boolean {
  return !!f && (f.external?.direction === 'out' || !!f.mxlOutputs)
}

// Inputs and outputs can be scaled out (several copies per instance).
export const isScalable = (f: FeatureDef | undefined) => isInputFeature(f) || isOutputFeature(f)

export function inputBlocks(design: ModuleDesign): ModuleBlock[] {
  return design.blocks.filter((b) => isInputFeature(getFeature(b.feature)))
}

export function outputBlocks(design: ModuleDesign): ModuleBlock[] {
  return design.blocks.filter((b) => isOutputFeature(getFeature(b.feature)))
}

const zeroFilled = (blocks: ModuleBlock[], counts: Record<string, number>) => Object.fromEntries(blocks.map((b) => [b.id, counts[b.id] ?? 0]))

// What a new instance uses without module defaults: the first input for "one", every input once for "several".
export function defaultInputs(design: ModuleDesign): InputSelection {
  const inputs = inputBlocks(design)
  return Object.fromEntries(inputs.map((b, i) => [b.id, design.inputRule === 'one' ? (i === 0 ? 1 : 0) : 1]))
}

// The full selection in force: the instance's own, over the module's defaults. With module defaults,
// what they don't list is unused; without them, inputs follow the input rule and every output runs once.
export function inputsOf(m: ModuleParts, chosen?: InputSelection): InputSelection {
  const inputs = inputBlocks(m.design)
  if (chosen) return { ...zeroFilled(inputs, {}), ...chosen }
  return m.defaults?.inputs ? zeroFilled(inputs, m.defaults.inputs) : defaultInputs(m.design)
}

export function outputsOf(m: ModuleParts, chosen?: OutputSelection): OutputSelection {
  const outputs = outputBlocks(m.design)
  const base = m.defaults?.outputs ? zeroFilled(outputs, m.defaults.outputs) : Object.fromEntries(outputs.map((b) => [b.id, 1]))
  return { ...base, ...chosen }
}

// An add-on's key in `features` ("<block>.<key>") and in `ModuleBlock.optional.addons`.
export function addonKey(addon: string): string {
  return getFeature(addon)?.key ?? addon.slice(addon.lastIndexOf('.') + 1)
}

// The full selection of optional functions in force, in design order. An add-on of a block that's off is off.
export function featuresOf(m: ModuleParts, chosen: FeatureSelection = {}): FeatureSelection {
  const out: FeatureSelection = {}
  for (const b of m.design.blocks) {
    if (!b.optional) continue
    const on = chosen[b.id] ?? b.optional.default
    out[b.id] = on
    for (const [key, d] of Object.entries(b.optional.addons ?? {})) out[`${b.id}.${key}`] = on && (chosen[`${b.id}.${key}`] ?? d)
  }
  return out
}

const countProblems = (what: string, blocks: ModuleBlock[], sel: Record<string, number>): string[] => {
  const errors: string[] = []
  for (const id of Object.keys(sel)) if (!blocks.some((b) => b.id === id)) errors.push(`${what}: the module has no ${what.slice(0, -1)} ${id}`)
  for (const b of blocks) {
    const n = sel[b.id] ?? 0
    const max = b.scaleOut ?? 1
    if (!Number.isInteger(n) || n < 0 || n > max) errors.push(`${what}: ${label(b)} can be used 0 to ${max} times`)
  }
  return errors
}

// An instance's selection against the module's input rules.
export function inputSelectionProblems(m: ModuleParts, chosen?: InputSelection): string[] {
  const inputs = inputBlocks(m.design)
  if (!inputs.length) return chosen && Object.keys(chosen).length ? ['inputs: the module has no inputs'] : []
  const sel = inputsOf(m, chosen)
  const errors = countProblems('inputs', inputs, sel)
  const used = inputs.filter((b) => (sel[b.id] ?? 0) > 0)
  if (m.design.inputRule === 'one' && used.length !== 1) errors.push('inputs: choose exactly one input')
  if (m.design.inputRule !== 'one' && !used.length) errors.push('inputs: choose at least one input')
  return errors
}

export function outputSelectionProblems(m: ModuleParts, chosen?: OutputSelection): string[] {
  const outputs = outputBlocks(m.design)
  return outputs.length ? countProblems('outputs', outputs, outputsOf(m, chosen)) : []
}

export function featureSelectionProblems(m: ModuleParts, chosen: FeatureSelection = {}): string[] {
  const known = featuresOf(m)
  return Object.entries(chosen).flatMap(([k, v]) =>
    !(k in known) ? [`features: "${k}" can't be turned on or off`] : typeof v !== 'boolean' ? [`features: "${k}" must be true or false`] : [],
  )
}

// What one instance runs (absent = the module's defaults).
export type InstanceSelection = { inputs?: InputSelection; outputs?: OutputSelection; features?: FeatureSelection }

// Id of the k-th copy of a scaled-out block (k >= 2): "srt1_2". Block ids never contain "_".
export const copyId = (blockId: string, k: number) => (k === 1 ? blockId : `${blockId}_${k}`)

// The design as one instance runs it: unused inputs and outputs dropped, scaled-out ones repeated,
// optional functions and add-ons that are off left out.
export function instanceDesign(m: ModuleParts, chosen: InstanceSelection = {}): ModuleDesign {
  const ins = inputsOf(m, chosen.inputs)
  const outs = outputsOf(m, chosen.outputs)
  const features = featuresOf(m, chosen.features)
  const blocks = m.design.blocks.flatMap((b) => {
    const f = getFeature(b.feature)
    const sel = isInputFeature(f) ? ins : isOutputFeature(f) ? outs : undefined
    if (!sel) {
      if (features[b.id] === false) return []
      return [{ ...b, addons: b.addons.filter((a) => features[`${b.id}.${addonKey(a)}`] !== false) }]
    }
    const n = Math.max(0, Math.min(sel[b.id] ?? 0, b.scaleOut ?? 1))
    return Array.from({ length: n }, (_, i) => ({ ...b, id: copyId(b.id, i + 1) }))
  })
  return { ...m.design, blocks }
}

// The input copies an instance runs, for choices such as what's on air at start.
export function inputCopies(m: ModuleParts, chosen: InstanceSelection = {}): { id: string; name: string }[] {
  const ins = inputsOf(m, chosen.inputs)
  return inputBlocks(m.design).flatMap((b) =>
    Array.from({ length: Math.max(0, Math.min(ins[b.id] ?? 0, b.scaleOut ?? 1)) }, (_, i) => ({ id: copyId(b.id, i + 1), name: `${getFeature(b.feature)?.name ?? b.id} ${i + 1}` })),
  )
}

// Ports and core parameter schema of one instance (cached per module object and selection).
const partsCache = new WeakMap<VendorModule, Map<string, { ports: PortDef[]; schema: JsonSchema }>>()
export function instanceParts(m: VendorModule, chosen: InstanceSelection = {}): { ports: PortDef[]; schema: JsonSchema } {
  let byKey = partsCache.get(m)
  if (!byKey) partsCache.set(m, (byKey = new Map()))
  const key = JSON.stringify([inputsOf(m, chosen.inputs), outputsOf(m, chosen.outputs), featuresOf(m, chosen.features)])
  let parts = byKey.get(key)
  if (!parts) byKey.set(key, (parts = composeModule(instanceDesign(m, chosen))))
  return parts
}

// Features that need another function in the design (e.g. SRT program output → program encoder).
export function requiresProblems(design: ModuleDesign): string[] {
  const used = [...design.blocks.flatMap((b) => [b.feature, ...b.addons]), ...design.moduleFeatures]
  return [...new Set(used)].flatMap((id) => {
    const f = getFeature(id)
    return (f?.rules?.requires ?? []).filter((r) => !design.blocks.some((b) => r.anyOf.some((p) => matchesFeature(p, b.feature)))).map((r) => `${f!.name}: ${r.message}`)
  })
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
  // input and output rules
  if (design.inputRule !== undefined && !['one', 'several'].includes(design.inputRule)) errors.push('input rule must be "one" or "several"')
  for (const b of design.blocks)
    if (b.scaleOut !== undefined) {
      if (!isScalable(getFeature(b.feature))) errors.push(`${label(b)}: only inputs and outputs can be scaled out`)
      else if (!Number.isInteger(b.scaleOut) || b.scaleOut < 1 || b.scaleOut > MAX_SCALE_OUT)
        errors.push(`${label(b)}: scale-out must be 1 to ${MAX_SCALE_OUT}`)
    }
  errors.push(...requiresProblems(design))
  // what an instance can turn off, and what the product narrows
  for (const b of design.blocks) {
    const f = getFeature(b.feature)
    if (b.optional) {
      if (isScalable(f)) errors.push(`${label(b)}: inputs and outputs are turned off by their copies, not "optional"`)
      if (typeof b.optional.default !== 'boolean') errors.push(`${label(b)}: optional needs a default`)
      for (const key of Object.keys(b.optional.addons ?? {}))
        if (!b.addons.some((a) => addonKey(a) === key)) errors.push(`${label(b)}: optional add-on "${key}" isn't attached`)
    }
    if (b.noData && !f?.mxlInputs && !f?.mxlOutputs) errors.push(`${label(b)}: only MXL blocks can have noData`)
    for (const [path, allowed] of Object.entries(b.allowed ?? {})) {
      const group = groupAt(baseGroups(b), path)
      if (!group) errors.push(`${label(b)}: allowed: no parameter group "${path}"`)
      else if (allowed.fields?.some((n) => !group.properties?.[n])) errors.push(`${label(b)}: allowed: "${path}" doesn't have those fields`)
    }
  }
  if (design.blocks.length && !composeModule(design).ports.length) errors.push('The module has no inputs or outputs yet')
  return errors
}
