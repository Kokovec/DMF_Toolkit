// Builds the product catalogs in catalogs/ (loaded by the server at startup). Every module models a real product: its design
// lists the product's functions (library features), and its ports and core parameters are derived
// from that and the feature library, so re-run this after a library change:
//   npx tsx scripts/product-catalogs.ts
import { writeFileSync } from 'node:fs'
import { checkCatalog } from '../src/model/catalog'
import { LIBRARY } from '../src/model/library'
import { withDerived } from '../src/model/modules'
import { API_VERSION, type JsonValue, type ModuleBlock, type ModuleCatalog, type VendorModule } from '../src/model/types'

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
  block('captions', 'switcher.captions', { addons: ['switcher.asr'], optional: { default: false, addons: { asr: false } } }),
  block('scte35', 'switcher.scte35', { addons: ['switcher.scte104'], optional: { default: false, addons: { scte104: false } } }),
  block('replay', 'switcher.replay', { optional: { default: true } }),
  block('clips', 'switcher.clips'),
  block('playout', 'switcher.playout', { optional: { default: false } }),
  block('ai-segment', 'switcher.ai-segment', { optional: { default: false } }),
  block('comms', 'switcher.comms'),
  block('control', 'switcher.control'),
]
const outputs = [
  block('srt-out', 'switcher.output.srt', { scaleOut: 8 }),
  block('rtmp-out', 'switcher.output.rtmp', { scaleOut: 4 }),
  block('mxl-out', 'switcher.output.mxl', { noData: true }), // the product opens no data writer for the programme
  block('st2110-out', 'switcher.output.st2110'),
  block('recording', 'switcher.output.recording', { optional: { default: false } }),
]
const switchframe: VendorModule = withDerived({
  id: 'switchframe.1',
  version: '1.1.0',
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
  defaults: {
    inputs: { 'mxl-src': 1 },
    outputs: { 'mxl-out': 1 },
    control: { health: { type: 'http', port: 9090, path: '/health' } },
    resources: { cpu: 2, memoryMiB: 4096 },
    // The facility's flow agent registers every flow; the product doesn't register itself (no control.nmos).
    discovery: { register: true },
  },
})

// DMF MXL: test sources for MXL workloads, modelling the MXL SDK's tools.
const testSource = (n: number, name: string, product: string, description: string, blocks: ModuleBlock[], parameters?: { [block: string]: JsonValue }): VendorModule =>
  withDerived({
    id: `dmf-mxl.${n}`,
    version: '1.0.0',
    name,
    description,
    categories: ['acquisition'],
    vendor: 'DMF MXL',
    product,
    capability: { produces: [], consumes: [], scaling: 'singleton' },
    design: { blocks, moduleFeatures: [] },
    ports: [],
    parameters: { schema: { type: 'object', properties: {} } },
    defaults: {
      outputs: { mxl: 1 },
      control: { health: { type: 'exec' } },
      resources: { cpu: 0.25, memoryMiB: 256 },
      discovery: { register: true },
      ...(parameters ? { parameters } : {}),
    },
  })

// Starts at the Switchframe engine's default format; the shared output.mxl default stays as it is.
const mxlTestSource = testSource(
  1,
  'MXL test source',
  'mxl-gst-testsrc',
  'A test pattern and tone published on MXL (mxl-gst-testsrc).',
  [block('pattern', 'test.pattern'), block('mxl', 'output.mxl', { scaleOut: 1, noData: true })],
  { mxl: { format: { video: { frameSize: '1920x1080', rate: '29.97' } } } },
)

// mxl-syncgen only runs at 1080p29.97.
const syncTestSource = testSource(2, 'A/V sync test source', 'mxl-syncgen', 'A white frame and a 1 kHz beep every 30 frames, published on MXL (mxl-syncgen).', [
  block('mxl', 'output.mxl', {
    scaleOut: 1,
    noData: true,
    allowed: {
      'format.video': {
        fields: ['frameSize', 'rate'],
        values: { '1920x1080': ['29.97'] },
        message: '{frameSize.height}p{rate} is not available: the A/V sync test source only runs at 1080p29.97',
      },
    },
  }),
])

const catalogs: ModuleCatalog[] = [
  {
    apiVersion: API_VERSION,
    kind: 'ModuleCatalog',
    metadata: { id: 'switchframe', name: 'Switchframe', version: '1', vendor: 'Switchframe' },
    spec: { modules: [switchframe] },
  },
  {
    apiVersion: API_VERSION,
    kind: 'ModuleCatalog',
    metadata: { id: 'dmf-mxl', name: 'DMF MXL', version: '1', vendor: 'DMF MXL' },
    spec: { modules: [mxlTestSource, syncTestSource] },
  },
]

for (const c of catalogs) {
  const problems = checkCatalog(c)
  if (problems.length) throw new Error(`${c.metadata.id}: ${problems.join('; ')}`)
  const file = `catalogs/${c.metadata.id}.catalog.json`
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`)
  console.log(`${file}: ${c.spec.modules.length} module(s), library ${LIBRARY.metadata.version}`)
}
