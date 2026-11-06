// studio-a plus every kind of value the XML encodes (each <value> type, secrets, arrays, nulls, empty
// objects and arrays, empty strings, markup characters, tab / LF / CR, non-ASCII) and every optional
// element of the schema. A round-trip fixture for both repos (see write-xml.ts).
import type { Catalog } from '../../src/model/catalog'
import type { JsonValue, WorkloadDescription } from '../../src/model/types'
import { withSelection } from '../../src/model/workload'
import { productCatalog, studioA } from './studio-a'

export function everyValue(catalog: Catalog = productCatalog()): WorkloadDescription {
  const doc = studioA(catalog)
  const vm = doc.spec.functions.find((f) => f.id === 'vision-mixer')!
  const switchframe = catalog.get('switchframe.1')!
  const sel = withSelection({ kind: 'fn', ...vm, settings: vm.settings ?? {} }, switchframe, { outputs: { 'mxl-out': 1, 'srt-out': 1, 'rtmp-out': 1 } })
  const p = sel.parameters as { [k: string]: { [k: string]: { [k: string]: JsonValue } } }
  Object.assign(p['srt-out'].srt, { address: 'cdn.example.net', port: 9000, encryption: 'aes-256', passphrase: { $secret: 'cdn-srt' } })
  Object.assign(p['rtmp-out'].rtmp, { url: 'rtmps://live.example.com/app', streamKey: { $secret: 'stream-key' } })
  p['mxl-src'].source.label = `Cam "one" & <two>, it's`
  const settings: { [k: string]: JsonValue } = {
    extraArgs: ['--log-level', 'debug'],
    text: `& < > " ' and tab\there, newline\nthere, CR\rhere, CRLF\r\nend, trailing space `,
    blank: '',
    spaces: '   ',
    unicode: 'Ünïcødé ✓ 🎬 日本語',
    nil: null,
    yes: true,
    no: false,
    empty: {},
    emptyList: [],
    numbers: [0, 1, -1, 2.5, -0.125, 1e-7, 1.2345e-12, 1e21, 2 ** 60, 123456789.123, Number.MAX_SAFE_INTEGER, -0],
    matrix: [[1, 2], [], [{}], [[null]]],
    records: [{ a: 1 }, { b: { c: null, d: [] } }],
    nested: { deep: { 'with-dash': { under_score: 'x' } } },
    secretRef: { $secret: 'vendor-token' },
  }
  return {
    ...doc,
    metadata: { ...doc.metadata, description: `Studio A & "B"\n\tsecond line\r\nthird <line>` },
    spec: {
      ...doc.spec,
      access: { roles: { director: ['director1', 'deputy.2'], audio: ['audio1'], graphics: ['gfx_1'], captioner: ['cc-1'], viewer: ['viewer1'] } },
      externals: [{ id: 'cdn', kind: 'destination', name: `CDN "A" & 'B'`, notes: 'line 1\nline 2 & <3>', reference: { kind: 'srt', value: 'cdn-ingest-a' } }],
      functions: doc.spec.functions.map((f) =>
        f.id !== 'vision-mixer'
          ? f
          : {
              ...f,
              name: 'Vision "mixer" & co\'s <1>\twith tab\nand newline',
              inputs: sel.inputs,
              outputs: sel.outputs,
              parameters: sel.parameters,
              settings,
              control: { health: { type: 'http', port: 9090, path: '/health' }, api: { type: 'rest', port: 8081, path: '/api' }, nmos: { registers: 'device' } },
              dependencies: [
                { name: 'archive', kind: 'storage', required: true, binding: 'storage:archive-a' },
                { name: 'upstream', kind: 'function', required: false, role: 'acquisition' },
              ],
              resources: { cpu: 2.5, memoryMiB: 4096, networkMbps: 200, storageGiB: 0.5, gpu: { class: 'nvidia-l4', count: 1 } },
              expectations: { resilience: '1+1', scaling: 'fixed' },
              placement: { site: 'studio-a', cluster: 'k3s', environment: 'on-prem', with: ['cam1', 'cam2'], apart: ['sync'], licensing: 'pool "A"' },
              discovery: { register: true, labels: ['news', 'studio a'] },
              flowOptions: { 'mxl-out.video': { labels: ['programme', 'clean'], historyMs: 1000 } },
            },
      ),
    },
  }
}

