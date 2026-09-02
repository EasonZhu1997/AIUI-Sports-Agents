# AIBike public source snapshot

AIBike is an AIUI cycling HUD for Rokid Glasses. It combines standard BLE cycling
profiles with a conservative glasses-IMU fallback, a local ride ledger, offline ride
summaries, and evidence-focused lifecycle handling.

This directory is a **source-available application**, not an OSI open-source module.
It is licensed under PolyForm Noncommercial 1.0.0. Commercial use requires a
separate written license; see `COMMERCIAL_LICENSE.md`.

## What is included

- AIUI/Ink pages for the conversation card and immersive cycling HUD.
- Pure parsers for HRS, CSC, Cycling Power, and FTMS Indoor Bike Data.
- BLE session ownership, notification freshness, cleanup, and reconnect logic.
- Local metrics, summaries, history, coaching, cadence audio, and deterministic tests.
- CN, JA, and EN AIX pack/inspect tooling with independent UUID provenance.
- Offline-gated optional network modules for integrator study.

Not included: source Git history, production endpoints, credentials, personal
activity evidence, field captures, firmware, release archives, AIX binaries,
unredacted BLE probes, generated previews, or unverified logo/GIF assets.

## Privacy-safe default

The checked-in application is fully offline:

- no production base URL is present;
- `networkSyncEnabled` defaults to `false`;
- `networkBaseUrl` defaults to an empty string;
- `app.json` and `AGENTS.md` do not declare network permission;
- the page rejects a request before `wx.request` unless opt-in and a valid HTTPS
  base URL are both present;
- an absolute URL outside the configured base is rejected.

The public UI intentionally provides no control to enable online sync. An integrator
who chooses to enable it must deliberately configure both local settings fields,
add the required platform permission, provide consent UX, and perform an independent
privacy/security review. That modified build is outside the default release claim.

## BLE architecture

```text
Explicit user action
  -> scan candidate
  -> GATT connect
  -> validate service and characteristic
  -> subscribe
  -> first valid parsed packet
  -> fresh LIVE metric
  -> silent/disconnected/cleanup

HRS / CSC / CPS / FTMS notifications
  -> pure parser
  -> per-source freshness and priority
  -> local CyclingMetrics ledger
  -> 480x352 HUD and local summary

Glasses accelerometer + gyroscope
  -> quality gate and cadence estimator
  -> clearly labelled fallback only
```

A device name or advertised service is not compatibility proof. `startNotifications`
success is not live-data proof. Only a semantically valid packet establishes first
data, and only fresh packets establish live state.

## Local development

Requirements: Node.js 20–25, npm, and Info-ZIP `zip`.

```bash
cd apps/aibike
npm ci
npm test
npm run doctor:aiui
npm run validate
```

Do not commit `node_modules`, test page caches, or release packages.

## Three-language local AIX verification

Keep generated artifacts outside the repository. The output path is a positional
argument after the locale flag:

```bash
AIBIKE_OUT="$(mktemp -d)"

npm run build:audio
node tools/pack_aix.mjs --cn "$AIBIKE_OUT/AIBike-cn.aix"
node tools/inspect_aix.mjs --cn "$AIBIKE_OUT/AIBike-cn.aix"

node tools/pack_aix.mjs --ja "$AIBIKE_OUT/AIBike-ja.aix"
node tools/inspect_aix.mjs --ja "$AIBIKE_OUT/AIBike-ja.aix"

node tools/pack_aix.mjs --en "$AIBIKE_OUT/AIBike-en.aix"
node tools/inspect_aix.mjs --en "$AIBIKE_OUT/AIBike-en.aix"
```

Each AIX includes the application license and copyright notice. The packages are
local verification artifacts only; the repository does not authorize upload,
signing, installation, store submission, or publication.

## Evidence status and open hardware gates

Current source gates covered locally:

- dependency installation and audit;
- deterministic unit and page lifecycle tests;
- AIUI metadata/structure doctor;
- CN/JA/EN pack, Reader inspection, locale identity, provenance, and 2 MB budget.

Still open on the exact release build and target hardware:

- Rokid/AIUI host Bluetooth availability and permission behavior;
- user-initiated scan and real-device discovery;
- GATT service/characteristic properties for each device and firmware;
- first valid HRS/CSC/CPS/FTMS packet and sustained freshness;
- optional-service degradation without breaking the required stream;
- hide/show, disconnect, reconnect, notification cleanup, and late-callback fencing;
- physical key, focus, TTS/audio, and long-session comfort testing;
- AIUI Studio signing, upload review, installation, and store/platform approval.

Garmin heart-rate broadcasting can validate HRS only. It does not prove CSC,
Cycling Power, FTMS, or the full cycling-device matrix.

## Licensing and contributions

- `LICENSE`: PolyForm Noncommercial License 1.0.0.
- `COPYRIGHT`: required Yixiao Zhu copyright notice.
- `COMMERCIAL_LICENSE.md`: commercial inquiry boundary.
- `TRADEMARKS.md`: naming and brand boundary.
- `THIRD_PARTY_NOTICES.md`: dependency and cadence-audio notices.
- `CONTRIBUTING.md`: evidence, privacy, and contribution requirements.

Do not submit credentials, private endpoints, raw BLE packets, stable identifiers,
health data, personal activity files, or third-party assets without documented
redistribution rights.
