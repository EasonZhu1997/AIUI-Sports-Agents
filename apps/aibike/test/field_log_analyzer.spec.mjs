import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeFieldLog,
  formatFieldLogReport,
} from '../tools/analyze_field_log.mjs';

function sensorlessLog() {
  return [
    '09:00:00 [AIBike IMU] ACCEL_STARTED requestedHz=25',
    '09:00:00 [AIBike IMU] GYRO_STARTED generation=1 requestedHz=20',
    '09:00:00 [AIBike IMU] ORIENTATION_STARTED generation=1 requestedHz=20',
    '09:00:00 [AIBike GPS] WATCH_STARTED',
    '09:00:01 [AIBike IMU] ACCEL_FIRST_READING',
    '09:00:01 [AIBike IMU] GYRO_FIRST_READING generation=1',
    '09:00:01 [AIBike IMU] ORIENTATION_FIRST_READING generation=1',
    '09:00:06 [AIBike IMU] ACCEL_RATE hz=10.2 samples=51',
    '09:00:10 [AIBike BLE] GATT_CONNECTED attempt=1 sources=hrs',
    '09:00:11 [AIBike BLE] PACKET source=hrs count=1',
    '09:00:15 [AIBike HUD] STATUS '
      + 'speed=gps/live/0 cadence=imu/live/0 power=none/unsupported/- '
      + 'heartRate=hrs/live/20 distance=42.50/gps_path/live '
      + 'ble=connected reconnect=0 imu=moving/true '
      + 'imuCadence=89/90/0.87/estimated imuRuntime=reading/10.2/151 '
      + 'imuQuality=trusted/none/0.94 gyro=reading/20/151 '
      + 'orientation=reading/25/151 '
      + 'gps=live/qualified-segment/6/0.86/7/3',
  ].join('\n');
}

test('无外设 GPS + IMU 同一 HUD 完整证据通过并保留 HRS 来源', () => {
  const result = analyzeFieldLog(sensorlessLog());
  const report = formatFieldLogReport(result);
  assert.equal(result.status, 'PASS');
  assert.equal(result.hud.classification.kind, 'sensorless');
  assert.deepEqual(result.imu.ratesHz, [10.2]);
  assert.equal(result.imu.latestFinalCadence.finalRpm, 90);
  assert.equal(result.imu.gyro.started, 1);
  assert.equal(result.imu.gyro.firstReading, 1);
  assert.equal(result.imu.orientation.started, 1);
  assert.equal(result.hud.selected.imuQuality.state, 'trusted');
  assert.equal(result.gps.maxAcceptedSegments, 7);
  assert.equal(result.gps.maxRejectedPositions, 3);
  assert.deepEqual(result.ble.packetSources, ['hrs']);
  assert.deepEqual(result.ble.subscribedSources, ['hrs']);
  assert.match(report, /结论: PASS/);
  assert.match(report, /踏频: 眼镜 IMU 估算/);
  assert.match(report, /速度: GPS 估算/);
  assert.match(report, /里程: GPS 路径估算/);
  assert.match(report, /质量门: trusted\/none/);
});

test('GPS 被拒绝时 IMU 固定挡位末级降级可独立形成完整证据', () => {
  const result = analyzeFieldLog([
    '[AIBike IMU] ACCEL_STARTED requestedHz=25',
    '[AIBike IMU] ACCEL_FIRST_READING',
    '[AIBike IMU] ACCEL_RATE hz=8.4 samples=43',
    '[AIBike GPS] ERROR code=1',
    '[AIBike HUD] STATUS '
      + 'speed=imu/live/0 cadence=imu/live/0 power=none/unsupported/- '
      + 'heartRate=none/unsupported/- distance=18.20/cadence_model/live '
      + 'ble=idle reconnect=0 imu=moving/true '
      + 'imuCadence=82/82/0.79/estimated imuRuntime=reading/8.4/90 '
      + 'gps=error/request-failed-1/-/0.00/0/0',
  ].join('\n'));
  assert.equal(result.status, 'PASS');
  assert.equal(result.hud.classification.kind, 'sensorless');
  assert.deepEqual(result.gps.errors, ['1']);
  assert.equal(result.hud.selected.distance.mode, 'cadence_model');
});

