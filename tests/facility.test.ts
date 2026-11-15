// What the facility can run (R8.8) and the products' own limits: the capability list matches the
// orchestrator's export, options the facility doesn't offer are publish problems naming them (only
// while a facility is set), and RTMP with an HEVC colour profile is refused with or without one.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { after, before, describe, test } from 'node:test'
import { productCatalog, studioA } from '../scripts/fixtures/studio-a'
import { createApp } from '../server/app'
import { Store } from '../server/db'
import { CAPABILITIES, checkFacility, facilityProblems } from '../src/model/facility'
import { checkLibrary, LIBRARY } from '../src/model/library'
import type { Facility, FunctionInstance, JsonValue, ModuleCatalog, WorkloadDescription } from '../src/model/types'
import { publishProblems, withSelection, type FnData } from '../src/model/workload'

// The orchestrator's export (`make facility-export` in DMF_Orchestrator), read where it lives.
const EXPORT =
  process.env.DMF_FACILITY ?? `/mnt/wsl/instances/Ubuntu-24.04/home/${userInfo().username}/DMF_Orchestrator/.state/facility-local.json`
const noExport = existsSync(EXPORT) ? false : `${EXPORT} isn't reachable (run make facility-export there, or bind-mount Ubuntu-24.04)`

// What facility "local" declares (facility/local.yaml in DMF_Orchestrator), so the gating tests don't
// depend on the cross-distro mount.
const LOCAL: Facility = {
  name: 'local',
  capabilities: {
    mxl: true,
    'srt-in': true,
    'srt-caller-out': true,
    'rtmp-out': true,
    recording: true,
    'srt-listener-out': false,
    st2110: false,
    moq: false,
    gpu: false,
    asr: false,
    'neural-key': false,
    'ai-segment': false,
    scte104: false,
  },
  limits: { maxRecordingGiB: 200, functionsPerWorkload: { 'switchframe.1': { min: 1, max: 1 } }, domainsPerWorkload: 1 },
}
const NONE: Facility = {}

const catalog = productCatalog()
type Obj = { [k: string]: JsonValue }
const mixer = (d: WorkloadDescription) => d.spec.functions.find((f) => f.id === 'vision-mixer')!
const group = (f: FunctionInstance, path: string): Obj => {
  let cur = f.parameters as Obj
  for (const k of path.split('.')) cur = (cur[k] ??= {}) as Obj
  return cur
}
const notOffered = (problems: string[]) => problems.filter((p) => p.includes("doesn't offer"))

describe('the capability list', () => {
  test('matches the keys of the facility export exactly', { skip: noExport }, () => {
    const doc = JSON.parse(readFileSync(EXPORT, 'utf8'))
    assert.deepEqual(checkFacility(doc), [])
    assert.deepEqual(CAPABILITIES.map((c) => c.id).sort(), Object.keys(doc.capabilities).sort())
  })
  test('the inline copy of facility local is what the export says', { skip: noExport }, () => {
    const doc = JSON.parse(readFileSync(EXPORT, 'utf8'))
    assert.deepEqual({ name: doc.name, capabilities: doc.capabilities, limits: doc.limits }, LOCAL)
  })
  test('every need in the library names a capability (checkLibrary)', () => {
    assert.deepEqual(checkLibrary(), [])
    const ids = new Set(CAPABILITIES.map((c) => c.id))
    const needs = JSON.stringify(LIBRARY.spec.features).match(/"needs":\[[^\]]*\]|"x-enumNeeds":\{[^}]*\}/g) ?? []
    assert.ok(needs.length >= 12)
    for (const n of needs) for (const id of n.match(/\[[^\]]*\]/g)!.flatMap((l) => JSON.parse(l) as string[])) assert.ok(ids.has(id), id)
  })
})

