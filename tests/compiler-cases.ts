// One workload per value the orchestrator's compiler refuses (tools/dmf_compile/products/switchframe.py)
// that stage 7A still published, each with the problem the toolkit now gives (R8.9). Built from the
// reference workload through injected functions, so the same cases can be built by an older toolkit
// (the case files for the compiler come from that). Not a test file itself: compiler-checks.test.ts.
import type { Catalog } from '../src/model/catalog'
import type { FunctionInstance, JsonValue, VendorModule, WorkloadDescription } from '../src/model/types'
import type { FnData } from '../src/model/workload'

export type Toolkit = {
  catalog: Catalog
  studioA: (c: Catalog) => WorkloadDescription
  withSelection: (data: FnData, prim: VendorModule, chosen: { inputs?: Record<string, number>; outputs?: Record<string, number>; features?: Record<string, boolean> }) => FnData
}
type Groups = { [k: string]: { [k: string]: { [k: string]: JsonValue } } }

export type Case = {
  name: string // the case file's name
  check: string // what the compiler checks
  facility?: true // needs a facility (skipped without one)
  build: (t: Toolkit) => WorkloadDescription
  problem: string // the publish problem, with the compiler's parameter path
  also?: string[] // other problems the same workload has
}

const mixerOf = (d: WorkloadDescription) => d.spec.functions.find((f) => f.id === 'vision-mixer')!

// studio-a with the vision mixer's selection changed (new copies get their defaults) and edited.
function mixer(t: Toolkit, sel: Parameters<Toolkit['withSelection']>[2], edit: (p: Groups, f: FunctionInstance, d: WorkloadDescription) => void = () => {}) {
  const doc = t.studioA(t.catalog)
  const i = doc.spec.functions.findIndex((f) => f.id === 'vision-mixer')
  const f = doc.spec.functions[i]
  const next = t.withSelection({ kind: 'fn', ...f, settings: f.settings ?? {} } as FnData, t.catalog.get('switchframe.1')!, sel)
  const { kind: _kind, ...fn } = next
  doc.spec.functions[i] = { ...f, ...fn }
  edit(doc.spec.functions[i].parameters as Groups, doc.spec.functions[i], doc)
  return doc
}

