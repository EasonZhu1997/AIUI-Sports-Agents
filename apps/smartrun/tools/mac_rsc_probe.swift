#!/usr/bin/env swift

import Foundation
import CoreBluetooth
import Darwin

private let rscServiceUUID = CBUUID(string: "1814")
private let rscFeatureUUID = CBUUID(string: "2A54")
private let rscMeasurementUUID = CBUUID(string: "2A53")

private struct Options {
  var nameFilter = "SmartRun Mac RSC"
  var timeout: TimeInterval = 25

  static func parse() -> Options {
    var options = Options()
    var index = 1
    while index < CommandLine.arguments.count {
      let argument = CommandLine.arguments[index]
      if argument == "--name", index + 1 < CommandLine.arguments.count {
        options.nameFilter = CommandLine.arguments[index + 1]
        index += 2
        continue
      }
      if argument == "--seconds", index + 1 < CommandLine.arguments.count,
         let seconds = Double(CommandLine.arguments[index + 1]), seconds > 0 {
        options.timeout = seconds
        index += 2
        continue
      }
      index += 1
    }
    return options
  }
}

private struct RscMeasurement {
  let speedMps: Double
  let cadence: Int
  let totalDistanceM: UInt32?
}

private func readUInt16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
  UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
}

private func readUInt32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
  UInt32(bytes[offset])
    | (UInt32(bytes[offset + 1]) << 8)
    | (UInt32(bytes[offset + 2]) << 16)
    | (UInt32(bytes[offset + 3]) << 24)
}

private func parseRsc(_ data: Data) -> RscMeasurement? {
  let bytes = [UInt8](data)
  guard bytes.count >= 4 else { return nil }
  let flags = bytes[0]
  let speedMps = Double(readUInt16(bytes, 1)) / 256.0
  let cadence = Int(bytes[3])
  var offset = 4
  if (flags & 0x01) != 0 {
    guard bytes.count >= offset + 2 else { return nil }
    offset += 2
  }
  var distance: UInt32?
  if (flags & 0x02) != 0 {
    guard bytes.count >= offset + 4 else { return nil }
    distance = readUInt32(bytes, offset)
  }
  guard speedMps >= 0, speedMps < 100 else { return nil }
  return RscMeasurement(speedMps: speedMps, cadence: cadence, totalDistanceM: distance)
}

