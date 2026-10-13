// The library's shared vocabulary, loaded from primitives.json: transports (protocols), MXL
// formats, External device kinds and reference kinds. Data, not code: extend it there.
import { PRIMITIVE_LIBRARY } from './primitives'
import type { Essence, ExternalKind, ExternalRefKind, ExternalTransport, PortDef } from './types'

const vocab = PRIMITIVE_LIBRARY.spec.vocabulary

export const EXTERNAL_TRANSPORTS: ExternalTransport[] = vocab.transports.map((t) => t.id)
export const TRANSPORT_LABELS: Record<ExternalTransport, string> = Object.fromEntries(vocab.transports.map((t) => [t.id, t.label]))

// A value naming a protocol (id, label like "Raw UDP", or alias like "udp-ts") -> transport id.
const ALIASES: Record<string, ExternalTransport> = Object.fromEntries(
  vocab.transports.flatMap((t) => [[t.id, t.id], [t.label, t.id], ...(t.aliases ?? []).map((a) => [a, t.id])]),
)
export function transportOf(value: unknown): ExternalTransport | undefined {
  return ALIASES[String(value)]
}

export const KNOWN_FORMATS: Record<Essence, string[]> = vocab.formats

// External devices have one stream: a video feed (with its audio and ANC) or an audio-only feed.
// Transport and formats are not checked on them: the edge function's port decides.
export type ExternalTemplate = { kind: ExternalKind; name: string; description: string; ports: PortDef[] }
export const EXTERNALS: Record<ExternalKind, ExternalTemplate> = Object.fromEntries(
  vocab.externals.map((e) => [
    e.kind,
    {
      kind: e.kind,
      name: e.name,
      description: e.description,
      ports: [
        {
          id: 'stream',
          direction: e.direction,
          essence: e.essence,
          label: e.essence === 'audio' ? 'audio feed' : 'feed',
          cardinality: '0..1',
          formats: [],
          transport: { external: EXTERNAL_TRANSPORTS[0] },
        },
      ],
    },
  ]),
)
export const EXTERNAL_KINDS: ExternalKind[] = vocab.externals.map((e) => e.kind)

// How an external device is identified, with the hint shown for its value.
export const REFERENCE_KINDS: Record<ExternalRefKind, { label: string; source: string; destination: string }> = Object.fromEntries(
  vocab.references.map((r) => [r.id, { label: r.label, source: r.source, destination: r.destination }]),
)
