// The published desired state as XML (schemas/dmf-workload-v1.xsd, namespace urn:dmf:workload:v1),
// the handover format the orchestrator reads. A lossless rendering of `toPublished`; the contract
// is DMF_Orchestrator/docs/orchestration/01-contract.md (the source of truth; summary in
// docs/orchestrator-contract.md). Hand-written, with no dependency.
//
// toWorkloadXml: deterministic bytes (UTF-8, declaration, 2-space indent, LF, trailing newline, no
// DOCTYPE or comments), element order from the XSD, document order everywhere else. Anything XML or
// the XSD can't carry is refused with every location named (XmlEncodeError), never written.
// fromWorkloadXml: the reverse, for round-trip tests. It reads only what toWorkloadXml writes.
import type { JsonValue, WorkloadDescription } from './types'

export const XML_NAMESPACE = 'urn:dmf:workload:v1'
export const XML_SCHEMA_VERSION = '1'

export class XmlEncodeError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`can't be written as XML: ${problems.join('; ')}`)
    this.problems = problems
  }
}

// ---- Attribute types (the XSD's simple types) ----

type AttrType = 'string' | 'token' | 'id' | 'uuid' | 'portRef' | 'blockId' | 'positiveInteger' | 'nonNegativeInteger' | 'decimal' | 'boolean'

const PATTERNS: Partial<Record<AttrType, RegExp>> = {
  id: /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  portRef: /^[a-z0-9-]+\/[A-Za-z0-9_.[\]-]+$/,
  blockId: /^[a-z0-9-]+(\.[a-z0-9-]+)?$/,
}
const KEY = /^[A-Za-z0-9_-]+$/ // a JSON key in a <value> path

type Attr = [name: string, value: unknown, type: AttrType]
type El = { name: string; attrs: Attr[]; children: El[]; text?: string; at: string }

const el = (name: string, at: string, attrs: Attr[] = [], children: El[] = [], text?: string): El => ({ name, attrs, children, text, at })

// ---- Writing ----

export function toWorkloadXml(published: WorkloadDescription): string {
  const problems: string[] = []
  const root = workloadEl(published, problems)
  const out = ['<?xml version="1.0" encoding="UTF-8"?>']
  render(root, 0, out, problems)
  if (problems.length) throw new XmlEncodeError(problems)
  return `${out.join('\n')}\n`
}

function render(e: El, depth: number, out: string[], problems: string[]) {
  const pad = '  '.repeat(depth)
  const attrs = e.attrs
    .filter(([, v]) => v !== undefined)
    .map(([k, v, t]) => ` ${k}="${escape(attrValue(v, t, `${e.at}@${k}`, problems), true)}"`)
    .join('')
  if (e.text !== undefined) {
    checkChars(e.text, e.at, problems)
    out.push(e.text === '' ? `${pad}<${e.name}${attrs}/>` : `${pad}<${e.name}${attrs}>${escape(e.text, false)}</${e.name}>`)
  } else if (!e.children.length) out.push(`${pad}<${e.name}${attrs}/>`)
  else {
    out.push(`${pad}<${e.name}${attrs}>`)
    for (const c of e.children) render(c, depth + 1, out, problems)
    out.push(`${pad}</${e.name}>`)
  }
}

