// The feature library: vocabulary, categories and the features (with their design rules) that
// modules are designed from. A versioned file in git (library.json); the server records each
// version at startup and refuses a changed file with an unchanged version.
import libraryJson from './library.json'
import { checkParameterSchema, defaultsFor, validateValue } from './schema'
import { API_VERSION, ESSENCES, FLOW_FIELDS, ID_RE, type CategoryDef, type FeatureDef, type FeatureLibrary, type JsonSchema } from './types'

// JSON literal types are too loose to assert directly; checkLibrary validates it (server start, tests).
export const LIBRARY = libraryJson as unknown as FeatureLibrary

const byId = new Map(LIBRARY.spec.features.map((f) => [f.id, f]))

export function getFeature(id: string): FeatureDef | undefined {
  return byId.get(id)
}

export function featuresIn(group: string): FeatureDef[] {
  return LIBRARY.spec.features.filter((f) => f.group === group)
}

export function getCategory(id: string): CategoryDef | undefined {
  return LIBRARY.spec.categories.find((c) => c.id === id)
}

// "input.*" matches any feature id starting with "input."
export function matchesFeature(pattern: string, featureId: string): boolean {
  return pattern.endsWith('.*') ? featureId.startsWith(pattern.slice(0, -1)) : pattern === featureId
}

export function checkLibrary(lib: FeatureLibrary = LIBRARY): string[] {
  if (lib?.apiVersion !== API_VERSION || lib.kind !== 'FeatureLibrary') return ['not a FeatureLibrary document']
  const errors: string[] = []
  if (!lib.metadata?.version) errors.push('metadata.version is required (bump it on every change)')

  // Vocabulary
  const v = lib.spec.vocabulary
  if (!v) return [...errors, 'spec.vocabulary is required']
  const transports = v.transports.map((t) => t.id)
  const names = new Set<string>()
  for (const t of v.transports) {
    if (!ID_RE.test(t.id)) errors.push(`vocabulary: transport id "${t.id}" is invalid`)
    for (const n of [t.id, t.label, ...(t.aliases ?? [])]) {
      if (names.has(n)) errors.push(`vocabulary: transport name "${n}" is used twice`)
      names.add(n)
    }
  }
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
    if (!ID_RE.test(c.id) || cats.has(c.id)) errors.push(`category ${c.id}: id must be unique and valid`)
    cats.add(c.id)
  }
  const groups = new Set(lib.spec.featureGroups.map((g) => g.id))

  // Features
  const ids = new Set<string>()
  for (const f of lib.spec.features) {
    const at = `feature ${f.id}`
    if (!ID_RE.test(f.id) || ids.has(f.id)) errors.push(`${at}: id must be unique and valid`)
    ids.add(f.id)
    if (!groups.has(f.group)) errors.push(`${at}: unknown group ${f.group}`)
    if (!['block', 'addon', 'module', 'option'].includes(f.kind)) errors.push(`${at}: kind must be block, addon, module or option`)
    if (f.kind !== 'block' && (f.external || f.mxlOutputs || f.mxlInputs)) errors.push(`${at}: only blocks have ports`)
    if (f.external) {
      if (!transports.includes(f.external.protocol)) errors.push(`${at}: unknown protocol ${f.external.protocol}`)
      if (!f.external.essenceOptions?.length || f.external.essenceOptions.some((e) => !ESSENCES.includes(e)))
        errors.push(`${at}: external port needs valid essence options`)
    }
    if (f.essence && !ESSENCES.includes(f.essence)) errors.push(`${at}: invalid essence`)
    if (f.kind === 'addon' && !f.rules?.attachTo?.length) errors.push(`${at}: an add-on must say what it attaches to`)
    if (f.parameters) {
      if (!f.key && !f.merge) errors.push(`${at}: parameters need a group key (or merge)`)
      const schemaErrors = checkParameterSchema(f.parameters.schema)
      errors.push(...schemaErrors.map((e) => `${at}: parameters: ${e}`))
      if (!schemaErrors.length)
        // Defaults must be valid; required parameters without a default (e.g. a port) are for the designer.
        errors.push(
          ...validateValue(f.parameters.schema, defaultsFor(f.parameters.schema))
            .filter((e) => !e.endsWith(': required'))
            .map((e) => `${at}: defaults: ${e}`),
        )
      const walk = (node: JsonSchema, path: string) => {
        if (node['x-flow'] && !FLOW_FIELDS.includes(node['x-flow'])) errors.push(`${at}: ${path}: unknown x-flow "${node['x-flow']}"`)
        for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${k}` : k)
      }
      walk(f.parameters.schema, '')
    }
  }
  // Rules refer to features and groups that exist
  for (const f of lib.spec.features) {
    for (const pattern of f.rules?.attachTo ?? [])
      if (!lib.spec.features.some((g) => g.kind === 'block' && matchesFeature(pattern, g.id)))
        errors.push(`feature ${f.id}: attachTo "${pattern}" matches no block feature`)
    for (const n of f.rules?.needsAddon ?? []) if (!groups.has(n.group)) errors.push(`feature ${f.id}: needsAddon names unknown group ${n.group}`)
    for (const id of f.includes ?? [])
      if (f.kind !== 'block' || lib.spec.features.find((g) => g.id === id)?.kind !== 'option')
        errors.push(`feature ${f.id}: includes "${id}": only blocks include, and only options`)
    if (f.kind === 'option' && !lib.spec.features.some((g) => g.includes?.includes(f.id))) errors.push(`feature ${f.id}: no block includes this option`)
    if (f.merge && !lib.spec.features.some((g) => g.key === f.merge)) errors.push(`feature ${f.id}: merge target "${f.merge}" is no feature's group`)
  }
  return errors
}
