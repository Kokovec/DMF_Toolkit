// Minimal JSON Schema support for module parameters: defaults and validation of the
// subset in types.ts (object/array/string/number/integer/boolean, enum, min/max, required).
// Unknown keywords are ignored: the vendor function does the authoritative validation.
import type { JsonSchema, JsonValue } from './types'

export const SECRET_FORMAT = 'secret-ref'

export function isSecretRef(v: unknown): v is { $secret: string } {
  return !!v && typeof v === 'object' && typeof (v as { $secret?: unknown }).$secret === 'string'
}

// Default value for a schema: its `default`, or for objects the defaults of each property.
export function defaultsFor(schema: JsonSchema): JsonValue | undefined {
  if (schema.default !== undefined) return structuredClone(schema.default)
  if (schema.type === 'object' && schema.properties) {
    const out: { [k: string]: JsonValue } = {}
    for (const [k, s] of Object.entries(schema.properties)) {
      const d = defaultsFor(s)
      if (d !== undefined) out[k] = d
    }
    return out
  }
  return undefined
}

export function getPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

export function schemaAt(schema: JsonSchema, path: string): JsonSchema | undefined {
  let cur: JsonSchema | undefined = schema
  for (const key of path.split('.')) cur = cur?.properties?.[key]
  return cur
}

// Whether a property applies (see `x-when`). A plain key names a sibling ("mode"); a dotted key
// is a path from the root of the parameters ("srt.bonding"), for conditions on another group.
export function applies(schema: JsonSchema, siblings: JsonValue | undefined, root?: JsonValue): boolean {
  const when = schema['x-when']
  if (!when) return true
  return Object.entries(when).every(([k, values]) =>
    values.includes((k.includes('.') ? getPath(root, k) : getPath(siblings, k)) as string | number | boolean),
  )
}

// The title to show, given the current values (see `x-title-when`).
export function titleFor(schema: JsonSchema, siblings: JsonValue | undefined, root?: JsonValue): string | undefined {
  const match = schema['x-title-when']?.find((t) => applies({ 'x-when': t.when }, siblings, root))
  return match?.title ?? schema.title
}

export function validateValue(schema: JsonSchema, value: JsonValue | undefined, path = '', root: JsonValue | undefined = value): string[] {
  const at = path || 'parameters'
  if (value === undefined) return []
  if (schema.format === SECRET_FORMAT) return isSecretRef(value) ? [] : [`${at}: must be a secret reference {"$secret": "name"}`]
  if (schema.enum && !schema.enum.includes(value as string | number)) return [`${at}: must be one of ${schema.enum.join(', ')}`]
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: must be an object`]
      const errors: string[] = []
      const props = schema.properties ?? {}
      for (const r of schema.required ?? [])
        if (value[r] === undefined && (!props[r] || applies(props[r], value, root))) errors.push(`${path ? `${path}.` : ''}${r}: required`)
      for (const [k, s] of Object.entries(props))
        if (applies(s, value, root)) errors.push(...validateValue(s, value[k], path ? `${path}.${k}` : k, root))
      return errors
    }
    case 'array':
      if (!Array.isArray(value)) return [`${at}: must be an array`]
      return schema.items ? value.flatMap((v, i) => validateValue(schema.items!, v, `${at}[${i}]`, root)) : []
    case 'string':
      return typeof value === 'string' ? [] : [`${at}: must be text`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: must be true or false`]
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${at}: must be a number`]
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${at}: must be a whole number`]
      if (schema.minimum !== undefined && value < schema.minimum) return [`${at}: must be ≥ ${schema.minimum}`]
      if (schema.maximum !== undefined && value > schema.maximum) return [`${at}: must be ≤ ${schema.maximum}`]
      return []
    }
    default:
      return []
  }
}

// Checks that a schema is usable as a parameter schema (top level object, sane defaults).
export function checkParameterSchema(schema: unknown): string[] {
  const s = schema as JsonSchema
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['parameter schema must be a JSON object']
  if (s.type !== 'object') return ['parameter schema must have "type": "object"']
  const errors: string[] = []
  const walk = (node: JsonSchema, path: string) => {
    if (node.default !== undefined) errors.push(...validateValue({ ...node, default: undefined }, node.default, `${path} default`))
    for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${k}` : k)
    if (node.items) walk(node.items, `${path}[]`)
  }
  walk(s, '')
  return errors
}

// Dot paths of every settable value in an object schema (objects with properties are walked into).
export function leafPaths(schema: JsonSchema, prefix = ''): string[] {
  return Object.entries(schema.properties ?? {}).flatMap(([k, s]) => {
    const path = prefix ? `${prefix}.${k}` : k
    return s.type === 'object' && s.properties ? leafPaths(s, path) : [path]
  })
}

// The schema without the given leaf paths (and without objects left empty), e.g. vendor settings
// minus the keys filled from core parameters.
export function omitPaths(schema: JsonSchema, paths: string[]): JsonSchema {
  if (!paths.length || !schema.properties) return schema
  const properties: Record<string, JsonSchema> = {}
  for (const [k, s] of Object.entries(schema.properties)) {
    if (paths.includes(k)) continue
    const inner = paths.filter((p) => p.startsWith(`${k}.`)).map((p) => p.slice(k.length + 1))
    const child = inner.length ? omitPaths(s, inner) : s
    if (child.type === 'object' && child.properties && !Object.keys(child.properties).length && s.properties) continue
    properties[k] = child
  }
  return { ...schema, properties, required: schema.required?.filter((r) => r in properties) }
}

// The value without properties whose `x-when` condition doesn't hold (e.g. path B settings while
// bonding is off), so only applicable settings reach the orchestrator.
export function withoutInapplicable(schema: JsonSchema, value: JsonValue | undefined, root: JsonValue | undefined = value): JsonValue | undefined {
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const out: { [k: string]: JsonValue } = {}
  for (const [k, v] of Object.entries(value)) {
    const s = schema.properties?.[k]
    if (s && !applies(s, value, root)) continue
    out[k] = s ? (withoutInapplicable(s, v, root) as JsonValue) : v
  }
  return out
}