// An attribute's text, checked against its XSD type.
function attrValue(v: unknown, t: AttrType, at: string, problems: string[]): string {
  const bad = (why: string) => {
    problems.push(`${at}: ${why}`)
    return ''
  }
  switch (t) {
    case 'boolean':
      return typeof v === 'boolean' ? String(v) : bad('must be true or false')
    case 'positiveInteger':
    case 'nonNegativeInteger':
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < (t === 'positiveInteger' ? 1 : 0))
        return bad(`must be a whole number ${t === 'positiveInteger' ? '≥ 1' : '≥ 0'} (is ${JSON.stringify(v)})`)
      return String(v)
    case 'decimal':
      return typeof v === 'number' && Number.isFinite(v) ? decimal(v) : bad(`must be a number (is ${JSON.stringify(v)})`)
  }
  if (typeof v !== 'string') return bad(`must be text (is ${JSON.stringify(v)})`)
  checkChars(v, at, problems)
  // An xs:token is read whitespace-collapsed, so a value that isn't would change meaning.
  if (t !== 'string' && v !== v.replace(/[\t\n\r ]+/g, ' ').trim()) return bad(`"${v}" has leading, trailing, repeated or non-space whitespace, which XML carries only as a collapsed token`)
  const pattern = PATTERNS[t]
  if (pattern && !pattern.test(v)) return bad(`"${v}" isn't a valid ${t} (${pattern.source})`)
  return v
}

// Characters XML 1.0 can carry: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
function checkChars(s: string, at: string, problems: string[]) {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const ok = c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)
    if (!ok) problems.push(`${at}: contains U+${c.toString(16).toUpperCase().padStart(4, '0')}, which XML 1.0 can't carry`)
  }
}

// The five entities everywhere. Also, as character references so a reader gets them back:
// CR anywhere (readers turn it into LF), and tab and LF in attributes (readers turn them into spaces).
function escape(s: string, attribute: boolean): string {
  return s.replace(/[&<>"'\r\t\n]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&apos;'
      case '\r':
        return '&#13;'
      default:
        return attribute ? `&#${c.charCodeAt(0)};` : c
    }
  })
}

// A number as XSD decimal / integer text: no exponent. -0 stays -0.
export function decimal(n: number): string {
  if (Object.is(n, -0)) return '-0'
  const s = String(n)
  const m = s.match(/^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/)
  if (!m) return s
  const [, sign, lead, frac = '', expText] = m
  const digits = lead + frac
  const point = 1 + Number(expText) // position of the decimal point in `digits`
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

// ---- Generic values: one <value path type> per leaf ----

function isSecretRef(v: JsonValue): v is { $secret: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $secret?: unknown }).$secret === 'string'
}

function valueTree(name: string, tree: { [k: string]: JsonValue } | undefined, at: string, problems: string[]): El {
  const values: El[] = []
  const leaf = (path: string, type: string, text: string) => values.push(el('value', `${at}.${path}`, [['path', path, 'string'], ['type', type, 'token']], [], text))
  const walk = (v: JsonValue, path: string) => {
    if (v === null) return leaf(path, 'null', '')
    if (Array.isArray(v)) {
      if (!v.length) return leaf(path, 'emptyArray', '')
      return v.forEach((x, i) => walk(x, `${path}[${i}]`))
    }
    switch (typeof v) {
      case 'string':
        return leaf(path, 'string', v)
      case 'boolean':
        return leaf(path, 'boolean', String(v))
      case 'number':
        if (!Number.isFinite(v)) return void problems.push(`${at}.${path}: ${v} isn't a number XML can carry`)
        return leaf(path, Number.isInteger(v) ? 'integer' : 'number', decimal(v))
      case 'object': {
        if (isSecretRef(v)) return leaf(path, 'secret', v.$secret)
        const entries = Object.entries(v)
        if (!entries.length) return path ? leaf(path, 'emptyObject', '') : undefined // an empty tree has no values
        for (const [k, x] of entries) {
          if (!KEY.test(k)) {
            problems.push(`${at}${path ? `.${path}` : ''}: key "${k}" can't be encoded (keys must match ${KEY.source})`)
            continue
          }
          walk(x, path ? `${path}.${k}` : k)
        }
        return
      }
    }
    problems.push(`${at}.${path}: unsupported value ${String(v)}`)
  }
  walk(tree ?? {}, '')
  return el(name, at, [], values)
}

// ---- The document, in XSD order ----

const rational = (prefix: string, r: { num: number; den?: number } | undefined): Attr[] => [
  [`${prefix}Num`, r?.num, 'positiveInteger'],
  [`${prefix}Den`, r === undefined ? undefined : (r.den ?? 1), 'positiveInteger'],
]

