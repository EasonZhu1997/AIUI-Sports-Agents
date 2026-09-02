import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RowerRecordAssembler,
  hasMandatoryRowerTelemetry,
  isRowerRecordLive,
  parseFitnessMachineFeature,
  parseRowerDataFragment,
  toFtmsBytes,
  validateRowerRecordAgainstFeature,
} from '../lib/ftms_rower.js';

function withBase(flags, optional = [], strokeRateRaw = 40, strokeCount = 1) {
  return [
    flags & 0xff,
    (flags >> 8) & 0xff,
    strokeRateRaw,
    strokeCount & 0xff,
    (strokeCount >> 8) & 0xff,
    ...optional,
  ];
}

test('normalizes only deliberate byte containers', () => {
  assert.deepEqual(toFtmsBytes(new Uint8Array([1, 2, 255])), [1, 2, 255]);
  assert.deepEqual(toFtmsBytes([0, 255]), [0, 255]);
  assert.deepEqual(toFtmsBytes([-1, 256]), []);
  assert.deepEqual(toFtmsBytes('00ff'), []);
});

test('parses the exact eight-byte Fitness Machine Feature value', () => {
  const parsed = parseFitnessMachineFeature([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.machineFeatures, 0x04030201);
  assert.equal(parsed.targetFeatures, 0x08070605);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parseFitnessMachineFeature([1, 2, 3]).valid, false);
});

test('parses the minimum final record and inverted More Data bit', () => {
  const final = parseRowerDataFragment([0x00, 0x00, 0x30, 0x34, 0x12]);
  assert.equal(final.valid, true);
  assert.equal(final.moreData, false);
  assert.equal(final.complete, true);
  assert.equal(final.fields.strokeRateSpm, 24);
  assert.equal(final.fields.strokeCount, 0x1234);

  const continuation = parseRowerDataFragment([0x01, 0x00]);
  assert.equal(continuation.valid, true);
  assert.equal(continuation.moreData, true);
  assert.equal(continuation.complete, false);
  assert.equal('strokeRateSpm' in continuation.fields, false);
});

test('decodes every optional flag in the FTMS 1.0.1 field order', () => {
  const cases = [
    [0x0002, [44], 'averageStrokeRateSpm', 22],
    [0x0004, [0x39, 0x30, 0], 'totalDistanceM', 12345],
    [0x0008, [0x2c, 1], 'instantaneousPaceSecPer500m', 300],
    [0x0010, [0x36, 1], 'averagePaceSecPer500m', 310],
    [0x0020, [0x7c, 0xfc], 'instantaneousPowerW', -900],
    [0x0040, [0x96, 0], 'averagePowerW', 150],
    [0x0080, [17], 'resistanceRaw', 17],
    [0x0100, [10, 0, 20, 0, 2], 'energyPerMinuteKcal', 2],
    [0x0200, [145], 'heartRateBpm', 145],
    [0x0400, [83], 'metabolicEquivalentMet', 8.3],
    [0x0800, [0x58, 2], 'elapsedTimeSec', 600],
    [0x1000, [0x78, 0], 'remainingTimeSec', 120],
  ];
  for (const [flag, optional, field, expected] of cases) {
    const parsed = parseRowerDataFragment(withBase(flag, optional));
    assert.equal(parsed.valid, true, `flag 0x${flag.toString(16)}`);
    assert.equal(parsed.fields[field], expected, field);
  }
});