test('候选踏频不能替代 finalCadence，零里程也不能拼成通过', () => {
  const result = analyzeFieldLog([
    '[AIBike IMU] ACCEL_STARTED requestedHz=25',
    '[AIBike GPS] WATCH_STARTED',
    '[AIBike IMU] ACCEL_FIRST_READING',
    '[AIBike IMU] ACCEL_RATE hz=9.8 samples=49',
    '[AIBike HUD] STATUS '
      + 'speed=gps/live/0 cadence=imu/subscribed/- power=none/unsupported/- '
      + 'heartRate=none/unsupported/- distance=0.00/gps_path/subscribed '
      + 'ble=idle reconnect=0 imu=moving/true '
      + 'imuCadence=170/-/0.52/warming imuRuntime=reading/9.8/80 '
      + 'gps=live/qualified-segment/5/0.82/3/1',
  ].join('\n'));
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.hud.completeCount, 0);
  assert.equal(result.imu.finalCadenceCount, 0);
  assert.match(result.missing.join('\n'), /完整且可验证/);
});

test('HUD 仍短暂保留旧 IMU 数值时，质量门 artifact 不得拼成通过', () => {
  const result = analyzeFieldLog([
    '[AIBike IMU] ACCEL_STARTED requestedHz=25',
    '[AIBike IMU] ACCEL_FIRST_READING',
    '[AIBike IMU] ACCEL_RATE hz=12.0 samples=60',
    '[AIBike HUD] STATUS '
      + 'speed=imu/live/100 cadence=imu/live/100 power=none/unsupported/- '
      + 'heartRate=none/unsupported/- distance=21.00/cadence_model/live '
      + 'ble=idle reconnect=0 imu=moving/true '
      + 'imuCadence=-/-/0.00/artifact imuRuntime=reading/12.0/80 '
      + 'imuQuality=head_motion/head_turn/0.10 gyro=reading/20/80 '
      + 'orientation=reading/20/80 '
      + 'gps=idle/not-started/-/0.00/0/0',
  ].join('\n'));
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.hud.completeCount, 0);
  assert.equal(result.hud.selected.imuQuality.artifact, 'head_turn');
});

test('坐标键泄漏强制降级且报告不回显坐标值', () => {
  const leaked = `${sensorlessLog()}
debug {"latitude":31.2304,"longitude":121.4737,"coords":{"lat":31.2,"lng":121.4}}
调试坐标：31.2,121.4`;
  const result = analyzeFieldLog(leaked);
  const report = formatFieldLogReport(result);
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.coordinateLeaks.some((item) => item.key === 'latitude'));
  assert.ok(result.coordinateLeaks.some((item) => item.key === 'longitude'));
  assert.ok(result.coordinateLeaks.some((item) => item.key === 'coords'));
  assert.ok(result.coordinateLeaks.some((item) => item.key === '坐标'));
  assert.doesNotMatch(report, /31\.2304|121\.4737/);
  assert.match(report, /为避免二次泄漏，不回显原日志内容/);
});

test('真实 BLE 速度踏频要求 PACKET 证据并汇总重启状态', () => {
  const base = [
    '[AIBike BLE] GATT_CONNECTED attempt=1 sources=csc',
    '[AIBike IMU] ACCEL_STALLED reason=reading-stalled count=20',
    '[AIBike IMU] ACCEL_RESTART attempt=1 reason=reading-stalled',
    '[AIBike GPS] WATCH_STALLED reason=fix-stalled',
    '[AIBike GPS] WATCH_RESTART attempt=1 reason=fix-stalled',
    '[AIBike HUD] STATUS '
      + 'speed=csc/live/0 cadence=csc/live/0 power=none/unsupported/- '
      + 'heartRate=none/unsupported/- distance=9.00/wheel/live '
      + 'ble=connected reconnect=0 imu=unknown/false '
      + 'imuCadence=-/-/0.00/unknown imuRuntime=stalled/-/20 '
      + 'gps=restarting/restart-1-fix-stalled/-/0.00/0/2',
  ];
  const incomplete = analyzeFieldLog(base.join('\n'));
  assert.equal(incomplete.status, 'INCOMPLETE');

  base.splice(1, 0, '[AIBike BLE] PACKET source=csc count=1');
  const result = analyzeFieldLog(base.join('\n'));
  assert.equal(result.status, 'PASS');
  assert.equal(result.hud.classification.kind, 'measured');
  assert.equal(result.imu.stalls.length, 1);
  assert.equal(result.imu.restarts.length, 1);
  assert.equal(result.gps.stalls.length, 1);
  assert.equal(result.gps.restarts.length, 1);
});
