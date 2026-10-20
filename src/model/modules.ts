// Vendor modules: identity (one catalog per vendor, numbered type ids), a blank module to design
// from, and the parts derived from the design.
import { type Catalog } from './catalog'
import { composeModule, EMPTY_DESIGN } from './compose'
import { ESSENCES, type VendorModule } from './types'

// ---- Identity: one catalog per vendor; type id = "<catalog>.<n>" ----

// Catalog id from a vendor name: "Acme Media GmbH" -> "acme-media-gmbh".
export function vendorSlug(vendor: string): string {
  return vendor
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents: Ü -> U
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function moduleId(catalogId: string, n: number): string {
  return `${catalogId}.${n}`
}

// Module number of an id ("acme.2" -> 2), or null if it isn't in the standard form.
export function moduleNumber(id: string): number | null {
  const n = Number(id.slice(id.lastIndexOf('.') + 1))
  return Number.isInteger(n) && n > 0 ? n : null
}

// Next free module number for this vendor (1 if none exists yet).
export function nextModuleId(catalog: Catalog, catalogId: string): string {
  let n = 1
  while (catalog.get(moduleId(catalogId, n))) n++
  return moduleId(catalogId, n)
}

// A module must carry its catalog's vendor and an id of the form <catalog>.<n>.
export function catalogProblems(m: VendorModule, cat: { id: string; vendor: string }): string[] {
  const errors: string[] = []
  if (m.vendor !== cat.vendor) errors.push(`vendor must be "${cat.vendor}" (the catalog's vendor)`)
  if (!m.id.startsWith(`${cat.id}.`) || moduleNumber(m.id) === null || m.id.slice(cat.id.length + 1).includes('.'))
    errors.push(`type id must be ${cat.id}.<number>`)
  return errors
}

// ---- Design ----

// A blank module for the designer: no features yet; the author drags them in.
export function blankModule(cat: { id: string; vendor: string }, catalog: Catalog): VendorModule {
  return withDerived({
    id: nextModuleId(catalog, cat.id),
    version: '1.0.0',
    name: '',
    description: '',
    categories: [],
    vendor: cat.vendor,
    capability: { produces: [], consumes: [], scaling: 'singleton' },
    design: structuredClone(EMPTY_DESIGN),
    ports: [],
    parameters: { schema: { type: 'object', properties: {} } },
  })
}

// The module with its ports, core parameter schema and capability recomputed from its design.
export function withDerived(m: VendorModule): VendorModule {
  const { ports, schema } = composeModule(m.design ?? EMPTY_DESIGN)
  const of = (dir: 'in' | 'out') => ESSENCES.filter((e) => ports.some((p) => p.direction === dir && p.essence === e))
  return { ...m, ports, parameters: { schema }, capability: { ...m.capability, produces: of('out'), consumes: of('in') } }
}
