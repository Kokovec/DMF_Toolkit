// Builds the product catalogs in catalogs/ (loaded by the server at startup). Every module models a real product: its design
// lists the product's functions (library features), and its ports and core parameters are derived
// from that and the feature library, so re-run this after a library change:
//   npx tsx scripts/product-catalogs.ts
import { writeFileSync } from 'node:fs'
import { checkCatalog } from '../src/model/catalog'
import { LIBRARY } from '../src/model/library'
import { withDerived } from '../src/model/modules'
import { API_VERSION, type ModuleBlock, type ModuleCatalog, type VendorModule } from '../src/model/types'

const block = (id: string, feature: string, extra: Partial<ModuleBlock> = {}): ModuleBlock => ({ id, feature, addons: [], ...extra })

// Switchframe: open-source browser-based live production switcher (github.com/zsiec/switchframe,
// fork github.com/thiagopnts/switchframe). Features from its README, docs/reference/config-and-flags.md
// and docs/subsystems/*; how its settings map to the product's flags: docs/products/switchframe.md.
const inputs = [
  block('srt-src', 'switcher.input.srt', { scaleOut: 16 }),
  block('moq-src', 'switcher.input.moq', { scaleOut: 8 }),
  block('mxl-src', 'switcher.input.mxl', { scaleOut: 8 }),
  block('st2110-src', 'switcher.input.st2110', { scaleOut: 8 }),
]
const features = [
  block('engine', 'switcher.engine'),
  block('transitions', 'switcher.transitions'),
  block('audio', 'switcher.audio'),
  block('keyers', 'switcher.keyers'),
  block('graphics', 'switcher.graphics'),
  block('colorgrade', 'switcher.colorgrade'),
  block('stmap', 'switcher.stmap'),
  block('encoder', 'switcher.encoder', { addons: ['codec.h264', 'codec.hevc', 'codec.aac'] }),
  block('captions', 'switcher.captions', { addons: ['switcher.asr'] }),
  block('scte35', 'switcher.scte35', { addons: ['switcher.scte104'] }),
  block('replay', 'switcher.replay'),
  block('clips', 'switcher.clips'),
  block('playout', 'switcher.playout'),
  block('ai-segment', 'switcher.ai-segment'),
  block('comms', 'switcher.comms'),
  block('control', 'switcher.control'),
]
const outputs = [
  block('srt-out', 'switcher.output.srt', { scaleOut: 8 }),
  block('rtmp-out', 'switcher.output.rtmp', { scaleOut: 4 }),
  block('mxl-out', 'switcher.output.mxl'),
  block('st2110-out', 'switcher.output.st2110'),
  block('recording', 'switcher.output.recording'),
]
const switchframe: VendorModule = withDerived({
  id: 'switchframe.1',
  version: '1.0.0',
  name: 'Switchframe',
  description:
    'Browser-operated live production switcher: SRT, MoQ, MXL and ST 2110 sources; switching, transitions, audio mixing, keying and DVE, ' +
    'graphics, colour grading, captions (with AI speech-to-text), SCTE-35/104, instant replay, clip players and playout; programme out ' +
    'over SRT, RTMP, MXL, ST 2110 and to recording. GPU-accelerated when the host has one.',
  categories: ['production'],
  vendor: 'Switchframe',
  product: 'Switchframe',
  productVersion: 'main@7923615 (2026-06-09)',
  capability: { produces: [], consumes: [], scaling: 'singleton' },
  design: { blocks: [...inputs, ...features, ...outputs], moduleFeatures: [], inputRule: 'several' },
  ports: [],
  parameters: { schema: { type: 'object', properties: {} } },
})

const catalogs: ModuleCatalog[] = [
  {
    apiVersion: API_VERSION,
    kind: 'ModuleCatalog',
    metadata: { id: 'switchframe', name: 'Switchframe', version: '1', vendor: 'Switchframe' },
    spec: { modules: [switchframe] },
  },
]

for (const c of catalogs) {
  const problems = checkCatalog(c)
  if (problems.length) throw new Error(`${c.metadata.id}: ${problems.join('; ')}`)
  const file = `catalogs/${c.metadata.id}.catalog.json`
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`)
  console.log(`${file}: ${c.spec.modules.length} module(s), library ${LIBRARY.metadata.version}`)
}
