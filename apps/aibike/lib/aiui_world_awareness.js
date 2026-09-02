// AIUI 0.16 preview world-awareness compatibility layer.
//
// This module is deliberately diagnostic-only. Head gestures and orientation
// stability never produce cadence, speed, distance or motion state. The page
// keeps its proven 0.15 sensor pipeline and only records these bounded signals
// when the host exposes the 0.16 page methods.

export const AIUI_WORLD_AWARENESS_STATES = Object.freeze([
  'idle',
  'unsupported',
  'enabled',
  'disabled',
  'error',
]);

export const AIUI_HEAD_GESTURES = Object.freeze([
  'none',
  'nod',
  'shake',
]);

const DUPLICATE_EVENT_WINDOW_MS = 250;
const MAX_DIAGNOSTIC_COUNT = 1000000;

function finiteInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : fallback;
}

function eventAtMs(value, fallback = Date.now()) {
  return finiteInteger(value, finiteInteger(fallback, 0));
}

function diagnosticCount(value) {
  return Math.min(MAX_DIAGNOSTIC_COUNT, finiteInteger(value, 0));
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createAiuiWorldAwarenessDiagnostics();
  }
  const state = AIUI_WORLD_AWARENESS_STATES.includes(value.state)
    ? value.state : 'idle';
  const gesture = AIUI_HEAD_GESTURES.includes(value.lastGesture)
    ? value.lastGesture : 'none';
  return {
    supported: value.supported === true,
    enabled: value.enabled === true,
    cleanupPending: value.cleanupPending === true,
    state,
    generation: finiteInteger(value.generation, 0),
    disableFailedGeneration: finiteInteger(value.disableFailedGeneration),
    enabledAtMs: finiteInteger(value.enabledAtMs),
    disabledAtMs: finiteInteger(value.disabledAtMs),
    lastGesture: gesture,
    lastGestureAtMs: finiteInteger(value.lastGestureAtMs),
    gestureCount: diagnosticCount(value.gestureCount),
    nodCount: diagnosticCount(value.nodCount),
    shakeCount: diagnosticCount(value.shakeCount),
    orientationStable: typeof value.orientationStable === 'boolean'
      ? value.orientationStable : null,
    lastStabilityAtMs: finiteInteger(value.lastStabilityAtMs),
    stabilityChangeCount: diagnosticCount(value.stabilityChangeCount),
    errorCount: diagnosticCount(value.errorCount),
  };
}

export function createAiuiWorldAwarenessDiagnostics() {
  return {
    supported: false,
    enabled: false,
    cleanupPending: false,
    state: 'idle',
    generation: 0,
    disableFailedGeneration: null,
    enabledAtMs: null,
    disabledAtMs: null,
    lastGesture: 'none',
    lastGestureAtMs: null,
    gestureCount: 0,
    nodCount: 0,
    shakeCount: 0,
    orientationStable: null,
    lastStabilityAtMs: null,
    stabilityChangeCount: 0,
    errorCount: 0,
  };
}

export function enableAiuiWorldAwareness(
  page,
  previous,
  options = {},
) {
  const current = normalizeState(previous);
  const generation = finiteInteger(options.generation, current.generation);
  const now = eventAtMs(options.now);
  if (!page || typeof page.enableWorldAwareness !== 'function'
      || typeof page.disableWorldAwareness !== 'function') {
    if (current.cleanupPending) {
      return {
        ...current,
        enabled: false,
        state: 'error',
        disabledAtMs: now,
      };
    }
    return {
      ...current,
      supported: false,
      enabled: false,
      cleanupPending: false,
      state: 'unsupported',
      generation,
      disableFailedGeneration: null,
      enabledAtMs: null,
      disabledAtMs: now,
      lastGesture: 'none',
      lastGestureAtMs: null,
      orientationStable: null,
      lastStabilityAtMs: null,
    };
  }
  if (current.enabled && current.generation === generation) return current;

  let prepared = current;
  if (current.cleanupPending || current.enabled) {
    try {
      page.disableWorldAwareness();
      prepared = {
        ...current,
        enabled: false,
        cleanupPending: false,
        state: 'disabled',
        disabledAtMs: now,
        disableFailedGeneration: null,
        orientationStable: null,
        lastStabilityAtMs: null,
      };
    } catch (_error) {
      return {
        ...current,
        supported: true,
        enabled: false,
        cleanupPending: true,
        state: 'error',
        disabledAtMs: now,
        disableFailedGeneration: current.generation,
        orientationStable: null,
        lastStabilityAtMs: null,
        errorCount: diagnosticCount(current.errorCount + 1),
      };
    }
  }
  try {
    page.enableWorldAwareness();
    return {
      ...prepared,
      supported: true,
      enabled: true,
      cleanupPending: false,
      state: 'enabled',
      generation,
      disableFailedGeneration: null,
      enabledAtMs: now,
      disabledAtMs: null,
      lastGesture: 'none',
      lastGestureAtMs: null,
      orientationStable: null,
      lastStabilityAtMs: null,
    };
  } catch (_error) {
    return {
      ...prepared,
      supported: true,
      enabled: false,
      cleanupPending: true,
      state: 'error',
      generation,
      disableFailedGeneration: generation,
      enabledAtMs: null,
      disabledAtMs: now,
      lastGesture: 'none',
      lastGestureAtMs: null,
      orientationStable: null,
      lastStabilityAtMs: null,
      errorCount: diagnosticCount(prepared.errorCount + 1),
    };
  }
}

