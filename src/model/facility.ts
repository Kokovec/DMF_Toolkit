// What the facility can run (R8.8). The orchestrator exports it (`make facility-export`); the server
// reads it from DMF_FACILITY and serves it at GET /api/facility. The toolkit decides nothing about
// infrastructure: it only stops offering what the facility declares it can't run. With no facility
// set, everything is offered. Product limits (`rules.conflictsWith`) are separate: no facility can
// honour them, so they apply either way (productProblems).
import { addonKey, inputBlocks, inputsOf, instanceDesign, instanceParts, outputBlocks, outputsOf, type InstanceSelection } from './compose'
import { getFeature, LIBRARY } from './library'
import { applies, defaultsFor, getPath } from './schema'
import type { Facility, FeatureDef, FunctionInstance, JsonSchema, JsonValue, VendorModule, WorkloadDescription } from './types'

// Every capability a facility can declare, in the library's order (the keys of the export).
export const CAPABILITIES = LIBRARY.spec.vocabulary.capabilities

const capabilityLabel = (id: string) => {
  const c = CAPABILITIES.find((x) => x.id === id)
  return c ? `${c.label} (${id})` : id
}

// ---- The facility in force in the UI (set from GET /api/facility) ----

let current: Facility = {}
const listeners = new Set<() => void>()

export function currentFacility(): Facility {
  return current
}

export function setFacility(next: Facility) {
  current = next
  for (const l of listeners) l()
}

export function subscribeFacility(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

// Whether a facility is set at all (otherwise everything is offered).
export const hasFacility = (f: Facility) => !!f.capabilities

// A facility file's problems (the server refuses to start with one that has any).
export function checkFacility(doc: unknown): string[] {
  const d = doc as { kind?: unknown; name?: unknown; capabilities?: unknown }
  if (!d || typeof d !== 'object' || d.kind !== 'FacilityExport') return ['not a FacilityExport document']
  const errors: string[] = []
  if (typeof d.name !== 'string' || !d.name) errors.push('name is required')
  if (!d.capabilities || typeof d.capabilities !== 'object' || Array.isArray(d.capabilities)) return [...errors, 'capabilities must be an object']
  for (const [k, v] of Object.entries(d.capabilities)) if (typeof v !== 'boolean') errors.push(`capabilities.${k} must be true or false`)
  const limits = (d as { limits?: unknown }).limits
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits))) errors.push('limits must be an object')
  else
    for (const [k, v] of Object.entries(limits ?? {}))
      if (k === 'functionsPerWorkload') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push(`limits.${k} must map a module type to {min, max}`)
        else
          for (const [type, r] of Object.entries(v as object))
            if (!r || typeof r !== 'object' || Object.entries(r).some(([b, n]) => !['min', 'max'].includes(b) || !Number.isInteger(n) || (n as number) < 0))
              errors.push(`limits.${k}.${type} must be {min, max}, whole numbers`)
      } else if (typeof v !== 'number') errors.push(`limits.${k} must be a number`)
  return errors
}

// The capabilities of `needs` the facility doesn't have (none with no facility set). A capability
// the facility doesn't list is one it doesn't have, as in the orchestrator's compiler.
export function missing(needs: string[] | undefined, facility: Facility = current): string[] {
  if (!needs?.length || !facility.capabilities) return []
  return needs.filter((c) => facility.capabilities![c] !== true)
}

// Why something isn't offered, or null if it is: "needs ST 2110 (st2110), which facility local doesn't offer".
export function unavailable(needs: string[] | undefined, facility: Facility = current): string | null {
  const gone = missing(needs, facility)
  if (!gone.length) return null
  const which = facility.name ? `facility ${facility.name}` : 'the facility'
  return `needs ${gone.map(capabilityLabel).join(' and ')}, which ${which} doesn't offer`
}

// A feature's needs, with those of the options built into it.
export function featureNeeds(f: FeatureDef | undefined): string[] {
  if (!f) return []
  return [...new Set([...(f.needs ?? []), ...(f.includes ?? []).flatMap((o) => getFeature(o)?.needs ?? [])])]
}

// Why an enum value isn't offered (x-enumNeeds), or null.
export function valueUnavailable(schema: JsonSchema, value: JsonValue | undefined, facility: Facility = current): string | null {
  if (value === undefined || value === null || typeof value === 'object') return null
  return unavailable(schema['x-enumNeeds']?.[String(value)], facility)
}

// A value over the facility's limit (`x-facilityLimit`), or null; never without a facility or that limit.
export function facilityLimitProblem(schema: JsonSchema, value: JsonValue | undefined, facility: Facility = current): string | null {
  const name = schema['x-facilityLimit']
  const limit = name ? facility.limits?.[name] : undefined
  if (!hasFacility(facility) || typeof limit !== 'number' || typeof value !== 'number' || value <= limit) return null
  return `${value} is more than ${facility.name ? `facility ${facility.name}'s` : "the facility's"} ${name} of ${limit}`
}

// Values in force (set, else the default) that need what the facility lacks, as "path: value needs …",
// or that are over one of its limits.
function valueProblems(schema: JsonSchema, value: JsonValue | undefined, root: JsonValue, facility: Facility, path = ''): string[] {
  if (schema.type === 'object' && schema.properties) {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return Object.entries(schema.properties).flatMap(([k, s]) =>
      applies(s, obj, root) ? valueProblems(s, obj[k], root, facility, path ? `${path}.${k}` : k) : [],
    )
  }
  const v = value ?? (schema.default as JsonValue | undefined)
  const why = valueUnavailable(schema, v, facility)
  const over = facilityLimitProblem(schema, v, facility)
  return [...(why ? [`${path}: ${String(v)} ${why}`] : []), ...(over ? [`${path}: ${over}`] : [])]
}

