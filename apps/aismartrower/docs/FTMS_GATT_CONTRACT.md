# AISmartRower FTMS/HRS GATT Contract

## 1. Scope and sources

This contract defines the public v0.0.1 implementation boundary for a required
standard FTMS rower and an optional standard HRS heart-rate sensor. UUIDs, field
order, units and properties follow the Bluetooth SIG assigned definitions and
FTMS/HRS specifications; product timeouts, ranges and UI states are explicitly
implementation policy. No vendor profile, private command, capture or firmware is
part of this contract.

## 2. Roles and runtime

The AIUI application is the BLE Central and GATT Client. The rowing machine and
heart-rate sensor are BLE Peripherals and GATT Servers. The application does not
act as a Peripheral, advertise a service or expose a local GATT server.

All scan, connect and notification operations begin from an explicit user action
while the page is visible. FTMS and HRS own separate generations, scan handles,
GATT objects, characteristics, listeners, reconnect budgets and cleanup promises.

## 3. Discovery and selection

- Required FTMS discovery filters service `0x1826`
  (`00001826-0000-1000-8000-00805f9b34fb`).
- Optional HRS discovery filters service `0x180D`
  (`0000180d-0000-1000-8000-00805f9b34fb`).
- `DISCOVERED` means only that an advertisement matched. It is not connection,
  subscription, first packet or liveness.
- A candidate is never connected automatically. The user must select it.
- UI candidates use generated session labels. Advertising names and stable IDs
  are neither displayed nor persisted.
- FTMS and HRS scans do not overlap. FTMS has priority when the host limits BLE
  concurrency.

## 4. GATT inventory

| Profile | Service / characteristic | UUID | Required | Property | Acceptance |
|---|---|---|---|---|---|
| FTMS | Fitness Machine Service | `0x1826` | Yes | Primary service | Must resolve after connect |
| FTMS | Fitness Machine Feature | `0x2ACC` | Yes | Read | Exactly 8 bytes: two little-endian UINT32 bitmaps |
| FTMS | Rower Data | `0x2AD1` | Yes | Notify | Notify required; Indicate-only rejected |
| HRS | Heart Rate Service | `0x180D` | Optional | Primary service | Failure must not fail FTMS |
| HRS | Heart Rate Measurement | `0x2A37` | Optional | Notify | Standard flags/length validation |
| FTMS | Fitness Machine Control Point | `0x2AD9` | Prohibited | Write/Indicate | Not discovered, subscribed or written |

The runtime never writes CCCD directly. `startNotifications()` and
`stopNotifications()` own subscription setup and teardown.

## 5. Data packets and fields

### 5.1 Fitness Machine Feature

`0x2ACC` is exactly 8 bytes. Bytes 0–3 are the supported-machine-feature bitmap
and bytes 4–7 the target-setting-feature bitmap, both unsigned little-endian
UINT32. Any other length is invalid.

Each optional Rower Data field must agree with the machine-feature bitmap:

| Rower Data flag | Field group | Required Feature bit |
|---:|---|---:|
| `0x0002` | average stroke rate | bit 1 cadence |
| `0x0004` | total distance | bit 2 total distance |
| `0x0018` | pace fields | bit 5 pace |
| `0x0060` | power fields | bit 14 power measurement |
| `0x0080` | resistance | bit 7 resistance level |
| `0x0100` | energy triplet | bit 9 expended energy |
| `0x0200` | heart rate | bit 10 heart rate measurement |
| `0x0400` | metabolic equivalent | bit 11 metabolic equivalent |
| `0x0800` | elapsed time | bit 12 elapsed time |
| `0x1000` | remaining time | bit 13 remaining time |

### 5.2 Rower Data

The first two bytes are an unsigned little-endian UINT16 flags field. Bit 0 is
the inverted `More Data` rule: clear includes the mandatory Stroke Rate UINT8 at
0.5 spm resolution and Stroke Count UINT16; set marks a front fragment without
that pair. Optional fields follow specification order. Distance is UINT24 metres;
pace is UINT16 seconds/500m; instantaneous and average power are signed SINT16
watts; resistance is UINT8; metabolic equivalent is UINT8 at 0.1 MET resolution;
elapsed and remaining time are UINT16 seconds.

The energy triplet uses its assigned Data Not Available sentinels (`0xFFFF` and
`0xFF`). Missing fields, sentinel values and numeric zero remain distinct. RFU
flags produce a warning but do not change field order. Truncation, trailing bytes,
conflicting fragment values, non-finite values, out-of-product-range values or a
Feature mismatch rejects the complete data set atomically.

