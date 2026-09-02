# Agent Manifest — AIBike

## Platform description / Store Description

AIBike is a cycling HUD for Rokid Glasses with verified sensor metrics, local summaries, and privacy-bounded field telemetry.

## Identity

- **Name**: AIBike
- **Version**: 0.3.80
- **Description**: AIBike is a cycling HUD for Rokid Glasses with verified sensor metrics, local summaries, and privacy-bounded field telemetry.
- **Author**: Yixiao Zhu

## Capabilities

- **Permissions**:
  - bluetooth
  - accelerometer
  - gyroscope
  - audio

### Permission purposes

- `bluetooth`: after an explicit user action, discover and connect to compatible standard BLE cycling sensors.
- `accelerometer` and `gyroscope`: provide a bounded glasses-IMU fallback for cadence and conservative speed/distance estimates; power is never estimated.
- `audio`: play short cadence and safety cues from packaged CC0-derived audio.

The public build declares no network permission and ships no backend address. Online
modules are inert unless an integrator deliberately adds the platform permission,
stores a valid HTTPS base URL, enables the separate opt-in flag, and completes a
privacy/security review.

## Runtime boundary

- AIUI acts as BLE Central / GATT Client.
- HRS: service `0x180D`, Heart Rate Measurement `0x2A37`.
- CSC: service `0x1816`, CSC Measurement `0x2A5B`.
- Cycling Power: service `0x1818`, Cycling Power Measurement `0x2A63`.
- FTMS: service `0x1826`, Indoor Bike Data `0x2AD2`.
- Discovery, GATT connection, subscription setup, first valid packet, and live
  freshness are separate milestones.
- Scan and connection begin only after an explicit interaction. Hide, unload,
  replacement, and exit invalidate generations, remove listeners, stop
  notifications best-effort, and disconnect.
- Production diagnostics use bounded stage codes. They do not print stable device
  identifiers, device names, health values, or raw BLE packets.

## Product boundary

- Pages: `pages/index/index` conversation card and `pages/ride_hud/index` immersive HUD.
- Display: 448×150 card and 480×352 immersive route, black background, green semantic tokens, no emoji.
- Measured CSC/CPS/FTMS data takes priority. The glasses IMU is an explicitly
  labelled fallback and never uses acceleration double integration.
- No location permission, weather request, route capture, or firmware is included.
- Warm-up and recovery guidance is text and programmatic layout; the public package
  contains no unverified logo or GIF assets.
- Local summaries, history, preferences, and bounded derived diagnostics remain on
  device under the default offline policy.

## Release boundary

Every local release is built from one source tree as CN, JA, and EN AIX variants.
Each variant receives an independent UUID and provenance record. `LICENSE`,
`COPYRIGHT`, `COMMERCIAL_LICENSE.md`, and `TRADEMARKS.md` are part of the AIX payload
and its provenance hash.

Local Reader/build success is not AIUI Studio review, signing, upload, installation,
or real-device validation. Those gates remain external and must not be inferred.
