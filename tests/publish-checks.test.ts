// What publishing requires beyond the model: everything the XML has to carry (so the JSON route, the
// XML route and the canvas agree), instance ids the schema accepts, and MXL history of at least 1 ms.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { productCatalog, studioA } from '../scripts/fixtures/studio-a'
import type { JsonValue, WorkloadDescription } from '../src/model/types'
import { checkWorkload, nextNodeId, publishProblems, toInstanceId } from '../src/model/workload'
import { toWorkloadXml, XmlEncodeError } from '../src/model/xml'
import { toPublished } from '../src/model/workload'

const catalog = productCatalog()
const mixer = (d: WorkloadDescription) => d.spec.functions.find((f) => f.id === 'vision-mixer')!
const xmlRefusal = (d: WorkloadDescription): string[] => {
  try {
    toWorkloadXml(toPublished(d, 1, catalog))
    return []
  } catch (e) {
    return (e as XmlEncodeError).problems
  }
}

describe("1. XML encodability is a publish problem, with the serialiser's location text", () => {
  const cases: [string, (d: WorkloadDescription) => void][] = [
    ['a character XML 1.0 lacks', (d) => ((mixer(d).parameters['mxl-src'] as { source: { [k: string]: JsonValue } }).source.label = 'Cam\u0007 1')],
    ['an unencodable key', (d) => (mixer(d).settings = { extraArgs: [], 'a.b': true })],
    ['an xs:token not in normal form', (d) => (mixer(d).domain = 'main  studio')],
  ]
  for (const [name, mutate] of cases)
    test(name, () => {
      const doc = studioA(catalog)
      mutate(doc)
      const xml = xmlRefusal(doc)
      assert.ok(xml.length >= 1)
      assert.deepEqual(publishProblems(doc, catalog), xml)
      console.log(`    ${name}: ${xml.join(' | ')}`)
    })
  test('a valid workload has none', () => assert.deepEqual(publishProblems(studioA(catalog), catalog), []))
})

describe('2. Instance ids match the schema, checked on save', () => {
  const bad = ['studio.a', 'studio_a', '-studio', 'studio-', 'Studio', 'a'.repeat(43)]
  for (const id of bad)
    test(`workload id ${JSON.stringify(id.length > 20 ? `${id.slice(0, 8)}… (${id.length})` : id)} is refused by checkWorkload`, () => {
      const doc = studioA(catalog)
      doc.metadata.id = id
      const problems = checkWorkload(doc, catalog)
      assert.ok(problems.some((p) => p.startsWith(`workload id "${id}" must be`)), problems.join('; '))
    })
  test('function and external ids too', () => {
    const doc = studioA(catalog)
    doc.spec.functions[0].id = 'cam_1'
    doc.spec.externals = [{ id: 'cdn.a', kind: 'destination', name: 'CDN' }]
    const problems = checkWorkload(doc, catalog)
    assert.ok(problems.some((p) => p.startsWith('function id "cam_1" must be')))
    assert.ok(problems.some((p) => p.startsWith('external device id "cdn.a" must be')))
  })
  test('42 characters is allowed', () => {
    const doc = studioA(catalog)
    doc.metadata.id = `a${'-'.repeat(40)}b`
    assert.ok(!checkWorkload(doc, catalog).some((p) => p.startsWith('workload id')))
  })
  test('nextNodeId only makes valid ids', () => {
    const re = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/
    const made = ['switchframe', 'Switchframe Pro_2', 'very-long-product-name-that-goes-on', '---', '', 'cam', '9to5', 'x'.repeat(60)].map((b) => nextNodeId(b, []))
    for (const id of made) assert.match(id, re)
    assert.equal(nextNodeId('cam', ['cam-1', 'cam-2']), 'cam-3')
    assert.equal(nextNodeId('x'.repeat(60), Array.from({ length: 9 }, (_, i) => `${'x'.repeat(40)}-${i + 1}`)), `${'x'.repeat(39)}-10`)
    console.log(`    made: ${made.join(', ')}`)
  })
  test('the workload id field keeps only allowed characters', () => {
    assert.equal(toInstanceId('Studio A_v2.final'), 'studio-a-v2-final')
    assert.equal(toInstanceId('x'.repeat(50)).length, 42)
  })
})

describe('3. MXL history is at least 1 ms', () => {
  for (const v of [0, -5, 2.5])
    test(`workload default historyMs ${v} is refused`, () => {
      const doc = studioA(catalog)
      doc.spec.defaults.mxl = { historyMs: v }
      assert.deepEqual(publishProblems(doc, catalog), ['spec.defaults.mxl.historyMs: must be a whole number ≥ 1'])
    })
  test('a flow option historyMs of 0 is refused', () => {
    const doc = studioA(catalog)
    mixer(doc).flowOptions = { 'mxl-out.video': { historyMs: 0 } }
    assert.deepEqual(publishProblems(doc, catalog), ['vision-mixer: flow mxl-out.video: historyMs must be a whole number ≥ 1'])
  })
  test('1 is accepted', () => {
    const doc = studioA(catalog)
    doc.spec.defaults.mxl = { historyMs: 1 }
    mixer(doc).flowOptions = { 'mxl-out.video': { historyMs: 1 } }
    assert.deepEqual(publishProblems(doc, catalog), [])
  })
})