private final class RscProbe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private let options: Options
  private var central: CBCentralManager!
  private var peripheral: CBPeripheral?
  private var timeoutTimer: Timer?
  private var notificationCount = 0
  private var phase = "starting"
  private var seen = Set<UUID>()

  init(options: Options) {
    self.options = options
    super.init()
    central = CBCentralManager(delegate: self, queue: .main)
    timeoutTimer = Timer.scheduledTimer(withTimeInterval: options.timeout, repeats: false) {
      [weak self] _ in self?.finishTimeout()
    }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      phase = "scanning"
      print("BLE_STATE=poweredOn SCAN_TARGET=\(options.nameFilter) service=1814 TIMEOUT=\(Int(options.timeout))s")
      central.scanForPeripherals(
        withServices: [rscServiceUUID],
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
      )
    case .unauthorized:
      print("BLE_ERROR=unauthorized Enable Bluetooth access for Terminal or Codex in System Settings > Privacy & Security > Bluetooth.")
      finish(code: 2)
    case .unsupported:
      print("BLE_ERROR=unsupported")
      finish(code: 2)
    case .poweredOff:
      print("BLE_ERROR=poweredOff")
      finish(code: 2)
    default:
      print("BLE_STATE=\(central.state.rawValue)")
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
    let name = advertisedName ?? peripheral.name ?? "Unknown"
    let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
      .map(\.uuidString).joined(separator: ",")
    if !seen.contains(peripheral.identifier) {
      seen.insert(peripheral.identifier)
      print("BLE_FOUND name=\(name) rssi=\(RSSI) services=\(services)")
    }
    guard self.peripheral == nil,
          options.nameFilter.isEmpty || name.localizedCaseInsensitiveContains(options.nameFilter) else { return }
    self.peripheral = peripheral
    peripheral.delegate = self
    phase = "connecting"
    central.stopScan()
    print("BLE_CONNECT name=\(name)")
    central.connect(peripheral, options: nil)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    phase = "discovering-service"
    print("BLE_CONNECTED name=\(peripheral.name ?? "Unknown")")
    peripheral.discoverServices([rscServiceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    print("BLE_ERROR=connectFailed message=\(error?.localizedDescription ?? "unknown")")
    finish(code: 3)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    print("BLE_DISCONNECTED message=\(error?.localizedDescription ?? "none")")
    if notificationCount == 0 { finish(code: 4) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error {
      print("BLE_ERROR=serviceDiscovery message=\(error.localizedDescription)")
      finish(code: 5)
      return
    }
    guard let service = peripheral.services?.first(where: { $0.uuid == rscServiceUUID }) else {
      print("BLE_ERROR=missing1814")
      finish(code: 5)
      return
    }
    phase = "discovering-characteristics"
    print("BLE_SERVICE=1814")
    peripheral.discoverCharacteristics([rscFeatureUUID, rscMeasurementUUID], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    if let error {
      print("BLE_ERROR=characteristicDiscovery message=\(error.localizedDescription)")
      finish(code: 6)
      return
    }
    guard let measurement = service.characteristics?.first(where: { $0.uuid == rscMeasurementUUID }) else {
      print("BLE_ERROR=missing2A53")
      finish(code: 6)
      return
    }
    phase = "subscribing"
    print("BLE_CHARACTERISTIC=2A53 properties=\(measurement.properties.rawValue)")
    peripheral.setNotifyValue(true, for: measurement)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    if let error {
      print("BLE_ERROR=subscribe message=\(error.localizedDescription)")
      finish(code: 7)
      return
    }
    phase = "waiting-notification"
    print("BLE_NOTIFY_ENABLED=\(characteristic.isNotifying) uuid=\(characteristic.uuid.uuidString)")
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if let error {
      print("BLE_ERROR=notification message=\(error.localizedDescription)")
      return
    }
    guard let value = characteristic.value else {
      print("RSC_PAYLOAD=empty")
      return
    }
    guard let parsed = parseRsc(value) else {
      print("RSC_PAYLOAD=invalid length=\(value.count)")
      return
    }
    notificationCount += 1
    phase = "receiving"
    let speedKmh = parsed.speedMps * 3.6
    let pace = parsed.speedMps > 0 ? String(format: "%.0f sec/km", 1000 / parsed.speedMps) : "--"
    let distance = parsed.totalDistanceM.map(String.init) ?? "absent"
    print("RSC_VALID speedKmh=\(String(format: "%.3f", speedKmh)) pace=\(pace) cadence=\(parsed.cadence) distanceM=\(distance) sample=\(notificationCount)")
    if notificationCount >= 3 {
      print("BLE_RESULT=rscLive samples=\(notificationCount)")
      finish(code: 0)
    }
  }

  private func finishTimeout() {
    if notificationCount > 0 {
      print("BLE_RESULT=rscReceived samples=\(notificationCount)")
      finish(code: 0)
      return
    }
    if phase == "scanning" {
      print("BLE_RESULT=noRscAdvertiser")
    } else if phase == "waiting-notification" || phase == "subscribing" {
      print("BLE_RESULT=connectedButNoRscNotification")
    } else {
      print("BLE_RESULT=timeout phase=\(phase)")
    }
    finish(code: 8)
  }

  private func finish(code: Int32) {
    timeoutTimer?.invalidate()
    timeoutTimer = nil
    central?.stopScan()
    if let peripheral, peripheral.state == .connected {
      central?.cancelPeripheralConnection(peripheral)
    }
    fflush(stdout)
    exit(code)
  }
}

private let options = Options.parse()
print("AISmartRun Mac RSC Probe")
private let probe = RscProbe(options: options)
RunLoop.main.run()