// [what, how to select it in the reference workload, the text the problem must contain]
const GATED: [string, (d: WorkloadDescription) => void, string][] = [
  ['ST 2110 source', (d) => (mixer(d).inputs = { ...mixer(d).inputs, 'st2110-src': 1 }), 'inputs: ST 2110 receiver (st2110-src, 1 copy) needs ST 2110 (st2110)'],
  ['ST 2110 output', (d) => (mixer(d).outputs = { ...mixer(d).outputs, 'st2110-out': 1 }), 'outputs: ST 2110 program output (st2110-out, 1 copy) needs ST 2110 (st2110)'],
  ['MoQ source', (d) => (mixer(d).inputs = { ...mixer(d).inputs, 'moq-src': 2 }), 'inputs: MoQ source (moq-src, 2 copies) needs MoQ (moq)'],
  ['speech-to-text', (d) => (mixer(d).features = { captions: true, 'captions.asr': true }), 'features: AI speech-to-text (captions.asr) needs Speech-to-text (asr)'],
  ['neural key', (d) => (group(mixer(d), 'mxl-src_2.key').type = 'neural'), 'mxl-src_2.key.type: neural needs Neural key (neural-key)'],
  ['AI background removal', (d) => (mixer(d).features = { 'ai-segment': true }), 'features: AI background removal (ai-segment) needs AI background removal (ai-segment)'],
  ['SCTE-104', (d) => (mixer(d).features = { scte35: true, 'scte35.scte104': true }), 'features: SCTE-104 on MXL (scte35.scte104) needs SCTE-104 (scte104)'],
  [
    'SRT listener output',
    (d) => {
      mixer(d).outputs = { ...mixer(d).outputs, 'srt-out': 1 }
      group(mixer(d), 'srt-out.srt').mode = 'listener'
    },
    'srt-out.srt.mode: listener needs SRT listener output (srt-listener-out)',
  ],
  ['a GPU', (d) => (mixer(d).resources = { cpu: 2, memoryMiB: 4096, gpu: { class: 'nvidia-l4', count: 1 } }), 'resources.gpu: 1 × nvidia-l4 needs GPU (gpu)'],
]

describe('with facility local', () => {
  test('the reference workload publishes: it uses nothing the facility lacks', () => {
    assert.deepEqual(publishProblems(studioA(catalog), catalog, LOCAL), [])
  })
  for (const [what, select, text] of GATED)
    test(`${what} is a publish problem naming it`, () => {
      const doc = studioA(catalog)
      select(doc)
      const found = notOffered(publishProblems(doc, catalog, LOCAL))
      assert.deepEqual(found, [`vision-mixer: ${text}, which facility local doesn't offer`])
    })
  test('an SRT caller output is offered (srt-caller-out is true)', () => {
    const doc = studioA(catalog)
    mixer(doc).outputs = { ...mixer(doc).outputs, 'srt-out': 1 }
    assert.deepEqual(notOffered(publishProblems(doc, catalog, LOCAL)), [])
  })
  test('a capability the facility file leaves out is one it lacks', () => {
    const doc = studioA(catalog)
    const { mxl: _mxl, ...rest } = LOCAL.capabilities!
    assert.ok(
      publishProblems(doc, catalog, { name: 'partial', capabilities: rest }).includes(
        "vision-mixer: inputs: MXL source (mxl-src, 3 copies) needs MXL (mxl), which facility partial doesn't offer",
      ),
    )
  })
  test('a function that is off needs nothing: the add-on of a function that is off is off', () => {
    const doc = studioA(catalog)
    mixer(doc).features = { captions: false, 'captions.asr': true }
    const prim = catalog.get('switchframe.1', '1.1.0')!
    assert.deepEqual(facilityProblems(prim, mixer(doc), LOCAL), [])
  })
})

describe('with no facility set', () => {
  for (const [what, select] of GATED)
    test(`${what} is offered`, () => {
      const doc = studioA(catalog)
      select(doc)
      assert.deepEqual(notOffered(publishProblems(doc, catalog, NONE)), [])
    })
  test('the reference workload publishes as before', () => {
    assert.deepEqual(publishProblems(studioA(catalog), catalog, NONE), [])
  })
})

