# SmartRun BLE GATT Interface Contract

## 1. Scope and Sources

### Purpose

- Product behavior: discover and connect compatible heart-rate peripherals, keep heart rate live during a run, and optionally use standard Running Speed and Cadence data.
- Supported device class: BLE peripherals that advertise and expose the Bluetooth SIG Heart Rate Service; RSC on the same GATT server is an optional enhancement.
- Out of scope: ANT+ only devices, vendor-private heart-rate protocols, RSC-only advertisements, Connect IQ Data Field discovery, and using the glasses as a BLE Peripheral.

### Evidence register

| ID | Type | Source/revision | Applies to | Confidence |
|---|---|---|---|---|
| S1 | SPEC | Bluetooth SIG Heart Rate Service 1.0 and Heart Rate Measurement characteristic | `0x180D/0x2A37` packet semantics | Normative |
| S2 | SPEC | Bluetooth SIG Running Speed and Cadence Service 1.0 | `0x1814/0x2A53/0x2A54` semantics | Normative |
| I1 | IMPLEMENTATION | `pages/run_hud/index.ink`, `lib/hr.js`, `lib/rsc.js` at SmartRun 0.1.108 | AIUI scan, subscription, recovery, parse and cleanup behavior | Observed |
| D1 | DEVICE_EVIDENCE | Fenix 8 macOS CoreBluetooth capture described in project acceptance notes | advertises `0x180D`; exposes HRS and RSC; 113 valid HRS packets and zero RSC packets during ordinary heart-rate broadcast | Measured |
| X1 | INFERENCE | HRS-only silence while RSC stays live | HRS notification/CCCD or host bridge may require bounded re-arm without disconnecting the shared GATT | Unverified until glasses log capture |

### Conflict policy

Bluetooth SIG specifications define packet layout and units. Real-device evidence decides whether an optional service actually emits data. The implementation must degrade safely when a device or host differs from either expectation, and UI claims require a first valid packet rather than discovery or subscription alone.

## 2. Roles and Runtime

| Participant | BLE role | GATT role | Initiates connection | Runtime constraints |
|---|---|---|---|---|
| Rokid AIUI SmartRun | Central | Client | Yes | owning InkView must be visible and interactive for scan/connect/notification bridge calls |
| Heart-rate wearable | Peripheral | Server | No | must advertise HRS and accept the standard GATT subscription sequence |

- AIUI owning InkView must be interactive for: scan, connect, service/characteristic discovery, and notification start/stop.
- Required user gesture: the user explicitly activates “开始搜索”; lifecycle callbacks never auto-start scanning.
- Background/hidden behavior: stop scanning and do not issue new native notification calls; preserve a committed run GATT when supported, invalidate pending generations, and resume recovery only when visible.
- Unsupported transport assumptions: the AIX is not a GATT server and does not communicate with a Connect IQ Data Field as a peer.

## 3. Discovery

### Advertising expectations

| Item | Required? | Expected value | Evidence | Fallback |
|---|---|---|---|---|
| Service UUID | Yes | Heart Rate `0x180D` | S1, D1 | no discovery match; pure-glasses run remains available |
| Local name | No | vendor/model display name | Runtime | show unnamed candidate |
| Manufacturer data | No | vendor-defined | Runtime | ignore |
| Stable identity | Yes | host `device.id` or platform handle | Runtime | never identify by display name alone |

### Scan policy

- Trigger: explicit activation of “开始搜索”.
- Filters: `scanDevices({ filters: [{ services: ['heart_rate'] }] })`.
- Candidate de-duplication: stable `device.id`; repeated advertisements increment diagnostics but not visible rows.
- Automatic selection: when a remembered stable ID exists, every other HRS candidate is display-only and cannot occupy the GATT; the page waits for an exact ID match. With no remembered ID, the first candidate may be selected only after a bounded 1-second collection window. Explicit row selection remains the only way to replace the remembered device.
- Scan stop condition: user selects a device, activates “下一步”, hides the page, exits, or replaces the scan generation.
- Timeout/retry/backoff: bounded scan retry; inability to scan never blocks the pure-glasses path.
- Permission/unavailable/user-cancel behavior: show a distinct diagnostic and keep “下一步” usable.
- Late `devicefound` generation guard: scan operation and lifecycle generations must both remain current.

### Post-connect validation

Compatibility requires `0x180D`, `0x2A37`, a notification listener, successful notification start, and ultimately a valid Heart Rate Measurement. Name or advertisement matching alone is insufficient. RSC enhancement additionally requires `0x1814/0x2A53` and a first valid RSC packet; its absence never tears down HRS.