// What an instance uses that the facility doesn't offer, each naming the option.
export function facilityProblems(prim: VendorModule, f: Pick<FunctionInstance, 'parameters' | 'resources'> & InstanceSelection, facility: Facility = current): string[] {
  if (!hasFacility(facility)) return []
  const errors: string[] = []
  const name = (id: string) => getFeature(id)?.name ?? id
  for (const [what, blocks, counts] of [
    ['inputs', inputBlocks(prim.design), inputsOf(prim, f.inputs)],
    ['outputs', outputBlocks(prim.design), outputsOf(prim, f.outputs)],
  ] as const)
    for (const b of blocks) {
      const n = counts[b.id] ?? 0
      const why = n > 0 && unavailable(featureNeeds(getFeature(b.feature)), facility)
      if (why) errors.push(`${what}: ${name(b.feature)} (${b.id}, ${n} ${n === 1 ? 'copy' : 'copies'}) ${why}`)
    }
  // functions and add-ons that are on (instanceDesign leaves out what's off)
  for (const b of instanceDesign(prim, f).blocks) {
    const base = prim.design.blocks.find((x) => x.id === b.id)
    if (!base || inputBlocks(prim.design).includes(base) || outputBlocks(prim.design).includes(base)) continue
    const why = unavailable(featureNeeds(getFeature(b.feature)), facility)
    if (why) errors.push(`features: ${name(b.feature)} (${b.id}) ${why}`)
    for (const a of b.addons) {
      const key = `${b.id}.${addonKey(a)}`
      const whyAddon = unavailable(getFeature(a)?.needs, facility)
      if (whyAddon) errors.push(`features: ${name(a)} (${key}) ${whyAddon}`)
    }
  }
  const schema = instanceParts(prim, f).schema
  errors.push(...valueProblems(schema, f.parameters, f.parameters, facility))
  const gpu = f.resources?.gpu
  const whyGpu = gpu && gpu.count > 0 && unavailable(['gpu'], facility)
  if (whyGpu) errors.push(`resources.gpu: ${gpu.count} × ${gpu.class} ${whyGpu}`)
  return errors
}

// "exactly one", "at most two", "at least one", "between one and three", as the compiler words it.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const word = (n: number) => WORDS[n] ?? String(n)
function between(lo: number, hi: number | undefined): string {
  if (hi === undefined) return `at least ${word(lo)}`
  if (lo === hi) return `exactly ${word(lo)}`
  return lo === 0 ? `at most ${word(hi)}` : `between ${word(lo)} and ${word(hi)}`
}

// The workload's shape within the facility's limits (the orchestrator's, compiler rule 2): how many
// functions of a type (limits.functionsPerWorkload) and MXL domains (limits.domainsPerWorkload), with
// every function in one of them. None of this applies with no facility set.
export function shapeProblems(doc: Pick<WorkloadDescription, 'spec'>, facility: Facility = current): string[] {
  if (!hasFacility(facility)) return []
  const limits = facility.limits ?? {}
  const of = (name: string) => `limits.${name} of ${facility.name ? `facility ${facility.name}` : 'the facility'}`
  const errors: string[] = []
  for (const [type, r] of Object.entries(limits.functionsPerWorkload ?? {})) {
    const ids = doc.spec.functions.filter((f) => f.type === type).map((f) => f.id).sort()
    const lo = r.min ?? 0
    if (ids.length < lo || (r.max !== undefined && ids.length > r.max))
      errors.push(`workload: functions: needs ${between(lo, r.max)} ${type} function, has ${ids.length}${ids.length ? ` (${ids.join(', ')})` : ''}; ${of('functionsPerWorkload')}`)
  }
  const most = limits.domainsPerWorkload
  if (typeof most === 'number') {
    const domains = doc.spec.domains.map((d) => d.id)
    if (!domains.length || domains.length > most)
      errors.push(`workload: domains: needs ${between(1, most)} MXL domain, has ${domains.length}${domains.length ? `: ${domains.join(', ')}` : ''}; ${of('domainsPerWorkload')}`)
    else
      for (const f of doc.spec.functions)
        if (!domains.includes(f.domain))
          errors.push(`${f.id}: domain: "${f.domain}" is not ${domains.length === 1 ? `the workload's domain "${domains[0]}"` : "one of the workload's domains"}`)
  }
  return errors
}

// Product limits: a block in use that can't run with what another function of the instance is set
// to (e.g. RTMP with an HEVC colour profile, MXL at 720p). With or without a facility. One problem per copy.
export function productProblems(prim: VendorModule, f: Pick<FunctionInstance, 'parameters'> & InstanceSelection): string[] {
  const design = instanceDesign(prim, f)
  const errors: string[] = []
  for (const b of design.blocks)
    for (const c of getFeature(b.feature)?.rules?.conflictsWith ?? []) {
      for (const other of design.blocks.filter((x) => x.feature === c.feature)) {
        const group = getFeature(other.feature)?.parameters?.schema
        const set = getPath(f.parameters[other.id], c.path)
        const [, ...rest] = c.path.split('.')
        const value = set ?? (group ? getPath(defaultsFor(group) ?? {}, rest.join('.')) : undefined)
        if (value !== undefined && c.values.includes(value as string | number | boolean))
          errors.push(`${b.id}: ${c.message.replace(/\{value\}/g, String(value))} (${other.id}.${c.path})`)
      }
    }
  return errors
}

// The product limits in force for one copy (e.g. "rtmp-out_2"), for the dialog: the publish problem's text.
export function conflictsOf(prim: VendorModule, f: Pick<FunctionInstance, 'parameters'> & InstanceSelection, copy: string): string[] {
  return productProblems(prim, f).filter((p) => p.startsWith(`${copy}: `)).map((p) => p.slice(copy.length + 2))
}
