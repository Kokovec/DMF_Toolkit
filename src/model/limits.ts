// What a product accepts beyond each value's own schema (R8.9), checked at publish so a design built
// from offered options deploys: values unique across a block's copies (`x-unique`), and the instance's
// own setup against the product's `setupSchema` (known vendor settings keys, the resource profile).
// Flow formats and writers (`ModuleBlock.flowFormat`, `readsFrom`) need the wires: `flowRuleProblems`
// in workload.ts. Problems name the parameter path as the orchestrator's compiler does.
import { type InstanceSelection, instanceParts } from './compose'
import { getPath, pathsWith, validateValue } from './schema'
import type { FunctionInstance, VendorModule } from './types'

// The block a copy belongs to: "srt-src_2" → "srt-src" (block ids never contain "_").
export const blockOfCopy = (copy: string) => copy.replace(/_\d+$/, '')

// `x-unique` values repeated between copies of one block, named on each later copy:
// "srt-src_2.srt.streamId: "cam" is also used by srt-src".
export function uniqueProblems(prim: VendorModule, f: Pick<FunctionInstance, 'parameters'> & InstanceSelection): string[] {
  const schema = instanceParts(prim, f).schema
  const seen = new Map<string, string>() // "<block>|<relative path>|<value>" → first copy
  const errors: string[] = []
  for (const [copy, group] of Object.entries(schema.properties ?? {}))
    for (const { path } of pathsWith(group, 'x-unique')) {
      const v = getPath(f.parameters[copy], path)
      if (v === undefined || v === '') continue
      const key = `${blockOfCopy(copy)}|${path}|${JSON.stringify(v)}`
      const first = seen.get(key)
      if (first) errors.push(`${copy}.${path}: ${JSON.stringify(v)} is also used by ${first}`)
      else seen.set(key, copy)
    }
  return errors
}

// The instance's vendor settings and resource profile against what the product accepts.
export function setupSchemaProblems(prim: VendorModule | undefined, f: Pick<FunctionInstance, 'settings' | 'resources'>): string[] {
  const s = prim?.setupSchema
  if (!s) return []
  return [
    ...(s.settings && f.settings !== undefined ? validateValue(s.settings, f.settings, 'settings') : []),
    ...(s.resources && f.resources !== undefined ? validateValue(s.resources, f.resources as never, 'resources') : []),
  ]
}
