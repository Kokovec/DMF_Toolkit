// The studio-a workload, built through the model the way a user would: new instances, then only what
// a user would set. Formats, discovery, health and resources come from each module's defaults.
// Matches examples/studio-a.workload.xml in the orchestrator repo (DMF_Orchestrator).
import { readFileSync } from 'node:fs'
import { Catalog } from '../../src/model/catalog'
import type { JsonValue, ModuleCatalog, VendorModule, Wire, WorkloadDescription } from '../../src/model/types'
import { DEFAULTS, newFunctionData, toWorkload, withSelection, type CanvasNode, type FnData } from '../../src/model/workload'

const catalogFile = (id: string) => JSON.parse(readFileSync(new URL(`../../catalogs/${id}.catalog.json`, import.meta.url), 'utf8')) as ModuleCatalog

// The product catalogs as shipped, for building and checking the fixture without a server.
export function productCatalog(): Catalog {
  return new Catalog(['switchframe', 'dmf-mxl'].flatMap((id) => catalogFile(id).spec.modules))
}

const SOURCES = [
  { id: 'cam1', label: 'Camera 1' },
  { id: 'cam2', label: 'Camera 2' },
  { id: 'sync', label: 'Sync test' },
]
const COPIES = ['mxl-src', 'mxl-src_2', 'mxl-src_3']

export function studioA(catalog: Catalog = productCatalog()): WorkloadDescription {
  const module = (id: string): VendorModule => {
    const m = catalog.get(id)
    if (!m) throw new Error(`module ${id} isn't in the catalog`)
    return m
  }
  const testSource = module('dmf-mxl.1')
  const switchframe = module('switchframe.1')

  const cam1 = newFunctionData(testSource, 'Camera 1') // the default pattern, smpte
  const cam2 = newFunctionData(testSource, 'Camera 2')
  ;(cam2.parameters.pattern as { pattern: { pattern: JsonValue } }).pattern.pattern = 'ball'
  const sync = newFunctionData(module('dmf-mxl.2'), 'Sync test')

  const mixer = withSelection(newFunctionData(switchframe, 'Vision mixer'), switchframe, { inputs: { 'mxl-src': 3 } })
  COPIES.forEach((copy, i) => {
    ;(mixer.parameters[copy] as { source: { [k: string]: JsonValue } }).source = {
      ...(mixer.parameters[copy] as { source: { [k: string]: JsonValue } }).source,
      label: SOURCES[i].label,
      position: i + 1,
    }
  })

  const node = (id: string, data: FnData): CanvasNode => ({ id, type: 'fn', position: { x: 0, y: 0 }, data })
  const wires: Wire[] = SOURCES.flatMap(({ id }, i) => ['video', 'audio'].map((e) => ({ from: `${id}/mxl.${e}`, to: `vision-mixer/${COPIES[i]}.${e}` })))

  return toWorkload(
    {
      id: 'studio-a',
      name: 'Studio A',
      description: 'Two-camera studio with an A/V sync source: the news-studio design, expressed as a published workload.',
    },
    // Workload panel: flow defaults for the show (the sources take their format from their own settings).
    { ...DEFAULTS, video: { ...DEFAULTS.video, grainRate: { num: 30000, den: 1001 } }, mxl: { historyMs: 500 } },
    [node('cam1', cam1), node('cam2', cam2), node('sync', sync), node('vision-mixer', mixer)],
    wires,
    { roles: { director: ['director1'], audio: ['audio1'], viewer: ['viewer1'] } },
  )
}
