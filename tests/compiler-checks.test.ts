// Every value the orchestrator's compiler refuses is refused at publish too (R8.9), naming the same
// parameter path, so a design built only from offered options deploys. One test per check, plus what
// each check still accepts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { productCatalog, studioA } from '../scripts/fixtures/studio-a'
import type { Facility, JsonValue, WorkloadDescription } from '../src/model/types'
import { publishProblems, toPublished, withSelection } from '../src/model/workload'
import { CASES, type Toolkit } from './compiler-cases'

const catalog = productCatalog()
const toolkit: Toolkit = { catalog, studioA, withSelection }
const LOCAL: Facility = {
  name: 'local',
  capabilities: Object.fromEntries(['mxl', 'srt-in', 'srt-caller-out', 'rtmp-out', 'recording'].map((c) => [c, true])),
  limits: { maxRecordingGiB: 200, functionsPerWorkload: { 'switchframe.1': { min: 1, max: 1 } }, domainsPerWorkload: 1 },
}
const mixer = (d: WorkloadDescription) => d.spec.functions.find((f) => f.id === 'vision-mixer')!
type Groups = { [k: string]: { [k: string]: { [k: string]: JsonValue } } }
const params = (d: WorkloadDescription) => mixer(d).parameters as Groups

describe('each check refuses at publish, with the compiler\'s parameter path', () => {
  for (const c of CASES)
    test(`${c.name}: ${c.check}`, () => {
      const doc = c.build(toolkit)
      // stage 7A published it with facility local: the new problems are all this check's
      const problems = publishProblems(doc, catalog, LOCAL)
      assert.ok(problems.includes(c.problem), problems.join('\n'))
      assert.deepEqual(problems.filter((p) => !c.also?.includes(p) && !p.startsWith(c.problem.slice(0, c.problem.indexOf(': ', 'vision-mixer: '.length)).replace(/_\d+$/, ''))), [])
      // a check that needs a facility is skipped without one; the others apply either way
      assert.equal(publishProblems(doc, catalog, {}).includes(c.problem), !c.facility)
    })
  test('the reference workload passes every check', () => assert.deepEqual(publishProblems(studioA(catalog), catalog, LOCAL), []))
})

