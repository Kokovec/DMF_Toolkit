// Minimal JSON Schema support for module parameters: defaults and validation of the
// subset in types.ts (object/array/string/number/integer/boolean, enum, min/max, pattern, required)
// plus the valid combinations of two fields (`x-allowed`).
// Unknown keywords are ignored: the vendor function does the authoritative validation.
import type { JsonSchema, JsonValue, XAllowed } from './types'

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

// The refusal if a group's two fields hold a combination `x-allowed` doesn't list, naming the values.
export function allowedProblem(schema: JsonSchema, value: JsonValue | undefined): string | null {
  const allowed = schema['x-allowed']
  if (!allowed || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const [a, b] = allowed.fields.map((f) => value[f])
  if (a === undefined || b === undefined || allowed.values[String(a)]?.includes(String(b))) return null
  const fill = (name: string, height?: string) => {
    const v = String(value[name])
    return height ? (v.split('x')[1] ?? v) : v
  }
  const message = allowed.message ?? `{${allowed.fields[0]}} with {${allowed.fields[1]}} is not an allowed combination`
  return message.replace(/\{(\w+)(\.height)?\}/g, (_m, name: string, height?: string) => fill(name, height))
}

// The choices a field of an `x-allowed` group offers while its sibling holds the current value. The
// current value stays listed even if invalid, so the form shows what is set and the refusal.
export function allowedChoices(group: JsonSchema, key: string, value: JsonValue | undefined): (string | number)[] | undefined {
  const allowed: XAllowed | undefined = group['x-allowed']
  const field = group.properties?.[key]
  if (!allowed || !field?.enum || !allowed.fields.includes(key)) return field?.enum
  const siblings = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as { [k: string]: JsonValue }
  const ok = key === allowed.fields[0] ? Object.keys(allowed.values) : (allowed.values[String(siblings[allowed.fields[0]])] ?? [])
  return field.enum.filter((o) => ok.includes(String(o)) || o === siblings[key])
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
      const combination = allowedProblem(schema, value)
      if (combination) errors.push(`${at}: ${combination}`)
      return errors
    }
    case 'array':
      if (!Array.isArray(value)) return [`${at}: must be an array`]
      return schema.items ? value.flatMap((v, i) => validateValue(schema.items!, v, `${at}[${i}]`, root)) : []
    case 'string':
      if (typeof value !== 'string') return [`${at}: must be text`]
      return schema.pattern && !new RegExp(schema.pattern).test(value) ? [`${at}: must match ${schema.pattern}`] : []
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
    if (node.pattern !== undefined)
      try {
        new RegExp(node.pattern)
      } catch {
        errors.push(`${path}: invalid pattern ${node.pattern}`)
      }
    if (node['x-options'] !== undefined && node['x-options'] !== 'inputs') errors.push(`${path}: unknown x-options "${String(node['x-options'])}"`)
    const allowed = node['x-allowed']
    if (allowed) {
      if (allowed.fields?.length !== 2 || allowed.fields.some((f) => !node.properties?.[f])) errors.push(`${path}: x-allowed needs two fields of this group`)
      else if (!allowed.values || !Object.keys(allowed.values).length) errors.push(`${path}: x-allowed needs values`)
      else
        for (const [first, seconds] of Object.entries(allowed.values)) {
          const [f, g] = allowed.fields.map((n) => node.properties![n].enum)
          if (f && !f.map(String).includes(first)) errors.push(`${path}: x-allowed value "${first}" isn't an option of ${allowed.fields[0]}`)
          for (const v of seconds) if (g && !g.map(String).includes(v)) errors.push(`${path}: x-allowed value "${v}" isn't an option of ${allowed.fields[1]}`)
        }
    }
    for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${k}` : k)
    if (node.items) walk(node.items, `${path}[]`)
  }
  walk(s, '')
  return errors
}

// Dot paths of the fields whose choices come from the instance (`x-options`).
export function optionPaths(schema: JsonSchema, prefix = ''): { path: string; source: 'inputs' }[] {
  return Object.entries(schema.properties ?? {}).flatMap(([k, s]) => {
    const path = prefix ? `${prefix}.${k}` : k
    return s['x-options'] ? [{ path, source: s['x-options'] }] : optionPaths(s, path)
  })
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
