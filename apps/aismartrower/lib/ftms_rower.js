// Pure Bluetooth SIG Fitness Machine Service (FTMS) Rower Data support.
// This module owns no UI, navigator, timers, logging, or device identifiers.

export const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
export const FTMS_FEATURE_UUID = '00002acc-0000-1000-8000-00805f9b34fb';
export const FTMS_ROWER_DATA_UUID = '00002ad1-0000-1000-8000-00805f9b34fb';

export const ROWER_FRAGMENT_TIMEOUT_MS = 2500;
export const ROWER_LIVE_WINDOW_MS = 3500;

export function toFtmsBytes(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (!value.every((item) => Number.isInteger(item) && item >= 0 && item <= 0xff)) {
      return [];
    }
    return value.slice();
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  return [];
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readS16LE(bytes, offset) {
  const raw = readU16LE(bytes, offset);
  return raw & 0x8000 ? raw - 0x10000 : raw;
}

function readU24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function direct(read) {
  return { read, unavailable: () => false };
}

function energy(read, sentinel) {
  return { read, unavailable: (bytes, offset) => read(bytes, offset) === sentinel };
}

// FTMS 1.0.1 Rower Data field order. Only the expended-energy triplet has
// explicit Data Not Available values in the service specification. Other
// maximum encodings are preserved until an applicable assigned definition or
// target-device capture proves a different rule.
const ROWER_FIELDS = Object.freeze([
  { name: 'strokeRateSpm', present: (flags) => !(flags & 0x0001), width: 1,
    ...direct((bytes, offset) => bytes[offset] * 0.5) },
  { name: 'strokeCount', present: (flags) => !(flags & 0x0001), width: 2,
    ...direct(readU16LE) },
  { name: 'averageStrokeRateSpm', present: (flags) => !!(flags & 0x0002), width: 1,
    ...direct((bytes, offset) => bytes[offset] * 0.5) },
  { name: 'totalDistanceM', present: (flags) => !!(flags & 0x0004), width: 3,
    ...direct(readU24LE) },
  { name: 'instantaneousPaceSecPer500m', present: (flags) => !!(flags & 0x0008), width: 2,
    ...direct(readU16LE) },
  { name: 'averagePaceSecPer500m', present: (flags) => !!(flags & 0x0010), width: 2,
    ...direct(readU16LE) },
  { name: 'instantaneousPowerW', present: (flags) => !!(flags & 0x0020), width: 2,
    ...direct(readS16LE) },
  { name: 'averagePowerW', present: (flags) => !!(flags & 0x0040), width: 2,
    ...direct(readS16LE) },
  { name: 'resistanceRaw', present: (flags) => !!(flags & 0x0080), width: 1,
    ...direct((bytes, offset) => bytes[offset]) },
  { name: 'totalEnergyKcal', present: (flags) => !!(flags & 0x0100), width: 2,
    ...energy(readU16LE, 0xffff) },
  { name: 'energyPerHourKcal', present: (flags) => !!(flags & 0x0100), width: 2,
    ...energy(readU16LE, 0xffff) },
  { name: 'energyPerMinuteKcal', present: (flags) => !!(flags & 0x0100), width: 1,
    ...energy((bytes, offset) => bytes[offset], 0xff) },
  { name: 'heartRateBpm', present: (flags) => !!(flags & 0x0200), width: 1,
    ...direct((bytes, offset) => bytes[offset]) },
  { name: 'metabolicEquivalentMet', present: (flags) => !!(flags & 0x0400), width: 1,
    ...direct((bytes, offset) => bytes[offset] * 0.1) },
  { name: 'elapsedTimeSec', present: (flags) => !!(flags & 0x0800), width: 2,
    ...direct(readU16LE) },
  { name: 'remainingTimeSec', present: (flags) => !!(flags & 0x1000), width: 2,
    ...direct(readU16LE) },
]);

// Fitness Machine Feature bits required by the optional Rower Data fields
// consumed by this product. The mandatory Stroke Rate / Stroke Count pair is
// intrinsic to Rower Data and remains valid when the feature bitmap is zero.
const ROWER_OPTIONAL_FEATURES = Object.freeze([
  { flag: 0x0002, feature: 0x00000002, name: 'averageStrokeRateSpm' },
  { flag: 0x0004, feature: 0x00000004, name: 'totalDistanceM' },
  { flag: 0x0018, feature: 0x00000020, name: 'pace' },
  { flag: 0x0080, feature: 0x00000080, name: 'resistanceRaw' },
  { flag: 0x0100, feature: 0x00000200, name: 'energy' },
  { flag: 0x0200, feature: 0x00000400, name: 'heartRateBpm' },
  { flag: 0x0400, feature: 0x00000800, name: 'metabolicEquivalentMet' },
  { flag: 0x0800, feature: 0x00001000, name: 'elapsedTimeSec' },
  { flag: 0x1000, feature: 0x00002000, name: 'remainingTimeSec' },
  { flag: 0x0060, feature: 0x00004000, name: 'power' },
]);

// The parser above preserves the full assigned encodings. This second, pure
// gate applies the narrower product ranges used by the indoor ledger before a
// complete data set may establish or refresh liveness.
const ROWER_PRODUCT_FIELD_RULES = Object.freeze({
  strokeRateSpm: { minimum: 0, maximum: 127.5 },
  strokeCount: { minimum: 0, maximum: 0xffff, integer: true },
  averageStrokeRateSpm: { minimum: 0, maximum: 127.5 },
  totalDistanceM: { minimum: 0, maximum: 0xffffff, integer: true },
  instantaneousPaceSecPer500m: { minimum: 1, maximum: 3600, integer: true },
  averagePaceSecPer500m: { minimum: 1, maximum: 3600, integer: true },
  instantaneousPowerW: { minimum: -1000, maximum: 3000, integer: true },
  averagePowerW: { minimum: -1000, maximum: 3000, integer: true },
  resistanceRaw: { minimum: 0, maximum: 0xff, integer: true },
  totalEnergyKcal: { minimum: 0, maximum: 0xfffe, integer: true, nullable: true },
  energyPerHourKcal: { minimum: 0, maximum: 0xfffe, integer: true, nullable: true },
  energyPerMinuteKcal: { minimum: 0, maximum: 0xfe, integer: true, nullable: true },
  heartRateBpm: { minimum: 20, maximum: 240, integer: true },
  metabolicEquivalentMet: { minimum: 0, maximum: 25.5 },
  elapsedTimeSec: { minimum: 0, maximum: 0xffff, integer: true },
  remainingTimeSec: { minimum: 0, maximum: 0xffff, integer: true },
});

export function parseFitnessMachineFeature(value) {
  const bytes = toFtmsBytes(value);
  if (bytes.length !== 8) {
    return {
      valid: false,
      rawLength: bytes.length,
      errors: ['FEATURE_LENGTH'],
      warnings: [],
    };
  }
  const machineFeatures = (bytes[0] | (bytes[1] << 8)
    | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const targetFeatures = (bytes[4] | (bytes[5] << 8)
    | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  return {
    valid: true,
    machineFeatures,
    targetFeatures,
    rawLength: 8,
    errors: [],
    warnings: [],
  };
}

export function parseRowerDataFragment(value) {
  const bytes = toFtmsBytes(value);
  if (bytes.length < 2) {
    return {
      valid: false,
      partial: true,
      complete: false,
      rawLength: bytes.length,
      fields: {},
      fieldStates: {},
      errors: ['FLAGS_TRUNCATED'],
      warnings: [],
    };
  }

  const flags = readU16LE(bytes, 0);
  const moreData = !!(flags & 0x0001);
  const unknownFlags = flags & 0xe000;
  const fields = {};
  const fieldStates = {};
  let offset = 2;

  for (const field of ROWER_FIELDS) {
    if (!field.present(flags)) continue;
    if (offset + field.width > bytes.length) {
      return {
        valid: false,
        partial: true,
        complete: false,
        flags,
        moreData,
        unknownFlags,
        rawLength: bytes.length,
        fields,
        fieldStates,
        errors: [`TRUNCATED_${field.name}`],
        warnings: unknownFlags ? ['RFU_FLAGS_SET'] : [],
      };
    }
    const unavailable = field.unavailable(bytes, offset);
    fields[field.name] = unavailable ? null : field.read(bytes, offset);
    fieldStates[field.name] = unavailable ? 'unavailable' : 'present';
    offset += field.width;
  }

  if (offset !== bytes.length) {
    return {
      valid: false,
      partial: false,
      complete: false,
      flags,
      moreData,
      unknownFlags,
      rawLength: bytes.length,
      fields,
      fieldStates,
      errors: ['TRAILING_BYTES'],
      warnings: unknownFlags ? ['RFU_FLAGS_SET'] : [],
    };
  }

  return {
    valid: true,
    partial: moreData,
    complete: !moreData,
    flags,
    moreData,
    unknownFlags,
    rawLength: bytes.length,
    fields,
    fieldStates,
    errors: [],
    warnings: unknownFlags ? ['RFU_FLAGS_SET'] : [],
  };
}

function sameFieldValue(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

export class RowerRecordAssembler {
  constructor({ timeoutMs = ROWER_FRAGMENT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.reset('init');
  }

  reset(reason = 'reset') {
    this.generation = null;
    this.startedAtMs = null;
    this.fragmentCount = 0;
    this.flags = 0;
    this.fields = {};
    this.fieldStates = {};
    this.warnings = new Set();
    this.resetReason = reason;
  }

  push(value, { generation = 0, nowMs = Date.now() } = {}) {
    if (this.generation != null && this.generation !== generation) {
      this.reset('generation');
    }
    if (this.startedAtMs != null && nowMs - this.startedAtMs > this.timeoutMs) {
      // The final packet cannot be correlated after the previous fragments
      // expire, so conservatively discard it with the incomplete record.
      this.reset('timeout');
      return {
        valid: false,
        partial: true,
        complete: false,
        published: false,
        errors: ['FRAGMENT_TIMEOUT'],
        warnings: [],
      };
    }

    const parsed = parseRowerDataFragment(value);
    if (!parsed.valid) {
      this.reset('malformed');
      return { ...parsed, complete: false, published: false };
    }

    if (this.generation == null) this.generation = generation;
    if (parsed.moreData && this.startedAtMs == null) this.startedAtMs = nowMs;
    this.fragmentCount += 1;

    for (const [name, next] of Object.entries(parsed.fields)) {
      if (Object.prototype.hasOwnProperty.call(this.fields, name)
          && !sameFieldValue(this.fields[name], next)) {
        this.reset('conflicting_field');
        return {
          valid: false,
          partial: false,
          complete: false,
          published: false,
          errors: [`CONFLICTING_${name}`],
          warnings: [],
        };
      }
      this.fields[name] = next;
      this.fieldStates[name] = parsed.fieldStates[name];
    }
    this.flags |= parsed.flags;
    for (const warning of parsed.warnings) this.warnings.add(warning);

    if (parsed.moreData) {
      return {
        ...parsed,
        complete: false,
        published: false,
        fragmentCount: this.fragmentCount,
      };
    }

    const record = {
      valid: true,
      partial: false,
      complete: true,
      published: true,
      generation,
      // Clear More Data in the assembled final-record view while retaining
      // every optional-field presence bit observed across fragments.
      flags: this.flags & 0xfffe,
      unknownFlags: this.flags & 0xe000,
      fields: { ...this.fields },
      fieldStates: { ...this.fieldStates },
      fragmentCount: this.fragmentCount,
      receivedAtMs: nowMs,
      errors: [],
      warnings: [...this.warnings],
    };
    this.reset('published');
    return record;
  }
}

export function hasMandatoryRowerTelemetry(record) {
  if (!record || record.valid !== true || record.complete !== true
      || record.published !== true || !record.fields) return false;
  return Number.isFinite(record.fields.strokeRateSpm)
    && Number.isInteger(record.fields.strokeCount)
    && record.fields.strokeCount >= 0;
}

export function validateRowerRecordAgainstFeature(record, feature) {
  const errors = [];
  if (!record || record.valid !== true || record.complete !== true
      || record.published !== true || !record.fields) {
    return { valid: false, errors: ['RECORD_INCOMPLETE'] };
  }
  if (!Number.isInteger(record.flags) || record.flags < 0 || record.flags > 0xffff) {
    errors.push('FLAGS_INVALID');
  }
  if (!feature || feature.valid !== true
      || !Number.isInteger(feature.machineFeatures)
      || feature.machineFeatures < 0 || feature.machineFeatures > 0xffffffff) {
    errors.push('FEATURE_INVALID');
  }

  for (const [name, rule] of Object.entries(ROWER_PRODUCT_FIELD_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(record.fields, name)) continue;
    const value = record.fields[name];
    if (value == null && rule.nullable === true) continue;
    if (!Number.isFinite(value)
        || (rule.integer === true && !Number.isInteger(value))
        || value < rule.minimum || value > rule.maximum) {
      errors.push(`FIELD_RANGE_${name}`);
    }
  }

  if (feature && feature.valid === true && Number.isInteger(feature.machineFeatures)
      && Number.isInteger(record.flags)) {
    const machineFeatures = feature.machineFeatures >>> 0;
    for (const requirement of ROWER_OPTIONAL_FEATURES) {
      if ((record.flags & requirement.flag) !== 0
          && (machineFeatures & requirement.feature) === 0) {
        errors.push(`FEATURE_MISSING_${requirement.name}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isRowerRecordLive(
  lastValidAtMs,
  nowMs = Date.now(),
  windowMs = ROWER_LIVE_WINDOW_MS,
) {
  return Number.isFinite(lastValidAtMs)
    && Number.isFinite(nowMs)
    && nowMs >= lastValidAtMs
    && nowMs - lastValidAtMs <= windowMs;
}
