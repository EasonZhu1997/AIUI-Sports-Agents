#!/usr/bin/env swift

import Foundation
import CoreBluetooth
import Darwin

private let heartRateServiceUUID = CBUUID(string: "180D")
private let heartRateMeasurementUUID = CBUUID(string: "2A37")
private let simulatorName = "SmartRun Mac HR"

private struct Options {
  let bpm: UInt8
  let duration: TimeInterval

  static func parse() -> Options {
    var bpm = 128
    var duration: TimeInterval = 10
    var index = 1

    func fail(_ message: String) -> Never {
      fputs("ARGUMENT_ERROR: \(message)\n", stderr)
      fputs("Usage: swift tools/mac_hr_simulator.swift [--bpm 1...254] [--seconds > 0]\n", stderr)
      exit(64)
    }

    while index < CommandLine.arguments.count {
      let argument = CommandLine.arguments[index]
      switch argument {
      case "--bpm":
        guard index + 1 < CommandLine.arguments.count,
              let value = Int(CommandLine.arguments[index + 1]),
              (1...254).contains(value) else {
          fail("--bpm must be an integer from 1 through 254")
        }
        bpm = value
        index += 2
      case "--seconds":
        guard index + 1 < CommandLine.arguments.count,
              let value = Double(CommandLine.arguments[index + 1]),
              value > 0 else {
          fail("--seconds must be greater than zero")
        }
        duration = value
        index += 2
      case "--help", "-h":
        print("Usage: swift tools/mac_hr_simulator.swift [--bpm 1...254] [--seconds > 0]")
        print("Advertises the standard Bluetooth Heart Rate Service (0x180D) and notifies 0x2A37 once per second.")
        exit(0)
      default:
        fail("unknown option \(argument)")
      }
    }

    return Options(bpm: UInt8(bpm), duration: duration)
  }
}

private final class HeartRatePeripheral: NSObject, CBPeripheralManagerDelegate {
  private let options: Options
  private var manager: CBPeripheralManager!
  private var measurement: CBMutableCharacteristic?
  private var updateTimer: Timer?
  private var stopTimer: Timer?
  private var signalSources: [DispatchSourceSignal] = []
  private var subscribedCentralIDs = Set<UUID>()
  private var pendingPacket: Data?
  private var sampleNumber = 0
  private var hasFinished = false