function workloadEl(doc: WorkloadDescription, problems: string[]): El {
  const m = doc.metadata
  const s = doc.spec
  const children: El[] = []
  if (m.description !== undefined) children.push(el('description', 'metadata.description', [], [], m.description))
  const d = s.defaults
  children.push(
    el('defaults', 'spec.defaults', [], [
      el('video', 'spec.defaults.video', [
        ...rational('grainRate', d.video.grainRate),
        ['frameWidth', d.video.frameSize.width, 'positiveInteger'],
        ['frameHeight', d.video.frameSize.height, 'positiveInteger'],
        ['colorspace', d.video.colorspace, 'token'],
      ]),
      el('audio', 'spec.defaults.audio', [...rational('sampleRate', d.audio.sampleRate), ['channelCount', d.audio.channelCount, 'positiveInteger']]),
      ...(d.mxl ? [el('mxl', 'spec.defaults.mxl', [['historyMs', d.mxl.historyMs, 'positiveInteger']])] : []),
    ]),
  )
  if (s.access)
    children.push(
      el(
        'access',
        'spec.access',
        [],
        Object.entries(s.access.roles ?? {}).map(([role, users]) =>
          el('role', `spec.access.roles.${role}`, [['name', role, 'token']], users.map((u, i) => el('member', `spec.access.roles.${role}[${i}]`, [], [], u))),
        ),
      ),
    )
  children.push(el('domains', 'spec.domains', [], s.domains.map((x, i) => el('domain', `spec.domains[${i}]`, [['id', x.id, 'token']]))))
  children.push(el('functions', 'spec.functions', [], s.functions.map((f) => functionEl(f, problems))))
  if (s.externals.length)
    children.push(
      el(
        'externals',
        'spec.externals',
        [],
        s.externals.map((x) => {
          const at = `spec.externals[${x.id}]`
          return el(
            'external',
            at,
            [['id', x.id, 'id'], ['kind', x.kind, 'token'], ['name', x.name, 'string']],
            [
              ...(x.notes !== undefined ? [el('notes', `${at}.notes`, [], [], x.notes)] : []),
              ...(x.reference ? [el('reference', `${at}.reference`, [['kind', x.reference.kind, 'token'], ['value', x.reference.value, 'string']])] : []),
            ],
          )
        }),
      ),
    )
  if (s.flows)
    children.push(
      el(
        'flows',
        'spec.flows',
        [],
        s.flows.map((f) => {
          const at = `spec.flows[${f.writer}]`
          const fm = f.format
          return el(
            'flow',
            at,
            [['id', f.id, 'uuid'], ['label', f.label, 'string'], ['domain', f.domain, 'token'], ['essence', f.essence, 'token'], ['writer', f.writer, 'portRef'], ['historyMs', f.historyMs, 'positiveInteger']],
            [
              ...f.readers.map((r, i) => el('reader', `${at}.readers[${i}]`, [], [], checkedText(r, 'portRef', `${at}.readers[${i}]`, problems))),
              el('format', `${at}.format`, [
                ['mediaType', fm.mediaType, 'token'],
                ...rational('grainRate', fm.grainRate),
                ['frameWidth', fm.frameWidth, 'positiveInteger'],
                ['frameHeight', fm.frameHeight, 'positiveInteger'],
                ['interlace', fm.interlace, 'token'],
                ['colorspace', fm.colorspace, 'token'],
                ['transfer', fm.transfer, 'token'],
                ...rational('sampleRate', fm.sampleRate),
                ['channelCount', fm.channelCount, 'positiveInteger'],
              ]),
              discoveryEl(f.discovery, `${at}.discovery`),
            ],
          )
        }),
      ),
    )
  children.push(el('wires', 'spec.wires', [], s.wires.map((w, i) => el('wire', `spec.wires[${i}]`, [['from', w.from, 'portRef'], ['to', w.to, 'portRef']]))))
  return el(
    'workload',
    'workload',
    [
      ['xmlns', XML_NAMESPACE, 'string'],
      ['schemaVersion', XML_SCHEMA_VERSION, 'string'],
      ['apiVersion', doc.apiVersion, 'token'],
      ['id', m.id, 'id'],
      ['uid', m.uid, 'uuid'],
      ['name', m.name, 'string'],
      ['revision', m.revision, 'positiveInteger'],
      ['libraryVersion', m.libraryVersion, 'token'],
    ],
    children,
  )
}

