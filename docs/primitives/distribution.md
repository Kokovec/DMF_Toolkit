# Distribution — Primitives (draft for review)

> **Partly historical (2026-10-20):** primitives were removed. Modules are now designed from
> features in `src/model/library.json` (see `../design-rules.md` R3.1, R7). The SRT parameter
> detail below still applies, now split across the SRT input block and its Bonding, Network
> constraints and Expected payload add-ons; port ids are prefixed with the block id.

> Design rules and their history: [`../design-rules.md`](../design-rules.md). This document holds the
> detailed definitions for this category's primitives.

Status: draft 2026-10-10. Source of truth: `src/model/library.json`. Hierarchy and
conventions: see `acquisition.md`.

```
Category        Distribution
  Primitive       Encoder
```

## Encoder — `distribution.encoder`

Edge function: compresses MXL flows for **delivery outside the facility** to audiences,
partners, CDNs or archive. Output can be H.264/HEVC/AV1/JPEG XS/…, carried over SRT, RIST,
MPEG-TS, RTMP or ST 2110-22, or written to file.

**Ports**:
- MXL inputs: `in.video`, `in.audio`, `in.anc`, sharing time context `in`.
- External outputs: `out.video`, `out.audio`, `out.anc`, sharing time context `out`.

| Group | Parameter | Values (default) |
|---|---|---|
| video | codec | h264, hevc, jpeg-xs, jpeg2000, av1 (hevc) |
| | profile, chroma, bitDepth | codec default, 4:2:0, 10 |
| | rateControl, bitrateKbps | cbr, 20000 |
| | gopFrames, bFrames, closedGop | 50, 0, true (ignored by intra codecs) |
| | latency, scale | low, source |
| audio | codec, bitrateKbps | aac-lc, 192 per track |
| | tracks[] | {channels, language}: [0,1] und |
| ancillary | captions, scte35, timecode | cea-608-708, false, true |
| output | transport | srt, rist, st2110-22, rtp-ts, udp-ts, rtmp, file (srt) |
| | container | mpeg-ts |
| | srt.{latencyMs, streamId, passphrase🔒} | 120 ms |
| | ts.{serviceName, programNumber, muxRateKbps} | 1, VBR |

🔒 = secret reference, never stored as a value.

Where the stream goes (and whether the far end calls or listens) is the **reference on the
External destination** wired to the encoder's outputs. Destination addresses, network
interfaces, hardware acceleration and licences are left to the orchestrator.

## Open questions

1. **Adaptive bitrate:** should one Encoder produce an ABR ladder (several renditions,
   packaged as HLS/DASH)? Or is a single-rendition encoder plus a separate
   **Packager** primitive better?
2. **Other Distribution primitives:** candidates are Packager (HLS/DASH/CMAF), Transmitter /
   Sender (uncompressed ST 2110 out, the mirror of the Receiver), Playout, and Multiplexer
   (multi-program TS for broadcast).
3. **Contribution encoding** (venue → facility) now has no home. Is it also a
   Distribution Encoder, or should Acquisition get its own?