  init(options: Options) {
    self.options = options
    super.init()
    installSignalHandlers()
    manager = CBPeripheralManager(delegate: self, queue: .main)
    stopTimer = Timer.scheduledTimer(withTimeInterval: options.duration, repeats: false) {
      [weak self] _ in
      self?.finish(reason: "durationComplete", code: 0)
    }
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      print("BLE_STATE=poweredOn")
      publishHeartRateService()
    case .unauthorized:
      print("BLE_ERROR=unauthorized")
      print("BLE_HINT=Enable Bluetooth for Terminal or Codex in System Settings > Privacy & Security > Bluetooth.")
      finish(reason: "bluetoothUnauthorized", code: 2)
    case .unsupported:
      print("BLE_ERROR=unsupported This Mac cannot act as a CoreBluetooth peripheral.")
      finish(reason: "bluetoothUnsupported", code: 2)
    case .poweredOff:
      print("BLE_ERROR=poweredOff Turn on Bluetooth and run the command again.")
      finish(reason: "bluetoothPoweredOff", code: 2)
    case .resetting:
      print("BLE_STATE=resetting")
    case .unknown:
      print("BLE_STATE=unknown")
    @unknown default:
      print("BLE_STATE=unknownValue raw=\(peripheral.state.rawValue)")
    }
  }

  private func publishHeartRateService() {
    let characteristic = CBMutableCharacteristic(
      type: heartRateMeasurementUUID,
      properties: [.notify],
      value: nil,
      permissions: []
    )
    let service = CBMutableService(type: heartRateServiceUUID, primary: true)
    service.characteristics = [characteristic]
    measurement = characteristic
    manager.removeAllServices()
    manager.add(service)
    print("GATT_ADD service=180D characteristic=2A37 properties=notify")
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didAdd service: CBService,
    error: Error?
  ) {
    if let error {
      print("BLE_ERROR=servicePublish message=\(error.localizedDescription)")
      finish(reason: "servicePublishFailed", code: 3)
      return
    }

    peripheral.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [heartRateServiceUUID],
      CBAdvertisementDataLocalNameKey: simulatorName,
    ])
  }

  func peripheralManagerDidStartAdvertising(
    _ peripheral: CBPeripheralManager,
    error: Error?
  ) {
    if let error {
      print("BLE_ERROR=advertising message=\(error.localizedDescription)")
      finish(reason: "advertisingFailed", code: 4)
      return
    }

    print("BLE_ADVERTISING name=\"\(simulatorName)\" service=180D")
    print("HR_READY bpm=\(options.bpm) interval=1s duration=\(formatSeconds(options.duration))s")
    print("HR_HINT=Open SmartRun Screen 02 on Rokid and keep it interactive while scanning.")
    startUpdates()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    subscribedCentralIDs.insert(central.identifier)
    print("BLE_SUBSCRIBED characteristic=2A37 mtu=\(central.maximumUpdateValueLength)")
    sendHeartRate()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    subscribedCentralIDs.remove(central.identifier)
    print("BLE_UNSUBSCRIBED characteristic=2A37")
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    guard let packet = pendingPacket, let measurement else { return }
    if peripheral.updateValue(packet, for: measurement, onSubscribedCentrals: nil) {
      pendingPacket = nil
      logPacket(packet, result: "sentAfterBackpressure")
    }
  }

  private func startUpdates() {
    updateTimer?.invalidate()
    updateTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) {
      [weak self] _ in self?.sendHeartRate()
    }
  }

  private func sendHeartRate() {
    guard manager.state == .poweredOn, let measurement else { return }

    // Heart Rate Measurement flags byte 0x00 selects an unsigned 8-bit BPM value.
    let packet = Data([0x00, options.bpm])
    sampleNumber += 1

    guard !subscribedCentralIDs.isEmpty else {
      if sampleNumber == 1 || sampleNumber % 5 == 0 {
        print("HR_WAITING bpm=\(options.bpm) subscribers=0 elapsedSamples=\(sampleNumber)")
      }
      return
    }

    if manager.updateValue(packet, for: measurement, onSubscribedCentrals: nil) {
      pendingPacket = nil
      logPacket(packet, result: "sent")
    } else {
      pendingPacket = packet
      print("HR_BACKPRESSURE sample=\(sampleNumber) waitingForPeripheralManagerReady=true")
    }
  }

  private func logPacket(_ packet: Data, result: String) {
    print("HR_NOTIFY bpm=\(options.bpm) sample=\(sampleNumber) subscribers=\(subscribedCentralIDs.count) result=\(result)")
  }

  private func installSignalHandlers() {
    for signalNumber in [SIGINT, SIGTERM] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { [weak self] in
        self?.finish(reason: signalNumber == SIGINT ? "interrupt" : "terminate", code: 0)
      }
      source.resume()
      signalSources.append(source)
    }
  }

  private func finish(reason: String, code: Int32) {
    guard !hasFinished else { return }
    hasFinished = true
    updateTimer?.invalidate()
    stopTimer?.invalidate()
    updateTimer = nil
    stopTimer = nil
    pendingPacket = nil

    if manager != nil {
      manager.stopAdvertising()
      manager.removeAllServices()
    }

    print("BLE_STOP reason=\(reason) samples=\(sampleNumber) subscribedCentrals=\(subscribedCentralIDs.count)")
    fflush(stdout)
    exit(code)
  }

  private func formatSeconds(_ seconds: TimeInterval) -> String {
    seconds.rounded() == seconds ? String(Int(seconds)) : String(format: "%.1f", seconds)
  }
}

private let options = Options.parse()
print("AISmartRun Mac Heart Rate Peripheral Simulator")
print("BLE_CONFIG bpm=\(options.bpm) seconds=\(options.duration)")
private let peripheral = HeartRatePeripheral(options: options)
RunLoop.main.run()