// Element text with a simple type: checked like an attribute.
function checkedText(v: string, t: AttrType, at: string, problems: string[]): string {
  return attrValue(v, t, at, problems)
}

const discoveryEl = (d: { register: boolean; labels?: string[] }, at: string): El =>
  el('discovery', at, [['register', d.register, 'boolean']], (d.labels ?? []).map((l, i) => el('label', `${at}.labels[${i}]`, [], [], l)))

const selectionEl = (name: string, sel: Record<string, number>, at: string): El =>
  el(name, at, [], Object.entries(sel).map(([block, n]) => el('use', `${at}.${block}`, [['block', block, 'blockId'], ['copies', n, 'nonNegativeInteger']])))

function functionEl(f: WorkloadDescription['spec']['functions'][number], problems: string[]): El {
  const at = `functions[${f.id}]`
  const c: El[] = []
  if (f.inputs) c.push(selectionEl('inputs', f.inputs, `${at}.inputs`))
  if (f.outputs) c.push(selectionEl('outputs', f.outputs, `${at}.outputs`))
  if (f.features)
    c.push(el('features', `${at}.features`, [], Object.entries(f.features).map(([block, on]) => el('feature', `${at}.features.${block}`, [['block', block, 'blockId'], ['enabled', on, 'boolean']]))))
  c.push(valueTree('parameters', f.parameters, `${at}.parameters`, problems))
  if (f.settings) c.push(valueTree('settings', f.settings, `${at}.settings`, problems))
  if (f.control) {
    const k = f.control
    c.push(
      el('control', `${at}.control`, [], [
        ...(k.health ? [el('health', `${at}.control.health`, [['type', k.health.type, 'token'], ['port', k.health.port, 'positiveInteger'], ['path', k.health.path, 'string']])] : []),
        ...(k.api ? [el('api', `${at}.control.api`, [['type', k.api.type, 'token'], ['port', k.api.port, 'positiveInteger'], ['path', k.api.path, 'string']])] : []),
        ...(k.nmos ? [el('nmos', `${at}.control.nmos`, [['registers', k.nmos.registers, 'token']])] : []),
      ]),
    )
  }
  if (f.dependencies)
    c.push(
      el(
        'dependencies',
        `${at}.dependencies`,
        [],
        f.dependencies.map((d, i) =>
          el('dependency', `${at}.dependencies[${i}]`, [
            ['name', d.name, 'string'],
            ['kind', d.kind, 'token'],
            ['required', d.required, 'boolean'],
            ['role', d.role, 'string'],
            ['binding', d.binding, 'string'],
          ]),
        ),
      ),
    )
  if (f.resources) {
    const r = f.resources
    c.push(
      el(
        'resources',
        `${at}.resources`,
        [['cpu', r.cpu, 'decimal'], ['memoryMiB', r.memoryMiB, 'decimal'], ['networkMbps', r.networkMbps, 'decimal'], ['storageGiB', r.storageGiB, 'decimal']],
        r.gpu ? [el('gpu', `${at}.resources.gpu`, [['class', r.gpu.class, 'string'], ['count', r.gpu.count, 'nonNegativeInteger']])] : [],
      ),
    )
  }
  if (f.expectations) c.push(el('expectations', `${at}.expectations`, [['resilience', f.expectations.resilience, 'token'], ['scaling', f.expectations.scaling, 'token']]))
  if (f.placement) {
    const p = f.placement
    c.push(
      el(
        'placement',
        `${at}.placement`,
        [['site', p.site, 'string'], ['cluster', p.cluster, 'string'], ['environment', p.environment, 'token'], ['licensing', p.licensing, 'string']],
        [
          ...(p.with ?? []).map((x, i) => el('with', `${at}.placement.with[${i}]`, [], [], checkedText(x, 'id', `${at}.placement.with[${i}]`, problems))),
          ...(p.apart ?? []).map((x, i) => el('apart', `${at}.placement.apart[${i}]`, [], [], checkedText(x, 'id', `${at}.placement.apart[${i}]`, problems))),
        ],
      ),
    )
  }
  if (f.discovery) c.push(discoveryEl(f.discovery, `${at}.discovery`))
  return el(
    'function',
    at,
    [['id', f.id, 'id'], ['type', f.type, 'token'], ['typeVersion', f.typeVersion, 'token'], ['name', f.name, 'string'], ['domain', f.domain, 'token']],
    c,
  )
}

