// Switchframe settings whose values follow the product's request bodies (checked against its source).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { productCatalog, studioA } from '../scripts/fixtures/studio-a'
import type { JsonValue, WorkloadDescription } from '../src/model/types'
import { publishProblems, withSelection } from '../src/model/workload'

const catalog = productCatalog()
const switchframe = catalog.get('switchframe.1')!
type Groups = { [k: string]: { [k: string]: { [k: string]: JsonValue } } }
// studio-a with the vision mixer's selection changed and one group edited.
function withMixer(sel: Parameters<typeof withSelection>[2], edit: (p: Groups) => void): WorkloadDescription {
  const doc = studioA(catalog)
  const i = doc.spec.functions.findIndex((f) => f.id === 'vision-mixer')
  const f = doc.spec.functions[i]
  const next = withSelection({ kind: 'fn', ...f, settings: f.settings ?? {} }, switchframe, sel)
  edit(next.parameters as Groups)
  const { kind: _k, ...fn } = next
  doc.spec.functions[i] = { ...f, ...fn }
  return doc
}
const mine = (doc: WorkloadDescription, text: string) => publishProblems(doc, catalog).filter((p) => p.includes(text))

describe('SRT caller address is host:port (the compiler\'s HOST_PORT)', () => {
  const caller = (address: string) =>
    withMixer({ inputs: { 'mxl-src': 3, 'srt-src': 1 } }, (p) => {
      Object.assign(p['srt-src'].srt, { mode: 'caller', address, streamId: 'cam9' })
      Object.assign(p['srt-src'].payload, { pathA: { bitrateMbps: 20 } })
    })
  for (const ok of ['venue.example.net:9000', '10.0.0.7:7001', 'cam-9:1', '[2001:db8::7]:9000'])
    test(`accepts ${ok}`, () => assert.deepEqual(mine(caller(ok), 'srt-src.srt.address'), []))
  for (const bad of ['venue.example.net', 'srt://venue:9000', 'venue:', ':9000', 'venue:123456', 'ven ue:9000'])
    test(`refuses ${JSON.stringify(bad)}`, () =>
      assert.deepEqual(mine(caller(bad), 'srt-src.srt.address'), ['vision-mixer: srt-src.srt.address: must be host:port']))
})

describe('SCTE-35 default rule is pass or drop', () => {
  const rule = (r: string) => withMixer({ features: { scte35: true } }, (p) => (p.scte35.scte35.defaultRule = r))
  test('offers pass and drop', () =>
    assert.deepEqual((switchframe.parameters.schema.properties!.scte35.properties!.scte35.properties!.defaultRule.enum), ['pass', 'drop']))
  for (const ok of ['pass', 'drop']) test(`accepts ${ok}`, () => assert.deepEqual(mine(rule(ok), 'defaultRule'), []))
  test('refuses rewrite', () => assert.deepEqual(mine(rule('rewrite'), 'defaultRule'), ['vision-mixer: scte35.scte35.defaultRule: must be one of pass, drop']))
})

describe('recording rotates at least every minute', () => {
  const rotate = (n: number) => withMixer({ features: { recording: true } }, (p) => (p.recording.recording.rotateAfterMinutes = n))
  test('refuses 0', () => assert.deepEqual(mine(rotate(0), 'rotateAfterMinutes'), ['vision-mixer: recording.recording.rotateAfterMinutes: must be ≥ 1']))
  for (const ok of [1, 60, 1440]) test(`accepts ${ok}`, () => assert.deepEqual(mine(rotate(ok), 'rotateAfterMinutes'), []))
})
