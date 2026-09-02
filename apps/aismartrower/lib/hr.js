export const HEART_RATE_SERVICE_UUID =
  '0000180d-0000-1000-8000-00805f9b34fb';
export const HEART_RATE_MEASUREMENT_UUID =
  '00002a37-0000-1000-8000-00805f9b34fb';

const HEART_RATE_UINT16_FLAG = 0x01;
const SENSOR_CONTACT_STATUS_FLAG = 0x02;
const SENSOR_CONTACT_SUPPORTED_FLAG = 0x04;
const ENERGY_EXPENDED_FLAG = 0x08;
const RR_INTERVAL_FLAG = 0x10;
const RFU_FLAGS = 0xe0;

export function toHeartRateBytes(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const bytes = [];
    for (const item of value) {
      if (typeof item !== 'number' || !Number.isInteger(item)
          || item < 0 || item > 0xff) return [];
      bytes.push(item);
    }
    return bytes;
  }
  try {
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return Array.from(new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ));
    }
  } catch (_error) {
    return [];
  }
  return [];
}

function invalid(rawLength, flags, error) {
  return {
    valid: false,
    usable: false,
    rawLength,
    flags,
    errors: [error],
  };
}

function u16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/**
 * Strict parser for Bluetooth Heart Rate Measurement 0x2A37.
 *
 * This is a protocol parser, not a human physiology policy. In particular,
 * UINT16 values above 255 are valid HRS encodings. Product code can apply a
 * narrower display/summary range after parsing.
 */
export function parseHeartRateMeasurement(value) {
  const bytes = toHeartRateBytes(value);
  const rawLength = bytes.length;
  if (rawLength < 2) return invalid(rawLength, null, 'TRUNCATED_FLAGS_OR_HEART_RATE');

  const flags = bytes[0];
  if ((flags & RFU_FLAGS) !== 0) return invalid(rawLength, flags, 'RFU_FLAGS_SET');

  const contactSupported = (flags & SENSOR_CONTACT_SUPPORTED_FLAG) !== 0;
  const contactStatusSet = (flags & SENSOR_CONTACT_STATUS_FLAG) !== 0;
  // HRS defines 0b01 for bits 2:1 as RFU. A server that does not support
  // contact detection must not assert the contact-status bit.
  if (!contactSupported && contactStatusSet) {
    return invalid(rawLength, flags, 'INVALID_CONTACT_FLAGS');
  }

  let offset = 1;
  const isUint16 = (flags & HEART_RATE_UINT16_FLAG) !== 0;
  const heartRateWidth = isUint16 ? 2 : 1;
  if (offset + heartRateWidth > rawLength) {
    return invalid(rawLength, flags, 'TRUNCATED_HEART_RATE');
  }
  const heartRateBpm = isUint16 ? u16le(bytes, offset) : bytes[offset];
  offset += heartRateWidth;

  let energyExpendedKj = null;
  if ((flags & ENERGY_EXPENDED_FLAG) !== 0) {
    if (offset + 2 > rawLength) {
      return invalid(rawLength, flags, 'TRUNCATED_ENERGY_EXPENDED');
    }
    energyExpendedKj = u16le(bytes, offset);
    offset += 2;
  }

  const rrIntervals1024 = [];
  if ((flags & RR_INTERVAL_FLAG) !== 0) {
    const remaining = rawLength - offset;
    if (remaining < 2) return invalid(rawLength, flags, 'RR_INTERVAL_MISSING');
    if (remaining % 2 !== 0) {
      return invalid(rawLength, flags, 'TRUNCATED_RR_INTERVAL');
    }
    while (offset < rawLength) {
      rrIntervals1024.push(u16le(bytes, offset));
      offset += 2;
    }
  } else if (offset !== rawLength) {
    return invalid(rawLength, flags, 'UNEXPECTED_TRAILING_BYTES');
  }

  const contactDetected = contactSupported ? contactStatusSet : null;
  return {
    valid: true,
    // Zero and an explicit no-contact sample are legal encodings but must not
    // enter the product's current/max/average heart-rate values.
    usable: heartRateBpm > 0 && contactDetected !== false,
    rawLength,
    flags,
    format: isUint16 ? 'uint16' : 'uint8',
    heartRateBpm,
    contactSupported,
    contactDetected,
    energyExpendedKj,
    rrIntervals1024,
    errors: [],
  };
}