describe('product limits, with or without a facility', () => {
  const withRtmp = (profile: string, copies = 1) => {
    const doc = studioA(catalog)
    mixer(doc).outputs = { ...mixer(doc).outputs, 'rtmp-out': copies }
    for (let k = 1; k <= copies; k++) group(mixer(doc), `${k === 1 ? 'rtmp-out' : `rtmp-out_${k}`}.rtmp`).url = 'rtmp://live.example.com/app'
    group(mixer(doc), 'engine.engine').colorProfile = profile
    return doc
  }
  const rtmpProblems = (doc: WorkloadDescription, facility: Facility) => publishProblems(doc, catalog, facility).filter((p) => p.includes('RTMP'))
  for (const facility of [LOCAL, NONE])
    for (const profile of ['standard-hevc', 'professional'])
      test(`RTMP with ${profile} (${facility.name ?? 'no facility'}) names the output and the profile`, () => {
        const problems = rtmpProblems(withRtmp(profile), facility)
        assert.equal(problems.length, 1)
        assert.match(problems[0], new RegExp(`^vision-mixer: rtmp-out: can't run with colour profile "${profile}": .*\\(engine\\.engine\\.colorProfile\\)$`))
      })
  test('each RTMP copy is named', () => {
    const problems = rtmpProblems(withRtmp('professional', 2), NONE)
    assert.deepEqual(
      problems.map((p) => p.split(':').slice(0, 2).join(':')),
      ['vision-mixer: rtmp-out', 'vision-mixer: rtmp-out_2'],
    )
  })
  test('RTMP with standard publishes', () => {
    assert.deepEqual(publishProblems(withRtmp('standard'), catalog, LOCAL), [])
  })
  test('the colour profile alone is fine without an RTMP output', () => {
    const doc = studioA(catalog)
    group(mixer(doc), 'engine.engine').colorProfile = 'professional'
    assert.deepEqual(publishProblems(doc, catalog, NONE), [])
  })
  // 720p with MXL (stage 7B): SwitchFrame's V210 path needs a width divisible by 6, and 1280 isn't.
  const select = (doc: WorkloadDescription, chosen: Parameters<typeof withSelection>[2]) => {
    const f = mixer(doc)
    const { kind: _kind, ...next } = withSelection({ kind: 'fn', ...f, settings: f.settings ?? {} } as FnData, catalog.get('switchframe.1')!, chosen)
    Object.assign(f, next)
  }
  // The reference workload at 720p, or with the cameras' wires gone and SRT in their place.
  const at720 = (mxl: { src: boolean; out: boolean }) => {
    const doc = studioA(catalog)
    if (!mxl.src) {
      select(doc, { inputs: { 'mxl-src': 0, 'srt-src': 1 } })
      doc.spec.externals.push({ id: 'remote', kind: 'source', name: 'Remote', reference: { kind: 'srt', value: 'remote-a' } })
      doc.spec.wires = [...doc.spec.wires.filter((w) => !w.to.startsWith('vision-mixer/')), { from: 'remote/stream', to: 'vision-mixer/srt-src.in.video' }]
      group(mixer(doc), 'srt-src.srt').streamId = 'remote-a'
      group(mixer(doc), 'srt-src.payload.pathA').bitrateMbps = 20
      group(mixer(doc), 'engine.engine').onAirAtStart = 'srt-src'
    }
    if (!mxl.out) {
      select(doc, { outputs: { 'mxl-out': 0, 'srt-out': 1 } })
      Object.assign(group(mixer(doc), 'srt-out.srt'), { address: 'cdn.example.net', port: 9000 })
    }
    group(mixer(doc), 'engine.engine').resolution = '1280x720'
    return doc
  }
  const v210 = (doc: WorkloadDescription, facility: Facility = NONE) => publishProblems(doc, catalog, facility).filter((p) => p.includes('V210'))
  const at720Problem = (copy: string) =>
    new RegExp(`^vision-mixer: ${copy}: can't run with resolution 1280x720: SwitchFrame's V210 path needs a frame width divisible by 6, .*\\(engine\\.engine\\.resolution\\)$`)
  for (const facility of [LOCAL, NONE])
    test(`720p with MXL sources is refused, each source named (${facility.name ?? 'no facility'})`, () => {
      const problems = v210(at720({ src: true, out: false }), facility)
      assert.equal(problems.length, 3)
      ;['mxl-src', 'mxl-src_2', 'mxl-src_3'].forEach((copy, i) => assert.match(problems[i], at720Problem(copy)))
    })
  test('720p with MXL output alone is refused', () => {
    const problems = v210(at720({ src: false, out: true }))
    assert.equal(problems.length, 1)
    assert.match(problems[0], at720Problem('mxl-out'))
  })
  test('720p without MXL publishes', () => {
    assert.deepEqual(publishProblems(at720({ src: false, out: false }), catalog, LOCAL), [])
  })
  test('a dmf-mxl source at 720p is not refused: only the switcher can\'t read it', () => {
    const doc = at720({ src: false, out: false })
    for (const id of ['cam1', 'cam2']) group(doc.spec.functions.find((f) => f.id === id)!, 'mxl.format.video').frameSize = '1280x720'
    assert.deepEqual(v210(doc), [])
  })
  const ranges: [string, string, number, string][] = [
    ['EQ low frequency', 'mxl-src.audio.eq.low', 50, 'frequencyHz: must be ≥ 80'],
    ['EQ mid frequency', 'mxl-src.audio.eq.mid', 9000, 'frequencyHz: must be ≤ 8000'],
    ['EQ high frequency', 'mxl-src.audio.eq.high', 18000, 'frequencyHz: must be ≤ 16000'],
    ['EQ gain', 'mxl-src.audio.eq.low', 15, 'gainDb: must be ≤ 12'],
    ['EQ Q', 'mxl-src.audio.eq.mid', 0.2, 'q: must be ≥ 0.5'],
    ['limiter threshold', 'audio.master.limiter', -20, 'thresholdDb: must be ≥ -12'],
    ['limiter ceiling', 'audio.master.limiter', -6, 'ceilingDb: must be ≥ -3'],
  ]
  for (const [what, path, value, message] of ranges)
    test(`${what} follows the mixer's range`, () => {
      const doc = studioA(catalog)
      const field = message.split(':')[0]
      const g = group(mixer(doc), path)
      if (path.includes('.eq.')) g.enabled = true
      g[field] = value
      assert.ok(publishProblems(doc, catalog, NONE).includes(`vision-mixer: ${path}.${message}`), `${path}.${message}`)
    })
})