describe('what the checks still accept', () => {
  const with_ = (name: string, edit: (d: WorkloadDescription) => void) => {
    const doc = CASES.find((c) => c.name === name)!.build(toolkit)
    edit(doc)
    return publishProblems(doc, catalog, LOCAL)
  }
  const shape = (d: WorkloadDescription, facility: Facility) => publishProblems(d, catalog, facility).filter((p) => p.startsWith('workload: ') || p.includes(': domain: '))
  test('zero, one and two mixers against functionsPerWorkload {min: 1, max: 1}', () => {
    const none = CASES.find((c) => c.name === 'no-switchframe')!.build(toolkit)
    const two = CASES.find((c) => c.name === 'switchframe-count')!.build(toolkit)
    assert.deepEqual(shape(none, LOCAL), ['workload: functions: needs exactly one switchframe.1 function, has 0; limits.functionsPerWorkload of facility local'])
    assert.deepEqual(shape(studioA(catalog), LOCAL), [])
    assert.deepEqual(shape(two, LOCAL), ['workload: functions: needs exactly one switchframe.1 function, has 2 (mixer-b, vision-mixer); limits.functionsPerWorkload of facility local'])
  })
  test('other ranges are worded as the compiler does', () => {
    const two = CASES.find((c) => c.name === 'switchframe-count')!.build(toolkit)
    const range = (min: number | undefined, max: number | undefined) =>
      shape(two, { ...LOCAL, limits: { functionsPerWorkload: { 'dmf-mxl.1': { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } } } })
    assert.deepEqual(range(0, 1), ['workload: functions: needs at most one dmf-mxl.1 function, has 2 (cam1, cam2); limits.functionsPerWorkload of facility local'])
    assert.deepEqual(range(3, undefined), ['workload: functions: needs at least three dmf-mxl.1 function, has 2 (cam1, cam2); limits.functionsPerWorkload of facility local'])
    assert.deepEqual(range(3, 5), ['workload: functions: needs between three and five dmf-mxl.1 function, has 2 (cam1, cam2); limits.functionsPerWorkload of facility local'])
    assert.deepEqual(range(1, 2), [])
  })
  test('two domains against domainsPerWorkload 1', () => {
    const doc = CASES.find((c) => c.name === 'two-domains')!.build(toolkit)
    assert.deepEqual(shape(doc, LOCAL), ['workload: domains: needs exactly one MXL domain, has 2: aux, main; limits.domainsPerWorkload of facility local'])
    assert.deepEqual(shape(doc, { ...LOCAL, limits: { ...LOCAL.limits, domainsPerWorkload: 2 } }), [])
  })
  test("a function outside the workload's domain (an imported document) is named", () => {
    const doc = studioA(catalog)
    doc.spec.functions.find((f) => f.id === 'cam2')!.domain = 'aux'
    assert.deepEqual(shape(doc, LOCAL), ['cam2: domain: "aux" is not the workload\'s domain "main"'])
  })
  test('with no facility none of the shape limits apply', () => {
    for (const name of ['no-switchframe', 'switchframe-count', 'two-domains'])
      assert.deepEqual(shape(CASES.find((c) => c.name === name)!.build(toolkit), {}), [], name)
  })
  test('test sources have no count limit', () => {
    const doc = studioA(catalog)
    doc.spec.functions.push({ ...structuredClone(doc.spec.functions.find((f) => f.id === 'cam1')!), id: 'cam3', name: 'Camera 3' })
    assert.deepEqual(publishProblems(doc, catalog, LOCAL), [])
  })
  test('MXL sources at the engine format', () => assert.deepEqual(with_('mxl-format', (d) => (params(d).engine.engine.rate = '29.97')), []))
  test('MXL audio must be 48 kHz stereo: 8 channels from the workload defaults are refused on every MXL flow', () => {
    const doc = studioA(catalog)
    doc.spec.defaults = structuredClone(doc.spec.defaults) // studio-a shares DEFAULTS
    doc.spec.defaults.audio.channelCount = 8 // what the mixer's programme audio follows
    ;(doc.spec.functions.find((f) => f.id === 'cam1')!.parameters as Groups).mxl.format = {
      ...((doc.spec.functions.find((f) => f.id === 'cam1')!.parameters as Groups).mxl.format as object),
      audio: { channels: 8 }, // a test source's own audio format
    }
    assert.deepEqual(publishProblems(doc, catalog, LOCAL), [
      'vision-mixer: mxl-src: flow cam1/mxl.audio channel count is 8, must be 2',
      'vision-mixer: mxl-out: flow vision-mixer/mxl-out.audio channel count is 8, must be 2',
    ])
  })
  test('distinct SRT stream IDs', () => assert.deepEqual(with_('srt-streamid-unique', (d) => (params(d)['srt-src_2'].srt.streamId = 'venue2')), []))
  test('a 128-byte label', () => assert.deepEqual(with_('label-bytes', (d) => ((params(d)['mxl-src'].source as { label: string }).label = 'é'.repeat(64))), []))
  for (const address of ['cdn.example.com', '10.0.0.7', '[2001:db8::7]'])
    test(`SRT output address ${address}`, () => assert.deepEqual(with_('srt-out-address', (d) => (params(d)['srt-out'].srt.address = address)), []))
  for (const url of ['rtmp://live.example.com/app', 'rtmps://live.example.com/app'])
    test(`RTMP URL ${url}`, () => assert.deepEqual(with_('rtmp-url', (d) => (params(d)['rtmp-out'].rtmp.url = url)), []))
  for (const prefix of ['program', 'studio-a_1.take'])
    test(`recording prefix ${prefix}`, () => assert.deepEqual(with_('recording-prefix', (d) => (params(d).recording.recording.filenamePrefix = prefix)), []))
  for (const bad of ['-x', 'a/b', 'x'.repeat(65), 'a..b'])
    test(`recording prefix ${JSON.stringify(bad)} is refused`, () =>
      assert.ok(with_('recording-prefix', (d) => (params(d).recording.recording.filenamePrefix = bad)).some((p) => p.startsWith('vision-mixer: recording.recording.filenamePrefix: '))))
  test('recording at the facility limit', () => assert.deepEqual(with_('recording-size', (d) => (params(d).recording.recording.storageGiB = 200)), []))
  for (const hook of ['', 'https://hooks.example.com/scte35', 'http://10.0.0.7/x'])
    test(`SCTE-35 webhook ${JSON.stringify(hook)}`, () => assert.deepEqual(with_('scte35-webhook', (d) => (params(d).scte35.scte35.webhookUrl = hook)), []))
  test('CPU 0.5 and 512 MiB', () => assert.deepEqual(with_('cpu', (d) => (mixer(d).resources = { cpu: 0.5, memoryMiB: 512 })), []))
  test('a test source may have 256 MiB: the limit is the product\'s', () =>
    assert.deepEqual(with_('cpu', (d) => {
      mixer(d).resources = { cpu: 2, memoryMiB: 4096 }
      d.spec.functions.find((f) => f.id === 'cam1')!.resources = { cpu: 0.25, memoryMiB: 256 }
    }), []))
  test('extraArgs as strings', () => assert.deepEqual(with_('extra-args-demo', (d) => (mixer(d).settings = { extraArgs: ['--log-level=debug'], other: 1 })), []))
  for (const demo of ['-demo', '--demo-video', '--demo=2'])
    test(`extraArgs ${demo} is refused`, () =>
      assert.ok(with_('extra-args-demo', (d) => (mixer(d).settings = { extraArgs: [demo] })).includes(`vision-mixer: settings.extraArgs: "${demo}" is refused: demo mode replaces the workload's sources`)))
  test('extraArgs items that aren\'t text are refused at the list', () =>
    assert.ok(with_('extra-args-demo', (d) => (mixer(d).settings = { extraArgs: ['--x', 2] })).includes('vision-mixer: settings.extraArgs: 2 must be text')))
})

describe('key fill source is an input copy of the function', () => {
  const fill = (v: string | undefined) => {
    const doc = CASES.find((c) => c.name === 'key-fill-source')!.build(toolkit)
    const key = params(doc)['mxl-src'].key
    if (v === undefined) delete key.fillSource
    else key.fillSource = v
    return doc
  }
  for (const v of ['mxl-src', 'mxl-src_3', '', undefined])
    test(`accepts ${JSON.stringify(v)}`, () => assert.deepEqual(publishProblems(fill(v), catalog, LOCAL), []))
  test('empty means this source: it is not resolved to the first copy when published', () => {
    const published = toPublished(fill(undefined), 1, catalog)
    assert.equal((params(published)['mxl-src'].key as { fillSource?: string }).fillSource, undefined)
  })
  test('offered as a choice of the input copies, empty labelled "This source"', () => {
    const s = catalog.get('switchframe.1')!.parameters.schema.properties!['mxl-src'].properties!.key.properties!.fillSource
    assert.equal(s['x-options'], 'inputs')
    assert.equal(s['x-emptyLabel'], 'This source')
  })
})
