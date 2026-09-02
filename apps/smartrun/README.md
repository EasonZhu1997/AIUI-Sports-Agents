# AISmartRun AIX

![AISmartRun runner icon](assets/smartrun-runner-48.png)

> A source-available AIUI running application for smart glasses, centered on
> standard Bluetooth heart-rate and running-speed/cadence sensors.

[![License: PolyForm NC](https://img.shields.io/badge/license-PolyForm%20Noncommercial-F59E0B)](LICENSE)
[![CI](https://github.com/EasonZhu1997/AIUI-Sports-Agents/actions/workflows/validate.yml/badge.svg)](https://github.com/EasonZhu1997/AIUI-Sports-Agents/actions/workflows/validate.yml)

> **License boundary:** this is public source, not OSI open source. Noncommercial
> use is governed by PolyForm Noncommercial 1.0.0. Commercial use requires a
> separate signed agreement; see [commercial licensing](COMMERCIAL_LICENSE.md).

This application is integrated in the public AIUI Sports Agents monorepo at
`apps/smartrun`. The repository root remains Apache-2.0, while this directory
and its descendants are governed by this directory's PolyForm license.

![Garmin BLE running architecture](docs/assets/garmin-ble-running-architecture-handdrawn.png)

## Bluetooth first

AISmartRun acts as the BLE Central / GATT Client on the glasses:

- HRS `0x180D` + Heart Rate Measurement `0x2A37` is the main path.
- RSC `0x1814` + RSC Measurement `0x2A53` is an optional enhancement for
  compatible devices and modes.
- Ordinary Garmin heart-rate broadcast proves HRS only. It does not prove RSC.
- For the Garmin compatibility demo, select **Virtual Run** and press **START**
  before expecting RSC notifications.
- Missing, invalid, silent, or stale RSC falls back to the glasses IMU without
  tearing down a working heart-rate connection.
- The HUD labels device pace as `配速接入` and fallback motion as `眼镜估算`.

The protocol and freshness contract is documented in
[SMARTRUN_BLE_GATT_CONTRACT.md](docs/SMARTRUN_BLE_GATT_CONTRACT.md).
For a button-by-button compatibility walkthrough, see the
[Garmin / standard BLE demo](docs/GARMIN_BLE_DEMO.md).

## Evidence boundary

Historical segmented evidence includes valid HRS packets from a Garmin Fenix 8
ordinary broadcast and a prior glasses scan/connect path. The current
`0.1.114` build still requires same-build Rokid hardware acceptance for the
first valid `0x2A53` packet, sustained RSC flow, silence/recovery, IMU fallback,
re-anchoring, and the complete HUD-to-summary loop.

Local tests, Reader checks, or an AIX build do not prove those hardware gates.

## Run locally

Requirements: Node.js `24.14.x` and npm `11.9.x`.

```bash
npm ci
npm test
npm run doctor:aiui
npm run build:all
```

Generated `.aix` packages remain local under `release/` and are ignored by Git.
This repository does not upload to AIUI Studio, install to glasses, submit for
review, or publish to a store.

## Offline by default

The public source contains no production backend URL or shared key. Its request
wrappers reject non-HTTPS URLs, so network features stay inactive until a
developer or user explicitly writes an HTTPS `coach_base_url` to app
storage. Bluetooth running, IMU fallback, HUD timing, and local summaries do
not require that backend.

## Source map

| Path | Purpose |
|---|---|
| `pages/run_hud/` | menu, device search, run HUD, warm-up, recovery, summary |
| `lib/hr.js`, `lib/rsc.js`, `lib/devices.js` | standard BLE parsing and lifecycle |
| `lib/motion_*`, `lib/imu*` | glasses-motion fallback and source arbitration |
| `test/` | parser, lifecycle, UI-state, persistence, and release regressions |
| `tools/` | AIX pack, Reader inspection, doctor, preview, and desktop probes |
| `docs/assets/` | documentation-only architecture images; excluded from AIX runtime |

## Privacy and safety

Do not attach unredacted Bluetooth identifiers, tokens, raw health histories,
or private activity backups to Issues. See [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md).

Garmin, Rokid, and AIUI are referenced for compatibility only. This project is
not officially affiliated with or certified by those companies.