## 4. GATT Inventory

### Services

| Service | UUID | Required? | Purpose | Evidence |
|---|---|---|---|---|
| Heart Rate Service | `0x180D` / `0000180d-0000-1000-8000-00805f9b34fb` | Yes | live BPM | S1, D1 |
| Running Speed and Cadence | `0x1814` / `00001814-0000-1000-8000-00805f9b34fb` | No | optional speed, cadence, stride and distance | S2, D1 |

### Characteristics

| Service | Characteristic | UUID | Required? | Properties | Security | Freshness | Failure/degrade behavior |
|---|---|---|---|---|---|---|---|
| HRS | Heart Rate Measurement | `0x2A37` / `00002a37-0000-1000-8000-00805f9b34fb` | Yes | Notify | device policy | 8,000 ms after a valid packet; 20,000 ms first-packet grace | clear BPM; if RSC is live, re-arm HRS only; otherwise reconnect shared GATT |
| RSC | RSC Measurement | `0x2A53` / `00002a53-0000-1000-8000-00805f9b34fb` | No | Notify | device policy | 2,500 ms | keep HRS, fall back to IMU and retry optional probe |
| RSC | RSC Feature | `0x2A54` / `00002a54-0000-1000-8000-00805f9b34fb` | No | Read | device policy | read once per connection | log capability bits; read failure is non-blocking |

### Capability reads

| Characteristic | Bit/field | Meaning | Required behavior | Unknown/RFU behavior |
|---|---|---|---|---|
| RSC Feature `0x2A54` | bit 0 | instantaneous stride length supported | accept optional stride field only when packet flag includes it | preserve raw flags in diagnostics and ignore unknown bits |
| RSC Feature `0x2A54` | bit 1 | total distance supported | allow total-distance priority only after a credible positive increment | preserve and ignore unknown bits |
| RSC Feature `0x2A54` | bit 2 | walking/running status supported | use optional packet status only as metadata | preserve and ignore unknown bits |

## 5. Data Packets

### Packet: Heart Rate Measurement

- Source characteristic: HRS `0x2A37`.
- Framing: flags-driven.
- Byte order: little-endian for multi-byte fields.
- Minimum and maximum length: minimum 2 bytes; variable maximum according to optional energy and RR fields.
- Notification cadence: device-defined.
- Freshness window: 8 seconds after a valid packet.
- First-valid-packet rule: BPM must parse, be finite, and be in `1..254`; subscription resolution alone is not live data.

| Order/offset | Presence condition | Field | Width | Type | Endian | Scale | Unit | Invalid/reserved | Semantic range |
|---|---|---|---|---|---|---|---|---|---|
| 0 | Always | Flags | 1 | uint8 | N/A | 1 | bits | RFU ignored | defined by S1 |
| 1 | flag bit 0 = 0 | Heart Rate | 1 | uint8 | N/A | 1 | bpm | 0 and 255 rejected by product | 1–254 bpm |
| 1 | flag bit 0 = 1 | Heart Rate | 2 | uint16 | LE | 1 | bpm | outside product range rejected | 1–254 bpm |
| next | flag bit 3 | Energy Expended | 2 | uint16 | LE | 1 | kJ | not used by SmartRun | specification range |
| next | flag bit 4; repeat to end | RR Interval | 2 each | uint16 | LE | 1/1024 | s | truncated pair rejected | specification range |

### Flags and fragmentation

| Bit | Name | 0 means | 1 means | Related capability | Parser action |
|---|---|---|---|---|---|
| 0 | Heart Rate Value Format | uint8 BPM | uint16 BPM | HRS | select BPM width |
| 3 | Energy Expended Status | absent | present | HRS | advance offset safely |
| 4 | RR-Interval | absent | one or more values | HRS | parse complete uint16 pairs |

- Unknown/RFU bits: preserve only in diagnostics; never shift known offsets without a defined rule.
- Truncated packet: reject; never present partial BPM as a live snapshot.
- Multi-notification record: not assembled; each notification is independent.
- Per-field freshness/merge policy: BPM has its own timestamp and never inherits RSC freshness.

### Golden vectors: Heart Rate Measurement

| Case | Hex bytes | Expected fields | Expected status |
|---|---|---|---|
| Minimum valid | `00 48` | BPM 72 | valid |
| uint16 format | `01 96 00` | BPM 150 | valid |
| RR interval | `10 48 00 04` | BPM 72; RR 1.0 s | valid |
| Truncated uint16 | `01 48` | no BPM | invalid |
| Reserved flags only | `20 48` | BPM 72; unknown flag retained only for diagnostics | valid with warning |