export const CASES: Case[] = [
  {
    name: 'mxl-format',
    check: 'MXL source format against the engine (rule 5)',
    build: (t) => mixer(t, {}, (p) => (p.engine.engine.rate = '25')),
    problem: "vision-mixer: mxl-src: flow cam1/mxl.video rate is 29.97, the function's is 25",
  },
  {
    // Rule 2, from the facility's limits.functionsPerWorkload. The only other MXL writer is Switchframe,
    // so the writer check (readsFrom) can only fire on a second mixer, which rule 2 already refuses.
    name: 'switchframe-count',
    check: "switchframe.1 functions within the facility's functionsPerWorkload (rule 2)",
    facility: true,
    build: (t) =>
      mixer(t, {}, (_p, _f, d) => {
        // a second mixer, reading Camera 1, whose programme feeds the vision mixer's third source
        const b = structuredClone(mixerOf(d))
        Object.assign(b, { id: 'mixer-b', name: 'Mixer B', inputs: { ...b.inputs, 'mxl-src': 1 } })
        ;(b.parameters.engine as Groups['engine']).engine.onAirAtStart = 'mxl-src'
        d.spec.functions.push(b)
        d.spec.wires = [
          ...d.spec.wires.filter((w) => !w.to.startsWith('vision-mixer/mxl-src_3.')),
          { from: 'cam1/mxl.video', to: 'mixer-b/mxl-src.video' },
          { from: 'cam1/mxl.audio', to: 'mixer-b/mxl-src.audio' },
          { from: 'mixer-b/mxl-out.video', to: 'vision-mixer/mxl-src_3.video' },
          { from: 'mixer-b/mxl-out.audio', to: 'vision-mixer/mxl-src_3.audio' },
        ]
      }),
    problem: 'workload: functions: needs exactly one switchframe.1 function, has 2 (mixer-b, vision-mixer); limits.functionsPerWorkload of facility local',
    also: ['vision-mixer: mxl-src_3.video: is wired from mixer-b (switchframe.1), and mxl-src_3 reads only from dmf-mxl.*'],
  },
  {
    name: 'no-switchframe',
    check: "switchframe.1 functions within the facility's functionsPerWorkload (rule 2): none",
    facility: true,
    build: (t) =>
      mixer(t, {}, (_p, _f, d) => {
        d.spec.functions = d.spec.functions.filter((f) => f.id !== 'vision-mixer')
        d.spec.wires = d.spec.wires.filter((w) => !w.to.startsWith('vision-mixer/'))
      }),
    problem: 'workload: functions: needs exactly one switchframe.1 function, has 0; limits.functionsPerWorkload of facility local',
  },
  {
    name: 'two-domains',
    check: "MXL domains within the facility's domainsPerWorkload (rule 2)",
    facility: true,
    build: (t) =>
      mixer(t, {}, (_p, _f, d) => {
        d.spec.functions.find((f) => f.id === 'cam2')!.domain = 'aux'
        d.spec.domains = [{ id: 'aux' }, { id: 'main' }]
      }),
    problem: "workload: domains: needs exactly one MXL domain, has 2: aux, main; limits.domainsPerWorkload of facility local",
  },
  {
    name: 'srt-streamid-unique',
    check: 'SRT stream ID unique per function',
    build: (t) =>
      mixer(t, { inputs: { 'mxl-src': 3, 'srt-src': 2 } }, (p, _f, d) => {
        for (const copy of ['srt-src', 'srt-src_2']) {
          Object.assign(p[copy].srt, { mode: 'listener', streamId: 'venue' })
          Object.assign(p[copy].payload, { pathA: { bitrateMbps: 20 } })
        }
        d.spec.externals.push(
          { id: 'venue-a', kind: 'source', name: 'Venue A', reference: { kind: 'srt', value: 'venue-a' } },
          { id: 'venue-b', kind: 'source', name: 'Venue B', reference: { kind: 'srt', value: 'venue-b' } },
        )
        d.spec.wires.push({ from: 'venue-a/stream', to: 'vision-mixer/srt-src.in.video' }, { from: 'venue-b/stream', to: 'vision-mixer/srt-src_2.in.video' })
      }),
    problem: 'vision-mixer: srt-src_2.srt.streamId: "venue" is also used by srt-src',
  },
  {
    name: 'label-bytes',
    check: 'source label at most 128 UTF-8 bytes',
    build: (t) => mixer(t, {}, (p) => (p['mxl-src'].source.label = 'é'.repeat(65))), // 65 characters, 130 bytes
    problem: 'vision-mixer: mxl-src.source.label: must be at most 128 bytes as UTF-8 (this is 130)',
  },
  {
    name: 'srt-out-address',
    check: 'SRT output address: a host, without the port',
    build: (t) => mixer(t, { outputs: { 'mxl-out': 1, 'srt-out': 1 } }, (p) => Object.assign(p['srt-out'].srt, { mode: 'caller', address: 'cdn.example.com:9000', port: 9000 })),
    problem: 'vision-mixer: srt-out.srt.address: must be a host name or address, without the port',
  },
  {
    name: 'rtmp-url',
    check: 'RTMP URL scheme',
    build: (t) => mixer(t, { outputs: { 'mxl-out': 1, 'rtmp-out': 1 } }, (p) => (p['rtmp-out'].rtmp.url = 'https://live.example.com/app')),
    problem: 'vision-mixer: rtmp-out.rtmp.url: must start with rtmp:// or rtmps://',
  },
  {
    name: 'recording-prefix',
    check: 'recording prefix a plain file name',
    build: (t) => mixer(t, { features: { recording: true } }, (p) => (p.recording.recording.filenamePrefix = '../program')),
    problem: 'vision-mixer: recording.recording.filenamePrefix: must be a plain file name prefix: a letter or digit, then up to 63 letters, digits, _ . or -, without ..',
  },
  {
    name: 'recording-size',
    check: "recording size within the facility's limits.maxRecordingGiB",
    facility: true,
    build: (t) => mixer(t, { features: { recording: true } }, (p) => (p.recording.recording.storageGiB = 500)),
    problem: "vision-mixer: recording.recording.storageGiB: 500 is more than facility local's maxRecordingGiB of 200",
  },
  {
    name: 'scte35-webhook',
    check: 'SCTE-35 webhook scheme',
    build: (t) => mixer(t, { features: { scte35: true } }, (p) => (p.scte35.scte35.webhookUrl = 'ftp://hooks.example.com/scte35')),
    problem: 'vision-mixer: scte35.scte35.webhookUrl: must be an http:// or https:// URL',
  },
  {
    name: 'cpu',
    check: 'CPU above 0',
    build: (t) => mixer(t, {}, (_p, f) => (f.resources = { cpu: 0, memoryMiB: 4096 })),
    problem: 'vision-mixer: resources.cpu: must be more than 0',
  },
  {
    name: 'memory',
    check: 'memory at least 512 MiB',
    build: (t) => mixer(t, {}, (_p, f) => (f.resources = { cpu: 2, memoryMiB: 256 })),
    problem: 'vision-mixer: resources.memoryMiB: must be ≥ 512',
  },
  {
    name: 'extra-args-list',
    check: 'extraArgs a list of strings',
    build: (t) => mixer(t, {}, (_p, f) => (f.settings = { extraArgs: '--log-level=debug' })),
    problem: 'vision-mixer: settings.extraArgs: must be an array',
  },
  {
    name: 'extra-args-demo',
    check: 'extraArgs without --demo',
    build: (t) => mixer(t, {}, (_p, f) => (f.settings = { extraArgs: ['--log-level=debug', '--demo'] })),
    problem: `vision-mixer: settings.extraArgs: "--demo" is refused: demo mode replaces the workload's sources`,
  },
  {
    name: 'key-fill-source',
    check: 'key fill source an input copy of the function',
    build: (t) => mixer(t, {}, (p) => Object.assign(p['mxl-src'].key, { type: 'luma', fillSource: 'Camera 2' })),
    problem: `vision-mixer: mxl-src.key.fillSource: "Camera 2" isn't an input copy in use (mxl-src, mxl-src_2, mxl-src_3)`,
  },
]