// ---- Reading (round-trip tests) ----

type Node = { name: string; attrs: Record<string, string>; children: Node[]; text: string }

// A small XML reader for documents this module writes: elements, attributes, text, the predefined
// entities and character references. Refuses DOCTYPE and ENTITY declarations, as the compiler does.
export function parseXml(xml: string): Node {
  if (/<!DOCTYPE|<!ENTITY/.test(xml)) throw new Error('DOCTYPE and ENTITY declarations are refused')
  const src = xml.replace(/\r\n?/g, '\n') // end-of-line handling (XML 1.0 §2.11)
  let i = 0
  const decode = (s: string) =>
    s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e],
    )
  const skipMisc = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? '')) i++
      if (src.startsWith('<?', i)) i = src.indexOf('?>', i) + 2
      else if (src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3
      else return
    }
  }
  const element = (): Node => {
    const open = /^<([A-Za-z_][\w.-]*)/.exec(src.slice(i))
    if (!open) throw new Error(`expected an element at ${i}`)
    i += open[0].length
    const node: Node = { name: open[1], attrs: {}, children: [], text: '' }
    for (;;) {
      const a = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(i))
      if (!a) break
      // attribute-value normalisation (§3.3.3): literal whitespace becomes a space; references don't
      node.attrs[a[1]] = decode((a[3] ?? a[4]).replace(/[\t\n]/g, ' '))
      i += a[0].length
    }
    const end = /^\s*(\/?)>/.exec(src.slice(i))
    if (!end) throw new Error(`bad tag <${node.name}> at ${i}`)
    i += end[0].length
    if (end[1]) return node
    for (;;) {
      const lt = src.indexOf('<', i)
      node.text += decode(src.slice(i, lt))
      i = lt
      if (src.startsWith('</', i)) {
        const close = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(src.slice(i))
        if (!close || close[1] !== node.name) throw new Error(`mismatched </${close?.[1]}> for <${node.name}>`)
        i += close[0].length
        if (node.children.length) node.text = ''
        return node
      }
      if (src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3
      else node.children.push(element())
    }
  }
  skipMisc()
  const root = element()
  skipMisc()
  if (i < src.length) throw new Error('content after the root element')
  return root
}