### Packet: RSC Measurement

- Source characteristic: RSC `0x2A53`.
- Framing: flags-driven fixed mandatory prefix plus optional fields.
- Byte order: little-endian.
- Minimum and maximum length: 4 to 10 bytes.
- Notification cadence: device-defined.
- Freshness window: 2.5 seconds.
- First-valid-packet rule: mandatory speed and cadence fields must parse; only the first valid packet sets `rscLive` and `lastRscAtMs`.

| Order/offset | Presence condition | Field | Width | Type | Endian | Scale | Unit | Invalid/reserved | Semantic range |
|---|---|---|---|---|---|---|---|---|---|
| 0 | Always | Flags | 1 | uint8 | N/A | 1 | bits | RFU ignored | bits 0–2 known |
| 1 | Always | Instantaneous Speed | 2 | uint16 | LE | 1/256 | m/s | non-finite rejected | product range 0–6.944 m/s |
| 3 | Always | Instantaneous Cadence | 1 | uint8 | N/A | 1 | sensor footfalls/min | invalid product range rejected | converted to total cadence; do not exceed 300 spm |
| 4 | flag bit 0 | Instantaneous Stride Length | 2 | uint16 | LE | 1/100 | m | malformed optional field rejects packet | positive specification range |
| next | flag bit 1 | Total Distance | 4 | uint32 | LE | 1/10 | m | negative impossible; jumps re-anchor | monotonic modulo device behavior |
| flag | flag bit 2 | Walking or Running | 0 | boolean | N/A | 1 | state | not a distance source | 0 walking, 1 running |

### Flags and fragmentation

| Bit | Name | 0 means | 1 means | Related capability | Parser action |
|---|---|---|---|---|---|
| 0 | Stride Length Present | absent | uint16 follows cadence | RSC Feature bit 0 | parse only when packet includes it |
| 1 | Total Distance Present | absent | uint32 follows optional stride | RSC Feature bit 1 | parse and require credible positive delta before priority |
| 2 | Walking or Running Status | walking | running | RSC Feature bit 2 | expose state metadata |

- Unknown/RFU bits: ignore without shifting known fields.
- Truncated packet: reject and log `RSC_PACKET_INVALID`.
- Multi-notification record: not used; each packet is complete.
- Per-field freshness/merge policy: RSC speed/cadence timestamps are independent from HRS; optional total distance must freeze/re-anchor independently.

### Golden vectors: RSC Measurement

| Case | Hex bytes | Expected fields | Expected status |
|---|---|---|---|
| Minimum valid | `00 00 01 5A` | speed 1.0 m/s; sensor cadence 90; total cadence 180 spm | valid |
| Optional fields | `07 00 01 5A 78 00 E8 03 00 00` | speed 1.0 m/s; cadence 180 spm; stride 1.2 m; total 100 m; running | valid |
| Negative signed field | Not applicable | all defined fields are unsigned | not applicable |
| Truncated | `03 00 01 5A 78` | missing optional bytes | invalid |
| Unknown flags | `80 00 01 5A` | mandatory fields parsed; RFU retained only in diagnostics | valid with warning |

## 6. Commands and Responses

SmartRun sends no vendor control commands. GATT notification start/stop is a runtime subscription operation, not an application opcode protocol.

- Transport write acknowledgement versus protocol response/result code: both are not applicable because SmartRun performs no application-level write.
- Rollback on control rejection: not applicable; a notification subscription failure leaves metrics unchanged and follows the recovery policy in section 9.

### Command inventory

| Command | Opcode | Parameters | Encoding | Capability gate | Control gate | Timeout | Commit condition |
|---|---|---|---|---|---|---|---|
| None | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

### Response format

| Offset | Field | Width/type | Expected value | Correlation rule |
|---|---|---|---|---|
| N/A | No command response | N/A | N/A | N/A |

### Procedure state machine

```text
IDLE -> SUBSCRIBING -> SUBSCRIBED_SILENT -> FIRST_VALID_PACKET -> LIVE
             | failure/timeout                    | silence
             v                                    v
          RETRY_WAIT <-------------------------- STALE
```

- Maximum in-flight procedures: one HRS notification recovery and one optional RSC probe per generation.
- Rapid user inputs: page-level activation de-duplication prevents duplicate scan/connect chains. Candidate choice also has an independent monotonic selection generation: an explicit row selection invalidates an automatic choice even during the native 250 ms scan-stop settling window; a stale different-device GATT is disconnected, while a replacement reusing the same native device object is not torn down.
- Control permission acquisition and loss: not applicable.
- Late response generation handling: every async completion checks page, BLE operation, lifecycle, and resource ownership generations.
- Device echo suppression: not applicable.

