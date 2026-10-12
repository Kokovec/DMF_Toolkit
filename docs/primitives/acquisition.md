# Acquisition — Primitives (draft for review)

Status: draft 2026-10-11 (rev 9: parameters follow the protocol: SRT session + network constraints; other protocols blank for now). Source of truth: `src/model/primitives.json`.

## Where primitives sit

```
Category        Acquisition                         Distribution (see distribution.md)
  Primitive       Receiver · Decoder · Synchronizer   Encoder      ← ports + shared parameters
    Vendor module   e.g. "<Vendor> 2110 Gateway"                    ← built from a primitive: identity, formats,
                                                                       control/health, dependencies
```

No generic layer (decision 2026-10-10): vendor modules are built directly from primitives.
Infrastructure (image, compute, licences, placement) is left to the orchestrator.

- A **primitive** fixes the port shape and the parameter set every module of it shares.
- A **vendor module** (catalog entry) is created from a primitive (Modules tab → New module…).
  It names the primitive in `role` and must **conform** to it:
  - its ports must be ports of the primitive, with the same direction, essence and side
    (external transport vs MXL); optional ports may be left out, required ones may not;
  - every core parameter stays, with the same type; option lists may only narrow
    (e.g. a 2110-only receiver keeps `transport: [st2110]`); no extra core parameters;
  - everything product-specific goes in **vendor settings** (vendor's own names), with a
    core → vendor mapping (decision 2026-10-11).
- **Identity:** each vendor has exactly one catalog (vendor name required when it's created;
  catalog id derived from it, e.g. "Acme Media" → `acme-media`). A module's type id is
  `<catalog>.<primitive>.<n>`, e.g. `acme-media.receiver.2`. The number is assigned
  automatically (next free for that vendor and primitive), so two modules can't share an id.
  *Version* versions one module's catalog entry; *Duplicate* creates the next module number.
- Ports marked `external` face the outside world; the module picks the transport
  (ST 2110, SRT, …) and the formats.

---

## Receiver — `acquisition.receiver`

Edge function: receives **one external stream** on **one protocol**, timestamps each grain at
ingress, and publishes it as **MXL flows**. In a DMF, MXL is the only way media travels
between functions (containers); external protocols exist only at the facility edge.

**Ports** (fixed by the primitive; the module author makes two choices, nothing else):

| Port | Choice | Result |
|---|---|---|
| Input | `in.video`: video feed (with its audio and ANC), or `in.audio`: audio-only feed | — |
| Protocol | SRT, ZIXI, RIST, 2022-7, RTP, Raw UDP, RTMP (JPEG XS is a codec, not a protocol) | one per module; a vendor handling several protocols makes one module per protocol |
| 2022-7 | — | **two inputs**, `in.video.a` + `in.video.b` (or `in.audio.a/.b`): legs A and B of the protected stream, both required. One External source can feed both |
| Output | locked to **MXL** | video feed → `out.video`, `out.audio`, `out.anc` flows; audio feed → `out.audio` |

On the canvas the node has one input connection (labelled with the protocol) and one output
connection (**MXL**). The output can be expanded to wire its flows separately, e.g. to send the
audio somewhere else. Array sizes, time contexts, formats and labels come from the primitive and
aren't exposed. How many receivers share a container is the orchestrator's decision.

**Core parameters follow the protocol.** Only SRT is defined so far; the other protocols have no
session block yet. Parameters are split by who uses them:

**1. SRT session** (`srt`, *injected into the media function*). Defines the SRT connection itself.
Shared settings first, then one box per path.

| Parameter | Required? | Values / notes |
|---|---|---|
| mode | Yes | listener, caller, rendezvous (listener) |
| bonding | Optional | none, broadcast (both paths carry the stream; first good packet wins, 2022-7 style), main-backup (none). SRT connection bonding |
| latencyMs | Yes | milliseconds, must be ≥ the sender's latency (120) |
| encryption | Optional | off, AES-128, AES-256 (off) |
| passphrase🔒 | Conditional | shown and required when encryption is on |
| streamId | Optional | for multiplexing or identification |
| mtu | Optional | 1500 unless the path requires otherwise |

Per path: box **Connection** (no bonding) or **Path A** + **Path B** (bonding on):

| Parameter | Required? | Values / notes |
|---|---|---|
| pathA / pathB `.port` | Yes | local listen port (Listener) or remote port (Caller) |
| pathA / pathB `.remoteAddress` | Conditional | IP or hostname; shown and required for Caller / Rendezvous |

**2. Network constraints** (`network`, *for the orchestrator*, recommended). Lets it place,
size, deploy and connect the receiver. Same layout: **Network** box, or **Path A network** +
**Path B network** when bonded.

| Parameter | Values / notes |
|---|---|
| exposure | wan-facing, internal (wan-facing) |
| pathA / pathB `.network` | logical network the path arrives on, e.g. contribution-a / contribution-b |
| pathA / pathB `.zone`, `.vlan` | preferred zone / VLAN or segment; path B should be independent of path A |

**Expected payload** (`payload`, *media function + orchestrator*). Same layout: **Stream** box, or
**Path A** + **Path B** when bonded. Each path declares what it carries:

| Parameter | Required? | Values / notes |
|---|---|---|
| pathA / pathB `.bitrateMbps` | Yes | bitrate of the incoming stream on that path; sizes SRT buffers and the orchestrator's bandwidth reservation |
| pathA / pathB `.container` | Optional | mpeg-ts, rtp, flv (mpeg-ts) |
| pathA / pathB `.videoCodec`, `.audioCodec` | Optional | h264, hevc, jpeg-xs, jpeg2000, av1, uncompressed; aac, mpeg-l2, ac3, eac3, opus, pcm |

**Media function settings** (*injected*):
output `video` format (normalized; becomes the MXL flow definition), output `audio` channels,
`timing.maxLatencyMs`.

🔒 = secret reference. The External source's reference names the remote party; its address and port are in the SRT session.

**Vendor settings:** everything else belongs to each vendor module, under the **vendor's own
names and structure**, with a core → vendor mapping (see the module editor, section 4).

**Which source** is the **reference on the External device** wired to the input: an SRT/RIST
party, a ZIXI stream, an RTMP stream, or an SDP name / address (RTP, Raw UDP, 2022-7).
External devices have one stream port each: a video feed (camera, external source,
destination) or an audio-only feed (microphone).

## Decoder — `acquisition.decoder`

Edge function: receives a **compressed contribution** stream (SRT, RIST, MPEG-TS over RTP/UDP,
ST 2110-22 JPEG XS, RTMP, WebRTC), decodes it, timestamps each grain at ingress, and publishes MXL flows.

**Ports**: same shape as the Receiver.
- External inputs: `in.video`, `in.audio`, `in.anc`, sharing time context `in`.
- MXL outputs: `out.video`, `out.audio`, `out.anc`, sharing time context `out`.

| Group | Parameter | Values (default) |
|---|---|---|
| — | transport | srt, rist, rtp-ts, udp-ts, st2110-22, rtmp, webrtc (srt) |
| — | protection | seamless protection (false); the orchestrator chooses SRT backup/bonding or ST 2022-7 |
| srt | latencyMs, streamId, passphrase🔒 | 120 ms recovery window agreed with the remote party |
| program | number, audioTracks[] | first program; all tracks (by index or language) |
| video | enabled, codec, scale, deinterlace | true, auto, source, off |
| audio | enabled, channels, channelMap | true, 2, track order |
| anc | captions, scte35ToScte104, timecode | true, false, true |
| timing | timestampSource, maxLatencyMs | stream (PCR/PTS) or arrival (stream); latency budget 500 ms |
| errors | concealment, onLoss | true; freeze, black, stop-flows (freeze) |

The remote party, and whether it calls us or listens, is the **reference on the External source**.

🔒 = secret reference, never stored as a value.

## Synchronizer — `acquisition.synchronizer`

Aligns asynchronous sources to a common time base. Covers frame sync, matched or fixed
delay across channels, audio/video alignment, and what to do when a signal is lost.

**Ports**: a port array of N channels (`channels` parameter). Each channel is a video and
audio bundle, `in.video[i]` + `in.audio[i]` → `out.video[i]` + `out.audio[i]`.

| Group | Parameter | Values (default) |
|---|---|---|
| — | channels | 1–32 (1) |
| — | mode | frame-sync (drop/repeat to reference), align (match channels, no drop/repeat), fixed-delay (frame-sync) |
| — | reference | facility-ptp, channel-1, free-run (facility-ptp) |
| delay | targetMs, maxAlignMs | 40, 500 |
| frameRate | output, conversion | source; drop-repeat, blend, motion-compensated |
| audio | lipSyncOffsetMs, driftCorrection | 0, true |
| loss | timeoutMs, video, audio | 200 ms; freeze/black/test-pattern; mute/hold |
| — | timecode | pass, regenerate |

## Left to the orchestrator (the compiler)

Removed from the primitives on 2026-10-10: network interfaces, addresses/ports/SSM and
second-path addresses, source discovery mode, PTP domain, buffer
sizes, hardware acceleration. **Licences** aren't modelled either: some functions and some
parameter values (e.g. seamless protection, UHD, a codec) carry licence requirements, and the
orchestrator works these out from the module and its parameters.

---

## Open questions

1. **Receiver vs Decoder:** the Receiver now takes compressed contribution streams too (SRT,
   ZIXI, RTMP…), which was the Decoder's job. Options: (a) the Receiver also decodes, and the
   Decoder is dropped or becomes an internal MXL → MXL function for compressed MXL flows; (b) the
   Receiver publishes compressed MXL flows and a Decoder (MXL → MXL) decodes them.
2. **2022-7 as a type:** 2022-7 is a dual-path protection scheme for RTP (often carrying
   JPEG XS or uncompressed 2110). As a receiver type, what does it carry? Should it instead be
   "RTP + protection"? The codec it carries (e.g. JPEG XS) would then be a separate choice.
3. **Synchronizer scope:** is frame-rate conversion part of it, or a separate primitive?
4. **ANC on the Synchronizer:** should captions / SCTE-104 travel through it too?

**Scope:** IP-based signals only. SDI and other baseband signals are out of scope (decision 2026-10-10).
