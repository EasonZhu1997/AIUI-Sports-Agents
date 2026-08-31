# AISmartRower FTMS GATT Interface Contract

**Status:** read-only telemetry contract complete at L1/L2; Rokid real-device acceptance remains open. Physical machine control is out of scope for v0.0.1.

## 1. Scope and Sources

### Purpose

- Provide live indoor-rowing telemetry to an interactive AIUI application.
- Require standard Fitness Machine Service Rower Data.
- Allow an optional, separately selected standard Heart Rate Service device.
- Keep start, stop, pause, resistance and training-program control out of scope.

### Evidence register

| ID | Type | Source/revision | Applies to | Confidence |
|---|---|---|---|---|
| S1 | SPEC | Bluetooth SIG Fitness Machine Service v1.0 | FTMS roles, UUIDs, flags, fields and fragmentation | Normative |
| S2 | SPEC | Bluetooth SIG Heart Rate Service and assigned field metadata | HRS packet structure and field types | Normative |
| I1 | IMPLEMENTATION | AISmartRower v0.0.1 pure parser and AIUI adapter | Current product behavior | Observed |
| D1 | DEVICE_EVIDENCE | macOS/CoreBluetooth + KS-HT-WMX-Ultra bounded capture, 2026-08-23 | Service/characteristic presence, sustained `0x2AD1` packets and one repeatable two-byte resistance shape | Partial; macOS host only |
| X1 | INFERENCE | Target device should expose standard final Rower Data records | Rokid interoperability | Unverified |

When implementation notes or device behavior conflict with S1/S2, the standard layout remains the default. D1 supports one separately named, read-only compatibility profile; it does not change the standard parser or prove Rokid compatibility. Any broader vendor profile still requires repeatable raw vectors tied to model, firmware and activity state.

## 2. Roles and Runtime

| Participant | BLE role | GATT role | Initiates connection | Runtime constraints |
|---|---|---|---|---|
| AIUI application | Central | Client | Yes | Owning InkView remains interactive through scan, connect and subscription |
| Rowing machine | Peripheral | Server | No | Exposes FTMS `0x1826` and notifiable Rower Data `0x2AD1` |
| Optional HR device | Peripheral | Server | No | Separately selected HRS `0x180D/0x2A37` |

- Every scan starts from an explicit user action.
- FTMS and optional HRS own independent GATT objects and generations.
- AIUI does not advertise, host a GATT server, expose raw CCCD access or reuse an Android AAR.
- A display name is presentation only and never proves compatibility.

## 3. Discovery

### FTMS scan policy

- Preferred filter: Fitness Machine Service `00001826-0000-1000-8000-00805f9b34fb`.
- Candidate identity: current-session `device.id`; never a public MAC assumption.
- Deduplicate repeated advertisements by non-empty `device.id`.
- Stop scan before connecting, on page hide, replacement, return or exit.
- If a target firmware does not advertise `0x1826`, a broader scan may be added only after explicit user approval and device evidence; post-connect validation remains mandatory.

### HRS scan policy

- HRS is offered only after FTMS reaches its first valid final Rower Data record.
- The user may skip HRS without blocking rowing.
- Stop the FTMS scan before HRS scanning, but retain the verified FTMS connection and notification.
- Reject a second connection to the same in-memory device or matching non-empty `device.id`.

## 4. GATT Inventory

### Required FTMS service

| Service | UUID | Required | Purpose | Evidence |
|---|---|---|---|---|
| Fitness Machine Service | `0x1826` / `00001826-0000-1000-8000-00805f9b34fb` | Yes | Standard rowing telemetry | S1 |

| Characteristic | UUID | Required | Properties | Freshness | Failure behavior |
|---|---|---|---|---|---|
| Fitness Machine Feature | `0x2ACC` | Yes | Read | Connection-scoped | Missing, unreadable or non-8-byte value makes the candidate incompatible |
| Rower Data | `0x2AD1` | Yes | Notify | 3.5s product live window | Subscription alone stays silent; only a valid final record becomes live |
| Training Status | `0x2AD3` | No | Read, Notify | Independent | Failure does not tear down Rower Data |
| Fitness Machine Status | `0x2ADA` | No in telemetry profile | Notify | Independent | Diagnostic only |

Fitness Machine Control Point `0x2AD9` is deliberately neither discovered nor written by v0.0.1. AIUI calls `startNotifications()` and never manually writes CCCD `0x2902`.

### Optional HRS service

| Service/characteristic | UUID | Required | Properties | Freshness | Failure behavior |
|---|---|---|---|---|---|
| Heart Rate Service | `0x180D` | No | Primary service | Connection-scoped | Keep FTMS telemetry |
| Heart Rate Measurement | `0x2A37` | Conditional after HRS selection | Notify | 5s product live window | Fall back to fresh FTMS bit-9 heart rate or unavailable |

## 5. Rower Data Packet `0x2AD1`