## 7. State and Freshness

| Stream/capability | Found at | Subscribed/read at | First valid at | Last valid at | Live threshold | Silent behavior |
|---|---|---|---|---|---|---|
| HRS | service discovery | `hrSubscribedAtMs` | first valid `0x2A37` | `lastHrAtMs` | 8,000 ms | blank BPM; re-arm HRS if RSC live, else shared-GATT reconnect |
| RSC | `RSC_SERVICE_FOUND` | `rscSubscribedAtMs` | `RSC_FIRST_PACKET` | `lastRscAtMs` | 2,500 ms | independently remove/stop stale `0x2A53`, notify MotionMetrics of the interruption, preserve HRS/GATT, fall back to IMU, and retry after 5 seconds |
| RSC Feature | service discovery | read completion | valid two-byte read | same as read | connection lifetime | capability unknown; no impact on HRS/RSC notifications |

Required milestones:

```text
DISCOVERED -> GATT_CONNECTED -> SERVICE_FOUND -> CHARACTERISTIC_FOUND
-> SUBSCRIBED_OR_READABLE -> FIRST_VALID_PACKET -> LIVE
```

UI truth rules: discovery is a candidate, subscription is “waiting for data”, and only a first valid packet is live. Stale heart rate displays an empty BPM without downgrading a previously engaged heart-rate HUD. Zero RSC speed/cadence is data only when a valid packet explicitly contains zero; it never proves active running. A positive cadence repeated with near-zero speed (`0..0.1 m/s`) keeps the RSC transport alive but cannot refresh cadence freshness unless the same packet has a plausible positive total-distance delta or the glasses accepted an IMU step within the previous 1.5 seconds. This is a product semantic gate, not a Bluetooth SIG packet-validity rule.

## 8. Lifecycle and Cleanup

### Owned resources

| Resource | Owner | Created | Invalidated | Cleanup | Timeout |
|---|---|---|---|---|---|
| Scan + listener | scan operation generation | explicit search | stop/hide/replace/exit | stop scan and detach callback | bounded host stop plus 250 ms settling window |
| GATT connection | BLE operation + connection-attempt + candidate-selection generations | selected candidate connect | disconnect/end/replace/manual override | disconnect exactly once after notifications; stale different-device attempt is released without touching the winner | 800 ms terminal aggregate wait |
| HRS notification | characteristic instance + listener | required subscription | teardown or resource replacement | remove listener then stop notification | bounded bridge step |
| RSC notification | independent characteristic instance + listener | optional probe | probe generation/teardown | remove listener then stop notification | bounded bridge step |
| HRS recovery | recovery generation + native single-flight | HRS stale while RSC fresh | valid BPM/hide/teardown/GATT loss | invalidate timer; let native flight settle under ownership guard | 5 s JS wait, 4 s retry, maximum 5 attempts |

### Generation rules

- Every scan, connection, RSC probe, and HRS recovery session has a monotonic generation.
- Async completion checks the active generation and exact characteristic/device owner before mutation.
- Hide/end invalidates generations before awaiting cleanup.
- Cleanup is idempotent; late completion cannot recreate resources or disconnect a replacement session.

### Reconnection

- Eligible disconnects: required HRS first-packet timeout, HRS+RSC both stale, native GATT disconnect, or connection failure with a retained stable device target.
- Budget and backoff: shared-GATT reconnect has five attempts with 4-second delay and 10-second connection wait; valid `0x2A37` data resets the budget.
- Required versus optional stream recovery: HRS is required; RSC is optional. When RSC remains live, HRS uses an independent five-attempt stop/start notification re-arm without disconnecting RSC or the GATT. When RSC becomes silent, free run and indoor run independently retire only the old `0x2A53` listener/notification and schedule a 5-second probe on the same GATT.
- Re-anchor/reset rules: RSC/IMU distance sources re-anchor after interruption; IMU may add distance during an RSC gap, the first recovered RSC cumulative-distance packet only establishes a new anchor, and only the next valid positive delta may grow distance. HRS recovery never changes the distance ledger.

## 9. Errors and Recovery