test('uses Data Not Available only for the FTMS energy triplet', () => {
  const allOptionalFlags = 0x1ffe;
  const parsed = parseRowerDataFragment(withBase(allOptionalFlags, [
    0xff,
    0xff, 0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0x7f,
    0x00, 0x80,
    0xff,
    0xff, 0xff, 0xff, 0xff, 0xff,
    0xff,
    0xff,
    0xff, 0xff,
    0xff, 0xff,
  ], 0xff, 0xffff));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.fields.strokeRateSpm, 127.5);
  assert.equal(parsed.fields.strokeCount, 0xffff);
  assert.equal(parsed.fields.averageStrokeRateSpm, 127.5);
  assert.equal(parsed.fields.totalDistanceM, 0xffffff);
  assert.equal(parsed.fields.instantaneousPaceSecPer500m, 0xffff);
  assert.equal(parsed.fields.averagePaceSecPer500m, 0xffff);
  assert.equal(parsed.fields.instantaneousPowerW, 32767);
  assert.equal(parsed.fields.averagePowerW, -32768);
  assert.equal(parsed.fields.resistanceRaw, 0xff);
  assert.equal(parsed.fields.totalEnergyKcal, null);
  assert.equal(parsed.fields.energyPerHourKcal, null);
  assert.equal(parsed.fields.energyPerMinuteKcal, null);
  assert.equal(parsed.fieldStates.totalEnergyKcal, 'unavailable');
  assert.equal(parsed.fields.heartRateBpm, 0xff);
  assert.equal(parsed.fields.metabolicEquivalentMet, 25.5);
  assert.equal(parsed.fields.elapsedTimeSec, 0xffff);
  assert.equal(parsed.fields.remainingTimeSec, 0xffff);
});

test('rejects every truncated prefix and trailing bytes', () => {
  const flags = 0x1ffe;
  const full = withBase(flags, [
    44,
    1, 2, 3,
    4, 5,
    6, 7,
    8, 9,
    10, 11,
    12,
    13, 14, 15, 16, 17,
    18,
    19,
    20, 21,
    22, 23,
  ]);
  assert.equal(parseRowerDataFragment(full).valid, true);
  for (let length = 0; length < full.length; length += 1) {
    assert.equal(parseRowerDataFragment(full.slice(0, length)).valid, false, `prefix ${length}`);
  }
  assert.deepEqual(parseRowerDataFragment([...full, 0]).errors, ['TRAILING_BYTES']);
});

test('preserves signed power boundaries, UINT24 maximum and RFU warnings', () => {
  const minimum = parseRowerDataFragment(withBase(0x0020, [0x00, 0x80]));
  assert.equal(minimum.fields.instantaneousPowerW, -32768);
  const maximum = parseRowerDataFragment(withBase(0x0020, [0xff, 0x7f]));
  assert.equal(maximum.fields.instantaneousPowerW, 32767);
  const distance = parseRowerDataFragment(withBase(0x0004, [0xff, 0xff, 0xff]));
  assert.equal(distance.fields.totalDistanceM, 0xffffff);
  const rfu = parseRowerDataFragment([0x00, 0x20, 40, 1, 0]);
  assert.equal(rfu.valid, true);
  assert.equal(rfu.unknownFlags, 0x2000);
  assert.deepEqual(rfu.warnings, ['RFU_FLAGS_SET']);
});

