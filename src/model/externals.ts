// Devices outside the facility. They are drawn on the canvas and published as `externals`
// so edge functions know what they connect to, but they are never deployed.
import type { Essence, ExternalKind, ExternalRefKind, PortDef } from './types'

export type ExternalTemplate = { kind: ExternalKind; name: string; description: string; ports: PortDef[] }

// An external device has one stream: a video feed (carrying its audio and ANC) or an audio-only
// feed. Transport and formats are not checked here: the edge function's port decides.
function stream(direction: 'in' | 'out', essence: Essence): PortDef {
  return {
    id: 'stream',
    direction,
    essence,
    label: essence === 'audio' ? 'audio feed' : 'feed',
    cardinality: '0..1',
    formats: [],
    transport: { external: 'srt' },
  }
}

export const EXTERNALS: Record<ExternalKind, ExternalTemplate> = {
  camera: {
    kind: 'camera',
    name: 'Camera',
    description: 'Camera or other device producing a video feed (with its audio).',
    ports: [stream('out', 'video')],
  },
  microphone: {
    kind: 'microphone',
    name: 'Microphone',
    description: 'External audio-only source.',
    ports: [stream('out', 'audio')],
  },
  source: {
    kind: 'source',
    name: 'External Source',
    description: 'Remote or third-party feed arriving at the facility.',
    ports: [stream('out', 'video')],
  },
  destination: {
    kind: 'destination',
    name: 'External Destination',
    description: 'Device or system receiving a feed from the facility (programme out, monitor wall, distribution).',
    ports: [stream('in', 'video')],
  },
}

export const EXTERNAL_KINDS = Object.keys(EXTERNALS) as ExternalKind[]

// How an external device is identified, with the hint shown for its value.
export const REFERENCE_KINDS: Record<ExternalRefKind, { label: string; source: string; destination: string }> = {
  nmos: { label: 'NMOS', source: 'IS-04 sender id', destination: 'IS-04 receiver id' },
  sdp: { label: 'SDP / address (RTP, Raw UDP, 2022-7)', source: 'SDP name or URL', destination: 'SDP name or URL' },
  srt: { label: 'SRT / RIST party', source: 'remote party name, e.g. venue-truck-1 (address/port: receiver SRT session)', destination: 'remote party name, e.g. cdn-ingest-a' },
  zixi: { label: 'ZIXI stream', source: 'Zixi stream id / broadcaster, e.g. venue-feed-1', destination: 'Zixi stream id / target' },
  rtmp: { label: 'RTMP stream', source: 'app/stream name pushed to us, e.g. live/venue1', destination: 'RTMP URL or app/stream, e.g. live/cdn-a' },
  ndi: { label: 'NDI', source: 'NDI source name', destination: 'NDI receiver name' },
}
