#!/usr/bin/env swift

import Foundation
import CoreBluetooth
import Darwin

private let heartRateService = CBUUID(string: "180D")
private let heartRateMeasurement = CBUUID(string: "2A37")

private struct Options {
  var nameFilter = ""
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

private func parseHeartRate(_ data: Data) -> Int? {
  let bytes = [UInt8](data)
  guard bytes.count >= 2 else { return nil }
  let is16Bit = (bytes[0] & 0x01) != 0
  let bpm: Int
  if is16Bit {
    guard bytes.count >= 3 else { return nil }
    bpm = Int(bytes[1]) | (Int(bytes[2]) << 8)
  } else {
    bpm = Int(bytes[1])
  }
  return bpm > 0 && bpm < 255 ? bpm : nil
}

private final class HeartRateProbe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
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
      let filter = options.nameFilter.isEmpty ? "any 0x180D advertiser" : options.nameFilter
      print("BLE_STATE=poweredOn SCAN_TARGET=\(filter) TIMEOUT=\(Int(options.timeout))s")
      central.scanForPeripherals(
        withServices: nil,
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
      )
    case .unauthorized:
      print("BLE_ERROR=unauthorized Enable Bluetooth access for Codex or Terminal in System Settings > Privacy & Security > Bluetooth.")
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
    let serviceUUIDs = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
    let advertisesHeartRate = serviceUUIDs.contains(heartRateService)
    let nameMatches = !options.nameFilter.isEmpty
      && name.localizedCaseInsensitiveContains(options.nameFilter)

    if !seen.contains(peripheral.identifier), name != "Unknown" || !serviceUUIDs.isEmpty {
      seen.insert(peripheral.identifier)
      let services = serviceUUIDs.map(\.uuidString).joined(separator: ",")
      print("BLE_FOUND name=\(name) rssi=\(RSSI) services=\(services)")
    }

    guard self.peripheral == nil, advertisesHeartRate || nameMatches else { return }
    self.peripheral = peripheral
    self.peripheral?.delegate = self
    phase = "connecting"
    central.stopScan()
    print("BLE_CONNECT name=\(name) advertised180D=\(advertisesHeartRate)")
    central.connect(peripheral, options: nil)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    phase = "discovering-service"
    print("BLE_CONNECTED name=\(peripheral.name ?? "Unknown")")
    peripheral.discoverServices([heartRateService])
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    print("BLE_ERROR=connectFailed message=\(error?.localizedDescription ?? "unknown")")
    finish(code: 3)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    print("BLE_DISCONNECTED message=\(error?.localizedDescription ?? "none")")
    if notificationCount == 0 { finish(code: 4) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error {
      print("BLE_ERROR=serviceDiscovery message=\(error.localizedDescription)")
      finish(code: 5)
      return
    }
    guard let service = peripheral.services?.first(where: { $0.uuid == heartRateService }) else {
      print("BLE_ERROR=missing180D")
      finish(code: 5)
      return
    }
    phase = "discovering-characteristic"
    print("BLE_SERVICE=180D")
    peripheral.discoverCharacteristics([heartRateMeasurement], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    if let error {
      print("BLE_ERROR=characteristicDiscovery message=\(error.localizedDescription)")
      finish(code: 6)
      return
    }
    guard let characteristic = service.characteristics?.first(where: {
      $0.uuid == heartRateMeasurement
    }) else {
      print("BLE_ERROR=missing2A37")
      finish(code: 6)
      return
    }
    phase = "subscribing"
    print("BLE_CHARACTERISTIC=2A37 properties=\(characteristic.properties.rawValue)")
    peripheral.setNotifyValue(true, for: characteristic)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    if let error {
      print("BLE_ERROR=subscribe message=\(error.localizedDescription)")
      finish(code: 7)
      return
    }
    phase = "waiting-notification"
    print("BLE_NOTIFY_ENABLED=\(characteristic.isNotifying)")
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    if let error {
      print("BLE_ERROR=notification message=\(error.localizedDescription)")
      return
    }
    guard let value = characteristic.value else {
      print("HR_PAYLOAD=empty")
      return
    }
    guard let bpm = parseHeartRate(value) else {
      print("HR_PAYLOAD=invalid length=\(value.count)")
      return
    }
    notificationCount += 1
    phase = "receiving"
    print("HR_BPM=\(bpm) sample=\(notificationCount)")
    if notificationCount >= 3 { finish(code: 0) }
  }

  private func finishTimeout() {
    if notificationCount > 0 {
      print("BLE_RESULT=heartRateReceived samples=\(notificationCount)")
      finish(code: 0)
      return
    }
    if phase == "scanning" {
      print("BLE_RESULT=noHeartRateAdvertiser")
    } else if phase == "waiting-notification" || phase == "subscribing" {
      print("BLE_RESULT=connectedButNoHeartRateNotification")
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
print("AISmartRun Mac Heart Rate Probe")
print("Keep the Garmin broadcast-heart-rate screen active and close other BLE receivers.")
private let probe = HeartRateProbe(options: options)
RunLoop.main.run()