test('product acceptance requires optional Feature bits while allowing the base pair and RFU', () => {
  const noFeatures = parseFitnessMachineFeature([0, 0, 0, 0, 0, 0, 0, 0]);
  const base = new RowerRecordAssembler().push([0x00, 0x00, 40, 1, 0], {
    generation: 1,
    nowMs: 1000,
  });
  assert.equal(validateRowerRecordAgainstFeature(base, noFeatures).valid, true);

  const distance = new RowerRecordAssembler().push([
    0x04, 0x00, 40, 1, 0, 10, 0, 0,
  ], { generation: 1, nowMs: 1000 });
  assert.deepEqual(
    validateRowerRecordAgainstFeature(distance, noFeatures).errors,
    ['FEATURE_MISSING_totalDistanceM'],
  );
  const distanceFeature = parseFitnessMachineFeature([0x04, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(validateRowerRecordAgainstFeature(distance, distanceFeature).valid, true);

  const rfu = new RowerRecordAssembler().push([0x00, 0x20, 40, 1, 0], {
    generation: 1,
    nowMs: 1000,
  });
  assert.deepEqual(rfu.warnings, ['RFU_FLAGS_SET']);
  assert.equal(validateRowerRecordAgainstFeature(rfu, noFeatures).valid, true);
});

test('product acceptance rejects every appeared out-of-range or non-finite field atomically', () => {
  const feature = parseFitnessMachineFeature([0x20, 0x44, 0, 0, 0, 0, 0, 0]);
  const record = new RowerRecordAssembler().push([
    0x28, 0x02,
    40, 1, 0,
    0xff, 0xff,
    0xff, 0x7f,
    0xff,
  ], { generation: 1, nowMs: 1000 });
  assert.deepEqual(validateRowerRecordAgainstFeature(record, feature).errors, [
    'FIELD_RANGE_instantaneousPaceSecPer500m',
    'FIELD_RANGE_instantaneousPowerW',
    'FIELD_RANGE_heartRateBpm',
  ]);

  const nonFinite = {
    ...record,
    fields: { ...record.fields, heartRateBpm: Number.NaN },
  };
  assert.ok(
    validateRowerRecordAgainstFeature(nonFinite, feature).errors
      .includes('FIELD_RANGE_heartRateBpm'),
  );
});

test('assembles fragments atomically only on the final notification', () => {
  const assembler = new RowerRecordAssembler();
  const partial = assembler.push([0x05, 0x00, 0x39, 0x30, 0], {
    generation: 7,
    nowMs: 1000,
  });
  assert.equal(partial.published, false);
  const complete = assembler.push([0x00, 0x00, 0x34, 0x09, 0x00], {
    generation: 7,
    nowMs: 1500,
  });
  assert.equal(complete.valid, true);
  assert.equal(complete.published, true);
  assert.equal(complete.fragmentCount, 2);
  assert.equal(complete.fields.totalDistanceM, 12345);
  assert.equal(complete.fields.strokeRateSpm, 26);
  assert.equal(complete.fields.strokeCount, 9);
  assert.equal(hasMandatoryRowerTelemetry(complete), true);
});

test('rejects conflicting duplicate fields across fragments', () => {
  const assembler = new RowerRecordAssembler();
  assembler.push([0x05, 0x00, 10, 0, 0], { generation: 1, nowMs: 0 });
  const conflict = assembler.push([0x05, 0x00, 11, 0, 0], {
    generation: 1,
    nowMs: 100,
  });
  assert.equal(conflict.valid, false);
  assert.deepEqual(conflict.errors, ['CONFLICTING_totalDistanceM']);
});

test('drops an expired fragment chain and resets across generations', () => {
  const assembler = new RowerRecordAssembler({ timeoutMs: 100 });
  assembler.push([0x05, 0x00, 7, 0, 0], { generation: 1, nowMs: 0 });
  const expired = assembler.push([0x00, 0x00, 40, 2, 0], {
    generation: 1,
    nowMs: 101,
  });
  assert.equal(expired.published, false);
  assert.deepEqual(expired.errors, ['FRAGMENT_TIMEOUT']);

  assembler.push([0x05, 0x00, 9, 0, 0], { generation: 1, nowMs: 200 });
  const nextGeneration = assembler.push([0x00, 0x00, 42, 3, 0], {
    generation: 2,
    nowMs: 220,
  });
  assert.equal(nextGeneration.published, true);
  assert.equal(nextGeneration.fields.totalDistanceM, undefined);
  assert.equal(nextGeneration.fields.strokeRateSpm, 21);
});

test('mandatory liveness requires a published complete base pair', () => {
  assert.equal(hasMandatoryRowerTelemetry({
    valid: true,
    complete: true,
    published: true,
    fields: { heartRateBpm: 140, elapsedTimeSec: 60 },
  }), false);
  assert.equal(hasMandatoryRowerTelemetry({
    valid: true,
    complete: true,
    published: true,
    fields: { strokeRateSpm: 0, strokeCount: 0 },
  }), true);
  assert.equal(hasMandatoryRowerTelemetry({
    valid: true,
    complete: false,
    published: false,
    fields: { strokeRateSpm: 24, strokeCount: 10 },
  }), false);
});

test('record freshness starts only after a valid record and expires', () => {
  assert.equal(isRowerRecordLive(null, 1000), false);
  assert.equal(isRowerRecordLive(1000, 4500), true);
  assert.equal(isRowerRecordLive(1000, 4501), false);
  assert.equal(isRowerRecordLive(1000, 999), false);
});
