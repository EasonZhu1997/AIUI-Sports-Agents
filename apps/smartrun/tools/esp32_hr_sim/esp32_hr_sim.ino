// ============================================================================
// ESP32 HR Sim —— 标准 BLE 心率外设模拟器（微雪 ESP32-S3-Touch-AMOLED-1.75）
//
// 角色：可控 BLE 外设模拟器，广播标准 Heart Rate
// Service，供 AIUI 眼镜端（BLE central）真机联调。心率为固件生成的 60-170 bpm
// 三角波扫频，非真实数据。断开连接后自动重新广播（测 central 的重连引导）。
//
// GATT 布局（对齐本仓公开的 HRS 合约）：
//   0x180D Heart Rate Service
//     0x2A37 Heart Rate Measurement  [Notify]  flags=0x00 + uint8 bpm（1Hz）
//     0x2A38 Body Sensor Location    [Read]    0x01 = Chest
//   0x180F Battery Service
//     0x2A19 Battery Level           [Read+Notify] 88%，每分钟 -1 到 60 回卷
//   0x180A Device Information
//     0x2A29 Manufacturer            [Read]    "AISmartRun Sim"
//
// 依赖：NimBLE-Arduino（arduino-cli lib install "NimBLE-Arduino"）
// 板型：esp32:esp32:esp32s3（USB CDC on boot 打开，串口走 USB-C）
// 屏幕/触摸/IMU 均不驱动 —— 模拟器只需要 BLE + 串口日志。
//
// 串口 115200：每秒打印当前 bpm 与连接状态，烧录后可用
//   arduino-cli monitor -p COM4 --config-file tools/arduino-cli/arduino-cli.yaml
// 验收：nRF Connect / 眼镜端扫到 "ESP32 HR Sim"，订阅 0x2A37 每秒收到 bpm。
// ============================================================================

#include <NimBLEDevice.h>

static const char* DEVICE_NAME = "ESP32 HR Sim";

// 心率扫频参数：60→170→60 三角波，每秒 ±2 bpm（约 55s 一个完整循环，
// 覆盖 hrZone 1-5 全区间，方便验证 HUD 区间点阵逐格点亮/熄灭）
static const uint8_t BPM_MIN = 60;
static const uint8_t BPM_MAX = 170;
static const int8_t  BPM_STEP = 2;

static NimBLEServer*         server = nullptr;
static NimBLECharacteristic* hrMeasurement = nullptr;
static NimBLECharacteristic* batteryLevel = nullptr;

static uint8_t bpm = 72;
static int8_t  bpmDir = 1;
static uint8_t battery = 88;
static uint32_t lastTickMs = 0;
static uint32_t lastBatteryMs = 0;
static volatile bool connected = false;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    connected = true;
    Serial.println("[conn] central connected");
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    connected = false;
    Serial.printf("[conn] disconnected (reason=%d) -> re-advertising\n", reason);
    // 断开自动重广播：重连测试的关键行为
    NimBLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== ESP32 HR Sim (standard BLE HRS peripheral) ===");

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(3); // +3 dBm，室内联调足够

  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  // central 断开后 NimBLE 默认也会停广播；上面回调里显式重启，双保险
  server->advertiseOnDisconnect(true);

  // --- Heart Rate Service 0x180D ---
  NimBLEService* hrs = server->createService(NimBLEUUID((uint16_t)0x180D));
  hrMeasurement = hrs->createCharacteristic(
      NimBLEUUID((uint16_t)0x2A37), NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic* sensorLocation = hrs->createCharacteristic(
      NimBLEUUID((uint16_t)0x2A38), NIMBLE_PROPERTY::READ);
  uint8_t chest = 0x01; // Chest —— lib/hr.js parseSensorLocation 映射 'Chest'
  sensorLocation->setValue(&chest, 1);
  hrs->start();

  // --- Battery Service 0x180F ---
  NimBLEService* bas = server->createService(NimBLEUUID((uint16_t)0x180F));
  batteryLevel = bas->createCharacteristic(
      NimBLEUUID((uint16_t)0x2A19), NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  batteryLevel->setValue(&battery, 1);
  bas->start();

  // --- Device Information 0x180A ---
  NimBLEService* dis = server->createService(NimBLEUUID((uint16_t)0x180A));
  NimBLECharacteristic* manufacturer = dis->createCharacteristic(
      NimBLEUUID((uint16_t)0x2A29), NIMBLE_PROPERTY::READ);
  manufacturer->setValue("AISmartRun Sim");
  dis->start();

  // --- 广播：把 0x180D 放进广播包，眼镜端 filters:[{services:['heart_rate']}] 才扫得到 ---
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NimBLEUUID((uint16_t)0x180D));
  adv->setName(DEVICE_NAME);
  adv->start();

  Serial.println("[adv] advertising as 'ESP32 HR Sim' with HRS 0x180D");
}

void loop() {
  uint32_t now = millis();

  // 1Hz：扫频 + notify（HRM 包：flags=0x00, uint8 bpm —— 最简标准包，
  // 对应 test/hr_parse.spec.mjs 的「ESP32 模拟器最简包」用例）
  if (now - lastTickMs >= 1000) {
    lastTickMs = now;

    bpm += bpmDir * BPM_STEP;
    if (bpm >= BPM_MAX) { bpm = BPM_MAX; bpmDir = -1; }
    if (bpm <= BPM_MIN) { bpm = BPM_MIN; bpmDir = 1; }

    uint8_t pkt[2] = { 0x00, bpm };
    hrMeasurement->setValue(pkt, sizeof(pkt));
    if (connected) hrMeasurement->notify();

    Serial.printf("[hr] bpm=%u %s\n", bpm, connected ? "(notified)" : "(no central)");
  }

  // 每 60s 电池 -1%，降到 60% 回 88%（让 central 的电量读数有变化可验）
  if (now - lastBatteryMs >= 60000) {
    lastBatteryMs = now;
    battery = (battery <= 60) ? 88 : battery - 1;
    batteryLevel->setValue(&battery, 1);
    if (connected) batteryLevel->notify();
  }

  delay(10);
}
