// Building vendor modules from primitives.
import { type Catalog } from './catalog'
import { EXTERNAL_TRANSPORTS, KNOWN_FORMATS, TRANSPORT_LABELS, transportOf } from './vocabulary'
import { roleBase } from './primitives'
import { getPath, omitPaths } from './schema'
import { type Essence, type ExternalTransport, type JsonSchema, type JsonValue, type PortDef, type PrimitiveDef, type VendorModule } from './types'


// Where a primitive declares its transport: top-level `transport` or `output.transport`.
function defaultTransport(schema: JsonSchema): unknown {
  return schema.properties?.transport?.default ?? schema.properties?.output?.properties?.transport?.default
}

// ---- Identity: one catalog per vendor; type id = "<catalog>.<primitive>.<n>" ----

// Catalog id from a vendor name: "Acme Media GmbH" -> "acme-media-gmbh".
export function vendorSlug(vendor: string): string {
  return vendor
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents: Ü -> U
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function moduleId(catalogId: string, role: string, n: number): string {
  return `${catalogId}.${roleBase(role)}.${n}`
}

// Module number of an id ("acme.receiver.2" -> 2), or null if it isn't in the standard form.
export function moduleNumber(id: string): number | null {
  const n = Number(id.slice(id.lastIndexOf('.') + 1))
  return Number.isInteger(n) && n > 0 ? n : null
}

// Next free module number for this vendor and primitive (1 if none exists yet).
export function nextModuleId(catalog: Catalog, catalogId: string, role: string): string {
  let n = 1
  while (catalog.get(moduleId(catalogId, role, n))) n++
  return moduleId(catalogId, role, n)
}

// A module must carry its catalog's vendor and an id of the form <catalog>.<primitive>.<n>.
export function catalogProblems(m: VendorModule, cat: { id: string; vendor: string }): string[] {
  const errors: string[] = []
  if (m.vendor !== cat.vendor) errors.push(`vendor must be "${cat.vendor}" (the catalog's vendor)`)
  const prefix = `${cat.id}.${roleBase(m.role)}.`
  if (!m.id.startsWith(prefix) || moduleNumber(m.id) === null || m.id.slice(prefix.length).includes('.'))
    errors.push(`type id must be ${prefix}<number>`)
  return errors
}

// What a module author chooses about its ports; everything else comes from the primitive.
export type PortChoice = { essence?: Essence; protocol?: ExternalTransport }

export function protocolsFor(prim: PrimitiveDef): ExternalTransport[] {
  return prim.protocols?.length ? prim.protocols : EXTERNAL_TRANSPORTS
}

// The module's ports: the primitive's templates, with the chosen input essence (for templates that
// offer one), outputs that depend on it, the chosen protocol on every external port, and MXL inside.
export function portsFor(prim: PrimitiveDef, choice: PortChoice = {}): PortDef[] {
  const option = prim.ports.find((t) => t.essenceOptions?.length)
  const essence = choice.essence && option?.essenceOptions?.includes(choice.essence) ? choice.essence : option?.essenceOptions?.[0]
  const allowed = protocolsFor(prim)
  const fallback = transportOf(defaultTransport(prim.parameters.schema)) // primitives that still carry a transport parameter
  const protocol =
    choice.protocol && allowed.includes(choice.protocol) ? choice.protocol : fallback && allowed.includes(fallback) ? fallback : allowed[0]
  return prim.ports
    .filter((t) => !t.whenInput || (essence !== undefined && t.whenInput.includes(essence)))
    .flatMap((t) => {
      const e = t.essenceOptions?.length ? essence! : t.essence
      const port: PortDef = {
        id: t.essenceOptions?.length ? `${t.id}.${e}` : t.id,
        direction: t.direction,
        essence: e,
        cardinality: t.cardinality,
        formats: KNOWN_FORMATS[e].slice(0, 1),
        transport: t.side === 'mxl' ? 'mxl' : { external: protocol },
      }
      if (t.label) port.label = t.label
      if (t.arraySize) port.arraySize = t.arraySize
      if (t.timeContext) port.timeContext = t.timeContext
      if (t.dualWhen) port.dualWhen = t.dualWhen
      if (t.side !== 'external' || !t.dualFor?.includes(protocol)) return [port]
      // Two legs of one protected stream (e.g. ST 2022-7 path A and path B), both required.
      const name = `${TRANSPORT_LABELS[protocol]}${e === 'audio' ? ' audio' : ''}`
      return (['a', 'b'] as const).map((leg) => ({ ...port, id: `${port.id}.${leg}`, label: `${name} ${leg.toUpperCase()}`, cardinality: '1' as const }))
    })
}

// The choice a module's ports were built from (inverse of portsFor).
export function portChoiceOf(m: Pick<VendorModule, 'ports'>): PortChoice {
  // (for dual-leg ports, both legs carry the same essence and protocol)
  const ext = m.ports.find((p) => p.transport !== 'mxl')
  return { essence: ext?.essence, protocol: ext && ext.transport !== 'mxl' ? ext.transport.external : undefined }
}

// The primitive's core parameters that apply to a module using `protocol`: blocks marked
// "x-protocols" (e.g. SRT ingress) only for those protocols. `current` keeps a module's existing
// (possibly narrowed) definitions for the parameters that remain.
export function coreSchemaFor(prim: PrimitiveDef, protocol: ExternalTransport | undefined, current?: JsonSchema): JsonSchema {
  const keep = Object.entries(prim.parameters.schema.properties ?? {}).filter(
    ([, s]) => !s['x-protocols'] || (protocol !== undefined && s['x-protocols'].includes(protocol)),
  )
  const properties = Object.fromEntries(keep.map(([k, s]) => [k, current?.properties?.[k] ?? s]))
  return { ...prim.parameters.schema, properties, required: prim.parameters.schema.required?.filter((r) => r in properties) }
}

// A new module draft with the primitive's ports and core parameters; the author fills in name,
// the port choices, the vendor's own settings (+ core mapping) and control endpoints.
export function moduleFromPrimitive(prim: PrimitiveDef, cat: { id: string; vendor: string }, catalog: Catalog): VendorModule {
  const ports = portsFor(prim)
  const protocol = portChoiceOf({ ports }).protocol
  return {
    id: nextModuleId(catalog, cat.id, prim.id),
    version: '1.0.0',
    name: '',
    description: '',
    role: prim.id,
    vendor: cat.vendor,
    capability: { produces: [], consumes: [], scaling: 'singleton' },
    ports,
    parameters: { schema: structuredClone(coreSchemaFor(prim, protocol)) },
    vendorSettings: { schema: { type: 'object', properties: {} }, mapping: [] },
    control: { health: { type: 'http', port: 8080, path: '/healthz' } },
    dependencies: [],
  }
}

// ---- Vendor settings ----

// The vendor settings a designer fills in: everything except the keys fed from core parameters.
export function settingsSchema(m: VendorModule): JsonSchema {
  return omitPaths(m.vendorSettings.schema, m.vendorSettings.mapping.map((x) => x.vendor))
}

// The configuration in the vendor's own terms, as the orchestrator would apply it: instance
// settings plus mapped core values (translated where a value map is given).
export function vendorConfig(m: VendorModule, parameters: JsonValue, settings: JsonValue): JsonValue {
  const out = structuredClone((settings ?? {}) as { [k: string]: JsonValue })
  for (const { core, vendor, values } of m.vendorSettings.mapping) {
    const v = getPath(parameters, core)
    if (v === undefined) continue
    setPath(out, vendor, values && String(v) in values ? values[String(v)] : v)
  }
  return out
}

function setPath(obj: { [k: string]: JsonValue }, path: string, value: JsonValue) {
  const keys = path.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k] as { [k: string]: JsonValue }
  }
  cur[keys[keys.length - 1]] = value
}
