import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
  parseHeartRateMeasurement,
  toHeartRateBytes,
} from '../lib/hr.js';

test('exports canonical standard HRS UUIDs', () => {
  assert.equal(
    HEART_RATE_SERVICE_UUID,
    '0000180d-0000-1000-8000-00805f9b34fb',
  );
  assert.equal(
    HEART_RATE_MEASUREMENT_UUID,
    '00002a37-0000-1000-8000-00805f9b34fb',
  );
});

test('parses UINT8 and UINT16 heart rates without imposing a 255 bpm protocol limit', () => {
  const uint8 = parseHeartRateMeasurement([0x00, 72]);
  assert.equal(uint8.valid, true);
  assert.equal(uint8.format, 'uint8');
  assert.equal(uint8.heartRateBpm, 72);
  assert.equal(uint8.contactDetected, null);

  const uint16 = parseHeartRateMeasurement([0x01, 0x2c, 0x01]);
  assert.equal(uint16.valid, true);
  assert.equal(uint16.format, 'uint16');
  assert.equal(uint16.heartRateBpm, 300);
  assert.equal(uint16.usable, true);
});

test('decodes contact, energy expended and every RR interval in little endian', () => {
  const parsed = parseHeartRateMeasurement([
    0x1e,
    88,
    0x34, 0x12,
    0x00, 0x04,
    0x80, 0x04,
  ]);
  assert.deepEqual(parsed, {
    valid: true,
    usable: true,
    rawLength: 8,
    flags: 0x1e,
    format: 'uint8',
    heartRateBpm: 88,
    contactSupported: true,
    contactDetected: true,
    energyExpendedKj: 0x1234,
    rrIntervals1024: [1024, 1152],
    errors: [],
  });
});

test('reports supported but poor contact without rejecting the legal packet', () => {
  const parsed = parseHeartRateMeasurement([0x04, 64]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.contactSupported, true);
  assert.equal(parsed.contactDetected, false);
  assert.equal(parsed.usable, false);
});

test('rejects RFU/contact flag violations, optional-field truncation and trailing bytes', () => {
  const cases = [
    [[0x20, 70], 'RFU_FLAGS_SET'],
    [[0x02, 70], 'INVALID_CONTACT_FLAGS'],
    [[0x01, 70], 'TRUNCATED_HEART_RATE'],
    [[0x08, 70, 0x01], 'TRUNCATED_ENERGY_EXPENDED'],
    [[0x10, 70], 'RR_INTERVAL_MISSING'],
    [[0x10, 70, 0x01, 0x02, 0x03], 'TRUNCATED_RR_INTERVAL'],
    [[0x00, 70, 0x00], 'UNEXPECTED_TRAILING_BYTES'],
  ];
  for (const [bytes, reason] of cases) {
    const parsed = parseHeartRateMeasurement(bytes);
    assert.equal(parsed.valid, false, reason);
    assert.deepEqual(parsed.errors, [reason]);
  }
});

test('normalizes typed-array views without reading bytes outside the view', () => {
  const backing = new Uint8Array([0xff, 0x00, 75, 0xee]);
  const view = new Uint8Array(backing.buffer, 1, 2);
  assert.deepEqual(toHeartRateBytes(view), [0x00, 75]);
  assert.equal(parseHeartRateMeasurement(view).heartRateBpm, 75);
});

test('does not wrap or coerce malformed array elements into protocol bytes', () => {
  for (const value of [
    [0, 256],
    [0, -1],
    [0, 72.5],
    [0, '72'],
    [0, Number.NaN],
  ]) {
    assert.deepEqual(toHeartRateBytes(value), []);
    assert.equal(parseHeartRateMeasurement(value).valid, false);
  }
});

test('zero bpm is structurally valid but explicitly unusable', () => {
  const parsed = parseHeartRateMeasurement([0x00, 0x00]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.usable, false);
});
