// Durable ACK-only sports completion/activity outbox.

import { normalizeWxJsonResponse } from './wx_json.js';
import {
  SPORTS_ACCEPT_LANGUAGE,
  normalizeSportsBaseUrl,
  sportsOwnerMarker,
} from './sports_identity.js';

export const SPORTS_ACTIVITY_PATH =
  '/api/coach-svc/coach/aiui-sports/activities';
export const SPORTS_WORKOUT_COMPLETE_PATH_PREFIX =
  '/api/coach-svc/coach/aiui-sports/workouts/';
export const SPORTS_OUTBOX_KEY = 'aibike_sports_outbox_v1';
export const SPORTS_OUTBOX_MAX = 24;

const ID_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const WORKOUT_ID_RE = /^spw_[a-f0-9]{24}$/;

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function metric(value, min, max) {
  const n = finite(value, min, max);
  return n == null ? undefined : Number(n.toFixed(3));
}

function normalizeMetrics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, min, max] of [
    ['avg_speed_kmh', 0, 150], ['max_speed_kmh', 0, 150],
    ['avg_cadence_rpm', 0, 250], ['max_cadence_rpm', 0, 250],
    ['avg_power_w', 0, 2500], ['max_power_w', 0, 2500],
    ['avg_heart_rate_bpm', 20, 240], ['max_heart_rate_bpm', 20, 240],
  ]) {
    const normalized = metric(source[key], min, max);
    if (normalized !== undefined) result[key] = normalized;
  }
  const heartCoverage = metric(source.heart_rate_coverage_pct, 0, 100);
  if (heartCoverage !== undefined) result.heart_rate_coverage_pct = heartCoverage;
  const sourceCoverage = {};
  const rawCoverage = source.source_coverage && typeof source.source_coverage === 'object'
    ? source.source_coverage : {};
  for (const name of ['hrs', 'csc', 'cps', 'ftms', 'gps', 'imu']) {
    const value = metric(rawCoverage[name], 0, 100);
    if (value !== undefined) sourceCoverage[name] = value;
  }
  if (Object.keys(sourceCoverage).length) result.source_coverage = sourceCoverage;
  if (Array.isArray(source.sensor_sources)) {
    const sensorSources = [];
    for (const item of source.sensor_sources) {
      if (['hrs', 'csc', 'cps', 'ftms', 'gps', 'imu'].includes(item)
          && !sensorSources.includes(item)) sensorSources.push(item);
      if (sensorSources.length >= 6) break;
    }
    if (sensorSources.length) result.sensor_sources = sensorSources;
  }
  return result;
}

export function buildCyclingSportsMetrics(summary, options = {}) {
  const sensors = [];
  if (Array.isArray(summary && summary.sources)) {
    for (const item of summary.sources) {
      const source = item === 'cadence_model' ? 'imu' : item;
      if (['hrs', 'csc', 'cps', 'ftms', 'imu'].includes(source)
          && !sensors.includes(source)) sensors.push(source);
    }
  }
  const sourceCoverage = options.source_coverage && typeof options.source_coverage === 'object'
    ? options.source_coverage : undefined;
  return normalizeMetrics({
    avg_speed_kmh: summary && summary.avgSpeedKmh,
    max_speed_kmh: summary && summary.maxSpeedKmh,
    avg_cadence_rpm: summary && summary.avgCadenceRpm,
    max_cadence_rpm: summary && summary.maxCadenceRpm,
    avg_power_w: summary && summary.avgPowerW,
    max_power_w: summary && summary.maxPowerW,
    avg_heart_rate_bpm: summary && summary.avgBpm,
    max_heart_rate_bpm: summary && summary.maxBpm,
    source_coverage: sourceCoverage,
    sensor_sources: sensors,
  });
}

function normalizeStageResult(value) {
  if (!value || typeof value !== 'object') return null;
  const stageId = String(value.stage_id || '');
  const durationSec = finite(value.duration_sec, 0, 21600);
  const distanceM = finite(value.distance_m, 0, 1000000);
  if (!/^sps_[a-f0-9]{24}$/.test(stageId) || durationSec == null || distanceM == null
      || !['completed', 'partial'].includes(value.status)) return null;
  return {
    stage_id: stageId,
    status: value.status,
    duration_sec: Math.round(durationSec),
    distance_m: Number(distanceM.toFixed(1)),
    // Hermes 的阶段指标契约比整场指标更窄。目标达标秒数与来源秒数只在
    // 眼镜端用于即时总结，不能透传为未知字段导致整个 completion 422。
    metrics: (() => {
      const source = value.metrics && typeof value.metrics === 'object'
        ? value.metrics : {};
      const result = {};
      const speed = metric(source.avg_speed_kmh, 0, 150);
      const heart = metric(source.avg_heart_rate_bpm, 20, 240);
      if (speed !== undefined) result.avg_speed_kmh = speed;
      if (heart !== undefined) result.avg_heart_rate_bpm = heart;
      return result;
    })(),
  };
}