- Flags: `UINT16` little-endian at bytes 0–1.
- Framing: flags-driven and optionally split across notifications.
- First-valid rule: a complete final record passes bounds, field order, finite-value and required base-field checks.
- First-packet watchdog: 10 seconds after subscription, as product policy rather than an FTMS constant.
- Fragment timeout: 2.5 seconds, scoped to connection generation.

### Flags

| Bit | Meaning when 1 | Parser action |
|---|---|---|
| 0 | More Data | Base stroke rate/count are absent; retain a fragment and publish nothing |
| 1 | Average Stroke Rate | Read one `UINT8 × 0.5 spm` |
| 2 | Total Distance | Read one `UINT24 LE` metre value |
| 3 | Instantaneous Pace | Read one `UINT16 LE` seconds/500m value |
| 4 | Average Pace | Read one `UINT16 LE` seconds/500m value |
| 5 | Instantaneous Power | Read one `SINT16 LE` watt value |
| 6 | Average Power | Read one `SINT16 LE` watt value |
| 7 | Resistance Level | Standard path preserves one raw `UINT8`; the bounded D1 profile below is separate |
| 8 | Expended Energy group | Read total `UINT16`, per-hour `UINT16`, per-minute `UINT8` |
| 9 | Heart Rate | Read one `UINT8` bpm value |
| 10 | Metabolic Equivalent | Read one `UINT8 × 0.1 MET` |
| 11 | Elapsed Time | Read one `UINT16 LE` second value |
| 12 | Remaining Time | Read one `UINT16 LE` second value |
| 13–15 | RFU | Preserve in bounded diagnostics; consume no invented fields |

When bit 0 is zero, read base fields immediately after Flags:

| Field | Width/type | Endian | Scale/unit |
|---|---|---|---|
| Stroke Rate | `UINT8` | N/A | ×0.5 strokes/min |
| Stroke Count | `UINT16` | LE | strokes |

Every optional field follows in increasing bit order. Bounds-check before every read. Absent, zero, invalid, partial and stale are distinct states.

### Invalid values

- Total Energy and Energy per Hour: `0xFFFF` means unavailable.
- Energy per Minute: `0xFF` means unavailable.
- Power remains signed; negative raw values must not wrap to large positives.
- Unknown flags remain diagnostic warnings and do not shift known offsets.
- Extra trailing bytes are a protocol conflict unless a documented vendor extension and matching model/firmware evidence explain them.

### D1 target compatibility profile

The standard parser remains fail-closed. The product also exposes the named profile
`ks_wmx_ultra_u16_resistance_20260823`, which accepts an extra byte only when all
observed D1 constraints match: flags exactly `0x00AD`, an 11-byte More Data front
fragment, resistance high byte `0x00`, and a decoded `UINT16 LE` resistance from
1 through 16. A match adds `KS_WMX_U16_RESISTANCE_COMPAT` to diagnostics.

The bounded front vector `ad00d20000f50078001000` decodes to distance 210 m,
pace 245 s/500 m, power 120 W and resistance 16. A different flag set, packet
length, high byte or range remains `TRAILING_BYTES`. The final vector
`000b2823000b00000000006200` completes the record with 20 spm, 35 strokes and
98 seconds elapsed. These vectors are macOS device evidence and unit-test inputs;
the parser change still needs a post-change sustained device run and Rokid tests.

### Fragmentation

- Intermediate packets with More Data update a generation-scoped assembler and publish nothing.
- A final packet atomically commits the merged record.
- Timeout, malformed packet, disconnect, hide, new session or generation change discards the assembler.
- Fields retain independent `receivedAtMs` timestamps after a complete record is published.
- No fragment or stale field crosses a reconnect or workout boundary.

### Golden vectors

| Case | Hex bytes | Expected result |
|---|---|---|
| Minimum final record | `00 00 40 34 12` | valid; 32 spm, 4660 strokes |
| Distance present | `04 00 40 34 12 78 56 34` | valid; distance `0x345678` m |
| Negative power | `20 00 40 34 12 9c ff` | valid; instantaneous power -100 W |
| Truncated distance | `04 00 40 34 12 78 56` | partial/invalid; publish nothing |
| Intermediate distance fragment | `05 00 78 56 34` | fragment only; publish nothing |
| Final base fragment | `00 00 40 34 12` | close and atomically publish assembled record |
| D1 named-profile front | `ad 00 d2 00 00 f5 00 78 00 10 00` | opt-in profile only; fragment with compatibility warning |
| D1 captured final | `00 0b 28 23 00 0b 00 00 00 00 00 62 00` | atomically publish the bounded merged record |

Synthetic vectors prove parser behavior only. A supported-device claim still requires the target model's raw packets.

## 6. Commands and Responses

v0.0.1 implements no FTMS command. It does not discover, subscribe to or write Fitness Machine Control Point `0x2AD9`; therefore it has no pending control procedure and cannot start, stop, pause or change resistance.

A future control contract must be reviewed and versioned separately. It must subscribe to indications before writing, request control when required, keep at most one procedure in flight, and correlate `[0x80, requestOpcode, resultCode]` with the exact pending generation. A successful GATT write is only a transport acknowledgement and never proves that the machine accepted or performed the operation. Protocol rejection, opcode mismatch, timeout, disconnect or generation change must roll back pending UI state and must not trigger a blind retry.