| Stage | Error | User state | Log/event | Retry | Cleanup |
|---|---|---|---|---|---|
| Availability | Bluetooth API absent | pure-glasses path remains available | `AVAILABILITY_FAILED` | next explicit search | none |
| Scan | start/retry failure | show unavailable diagnostic and keep next step | `SCAN_ERROR` | bounded | stop listener/session |
| Connect | timeout/reject | heart-rate blank; run unaffected | `GATT_ERROR` | shared budget | release attempt and disconnect |
| Service/characteristic | missing/property mismatch | mark candidate incompatible | exact UUID and error | another candidate only | disconnect required chain |
| HRS subscribe | failed/silent | waiting/blank BPM | `HR_NOTIFY_RECOVERY_FAILED` or timeout | independent bounded recovery when RSC live; otherwise shared reconnect | preserve RSC for independent recovery |
| RSC subscribe | missing/failed/silent | pure-HRS plus IMU | `RSC_UNAVAILABLE`, `RSC_SILENT`, `RSC_PROBE_TIMEOUT`, `RSC_RETRY_SCHEDULED` | 5-second optional probe retry in free/indoor run | remove listener and stop only the old RSC notification; preserve HRS/shared GATT |
| Data | malformed packet | retain prior safe state until freshness expires | `RSC_PACKET_INVALID` or invalid-HR counter | await next packet | no immediate disconnect |
| Control | not applicable | unchanged | none | none | none |

## 10. Security and Privacy

- Pairing/bonding/encryption requirements: device and platform policy; SmartRun adds no private pairing secret.
- Authentication/authorization: standard GATT access only; server credentials are unrelated and never sent over BLE.
- Device identifier retention: only the host stable device identifier and display name are remembered after a valid HRS notification chain.
- Raw packet/log retention: raw BLE packets are not persisted or uploaded; diagnostics contain milestone names and bounded metadata.
- Health/location data handling: BPM contributes to the local run summary and owner-scoped upload policy; raw location and raw motion frames are not part of BLE logs.
- Secrets: no long-lived server secret is present in the AIX package.

## 11. Validation

### Static and unit gates

- [ ] Contract linter passes.
- [ ] UUIDs/properties match applicable specification.
- [ ] Signedness, byte order, scale, unit, invalid values, and RFU behavior are explicit.
- [ ] Golden packet suite passes.
- [ ] HRS independent recovery, timeout, retry, first-packet and stale-generation tests pass.
- [ ] Cleanup and shared-GATT ownership tests pass.
- [ ] Remembered-device auto choice versus explicit row choice race passes across the synchronous scan-stop settling window; manual choice wins and stale different-device GATT is released.
- [ ] Full shared-GATT loss test proves IMU distance grows during the gap, then same-device RSC reconnect re-anchors on the first cumulative-distance packet and grows on the second.

### Privacy-preserving real-device acceptance matrix

| Device/model/firmware | Advertised | Connected | Service | Characteristic/property | Subscribed | First-valid evidence (redacted) | Live | Control result | Disconnect/reconnect |
|---|---|---|---|---|---|---|---|---|---|
| Garmin Fenix 8, ordinary HR broadcast, firmware from D1 | `0x180D` | yes on macOS | HRS + RSC found | `0x2A37` Notify; `0x2A53` Notify; `0x2A54=0000` | both true | redacted HRS first-valid metadata and 113-packet count; RSC count 0 in 60 s | HRS yes, RSC no | N/A | glasses recovery still required |
| Garmin Fenix 8, Virtual Run + START | to verify | to verify on Rokid | expect HRS + RSC | verify on glasses | verify | record redacted HRS/RSC first-valid metadata and packet counts | require both for enhanced mode | N/A | test HRS-only silence and full GATT loss |
| Generic standard HRS peripheral | to test | to test | require HRS | require `0x2A37` Notify | verify | record redacted HRS first-valid metadata and packet count | require BPM recovery | N/A | test 12–20 s silence and return |

Real-device evidence must use an anonymized candidate label and include advertised services, required UUID/property discovery, subscription completion, redacted first-valid timestamps and decoded bounded values, packet counts, cadence, silence transition, independent HRS recovery, cleanup, and shared-GATT reconnect behavior. It must not record raw packet bytes or a complete stable device identifier.

## 12. Open Questions

- Does the current Rokid host actually toggle the HRS CCCD when `stopNotifications()` then `startNotifications()` is called on an already connected characteristic? Close with redacted ADB milestone logs showing the recovery attempt, subscription, first-valid metadata and packet count.
- Does Fenix 8 Virtual Run emit `0x2A53` continuously only after START? Close with redacted first-valid RSC metadata and a 30-minute packet-count timeline, without raw bytes.
- Which wearable models require bonding or encrypted access for HRS/RSC? Close per model/firmware in the acceptance matrix.
- Can an AIUI hide/show cycle retain notifications without a native restart on every supported firmware? Close with HR-only and HR+RSC device tests; keep the generation-safe recovery regardless.