export function disableAiuiWorldAwareness(
  page,
  previous,
  options = {},
) {
  const current = normalizeState(previous);
  const now = eventAtMs(options.now);
  if (!current.enabled && !current.cleanupPending
      && (!current.supported || current.state === 'disabled')) {
    return {
      ...current,
      enabled: false,
      cleanupPending: false,
      state: current.state === 'enabled' ? 'disabled' : current.state,
      disabledAtMs: current.disabledAtMs ?? now,
      disableFailedGeneration: null,
    };
  }
  try {
    if (page && typeof page.disableWorldAwareness === 'function') {
      page.disableWorldAwareness();
    }
    return {
      ...current,
      enabled: false,
      cleanupPending: false,
      state: 'disabled',
      disabledAtMs: now,
      disableFailedGeneration: null,
      orientationStable: null,
      lastStabilityAtMs: null,
    };
  } catch (_error) {
    return {
      ...current,
      enabled: false,
      cleanupPending: true,
      state: 'error',
      disabledAtMs: now,
      disableFailedGeneration: current.generation,
      orientationStable: null,
      lastStabilityAtMs: null,
      errorCount: diagnosticCount(current.errorCount + 1),
    };
  }
}

export function recordAiuiHeadGesture(previous, event, options = {}) {
  const current = normalizeState(previous);
  if (!current.enabled) return current;
  const generation = finiteInteger(options.generation, current.generation);
  if (generation !== current.generation) return current;
  const gesture = event && AIUI_HEAD_GESTURES.includes(event.gesture)
    ? event.gesture : null;
  if (!gesture || gesture === 'none') return current;
  const now = eventAtMs(options.now);
  if (current.lastGesture === gesture
      && current.lastGestureAtMs != null
      && now - current.lastGestureAtMs < DUPLICATE_EVENT_WINDOW_MS) {
    return current;
  }
  return {
    ...current,
    lastGesture: gesture,
    lastGestureAtMs: now,
    gestureCount: diagnosticCount(current.gestureCount + 1),
    nodCount: diagnosticCount(current.nodCount + (gesture === 'nod' ? 1 : 0)),
    shakeCount: diagnosticCount(
      current.shakeCount + (gesture === 'shake' ? 1 : 0),
    ),
  };
}

export function recordAiuiOrientationStability(
  previous,
  event,
  options = {},
) {
  const current = normalizeState(previous);
  if (!current.enabled || !event || typeof event.stable !== 'boolean') {
    return current;
  }
  const generation = finiteInteger(options.generation, current.generation);
  if (generation !== current.generation) return current;
  const now = eventAtMs(options.now);
  if (current.orientationStable === event.stable) return current;
  return {
    ...current,
    orientationStable: event.stable,
    lastStabilityAtMs: now,
    stabilityChangeCount: diagnosticCount(current.stabilityChangeCount + 1),
  };
}

export function snapshotAiuiWorldAwareness(previous, now = Date.now()) {
  const current = normalizeState(previous);
  const age = (value) => value == null ? null : Math.max(0, eventAtMs(now) - value);
  return {
    supported: current.supported,
    enabled: current.enabled,
    cleanupPending: current.cleanupPending,
    state: current.state,
    generation: current.generation,
    disableFailedGeneration: current.disableFailedGeneration,
    headGesture: current.lastGesture,
    headGestureAgeMs: age(current.lastGestureAtMs),
    headGestureCount: current.gestureCount,
    headNodCount: current.nodCount,
    headShakeCount: current.shakeCount,
    orientationStable: current.orientationStable,
    orientationStabilityAgeMs: age(current.lastStabilityAtMs),
    orientationStabilityChangeCount: current.stabilityChangeCount,
    errorCount: current.errorCount,
  };
}
