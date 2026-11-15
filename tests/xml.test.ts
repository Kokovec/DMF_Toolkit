// The XML handover format: schema copy, encoding, refusals, determinism and round trips.
// Run: npm test. Validates against the XSD with xmllint when it's installed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { productCatalog, studioA } from '../scripts/fixtures/studio-a'
import { everyValue } from '../scripts/fixtures/every-value'
import { FIXTURES, fixtureFiles } from '../scripts/fixtures/write-xml'
import { ORCHESTRATOR } from './orchestrator'
import type { JsonValue, WorkloadDescription } from '../src/model/types'
import { publishProblems, toPublished } from '../src/model/workload'
import { decimal, fromWorkloadXml, toWorkloadXml, XmlEncodeError } from '../src/model/xml'

const XSD = new URL('../schemas/dmf-workload-v1.xsd', import.meta.url)
// sha256 of DMF_Orchestrator/schemas/dmf-workload-v1.xsd (the source of truth) this copy must equal.
const XSD_SHA256 = '95d86535c074e423fedb39f6cf5dbdc3b3e08d0d61a18dbda0853aa5bf5f53b2'

const hasXmllint = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// Validates against the XSD; returns xmllint's verdict.
function validate(xml: string): string {
  try {
    return execFileSync('xmllint', ['--noout', '--schema', XSD.pathname, '-'], { input: xml, stdio: ['pipe', 'pipe', 'pipe'] }).toString() || '- validates'
  } catch (e) {
    const err = e as { stderr?: Buffer }
    throw new Error(`XSD validation failed:\n${err.stderr?.toString()}`)
  }
}

const catalog = productCatalog()
const publishedStudioA = () => toPublished(studioA(catalog), 1, catalog)
// The published JSON as the orchestrator gets it over HTTP.
const asSent = (doc: WorkloadDescription) => JSON.parse(JSON.stringify(doc))

describe('checked-in fixtures (shared with the compiler)', () => {
  for (const f of FIXTURES)
    test(`${f.name}: .workload.xml and .published.json are current`, () => {
      const { xml, json } = fixtureFiles(f)
      assert.equal(readFileSync(f.xml, 'utf8'), xml)
      assert.equal(readFileSync(f.json, 'utf8'), json)
    })
})

describe('schema copy', () => {
  test('is byte-identical to the recorded source (sha256)', () => {
    assert.equal(createHash('sha256').update(readFileSync(XSD)).digest('hex'), XSD_SHA256)
  })
  const source = `${ORCHESTRATOR}/schemas/dmf-workload-v1.xsd`
  test('equals the orchestrator repo copy, when visible', { skip: !existsSync(source) && `no orchestrator checkout at ${ORCHESTRATOR} (set DMF_ORCHESTRATOR)` }, () => {
    assert.deepEqual(readFileSync(source), readFileSync(XSD))
  })
})

describe('studio-a', () => {
  test('publishes with no problems', () => assert.deepEqual(publishProblems(studioA(catalog), catalog), []))
  test('validates against the XSD', { skip: !hasXmllint && 'xmllint not installed' }, () => {
    validate(toWorkloadXml(publishedStudioA()))
  })
  test('the validator rejects a document the schema refuses', { skip: !hasXmllint && 'xmllint not installed' }, () => {
    const broken = toWorkloadXml(publishedStudioA()).replace(/<parameters>[\s\S]*?<\/parameters>/, '')
    assert.throws(() => validate(broken), /XSD validation failed[\s\S]*fails to validate/)
  })
  test('is deterministic', () => assert.equal(toWorkloadXml(publishedStudioA()), toWorkloadXml(publishedStudioA())))
  test('round trip JSON -> XML -> JSON is deep-equal', () => {
    const json = asSent(publishedStudioA())
    assert.deepStrictEqual(fromWorkloadXml(toWorkloadXml(json)), json)
  })
  test('has no data flow and the example flow ids', () => {
    const flows = publishedStudioA().spec.flows!
    assert.equal(flows.length, 8)
    assert.ok(flows.every((f) => f.essence !== 'data'))
    assert.equal(flows.find((f) => f.writer === 'vision-mixer/mxl-out.video')!.id, '7bc1d998-ac05-5b73-bed3-f61352d6515e')
  })
})