export function normalizeSportsOutboxEvent(value) {
  if (!value || typeof value !== 'object' || !['activity', 'completion'].includes(value.kind)) {
    return null;
  }
  const marker = sportsOwnerMarker(value.owner);
  const clientId = String(value.client_execution_id || '');
  const startedAt = finite(value.started_at_ms, 946684800000, 4102444800000);
  const endedAt = finite(value.ended_at_ms, 946684800000, 4102444800000);
  const duration = finite(value.duration_sec, 0, 172800);
  const distance = finite(value.distance_m, 0, 1000000);
  if (!marker || !ID_RE.test(clientId) || startedAt == null || endedAt == null
      || endedAt < startedAt || duration == null || distance == null) return null;
  const allowedStatuses = value.kind === 'completion'
    ? ['completed', 'partial', 'aborted'] : ['completed', 'partial'];
  if (!allowedStatuses.includes(value.status)) return null;
  const event = {
    kind: value.kind,
    owner: marker,
    client_execution_id: clientId,
    status: value.status,
    started_at_ms: Math.round(startedAt),
    ended_at_ms: Math.round(endedAt),
    duration_sec: Math.round(duration),
    distance_m: Number(distance.toFixed(1)),
    metrics: normalizeMetrics(value.metrics),
  };
  if (event.kind === 'completion') {
    const workoutId = String(value.workout_id || '');
    const revision = Number(value.revision);
    const rawStages = Array.isArray(value.stage_results) ? value.stage_results : [];
    const stages = rawStages.map(normalizeStageResult);
    if (!WORKOUT_ID_RE.test(workoutId) || !Number.isSafeInteger(revision) || revision < 1
        || !rawStages.length || stages.some((stage) => !stage)) return null;
    event.workout_id = workoutId;
    event.revision = revision;
    event.stage_results = stages;
  }
  return event;
}

export function readSportsOutbox(storage, identity) {
  try {
    const values = storage && typeof storage.getStorageSync === 'function'
      ? storage.getStorageSync(SPORTS_OUTBOX_KEY) : [];
    if (!Array.isArray(values)) return [];
    const marker = sportsOwnerMarker(identity);
    return values.map(normalizeSportsOutboxEvent).filter(
      (item) => item && JSON.stringify(item.owner) === JSON.stringify(marker),
    ).slice(-SPORTS_OUTBOX_MAX);
  } catch (_error) {
    return [];
  }
}

export function writeSportsOutbox(storage, events, identity) {
  if (!storage || typeof storage.setStorageSync !== 'function') return null;
  const normalized = Array.isArray(events)
    ? events.map(normalizeSportsOutboxEvent).filter(Boolean).filter(
      (item) => JSON.stringify(item.owner) === JSON.stringify(sportsOwnerMarker(identity)),
    ).slice(-SPORTS_OUTBOX_MAX) : [];
  try {
    storage.setStorageSync(SPORTS_OUTBOX_KEY, normalized);
    const readback = readSportsOutbox(storage, identity);
    return JSON.stringify(readback) === JSON.stringify(normalized) ? readback : null;
  } catch (_error) {
    return null;
  }
}

export function enqueueSportsOutbox(storage, event, identity) {
  const normalized = normalizeSportsOutboxEvent(event);
  if (!normalized || JSON.stringify(normalized.owner)
      !== JSON.stringify(sportsOwnerMarker(identity))) return null;
  const events = readSportsOutbox(storage, identity).filter(
    (item) => item.client_execution_id !== normalized.client_execution_id,
  );
  events.push(normalized);
  return writeSportsOutbox(storage, events, identity);
}