## 7. Heart Rate Packet `0x2A37`

- Parse the Heart Rate Measurement flags before choosing UINT8 or UINT16 bpm.
- Bounds-check optional Energy Expended and each RR Interval.
- Independent HRS is display-eligible only when structurally valid, 20–240 bpm, fresh within 5 seconds and contact is not explicitly false.
- Otherwise use fresh FTMS bit-9 heart rate within 3.5 seconds; otherwise show unavailable.
- Never average the two live sources or reconnect one by destroying the other.

## 8. State and Freshness

```text
IDLE
  -> SCANNING
  -> GATT_CONNECTED
  -> SERVICE_FOUND
  -> FEATURE_READ
  -> ROWER_CHARACTERISTIC_FOUND
  -> ROWER_SUBSCRIBED
  -> ROWER_FIRST_VALID_PACKET
  -> ROWER_LIVE
  -> ROWER_SILENT / DISCONNECTED / ENDED
```

`ROWER_SUBSCRIBED` never changes the HUD to live. Invalid packets do not refresh liveness. Each optional field expires independently.

The UI distinguishes unavailable, scanning, connecting, validating, subscribed-but-silent, live, stale and disconnected. Zero appears only when a valid packet explicitly carries zero.

## 9. Lifecycle and Cleanup

FTMS and HRS each own:

- scan plus listener;
- monotonic generation;
- selected device and GATT object;
- characteristic instance and listener;
- subscription, first-valid and last-valid timestamps;
- reconnect budget and cleanup promise.

On hide, return, replacement or exit:

1. synchronously invalidate the owning generation;
2. stop scan and retry/liveness timers;
3. remove each listener from the same characteristic instance;
4. stop notifications best-effort;
5. discard fragments and pending state;
6. disconnect that profile's GATT once.

Late async work checks generation before every state mutation and cannot revive an ended page. `onShow` restores FTMS first and optional HRS second; the first recovered packet only re-anchors counters.

## 10. Errors and Recovery

| Earliest failed milestone | User truth | Retry and cleanup |
|---|---|---|
| Bluetooth unavailable | Bluetooth unavailable | No automatic loop |
| Scan fails/no candidate | No compatible device found | Bounded retry from active user page |
| `0x1826`, `0x2ACC` or `0x2AD1` missing | Device incompatible | Disconnect FTMS candidate |
| Feature read not exactly 8 bytes | FTMS validation failed | Disconnect and retain bounded reason |
| Subscribe succeeds but no valid packet | Connected, data silent | Do not show live; bounded reconnect only |
| Invalid/truncated/unmatched extra-byte packet | Data format unresolved | Publish nothing; request model/firmware vector |
| Exact D1 compatibility match | Named target layout observed | Publish only after the legal final fragment; retain the compatibility warning |
| Optional HRS failure | Heart rate unavailable or FTMS fallback | Preserve FTMS GATT and session |
| One profile disconnects | Only that source is stale | Its own bounded reconnect; never replace the other generation |

## 11. Security and Privacy

- Read-only telemetry needs no client-side server secret.
- Device names and identifiers are not persisted or uploaded.
- Raw packets are retained only in bounded, user-aware diagnostics and excluded from public result cards by default.
- Health and training data remain local unless the user explicitly enables a separately documented aggregate upload.
- No location, raw motion axes, MAC assumption or private bridge command is part of this contract.
- Physical machine control remains disabled. A future control profile must separately prove pairing/encryption, feature/range gates, Request Control, matching indications and real physical effects.

## 12. Validation

### Static and unit gates

- Contract linter succeeds.
- Golden parser tests cover every optional field, signed power, sentinels, RFU, truncation, fragmentation and the exact bounded D1 pair without weakening standard trailing-byte rejection.
- Adapter tests cover subscription-without-data, late callbacks, independent FTMS/HRS cleanup and idempotent exit.
- Package checks verify permissions, required UUIDs, AIX closure and size.

### Real-device acceptance

For each supported rower model/firmware and Rokid host build, record:

| Advertised | Connected | `0x1826` | `0x2ACC` | `0x2AD1` Notify | First valid | Sustained live | Optional HRS | Reconnect | Cleanup |
|---|---|---|---|---|---|---|---|---|---|
| open | open | open | open | open | open | open | open | open | open |

The evidence bundle binds client version, source revision, AIX UUID/hash, Rokid model, firmware, AIUI host, rower model/firmware, bounded raw hex and decoded safe summary.

## 13. Open Questions

1. Does each target model advertise `0x1826`, or is a user-approved broad scan required?
2. Is the D1 two-byte resistance shape stable across activity states and firmware after the parser patch?
3. Does the target Rokid host maintain FTMS Notify while scanning and connecting a second HRS device?
4. Which fields fragment on each target device, and at what cadence?
5. Does a new workout reset totals and optional-field presence consistently?