describe('every value type', () => {
  test('is publishable', () => assert.deepEqual(publishProblems(everyValue(catalog), catalog), []))
  test('validates against the XSD', { skip: !hasXmllint && 'xmllint not installed' }, () => {
    validate(toWorkloadXml(toPublished(everyValue(catalog), 3, catalog)))
  })
  test('round trip JSON -> XML -> JSON is deep-equal (in memory and over JSON)', () => {
    const published = toPublished(everyValue(catalog), 3, catalog)
    assert.ok(published.spec.functions.every((f) => !('flowOptions' in f)), 'flowOptions are not published')
    assert.deepStrictEqual(fromWorkloadXml(toWorkloadXml(published)), published) // in memory: keeps -0
    const json = asSent(published)
    assert.deepStrictEqual(fromWorkloadXml(toWorkloadXml(json)), json)
  })
  test('secrets carry only their name', () => {
    const xml = toWorkloadXml(toPublished(everyValue(catalog), 3, catalog))
    assert.match(xml, /<value path="srt-out\.srt\.passphrase" type="secret">cdn-srt<\/value>/)
    assert.match(xml, /<value path="rtmp-out\.rtmp\.streamKey" type="secret">stream-key<\/value>/)
    assert.match(xml, /<value path="secretRef" type="secret">vendor-token<\/value>/)
    assert.doesNotMatch(xml, /\$secret/)
  })
  test('a secret field holding a value instead of a reference is refused before XML', () => {
    const doc = everyValue(catalog)
    const p = doc.spec.functions.find((f) => f.id === 'vision-mixer')!.parameters as { [k: string]: { [k: string]: { [k: string]: JsonValue } } }
    p['srt-out'].srt.passphrase = 'hunter2'
    assert.ok(publishProblems(doc, catalog).some((e) => e.includes('srt-out.srt.passphrase: must be a secret reference')))
  })
  test('numbers have no exponent', () => {
    assert.equal(decimal(1e-7), '0.0000001')
    assert.equal(decimal(1.2345e-12), '0.0000000000012345')
    assert.equal(decimal(1e21), '1000000000000000000000')
    assert.equal(decimal(-1.5e22), '-15000000000000000000000')
    assert.equal(decimal(-0), '-0')
  })
})

describe('refusals name the location', () => {
  const refusal = (mutate: (doc: WorkloadDescription) => void): string[] => {
    const doc = structuredClone(publishedStudioA())
    mutate(doc)
    try {
      toWorkloadXml(doc)
    } catch (e) {
      assert.ok(e instanceof XmlEncodeError)
      return e.problems
    }
    assert.fail('expected a refusal')
  }
  const vm = (d: WorkloadDescription) => d.spec.functions.find((f) => f.id === 'vision-mixer')!
  test('a control character', () =>
    assert.deepEqual(
      refusal((d) => ((vm(d).parameters['mxl-src'] as { source: { label: string } }).source.label = 'Cam\u0007 1')),
      ["functions[vision-mixer].parameters.mxl-src.source.label: contains U+0007, which XML 1.0 can't carry"],
    ))
  test('a lone surrogate and U+FFFE', () =>
    assert.deepEqual(
      refusal((d) => (vm(d).settings = { a: '\ud800', b: '￾' })),
      ["functions[vision-mixer].settings.a: contains U+D800, which XML 1.0 can't carry", "functions[vision-mixer].settings.b: contains U+FFFE, which XML 1.0 can't carry"],
    ))
  test('a key with a dot, an empty key, a key beside $secret', () =>
    assert.deepEqual(
      refusal((d) => (vm(d).settings = { 'a.b': 1, '': 2, x: { $secret: 's', other: 1 } })),
      [
        'functions[vision-mixer].settings: key "a.b" can\'t be encoded (keys must match ^[A-Za-z0-9_-]+$)',
        'functions[vision-mixer].settings: key "" can\'t be encoded (keys must match ^[A-Za-z0-9_-]+$)',
        'functions[vision-mixer].settings.x: key "$secret" can\'t be encoded (keys must match ^[A-Za-z0-9_-]+$)',
      ],
    ))
  test('ids, tokens and counts the schema refuses', () =>
    assert.deepEqual(
      refusal((d) => {
        d.metadata.id = 'studio.a'
        vm(d).domain = 'main '
        d.spec.defaults.mxl = { historyMs: 0 }
      }),
      [
        'workload@id: "studio.a" isn\'t a valid id (^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$)',
        'spec.defaults.mxl@historyMs: must be a whole number ≥ 1 (is 0)',
        'functions[vision-mixer]@domain: "main " has leading, trailing, repeated or non-space whitespace, which XML carries only as a collapsed token',
      ],
    ))
})