export function buildSportsOutboxRequest(event, identity, options = {}) {
  const normalized = normalizeSportsOutboxEvent(event);
  if (!normalized || JSON.stringify(normalized.owner)
      !== JSON.stringify(sportsOwnerMarker(identity))) return null;
  const data = { ...normalized };
  delete data.kind;
  delete data.owner;
  const path = normalized.kind === 'completion'
    ? SPORTS_WORKOUT_COMPLETE_PATH_PREFIX + normalized.workout_id + '/complete'
    : SPORTS_ACTIVITY_PATH;
  if (normalized.kind === 'completion') delete data.workout_id;
  return {
    url: normalizeSportsBaseUrl(options.baseUrl) + path,
    method: 'POST',
    header: {
      Authorization: 'Bearer ' + identity.token,
      'Content-Type': 'application/json',
      'Accept-Language': SPORTS_ACCEPT_LANGUAGE,
    },
    data,
    dataType: 'json',
    responseType: 'text',
    timeout: Number(options.timeout) || 12000,
  };
}

export function parseSportsAck(response) {
  const status = Number(response && response.statusCode);
  const normalized = normalizeWxJsonResponse(response);
  const data = normalized && normalized.data;
  if (!(status >= 200 && status < 300) || !data || data.accepted !== true) return null;
  const id = String(data.activity_id || '');
  const rawReview = data.review && typeof data.review === 'object' ? data.review : null;
  const reviewCopy = rawReview ? [
    String(rawReview.headline || '').slice(0, 40),
    String(rawReview.detail || '').slice(0, 120),
    String(rawReview.next_focus || '').slice(0, 80),
  ] : [];
  const reviewMatchesLocale = SPORTS_ACCEPT_LANGUAGE === 'zh-CN'
    || (SPORTS_ACCEPT_LANGUAGE === 'en-US'
      && reviewCopy.some(Boolean) && !reviewCopy.some((item) => /[\u3040-\u30ff\u3400-\u9fff]/.test(item)))
    || (SPORTS_ACCEPT_LANGUAGE === 'ja-JP'
      && reviewCopy.some((item) => /[\u3040-\u30ff]/.test(item)));
  return /^spa_[a-f0-9]{24}$/.test(id) ? {
    activity_id: id,
    duplicate: data.duplicate === true,
    review: rawReview && reviewMatchesLocale ? {
      headline: reviewCopy[0],
      detail: reviewCopy[1],
      next_focus: reviewCopy[2],
      confidence: String(rawReview.confidence || '').slice(0, 16),
      source: String(rawReview.source || '').slice(0, 24),
      generated_at_ms: Number(rawReview.generated_at_ms) || 0,
    } : null,
    memory_status: String(data.memory_status || '').slice(0, 32),
  } : null;
}

export async function flushSportsOutbox(options = {}) {
  const { storage, identity, request } = options;
  if (!storage || !identity || typeof request !== 'function') {
    return { status: 'pending', acked: 0, pending: 0, reason: 'unavailable' };
  }
  const events = readSportsOutbox(storage, identity);
  let acked = 0;
  let review = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const requestOptions = buildSportsOutboxRequest(event, identity, options);
    if (!requestOptions) break;
    let response = null;
    try { response = await request(requestOptions); } catch (_error) {}
    if (Number(response && response.statusCode) === 401
        && options.refreshIdentity && options.authRefreshUsed !== true) {
      const refreshed = await options.refreshIdentity();
      if (refreshed && JSON.stringify(sportsOwnerMarker(refreshed))
          === JSON.stringify(sportsOwnerMarker(identity))) {
        return flushSportsOutbox({ ...options, identity: refreshed, authRefreshUsed: true });
      }
    }
    const parsed = parseSportsAck(response);
    if (!parsed) return {
      status: 'pending', acked, pending: events.length - acked,
      statusCode: Number(response && response.statusCode) || 0, review,
    };
    const remaining = readSportsOutbox(storage, identity).filter(
      (item) => item.client_execution_id !== event.client_execution_id,
    );
    if (!writeSportsOutbox(storage, remaining, identity)) {
      return { status: 'pending', acked, pending: remaining.length + 1, reason: 'storage', review };
    }
    acked += 1;
    if (parsed.review) review = parsed.review;
  }
  return { status: 'acked', acked, pending: readSportsOutbox(storage, identity).length, review };
}

export function createSportsExecutionId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(Math.abs(Number(random()) || 0) * 0x100000000)
    .toString(36).padStart(7, '0').slice(0, 7);
  return `bike-${Math.floor(Number(now)).toString(36)}-${suffix}`;
}
