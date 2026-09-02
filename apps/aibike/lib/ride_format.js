function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// 两位公里显示的最小分辨率：不足 5 米会舍入成 0.00 公里。
export const MIN_DISTANCE_DISPLAY_M = 5;

export function formatElapsed(elapsedMs) {
  const numeric = finite(elapsedMs);
  const totalSeconds = Math.max(0, Math.floor((numeric ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatSpeedKmh(speedKmh, unavailable = '未记录') {
  const numeric = finite(speedKmh);
  if (numeric == null || numeric < 0 || numeric > 150) return unavailable;
  return numeric.toFixed(1);
}

export function formatDistanceKm(distanceM, unavailable = '未记录') {
  const numeric = finite(distanceM);
  if (numeric == null || numeric < 0) return unavailable;
  return (numeric / 1000).toFixed(2);
}

export function formatCadenceRpm(cadenceRpm, unavailable = '未记录') {
  const numeric = finite(cadenceRpm);
  if (numeric == null || numeric < 0 || numeric > 250) return unavailable;
  return String(Math.round(numeric));
}

export function formatPowerW(powerW, unavailable = '未记录') {
  const numeric = finite(powerW);
  if (numeric == null || numeric < 0 || numeric > 3000) return unavailable;
  return String(Math.round(numeric));
}

export function formatBpm(bpm, unavailable = '未记录') {
  const numeric = finite(bpm);
  if (numeric == null || numeric <= 0 || numeric >= 255) return unavailable;
  return String(Math.round(numeric));
}

export function averageSpeedKmh(distanceM, movingMs) {
  const distance = finite(distanceM);
  const duration = finite(movingMs);
  if (distance == null || distance <= 0 || duration == null || duration <= 0) return null;
  return (distance / 1000) / (duration / 3600000);
}
