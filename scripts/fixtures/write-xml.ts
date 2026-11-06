// Writes the published fixtures, as the orchestrator receives them, for both repos' round-trip tests:
//   scripts/fixtures/<name>.workload.xml    GET /api/workloads/:id/published.xml
//   scripts/fixtures/<name>.published.json  GET /api/workloads/:id/published, the same document as JSON
// Tests check the files are current. Re-run after a model or library change:
//   npx tsx scripts/fixtures/write-xml.ts
import { writeFileSync } from 'node:fs'
import { toPublished } from '../../src/model/workload'
import { toWorkloadXml } from '../../src/model/xml'
import { everyValue } from './every-value'
import { productCatalog, studioA } from './studio-a'

const file = (name: string) => new URL(`./${name}`, import.meta.url)
export const FIXTURES = [
  { name: 'studio-a', revision: 1, build: studioA, xml: file('studio-a.workload.xml'), json: file('studio-a.published.json') },
  { name: 'every-value', revision: 3, build: everyValue, xml: file('every-value.workload.xml'), json: file('every-value.published.json') },
]

export function fixtureFiles(f: (typeof FIXTURES)[number]): { xml: string; json: string } {
  const catalog = productCatalog()
  const published = toPublished(f.build(catalog), f.revision, catalog)
  return { xml: toWorkloadXml(published), json: `${JSON.stringify(published, null, 2)}\n` }
}

if (import.meta.url === `file://${process.argv[1]}`)
  for (const f of FIXTURES) {
    const { xml, json } = fixtureFiles(f)
    writeFileSync(f.xml, xml)
    writeFileSync(f.json, json)
    console.log(`wrote ${f.xml.pathname}, ${f.json.pathname}`)
  }
