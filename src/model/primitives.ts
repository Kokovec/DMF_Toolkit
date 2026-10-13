// Primitives: the base type of each category (Receiver, Encoder, …). Generic and vendor
// models (MediaPrimitive entries in a catalog) name their primitive in `role`.
import primitivesJson from './primitives.json'
import { checkParameterSchema, defaultsFor, validateValue } from './schema'
import { API_VERSION, CARDINALITIES, ESSENCES, FLOW_FIELDS, ID_RE, type CategoryDef, type JsonSchema, type PrimitiveDef, type PrimitiveLibrary } from './types'

// JSON literal types are too loose to assert directly; checkPrimitiveLibrary validates it (server start, tests).
export const PRIMITIVE_LIBRARY = primitivesJson as unknown as PrimitiveLibrary

const byId = new Map(PRIMITIVE_LIBRARY.spec.primitives.map((p) => [p.id, p]))

export function getPrimitive(id: string): PrimitiveDef | undefined {
  return byId.get(id)
}

// Category headings with their primitives, in declaration order (palette, editor).
export function primitiveTree(): { category: CategoryDef; primitives: PrimitiveDef[] }[] {
  return PRIMITIVE_LIBRARY.spec.categories.map((category) => ({
    category,
    primitives: PRIMITIVE_LIBRARY.spec.primitives.filter((p) => p.category === category.id),
  }))
}

// Short base for instance ids: "acquisition.receiver" -> "receiver".
export function roleBase(role: string): string {
  return role.slice(role.lastIndexOf('.') + 1)
}

export function roleLabel(role: string): string {
  const p = getPrimitive(role)
  const c = p && PRIMITIVE_LIBRARY.spec.categories.find((x) => x.id === p.category)
  return p ? `${c?.name ?? p.category} › ${p.name}` : role
}

export function checkPrimitiveLibrary(lib: PrimitiveLibrary = PRIMITIVE_LIBRARY): string[] {
  if (lib?.apiVersion !== API_VERSION || lib.kind !== 'PrimitiveLibrary') return ['not a PrimitiveLibrary document']
  const errors: string[] = []
  if (!lib.metadata?.version) errors.push('metadata.version is required (bump it on every change)')
  // Vocabulary
  const v = lib.spec.vocabulary
  if (!v) return [...errors, 'spec.vocabulary is required']
  const EXTERNAL_TRANSPORTS = v.transports.map((t) => t.id)
  const names = new Set<string>()
  for (const t of v.transports)
    for (const n of [t.id, t.label, ...(t.aliases ?? [])]) {
      if (names.has(n)) errors.push(`vocabulary: transport name "${n}" is used twice`)
      names.add(n)
    }
  for (const t of v.transports) if (!ID_RE.test(t.id)) errors.push(`vocabulary: transport id "${t.id}" is invalid`)
  for (const e of ESSENCES) if (!v.formats?.[e]?.length) errors.push(`vocabulary: formats for ${e} are required`)
  const kinds = new Set<string>()
  for (const x of v.externals) {
    if (!ID_RE.test(x.kind) || kinds.has(x.kind)) errors.push(`vocabulary: external kind "${x.kind}" must be unique and valid`)
    kinds.add(x.kind)
    if (!['in', 'out'].includes(x.direction) || !ESSENCES.includes(x.essence)) errors.push(`vocabulary: external ${x.kind}: invalid direction or essence`)
  }
  const refs = new Set<string>()
  for (const r of v.references) {
    if (!ID_RE.test(r.id) || refs.has(r.id)) errors.push(`vocabulary: reference kind "${r.id}" must be unique and valid`)
    refs.add(r.id)
  }
  const cats = new Set<string>()
  for (const c of lib.spec.categories) {
    if (!ID_RE.test(c.id) || cats.has(c.id)) errors.push(`category ${c.id}: id must be unique, lowercase letters, digits, . _ -`)
    cats.add(c.id)
  }
  const ids = new Set<string>()
  for (const p of lib.spec.primitives) {
    const at = `primitive ${p.id}`
    if (ids.has(p.id)) errors.push(`${at}: duplicate id`)
    ids.add(p.id)
    if (!cats.has(p.category)) errors.push(`${at}: unknown category ${p.category}`)
    if (p.id !== `${p.category}.${roleBase(p.id)}`) errors.push(`${at}: id must be "<category>.<name>"`)
    const schemaErrors = checkParameterSchema(p.parameters?.schema)
    errors.push(...schemaErrors.map((e) => `${at}: parameters: ${e}`))
    if (!schemaErrors.length)
      // Defaults must be valid values; required parameters without a default (e.g. a port) are for the designer to fill in.
      errors.push(
        ...validateValue(p.parameters.schema, defaultsFor(p.parameters.schema))
          .filter((e) => !e.endsWith(': required'))
          .map((e) => `${at}: defaults: ${e}`),
      )
    const ports = new Set<string>()
    for (const t of p.ports) {
      if (!ID_RE.test(t.id) || ports.has(t.id)) errors.push(`${at}: port ${t.id}: id must be unique`)
      ports.add(t.id)
      if (!ESSENCES.includes(t.essence) || !CARDINALITIES.includes(t.cardinality) || !['in', 'out'].includes(t.direction))
        errors.push(`${at}: port ${t.id}: invalid essence, cardinality or direction`)
      if (!['external', 'mxl'].includes(t.side)) errors.push(`${at}: port ${t.id}: side must be external or mxl`)
      if (t.essenceOptions && (t.side !== 'external' || t.direction !== 'in' || t.essenceOptions.some((e) => !ESSENCES.includes(e))))
        errors.push(`${at}: port ${t.id}: essence options are only for external inputs`)
      if (t.whenInput?.some((e) => !ESSENCES.includes(e))) errors.push(`${at}: port ${t.id}: invalid whenInput essence`)
      if (t.dualFor && (t.side !== 'external' || t.dualFor.some((x) => !EXTERNAL_TRANSPORTS.includes(x))))
        errors.push(`${at}: port ${t.id}: dualFor is only for external ports, with known protocols`)
      if (t.arraySize && p.parameters.schema.properties?.[t.arraySize]?.type !== 'integer')
        errors.push(`${at}: port ${t.id}: array size "${t.arraySize}" must name an integer parameter`)
    }
    if (p.ports.filter((t) => t.essenceOptions?.length).length > 1) errors.push(`${at}: at most one port may offer essence options`)
    if (p.protocols?.some((x) => !EXTERNAL_TRANSPORTS.includes(x))) errors.push(`${at}: unknown protocol in protocols`)
    for (const [k, s] of Object.entries(p.parameters.schema.properties ?? {}))
      if (s['x-protocols']?.some((x) => !EXTERNAL_TRANSPORTS.includes(x)))
        errors.push(`${at}: parameter ${k}: unknown protocol in x-protocols`)
    const walk = (node: JsonSchema, path: string) => {
      if (node['x-flow'] && !FLOW_FIELDS.includes(node['x-flow'])) errors.push(`${at}: ${path}: unknown x-flow "${node['x-flow']}"`)
      for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${k}` : k)
    }
    walk(p.parameters.schema, '')
  }
  return errors
}