const kids = (n: Node | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? []
const kid = (n: Node | undefined, name: string) => kids(n, name)[0]
const num = (s: string | undefined) => (s === undefined ? undefined : Number(s))
const bool = (s: string | undefined) => (s === undefined ? undefined : s === 'true' || s === '1')

// Drop undefined properties, so a missing attribute reads back as a missing key.
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function rationalOf(n: Node, prefix: string) {
  const v = n.attrs[`${prefix}Num`]
  return v === undefined ? undefined : { num: Number(v), den: Number(n.attrs[`${prefix}Den`] ?? 1) }
}

function readValues(n: Node | undefined): { [k: string]: JsonValue } {
  const root: { [k: string]: JsonValue } = {}
  for (const v of kids(n, 'value')) {
    const t = v.attrs.type
    const leaf: JsonValue =
      t === 'string' ? v.text : t === 'integer' || t === 'number' ? Number(v.text) : t === 'boolean' ? v.text === 'true' : t === 'secret' ? { $secret: v.text } : t === 'null' ? null : t === 'emptyObject' ? {} : []
    const steps = [...v.attrs.path.matchAll(/([A-Za-z0-9_-]+)|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? m[1] : Number(m[2])))
    let cur: JsonValue = root
    steps.forEach((step, k) => {
      const last = k === steps.length - 1
      const next = last ? leaf : typeof steps[k + 1] === 'number' ? [] : {}
      const holder = cur as Record<string | number, JsonValue>
      if (last) holder[step] = next
      else if (holder[step] === undefined) holder[step] = next
      cur = holder[step]
    })
  }
  return root
}

function discoveryOf(n: Node | undefined) {
  if (!n) return undefined
  const labels = kids(n, 'label').map((l) => l.text)
  return compact({ register: bool(n.attrs.register)!, labels: labels.length ? labels : undefined })
}

export function fromWorkloadXml(xml: string): WorkloadDescription {
  const w = parseXml(xml)
  if (w.name !== 'workload' || w.attrs.xmlns !== XML_NAMESPACE) throw new Error(`not a ${XML_NAMESPACE} workload`)
  if (w.attrs.schemaVersion !== XML_SCHEMA_VERSION) throw new Error(`schemaVersion ${w.attrs.schemaVersion} isn't supported`)
  const d = kid(w, 'defaults')!
  const video = kid(d, 'video')!
  const audio = kid(d, 'audio')!
  const mxl = kid(d, 'mxl')
  const access = kid(w, 'access')
  const flows = kid(w, 'flows')
  const description = kid(w, 'description')
  return {
    apiVersion: w.attrs.apiVersion as WorkloadDescription['apiVersion'],
    kind: 'MediaWorkload',
    metadata: compact({
      id: w.attrs.id,
      uid: w.attrs.uid,
      name: w.attrs.name,
      description: description?.text,
      revision: num(w.attrs.revision),
      libraryVersion: w.attrs.libraryVersion,
    }),
    spec: compact({
      defaults: compact({
        video: {
          grainRate: rationalOf(video, 'grainRate')!,
          frameSize: { width: Number(video.attrs.frameWidth), height: Number(video.attrs.frameHeight) },
          colorspace: video.attrs.colorspace as WorkloadDescription['spec']['defaults']['video']['colorspace'],
        },
        audio: { sampleRate: rationalOf(audio, 'sampleRate')!, channelCount: Number(audio.attrs.channelCount) },
        mxl: mxl ? { historyMs: Number(mxl.attrs.historyMs) } : undefined,
      }),
      access: access ? { roles: Object.fromEntries(kids(access, 'role').map((r) => [r.attrs.name, kids(r, 'member').map((m) => m.text)])) } : undefined,
      domains: kids(kid(w, 'domains'), 'domain').map((x) => ({ id: x.attrs.id })),
      functions: kids(kid(w, 'functions'), 'function').map((f) => {
        const sel = (name: string) => {
          const s = kid(f, name)
          return s ? Object.fromEntries(kids(s, 'use').map((u) => [u.attrs.block, Number(u.attrs.copies)])) : undefined
        }
        const features = kid(f, 'features')
        const control = kid(f, 'control')
        const health = kid(control, 'health')
        const api = kid(control, 'api')
        const nmos = kid(control, 'nmos')
        const deps = kid(f, 'dependencies')
        const res = kid(f, 'resources')
        const gpu = kid(res, 'gpu')
        const ex = kid(f, 'expectations')
        const pl = kid(f, 'placement')
        const settings = kid(f, 'settings')
        const withs = kids(pl, 'with').map((x) => x.text)
        const aparts = kids(pl, 'apart').map((x) => x.text)
        return compact({
          id: f.attrs.id,
          type: f.attrs.type,
          typeVersion: f.attrs.typeVersion,
          name: f.attrs.name,
          domain: f.attrs.domain,
          inputs: sel('inputs'),
          outputs: sel('outputs'),
          features: features ? Object.fromEntries(kids(features, 'feature').map((x) => [x.attrs.block, bool(x.attrs.enabled)!])) : undefined,
          parameters: readValues(kid(f, 'parameters')),
          settings: settings ? readValues(settings) : undefined,
          control: control
            ? compact({
                health: health ? (compact({ type: health.attrs.type, port: num(health.attrs.port), path: health.attrs.path }) as never) : undefined,
                api: api ? (compact({ type: api.attrs.type, port: Number(api.attrs.port), path: api.attrs.path }) as never) : undefined,
                nmos: nmos ? ({ registers: nmos.attrs.registers } as never) : undefined,
              })
            : undefined,
          dependencies: deps
            ? kids(deps, 'dependency').map(
                (x) => compact({ name: x.attrs.name, kind: x.attrs.kind, required: bool(x.attrs.required)!, role: x.attrs.role, binding: x.attrs.binding }) as never,
              )
            : undefined,
          resources: res
            ? compact({
                cpu: num(res.attrs.cpu),
                memoryMiB: num(res.attrs.memoryMiB),
                gpu: gpu ? { class: gpu.attrs.class, count: Number(gpu.attrs.count) } : undefined,
                networkMbps: num(res.attrs.networkMbps),
                storageGiB: num(res.attrs.storageGiB),
              })
            : undefined,
          expectations: ex ? (compact({ resilience: ex.attrs.resilience, scaling: ex.attrs.scaling }) as never) : undefined,
          placement: pl
            ? (compact({
                site: pl.attrs.site,
                cluster: pl.attrs.cluster,
                environment: pl.attrs.environment,
                with: withs.length ? withs : undefined,
                apart: aparts.length ? aparts : undefined,
                licensing: pl.attrs.licensing,
              }) as never)
            : undefined,
          discovery: discoveryOf(kid(f, 'discovery')),
        })
      }),
      externals: kids(kid(w, 'externals'), 'external').map((x) => {
        const notes = kid(x, 'notes')
        const ref = kid(x, 'reference')
        return compact({ id: x.attrs.id, kind: x.attrs.kind, name: x.attrs.name, notes: notes?.text, reference: ref ? { kind: ref.attrs.kind, value: ref.attrs.value } : undefined })
      }),
      flows: flows
        ? kids(flows, 'flow').map((x) => {
            const fm = kid(x, 'format')!
            return {
              id: x.attrs.id,
              label: x.attrs.label,
              domain: x.attrs.domain,
              essence: x.attrs.essence as 'video',
              writer: x.attrs.writer,
              readers: kids(x, 'reader').map((r) => r.text),
              format: compact({
                mediaType: fm.attrs.mediaType,
                grainRate: rationalOf(fm, 'grainRate'),
                frameWidth: num(fm.attrs.frameWidth),
                frameHeight: num(fm.attrs.frameHeight),
                interlace: fm.attrs.interlace as 'progressive' | undefined,
                colorspace: fm.attrs.colorspace,
                transfer: fm.attrs.transfer,
                sampleRate: rationalOf(fm, 'sampleRate'),
                channelCount: num(fm.attrs.channelCount),
              }),
              historyMs: Number(x.attrs.historyMs),
              discovery: discoveryOf(kid(x, 'discovery'))!,
            }
          })
        : undefined,
      wires: kids(kid(w, 'wires'), 'wire').map((x) => ({ from: x.attrs.from, to: x.attrs.to })),
    }),
  } as WorkloadDescription
}
