# Garmin / Standard BLE Heart-Rate Demo

This walkthrough demonstrates a direct Bluetooth link from a compatible watch
to the AISmartRun AIX running on the glasses. Garmin is one compatibility
example; the protocol path is standard Bluetooth GATT and does not require a
phone relay.

![Garmin BLE running architecture](assets/garmin-ble-running-architecture-handdrawn.png)

## Before you start

- Use a watch or sensor that can broadcast the standard Heart Rate Service
  (HRS `0x180D`, measurement `0x2A37`).
- If you want the optional speed/cadence path, the device must also expose the
  Running Speed and Cadence Service (RSC `0x1814`, measurement `0x2A53`).
- On compatible Garmin watches, ordinary heart-rate broadcast normally proves
  HRS only. Start **Virtual Run** and press **START** before testing RSC.
- Keep the watch close to the glasses and stop other clients from holding its
  Bluetooth connection.

## HRS demo: watch BPM on the glasses

1. Enable heart-rate broadcast on the watch.
2. Open AISmartRun on the glasses and choose **自由跑** or **室内跑**.
3. On the device screen, press **开始搜索**. Bluetooth discovery begins only
   after this user action.
4. Select the watch if it appears in the candidate list, or let the Smart Next
   path choose the strongest compatible candidate.
5. Wait for a valid `0x2A37` notification. A successful scan or notification
   subscription alone is not counted as live heart rate.
6. Confirm that the HUD displays BPM. Cover or uncover the sensor briefly to
   observe stale-data handling without stopping the run.

Expected evidence: discovery, GATT connection, `0x180D`, `0x2A37`, notification
subscription, and at least one valid BPM packet are separate checkpoints.

## Optional RSC demo: device pace and cadence

1. On a compatible Garmin watch, open **Virtual Run** and press **START**.
2. Start the AISmartRun device search and enter the run HUD.
3. Wait for the first valid `0x2A53` notification. Only then may the HUD show
   `配速接入` and use device cadence/speed.
4. Stop Virtual Run or move the watch out of range. After RSC becomes stale,
   confirm that motion returns to `眼镜估算` while a healthy HRS connection can
   remain active.
5. Resume Virtual Run. The first recovered RSC packet re-anchors distance; a
   later packet supplies the next increment so distance is not counted twice.

## What this demo does not prove

- A Garmin name in scan results does not prove HRS or RSC support.
- HRS success does not prove RSC success.
- Local unit tests, Reader inspection, or an AIX build do not prove the
  same-build glasses hardware loop.
- The current `0.1.114` release still needs same-build Rokid acceptance for
  sustained RSC flow, silence/recovery, IMU fallback, re-anchoring, and the
  complete HUD-to-summary path.

## Safe evidence sharing

When opening an Issue, share the AIX version, glasses/runtime version, watch
model, service/characteristic checkpoints, packet counts, and a redacted
result summary. Do not publish a stable Bluetooth identifier, account data,
token, raw health history, or an unredacted log.

Garmin, Rokid, and AIUI names are used only to describe compatibility. No
official partnership, certification, or endorsement is claimed.