describe('the server', () => {
  const servers: Server[] = []
  const start = async (facility?: Facility) => {
    const store = new Store(':memory:')
    for (const id of ['switchframe', 'dmf-mxl']) store.importCatalog(JSON.parse(readFileSync(new URL(`../catalogs/${id}.catalog.json`, import.meta.url), 'utf8')) as ModuleCatalog)
    const server = createServer(createApp(store, { facility }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  }
  let withFacility = ''
  let without = ''
  before(async () => {
    withFacility = await start(LOCAL)
    without = await start()
  })
  after(() => servers.forEach((s) => s.close()))

  test('GET /api/facility: the name and capabilities, or {} with none set', async () => {
    assert.deepEqual(await (await fetch(`${withFacility}/facility`)).json(), LOCAL)
    assert.deepEqual(await (await fetch(`${without}/facility`)).json(), {})
  })
  test('a saved workload using a neural key: saved, but 422 naming it on this facility, published without one', async () => {
    const doc = studioA(catalog)
    group(mixer(doc), 'mxl-src.key').type = 'neural'
    for (const base of [withFacility, without]) {
      const put = await fetch(`${base}/workloads/studio-a?baseRevision=0`, { method: 'PUT', body: JSON.stringify(doc) })
      assert.equal(put.status, 200, 'saving is allowed: it is a draft')
    }
    for (const route of ['published', 'published.xml']) {
      const res = await fetch(`${withFacility}/workloads/studio-a/${route}`)
      assert.equal(res.status, 422)
      const body = (await res.json()) as { details: string[] }
      assert.deepEqual(notOffered(body.details), ["vision-mixer: mxl-src.key.type: neural needs Neural key (neural-key), which facility local doesn't offer"])
      assert.equal((await fetch(`${without}/workloads/studio-a/${route}`)).status, 200)
    }
  })
})
