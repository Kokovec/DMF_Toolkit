// GET /api/workloads/:id/published.xml against a server on an in-memory database.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../server/app'
import { Store } from '../server/db'
import { studioA } from '../scripts/fixtures/studio-a'
import type { JsonValue, ModuleCatalog, WorkloadDescription } from '../src/model/types'
import { fromWorkloadXml } from '../src/model/xml'

let server: Server
let base = ''
before(async () => {
  const store = new Store(':memory:')
  for (const id of ['switchframe', 'dmf-mxl']) store.importCatalog(JSON.parse(readFileSync(new URL(`../catalogs/${id}.catalog.json`, import.meta.url), 'utf8')) as ModuleCatalog)
  server = createServer(createApp(store))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(() => server.close())

const put = async (doc: WorkloadDescription, baseRevision: number) =>
  (await (await fetch(`${base}/workloads/${doc.metadata.id}?baseRevision=${baseRevision}`, { method: 'PUT', body: JSON.stringify(doc) })).json()) as { revision: number }
const get = (path: string) => fetch(`${base}${path}`)
const mixer = (doc: WorkloadDescription) => doc.spec.functions.find((f) => f.id === 'vision-mixer')!

describe('published.xml', () => {
  test('serves the published revision as XML, the same bytes every time', async () => {
    const { revision } = await put(studioA(), 0)
    const a = await get(`/workloads/studio-a/published.xml?revision=${revision}`)
    assert.equal(a.status, 200)
    assert.equal(a.headers.get('content-type'), 'application/xml; charset=utf-8')
    const xml = await a.text()
    assert.equal(await (await get('/workloads/studio-a/published.xml')).text(), xml)
    const json = await (await get(`/workloads/studio-a/published?revision=${revision}`)).json()
    assert.deepStrictEqual(fromWorkloadXml(xml), json)
  })
  test('an unpublishable revision gives the same 422 as the JSON route', async () => {
    const doc = studioA()
    doc.metadata.id = 'no-director'
    delete doc.spec.access
    await put(doc, 0)
    const [x, j] = await Promise.all([get('/workloads/no-director/published.xml'), get('/workloads/no-director/published')])
    assert.equal(x.status, 422)
    assert.equal(j.status, 422)
    assert.deepEqual(await x.json(), await j.json())
  })
  test("the JSON route refuses what the XML can't carry, with the same 422", async () => {
    const doc = studioA()
    doc.metadata.id = 'agree'
    mixer(doc).settings = { extraArgs: [], 'a.b': true }
    await put(doc, 0)
    const [x, j] = await Promise.all([get('/workloads/agree/published.xml'), get('/workloads/agree/published')])
    assert.equal(x.status, 422)
    assert.equal(j.status, 422)
    assert.deepEqual(await x.json(), await j.json())
  })
  test('a workload id the schema refuses is refused on save', async () => {
    const doc = studioA()
    doc.metadata.id = 'studio.a'
    const r = await fetch(`${base}/workloads/studio.a?baseRevision=0`, { method: 'PUT', body: JSON.stringify(doc) })
    assert.equal(r.status, 400)
    assert.match(((await r.json()) as { error: string }).error, /workload id must be lowercase letters, digits and -/)
  })
  test('a control character gives 422 naming the location', async () => {
    const doc = studioA()
    doc.metadata.id = 'bell'
    ;(mixer(doc).parameters['mxl-src'] as { source: { [k: string]: JsonValue } }).source.label = 'Cam\u0007 1'
    await put(doc, 0)
    const r = await get('/workloads/bell/published.xml')
    assert.equal(r.status, 422)
    assert.deepEqual(await r.json(), {
      error: 'revision 1 is not publishable',
      details: ["functions[vision-mixer].parameters.mxl-src.source.label: contains U+0007, which XML 1.0 can't carry"],
    })
  })
  test('a settings key like a.b gives 422 naming the location', async () => {
    const doc = studioA()
    doc.metadata.id = 'dotted'
    mixer(doc).settings = { extraArgs: [], 'a.b': true }
    await put(doc, 0)
    const r = await get('/workloads/dotted/published.xml')
    assert.equal(r.status, 422)
    assert.deepEqual(await r.json(), {
      error: 'revision 1 is not publishable',
      details: ['functions[vision-mixer].settings: key "a.b" can\'t be encoded (keys must match ^[A-Za-z0-9_-]+$)'],
    })
  })
  test('an unknown workload is 404', async () => assert.equal((await get('/workloads/nope/published.xml')).status, 404))
})