Fragments share one generation and expire after 2.5 seconds. No partial record is
published. Only the final notification can publish the assembled record.

### 5.3 Heart Rate Measurement

`0x2A37` follows the standard flags. Heart rate is UINT8 or UINT16 as selected by
bit 0. Contact support/detection, Energy Expended and zero or more UINT16 RR
intervals are parsed only when their flags and remaining length agree. The product
display range is 20–240 bpm; malformed or poor-contact data cannot establish
usable HRS liveness.

## 6. Commands and responses

v0.0.1 is telemetry-only and performs no GATT Write. Fitness Machine Control
Point `0x2AD9` is absent from runtime discovery and code. If a future product adds
control, a transport/write acknowledgement must remain distinct from the matching
protocol indication/result code and verified physical effect. It would also need
single-flight command ownership, a procedure timeout, range/capability checks,
explicit confirmation and UI rollback on rejection or disconnect. None of those
future rules authorizes control in this release.

## 7. State and freshness

FTMS progresses monotonically through:

`idle → scanning → connecting → validating → subscribed_silent → live`

`GATT_CONNECTED`, service discovery, Feature Read and `SUBSCRIBED` are separate
milestones. `FIRST_VALID_PACKET` occurs only after a complete mandatory record
passes packet, range and Feature gates; only then may the stream be `LIVE`.
Notifications may arrive before the subscription promise settles, but state must
never roll back from live to subscribed.

FTMS data is fresh for 3.5 seconds after the last valid complete record. A
subscription without a first valid packet becomes `silent` after 10 seconds. A
previously live stream becomes `stale` when freshness expires. HRS uses a 5-second
freshness window. Waiting, silent and stale values render as unavailable rather
than reusing old values.

## 8. Lifecycle and cleanup

Every asynchronous callback checks its generation and owned object before
publishing state. A new attempt, hide, cleanup or disconnect increments the
generation so late scan, connect, service, notification and timer callbacks are
ignored. The initially selected FTMS device is committed atomically only after
service, Feature, Rower Data properties and notification subscription all pass.

Cleanup order is: invalidate generation; stop scan; remove characteristic and
disconnect listeners; call `stopNotifications()` when started; disconnect GATT;
clear references. Cleanup is idempotent and bounded. `onHide` suspends both links;
`onShow` may reconnect only the same in-memory devices explicitly selected for
the current session, FTMS first. It never rescans automatically.

## 9. Errors and recovery

Runtime diagnostics expose bounded stage/reason enums such as
`FEATURE_INVALID`, `ROWER_DATA_NOT_NOTIFIABLE`, `FEATURE_MISSING_totalDistanceM`,
`SUBSCRIBE_TIMEOUT` and `PACKET_INVALID`. They do not expose native errors,
device names, stable identifiers or packet bytes.

FTMS is required. An FTMS setup failure returns to explicit search. After an
established link disconnects, the page may attempt the same current-session object
at a 4-second interval up to five times; it does not scan or replace the target.
HRS is optional: scan, setup, silence, contact loss or reconnect exhaustion falls
back to fresh FTMS heart rate or unavailable without terminating FTMS.

## 10. Security and privacy

The application is offline by default and has no endpoint, account, analytics or
upload path. It stores only allowlisted aggregate summaries. Raw packets,
per-packet timelines, RR intervals, advertising names, stable identifiers and
native errors are not logged or persisted. Pairing/bonding behavior belongs to the
host and peripheral; the app neither claims encrypted control nor handles keys.

No MAC assumption, vendor command, Android/Unity bridge, firmware or manual CCCD
write is permitted in the public runtime.

## 11. Validation and acceptance

Automated golden test vectors cover exact 8-byte Feature parsing, little-endian
flags, UINT/SINT signedness, scale and units, sentinels, every optional flag,
truncation, trailing bytes, More Data assembly, timeouts, Feature mismatches,
range rejection, early notifications, generation invalidation and bounded dual
cleanup. Vectors are synthetic or minimal sanitized hex bytes without identity.

Local acceptance requires tests, AIUI Doctor, this contract lint, static preview,
AIX pack, AIX CLI reader inspection, source/payload hashes and the 2MB gate.
Real-device acceptance remains separate: record glasses model/firmware/host build,
rower and HRS model/firmware, source revision, AIX UUID and SHA-256; then verify
FTMS advertisement/Feature/Notify/first valid/sustained stream, optional HRS while
FTMS remains live, at least 15 minutes dual Notify, single-link disconnect
isolation, silent/stale behavior, hide/show recovery, input dedupe and cleanup.
