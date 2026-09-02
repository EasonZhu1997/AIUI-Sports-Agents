import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPORT_AGENT_LOCALE,
  SPORT_AGENT_DEBRIEF_CACHE_KEY,
  SPORT_AGENT_OUTBOX_KEY,
  SPORT_AGENT_PRESTART_KEY,
  SPORT_AGENT_ACTIVE_KEY,
  abortRecoveredSportAgent,
  activateSportAgentPrestart,
  buildSportAgentExecutionPlan,
  buildSportAgentBriefingRequest,
  buildSportAgentEventMetrics,
  buildSportAgentItemRequest,
  buildSportAgentRideSummary,
  enqueueSportAgentItem,
  flushSportAgentOutbox,
  migrateSportAgentHandshakeForAnonymousClaim,
  migrateSportAgentOutboxForAnonymousClaim,
  parseSportAgentDebriefResponse,
  parseSportAgentBriefingResponse,
  parseSportAgentSessionResponse,
  prepareSportAgentSession,
  readSportAgentActive,
  readSportAgentPrestart,
  readSportAgentDebriefCache,
  readSportAgentOutbox,
  refreshSportAgentDebrief,
  reconcileSportAgentHandshakeOwner,
} from '../lib/sport_agent.js';

const identity = {
  app_id: 'aibike', token: 't'.repeat(64), public_device_id: 'bike_public_001',
  ownership_epoch: 2, data_namespace: 'bike_owner_namespace_002',
};
const owner = {
  public_device_id: identity.public_device_id,
  ownership_epoch: identity.ownership_epoch,
  data_namespace: identity.data_namespace,
};
const policy = {
  schema_version: 1, snapshot_max_age_ms: 15000, normal_cue_cooldown_s: 75,
  repeat_cue_cooldown_s: 180, safety_cue_cooldown_s: 20, minimum_evidence_s: 12,
};
const hrPolicy = {
  schema_version: 1, max_hr_bpm: 180, source: 'conservative_default',
  issued_at_ms: 1760000000000, expires_at_ms: 1760003600000,
};
const capabilities = {
  heart_rate: true, pace: false, cadence: true, speed: true, power: false,
};
const capabilityHash = 'e'.repeat(64);
const readiness = {
  schema_version: 1, status: 'clear', reason_codes: [],
  source: 'history_only', launch_allowed: true,
};
const iteration = {
  schema_version: 1, strategy_version: 2, recent_sessions: 2,
  completed: 1, partial: 1, aborted: 0, safety_events: 0,
  completion_rate_pct: 50, plan_basis: 'hold', evidence_confidence: 'medium',
  data_coverage: 'limited', reason_codes: ['recent_partial'],
};
const v2 = (executionStages = []) => ({
  context_version: 2, capabilities, capability_hash: capabilityHash,
  readiness, iteration, execution_stages: executionStages,
});
const nextTraining = {
  schema_version: 2, strategy_version: 2, direction: 'hold',
  recommended_mode: 'endurance', duration_sec: 1200,
  reason_codes: ['partial_completion'], confidence: 'medium', evidence_count: 2,
  message: '下次先保持二十分钟稳定骑行。',
};
const debrief = (overrides = {}) => ({
  schema_version: 1, debrief_id: 'sad_' + 'd'.repeat(24),
  session_id: 'sas_' + 'c'.repeat(24), locale: 'zh-CN',
  client_completion_id: 'bike-complete-001',
  client_activity_id: 'bike-activity-001', client_run_id: null,
  duplicate: false, status: 'pending', memory_status: 'pending',
  canonical_summary: { distance_m: 300 },
  review: {
    schema_version: 1, headline: '稳定完成', detail: '保持稳定节奏。',
    focus: '关注踏频来源覆盖。', load_direction: 'hold',
    next_training: nextTraining,
    evidence: { canonical: true, duration_s: 60, supervision_counts: {} },
  },
  next_training: nextTraining, ...owner, ...overrides,
});

function storage() {
  const values = new Map();
  return {
    values,
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { values.delete(key); },
  };
}

function sessionPayload({
  mode = 'free', workoutId = null, clientSessionId = 'bike-session-durable-001',
  briefingId = 'sab_' + 'b'.repeat(24), prescription = {}, executionStages = [],
  duplicate = false,
} = {}) {
  return {
    schema_version: 1, session_id: 'sas_' + 'c'.repeat(24), duplicate,
    client_session_id: clientSessionId, briefing_id: briefingId,
    ...(workoutId ? { workout_id: workoutId } : {}),
    sport: 'cycling', mode, locale: 'zh-CN', prescription,
    supervision_policy: policy, heart_rate_policy: hrPolicy,
    ...v2(executionStages), ...owner,
  };
}

test('briefing is product scoped and strictly validates owner and HR provenance', () => {
  assert.equal(SPORT_AGENT_LOCALE, 'zh-CN');
  const request = buildSportAgentBriefingRequest(identity, {
    mode: 'planned', workoutId: 'spw_' + 'a'.repeat(24),
    heartRate: true, cadence: true, speed: true, power: false,
  });
  assert.match(request.url, /sport-agent\/briefing$/);
  assert.equal(request.header['Accept-Language'], 'zh-CN');
  assert.equal(request.data.locale, 'zh-CN');
  assert.equal(request.data.context_version, 2);
  assert.deepEqual(request.data.capabilities, {
    heart_rate: true, pace: false, cadence: true, speed: true, power: false,
  });
  const response = { statusCode: 200, data: {
    schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
    mode: 'planned', locale: 'zh-CN', title: '耐力骑', rationale: '稳定执行', prescription: {},
    supervision_policy: policy, heart_rate_policy: hrPolicy, ...v2(), ...owner,
  } };
  const parsed = parseSportAgentBriefingResponse(response, identity);
  assert.equal(parsed.heart_rate_policy.authoritative, false);
  assert.equal(parseSportAgentBriefingResponse({
    ...response, data: { ...response.data, ownership_epoch: 3 },
  }, identity), null);
  assert.equal(parseSportAgentBriefingResponse({
    ...response, data: { ...response.data, locale: 'en-US' },
  }, identity), null);
  assert.equal(parseSportAgentBriefingResponse({
    ...response, data: { ...response.data, locale: undefined },
  }, identity), null);
});

test('JIT briefing and start session are an idempotent owner-bound handshake', async () => {
  const clientSessionId = 'bike-session-001';
  const calls = [];
  const local = storage();
  const result = await prepareSportAgentSession({
    storage: local,
    identity, mode: 'free', clientSessionId,
    async request(options) {
      calls.push(options);
      if (calls.length === 1) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录', prescription: {},
        supervision_policy: policy, heart_rate_policy: hrPolicy, ...v2(), ...owner,
      } };
      return { statusCode: 200, data: {
        schema_version: 1, session_id: 'sas_' + 'c'.repeat(24), duplicate: false,
        client_session_id: clientSessionId, briefing_id: 'sab_' + 'b'.repeat(24),
        workout_id: null, sport: 'cycling', mode: 'free', locale: 'zh-CN', prescription: {},
        supervision_policy: policy, heart_rate_policy: hrPolicy, ...v2(), ...owner,
      } };
    },
  });
  assert.equal(result.session.session_id, 'sas_' + 'c'.repeat(24));
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['briefing', 'sessions']);
  assert.deepEqual(calls.map((call) => call.data.locale), ['zh-CN', 'zh-CN']);
  assert.deepEqual(calls.map((call) => call.data.context_version), [2, 2]);
  assert.deepEqual(calls[1].data.capabilities, capabilities);
  assert.equal(calls[1].data.capability_hash, capabilityHash);
  assert.deepEqual(calls.map((call) => call.header['Accept-Language']), ['zh-CN', 'zh-CN']);
  assert.equal(parseSportAgentSessionResponse({
    statusCode: 200,
    data: {
      schema_version: 1, session_id: 'sas_' + 'c'.repeat(24), duplicate: false,
      client_session_id: clientSessionId, briefing_id: 'sab_' + 'b'.repeat(24),
      workout_id: null, sport: 'cycling', mode: 'free', locale: 'ja-JP',
      prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
      ...v2(), ...owner,
    },
  }, identity, {
    clientSessionId, briefingId: 'sab_' + 'b'.repeat(24), workoutId: null, mode: 'free',
    capabilities, capabilityHash,
  }), null);
});

test('response-lost replays the exact durable start body and restart reuses the ACK', async () => {
  const local = storage();
  const clientSessionId = 'bike-session-durable-001';
  const requests = [];
  let sessionAttempts = 0;
  const perform = async (options) => {
    requests.push(structuredClone(options));
    if (/\/briefing$/.test(options.url)) return { statusCode: 200, data: {
      schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
      mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
      prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
      ...v2(), ...owner,
    } };
    sessionAttempts += 1;
    if (sessionAttempts === 1) return { statusCode: 0 };
    return { statusCode: 200, data: sessionPayload({
      clientSessionId: options.data.client_session_id,
      duplicate: true,
    }) };
  };
  assert.equal(await prepareSportAgentSession({
    storage: local, identity, mode: 'free', clientSessionId, request: perform,
  }), null);
  const requestReady = readSportAgentPrestart(local, identity);
  assert.equal(requestReady.state, 'request_ready');
  assert.equal(requestReady.client_session_id, clientSessionId);
  assert.equal(await prepareSportAgentSession({
    storage: local, identity, mode: 'free',
    clientSessionId: 'bike-session-ignored-new-id', request: perform,
  }).then((value) => value.session.duplicate), true);
  const sessionBodies = requests.filter((item) => /\/sessions$/.test(item.url))
    .map((item) => item.data);
  assert.equal(sessionBodies.length, 2);
  assert.deepEqual(sessionBodies[1], sessionBodies[0]);
  assert.equal(sessionBodies[1].client_session_id, clientSessionId);
  const requestCount = requests.length;
  const restored = await prepareSportAgentSession({
    storage: local, identity, mode: 'free',
    clientSessionId: 'bike-session-another-new-id', request: perform,
  });
  assert.equal(restored.recovered, true);
  assert.equal(restored.session.session_id, 'sas_' + 'c'.repeat(24));
  assert.equal(requests.length, requestCount, 'durable session ACK resumes without a third POST');
  assert.equal(Object.hasOwn(restored.session, 'workout_id'), true);
  assert.equal(restored.session.workout_id, null,
    'real exclude_none free response normalizes absent workout_id to null');
});

test('prestart is owner isolated, storage failure blocks POST, and start migrates atomically', async () => {
  const local = storage();
  const calls = [];
  const prepared = await prepareSportAgentSession({
    storage: local, identity, mode: 'free', clientSessionId: 'bike-session-owner-001',
    async request(options) {
      calls.push(options);
      if (/\/briefing$/.test(options.url)) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
        prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(), ...owner,
      } };
      return { statusCode: 200, data: sessionPayload({
        clientSessionId: options.data.client_session_id,
      }) };
    },
  });
  assert.equal(calls.length, 2);
  const active = activateSportAgentPrestart(
    local, identity, prepared.session, { startedAtMs: 1760000000000 },
  );
  assert.equal(active.session_id, prepared.session.session_id);
  assert.equal(readSportAgentPrestart(local, identity), null);
  assert.equal(readSportAgentActive(local, identity).session_id, prepared.session.session_id);

  const nextOwner = { ...identity, ownership_epoch: 3, data_namespace: 'bike_owner_namespace_003' };
  assert.equal(reconcileSportAgentHandshakeOwner(local, nextOwner), true);
  assert.equal(local.values.has(SPORT_AGENT_ACTIVE_KEY), false);
  assert.equal(readSportAgentActive(local, nextOwner), null);

  const broken = storage();
  broken.setStorageSync = () => {};
  let networkCalls = 0;
  const failed = await prepareSportAgentSession({
    storage: broken, identity, mode: 'free', clientSessionId: 'bike-session-storefail-001',
    async request(options) {
      networkCalls += 1;
      return /\/briefing$/.test(options.url) ? { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
        prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(), ...owner,
      } } : { statusCode: 500 };
    },
  });
  assert.equal(failed, null);
  assert.equal(networkCalls, 1, 'failed readback must stop before session POST');
});

test('verified anonymous claim migrates only committed handshake state without changing intent', async () => {
  const local = storage();
  const prepared = await prepareSportAgentSession({
    storage: local, identity, mode: 'free', clientSessionId: 'bike-session-claim-001',
    async request(options) {
      if (/\/briefing$/.test(options.url)) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
        prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(), ...owner,
      } };
      return { statusCode: 200, data: sessionPayload({
        clientSessionId: options.data.client_session_id,
      }) };
    },
  });
  const before = readSportAgentPrestart(local, identity);
  const claimed = {
    ...identity,
    ownership_epoch: 3,
    data_namespace: 'bike_owner_namespace_003',
    ownership_transition: {
      kind: 'anonymous_claim',
      previous_ownership_epoch: 2,
      previous_data_namespace: identity.data_namespace,
      current_ownership_epoch: 3,
      current_data_namespace: 'bike_owner_namespace_003',
    },
  };
  const migrated = migrateSportAgentHandshakeForAnonymousClaim(local, identity, claimed);
  assert.equal(migrated.prestart.session.session_id, prepared.session.session_id);
  assert.equal(migrated.prestart.client_session_id, before.client_session_id);
  assert.deepEqual(migrated.prestart.session_request_body, before.session_request_body);
  assert.equal(migrated.prestart.capability_signature, before.capability_signature);
  assert.equal(readSportAgentPrestart(local, identity), null);
  assert.equal(readSportAgentPrestart(local, claimed).owner.ownership_epoch, 3);

  const active = activateSportAgentPrestart(local, claimed, migrated.prestart.session, {
    startedAtMs: 1760000000000,
  });
  const nextClaim = {
    ...claimed,
    ownership_epoch: 4,
    data_namespace: 'bike_owner_namespace_004',
    ownership_transition: {
      kind: 'anonymous_claim', previous_ownership_epoch: 3,
      previous_data_namespace: claimed.data_namespace,
      current_ownership_epoch: 4,
      current_data_namespace: 'bike_owner_namespace_004',
    },
  };
  const activeMigrated = migrateSportAgentHandshakeForAnonymousClaim(
    local, claimed, nextClaim,
  );
  assert.equal(activeMigrated.active.session_id, active.session_id);
  assert.equal(activeMigrated.active.client_session_id, active.client_session_id);
  assert.deepEqual(activeMigrated.active.execution_plan, active.execution_plan);

  const tampered = { ...nextClaim, ownership_transition: {
    ...nextClaim.ownership_transition, previous_data_namespace: 'tampered',
  } };
  assert.equal(migrateSportAgentHandshakeForAnonymousClaim(local, nextClaim, tampered), null);
  assert.equal(readSportAgentActive(local, nextClaim).session_id, active.session_id);
});

test('anonymous claim discards uncommitted request journal instead of replaying old briefing', () => {
  const local = storage();
  local.setStorageSync(SPORT_AGENT_PRESTART_KEY, {
    schema_version: 1, state: 'request_ready', owner,
    mode: 'free', workout_id: null, workout_revision: null,
    client_session_id: 'bike-session-request-001',
    capability_signature: JSON.stringify(capabilities),
    briefing: {
      schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
      mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
      prescription: {}, supervision_policy: policy,
      heart_rate_policy: { ...hrPolicy, authoritative: false }, ...v2(), ...owner,
    },
    session_request_body: {
      schema_version: 1, context_version: 2, sport: 'cycling', mode: 'free',
      locale: 'zh-CN', client_session_id: 'bike-session-request-001',
      briefing_id: 'sab_' + 'b'.repeat(24), capabilities,
      capability_hash: capabilityHash,
    },
  });
  const claimed = {
    ...identity, ownership_epoch: 3, data_namespace: 'bike_owner_namespace_003',
    ownership_transition: {
      kind: 'anonymous_claim', previous_ownership_epoch: 2,
      previous_data_namespace: identity.data_namespace,
      current_ownership_epoch: 3, current_data_namespace: 'bike_owner_namespace_003',
    },
  };
  assert.deepEqual(migrateSportAgentHandshakeForAnonymousClaim(
    local, identity, claimed,
  ), { prestart: null, active: null });
  assert.equal(local.values.has(SPORT_AGENT_PRESTART_KEY), false);
});

test('anonymous claim handshake migration is atomic and purges unusable partial writes', async () => {
  const local = storage();
  const prepared = await prepareSportAgentSession({
    storage: local, identity, mode: 'free', clientSessionId: 'bike-session-atomic-001',
    async request(options) {
      if (/\/briefing$/.test(options.url)) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
        prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(), ...owner,
      } };
      return { statusCode: 200, data: sessionPayload({
        clientSessionId: options.data.client_session_id,
      }) };
    },
  });
  activateSportAgentPrestart(local, identity, prepared.session, {
    startedAtMs: 1760000000000,
  });
  // Recreate a committed prestart alongside active to exercise the two-record
  // all-or-fail claim transaction; a crash can leave both before final cleanup.
  const active = readSportAgentActive(local, identity);
  const originalSet = local.setStorageSync.bind(local);
  const originalRemove = local.removeStorageSync.bind(local);
  const claimed = {
    ...identity, ownership_epoch: 3, data_namespace: 'bike_owner_namespace_003',
    ownership_transition: {
      kind: 'anonymous_claim', previous_ownership_epoch: 2,
      previous_data_namespace: identity.data_namespace,
      current_ownership_epoch: 3, current_data_namespace: 'bike_owner_namespace_003',
    },
  };
  // Active-only is enough to validate rollback safety: the migration write is
  // silently corrupted and every rollback/removal write also becomes a no-op.
  let corrupt = true;
  local.setStorageSync = (key, value) => {
    if (corrupt && key === SPORT_AGENT_ACTIVE_KEY) {
      originalSet(key, { ...value, client_session_id: 'tampered-session-id' });
      return;
    }
    originalSet(key, value);
  };
  local.removeStorageSync = (key) => {
    if (corrupt) return;
    originalRemove(key);
  };
  assert.equal(migrateSportAgentHandshakeForAnonymousClaim(
    local, identity, claimed,
  ), null);
  corrupt = false;
  // If a hostile storage bridge prevents both rollback and purge, neither
  // owner may parse the half-written value as launch authority.
  assert.equal(readSportAgentActive(local, claimed), null);
  assert.equal(readSportAgentActive(local, identity), null);
  assert.equal(active.session_id, prepared.session.session_id);
});

test('crash active snapshot is durably aborted before it can release the next ride', async () => {
  const local = storage();
  const prepared = await prepareSportAgentSession({
    storage: local, identity, mode: 'free', clientSessionId: 'bike-session-crash-001',
    async request(options) {
      if (/\/briefing$/.test(options.url)) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '稳定记录',
        prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(), ...owner,
      } };
      return { statusCode: 200, data: sessionPayload({
        clientSessionId: options.data.client_session_id,
      }) };
    },
  });
  activateSportAgentPrestart(local, identity, prepared.session, {
    startedAtMs: 1760000000000,
  });
  const completion = abortRecoveredSportAgent(local, identity, {
    endedAtMs: 1760000060000,
    clientActivityId: 'bike-activity-crash-001',
  });
  assert.equal(completion.status, 'aborted');
  assert.equal(completion.duration_s, 0);
  assert.equal(readSportAgentActive(local, identity).completion_queued, true);
  assert.ok(readSportAgentOutbox(local, identity).some(
    (item) => item.client_completion_id === 'bike-session-crash-001.aborted',
  ));
  const offline = await flushSportAgentOutbox({
    storage: local, identity, async request() { throw new Error('offline'); },
  });
  assert.equal(offline.pending, 1);
  assert.equal(readSportAgentActive(local, identity).completion_queued, true,
    'offline completion evidence keeps the active owner/session marker');
  const acked = await flushSportAgentOutbox({
    storage: local, identity,
    async request() {
      return { statusCode: 200, data: debrief({
        session_id: prepared.session.session_id,
        client_completion_id: completion.client_completion_id,
        client_activity_id: completion.client_activity_id,
        status: 'local_ready', memory_status: 'skipped_no_consent',
      }) };
    },
  });
  assert.equal(acked.acked, 1);
  assert.equal(readSportAgentActive(local, identity), null,
    'only an exact durable debrief ACK releases the active marker');
});

test('v2 responses reject type coercion and unexpected fields at every frozen layer', () => {
  const base = {
    schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
    mode: 'free', locale: 'zh-CN', title: '自由骑', rationale: '严格校验',
    prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
    ...v2(), ...owner,
  };
  assert.ok(parseSportAgentBriefingResponse({ statusCode: 200, data: base }, identity));
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base, schema_version: '1',
  } }, identity), null);
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base, unexpected: true,
  } }, identity), null);
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base, capabilities: { ...capabilities, extra: true },
  } }, identity), null);
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base, readiness: { ...readiness, launch_allowed: 1 },
  } }, identity), null);
  for (const drift of [
    { title: 123 },
    { mode: ' free ' },
    { prescription: [] },
  ]) {
    assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
      ...base, ...drift,
    } }, identity), null);
  }
  assert.equal(parseSportAgentSessionResponse({ statusCode: 200, data: {
    ...sessionPayload({ clientSessionId: 'bike-session-exact-001' }),
    duplicate: 0,
  } }, identity, {
    clientSessionId: 'bike-session-exact-001', briefingId: 'sab_' + 'b'.repeat(24),
    workoutId: null, mode: 'free', capabilities, capabilityHash,
  }), null);
  assert.equal(parseSportAgentSessionResponse({ statusCode: 200, data: {
    ...sessionPayload({ clientSessionId: 'bike-session-exact-001' }),
    workout_id: '',
  } }, identity, {
    clientSessionId: 'bike-session-exact-001', briefingId: 'sab_' + 'b'.repeat(24),
    workoutId: null, mode: 'free', capabilities, capabilityHash,
  }), null);
  assert.equal(parseSportAgentDebriefResponse({ statusCode: 200, data: {
    ...debrief(), ownership_epoch: '2',
  } }, identity), null);
  assert.equal(parseSportAgentDebriefResponse({ statusCode: 200, data: {
    ...debrief(), unexpected: true,
  } }, identity), null);
  for (const drift of [
    { review: [] },
    { canonical_summary: [] },
    { client_run_id: 123 },
  ]) {
    assert.equal(parseSportAgentDebriefResponse({ statusCode: 200, data: {
      ...debrief(), ...drift,
    } }, identity), null);
  }
});

test('planned JIT session freezes the exact validated workout revision', async () => {
  const clientSessionId = 'bike-session-planned-001';
  const workoutId = 'spw_' + 'a'.repeat(24);
  const prescription = {
    workout_id: workoutId, revision: 7, title: '今日耐力骑', type: 'endurance',
    scheduled_date: '2026-08-13', source: 'adaptive', rationale: '稳定积累',
    issued_at_ms: 1760000000000, expires_at_ms: 1760086400000,
    safety_notes: [], stages: [{
      stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work', title: '稳定段',
      duration_sec: 600, cue: '保持稳定踩踏', target: {
        kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 95,
      },
    }],
  };
  const executionStages = [{
    stage_id: prescription.stages[0].stage_id, duration_s: 480,
    target: { kind: 'cycling', cadence_min_rpm: 78, cadence_max_rpm: 90,
      effort_min: 3, effort_max: 5 },
    source: 'readiness_reduction', fallback: 'cadence',
  }];
  let call = 0;
  const local = storage();
  const prepared = await prepareSportAgentSession({
    storage: local,
    identity, mode: 'planned', workoutId, workoutRevision: 7, clientSessionId,
    async request() {
      call += 1;
      if (call === 1) return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'planned', locale: 'zh-CN', title: '今日耐力骑', rationale: '稳定执行', prescription,
        supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(executionStages), ...owner,
      } };
      return { statusCode: 200, data: {
        schema_version: 1, session_id: 'sas_' + 'c'.repeat(24), duplicate: false,
        client_session_id: clientSessionId, briefing_id: 'sab_' + 'b'.repeat(24),
        workout_id: workoutId, sport: 'cycling', mode: 'planned', locale: 'zh-CN', prescription,
        supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2(executionStages), ...owner,
      } };
    },
  });
  assert.equal(prepared.session.workout_id, workoutId);
  const executable = buildSportAgentExecutionPlan(prescription, prepared.session);
  assert.equal(executable.stages[0].duration_sec, 480);
  assert.equal(executable.stages[0].target.cadence_min_rpm, 78);
});

test('event snapshot and completion contain bounded aggregates only', () => {
  const metrics = buildSportAgentEventMetrics({
    paused: false, distanceM: 120.4, metrics: {
      speed: { state: 'live', fresh: true, held: false, value: 22, source: 'csc' },
      cadence: { state: 'live', fresh: true, held: false, value: 86, source: 'csc' },
      power: { state: 'unsupported' },
      heartRate: { state: 'live', fresh: true, held: false, value: 142, source: 'hrs' },
    },
  });
  assert.deepEqual(metrics, {
    speed_kmh: 22, cadence_rpm: 86, heart_rate_bpm: 142, distance_m: 120.4,
    motion_state: 'moving', metric_quality: 'high',
  });
  const summary = buildSportAgentRideSummary({
    distanceM: 1200, avgBpm: 142, maxBpm: 169, avgSpeedKmh: 21.2,
    maxSpeedKmh: 40.1, avgCadenceRpm: 84, maxCadenceRpm: 101,
    avgPowerW: 182, maxPowerW: 281,
    heartRateCoveragePct: 87.5,
    sources: ['csc', 'hrs', 'cadence_model'],
    latitude: 1, longitude: 2, rawImu: [1, 2, 3],
  }, { sourceCoverage: { csc: 95, hrs: 88, imu: 80, unknown: 100 } });
  assert.deepEqual(summary, {
    distance_m: 1200, avg_heart_rate_bpm: 142, max_heart_rate_bpm: 169,
    avg_speed_kmh: 21.2, max_speed_kmh: 40.1, avg_cadence_rpm: 84,
    max_cadence_rpm: 101, avg_power_w: 182, max_power_w: 281,
    heart_rate_coverage_pct: 87.5,
    source_coverage: { hrs: 88, csc: 95, imu: 80 },
    sensor_sources: ['csc', 'hrs', 'imu'],
  });
  assert.equal(Object.hasOwn(metrics, 'heart_zone'), false);
  assert.equal(Object.hasOwn(metrics, 'latitude'), false);
  assert.equal(Object.hasOwn(metrics, 'rawImu'), false);
});

test('event and completion wire bodies route session_id only in the URL', () => {
  const sessionId = 'sas_' + 'c'.repeat(24);
  const event = {
    kind: 'event', owner, session_id: sessionId,
    client_event_id: 'bike-event-wire-001', seq: 1,
    event_kind: 'snapshot', captured_at_ms: 1760000000000,
    elapsed_s: 30, metrics: { cadence_rpm: 82 },
  };
  const eventRequest = buildSportAgentItemRequest(event, identity);
  assert.match(eventRequest.url, new RegExp(`/sessions/${sessionId}/events$`));
  assert.deepEqual(eventRequest.data, {
    schema_version: 1,
    client_event_id: event.client_event_id,
    seq: 1,
    event_kind: 'snapshot',
    captured_at_ms: 1760000000000,
    elapsed_s: 30,
    metrics: { cadence_rpm: 82 },
  });
  const completion = {
    kind: 'complete', owner, session_id: sessionId,
    client_completion_id: 'bike-complete-wire-001',
    client_activity_id: 'bike-activity-wire-001',
    status: 'completed', started_at_ms: 1760000000000,
    ended_at_ms: 1760000060000, duration_s: 60,
    summary: { distance_m: 300 },
  };
  const completionRequest = buildSportAgentItemRequest(completion, identity);
  assert.match(completionRequest.url, new RegExp(`/sessions/${sessionId}/complete$`));
  assert.equal(Object.hasOwn(completionRequest.data, 'session_id'), false);
  assert.equal(Object.hasOwn(completionRequest.data, 'kind'), false);
  assert.equal(Object.hasOwn(completionRequest.data, 'owner'), false);
  assert.equal(completionRequest.data.client_completion_id, completion.client_completion_id);
  assert.equal(completionRequest.data.summary.distance_m, 300);
});

test('v0.3.73 durable items are upgraded to Hermes strict bodies before retry', async () => {
  const local = storage();
  const sessionId = 'sas_' + 'c'.repeat(24);
  // v0.3.73 persisted the routing-only session_id with each item.  Preserve
  // that exact durable shape here: an upgrade must sanitize the request at
  // send time rather than require the user to discard an afternoon ride.
  local.setStorageSync(SPORT_AGENT_OUTBOX_KEY, [{
    kind: 'event', owner, session_id: sessionId,
    client_event_id: 'bike-event-v0373-001', seq: 1,
    event_kind: 'snapshot', captured_at_ms: 1760000000000,
    elapsed_s: 30, metrics: { cadence_rpm: 82, distance_m: 110 },
  }, {
    kind: 'complete', owner, session_id: sessionId,
    client_completion_id: 'bike-complete-v0373-001',
    client_activity_id: 'bike-activity-v0373-001',
    status: 'completed', started_at_ms: 1760000000000,
    ended_at_ms: 1760000060000, duration_s: 60,
    summary: { distance_m: 300 },
  }]);

  const sent = [];
  const result = await flushSportAgentOutbox({
    storage: local,
    identity,
    async request(options) {
      sent.push(options);
      if (/\/events$/.test(options.url)) return { statusCode: 200, data: {
        schema_version: 1, session_id: sessionId,
        client_event_id: options.data.client_event_id,
        seq: options.data.seq, locale: 'zh-CN', duplicate: false,
        decision: { speak: false }, ...owner,
      } };
      return { statusCode: 200, data: debrief({
        session_id: sessionId,
        client_completion_id: options.data.client_completion_id,
        client_activity_id: options.data.client_activity_id,
        canonical_summary: options.data.summary,
      }) };
    },
  });

  assert.equal(result.status, 'acked');
  assert.equal(result.acked, 2);
  assert.equal(readSportAgentOutbox(local, identity).length, 0);
  assert.deepEqual(Object.keys(sent[0].data).sort(), [
    'captured_at_ms', 'client_event_id', 'elapsed_s', 'event_kind',
    'metrics', 'schema_version', 'seq',
  ]);
  assert.deepEqual(Object.keys(sent[1].data).sort(), [
    'client_activity_id', 'client_completion_id', 'duration_s', 'ended_at_ms',
    'schema_version', 'started_at_ms', 'status', 'summary',
  ]);
  for (const request of sent) {
    assert.equal(Object.hasOwn(request.data, 'session_id'), false);
    assert.equal(Object.hasOwn(request.data, 'kind'), false);
    assert.equal(Object.hasOwn(request.data, 'owner'), false);
  }
});

test('ordered outbox keeps events before completion and deletes only exact ACKs', async () => {
  const local = storage();
  const sessionId = 'sas_' + 'c'.repeat(24);
  const event = {
    kind: 'event', owner, session_id: sessionId, client_event_id: 'bike-event-001',
    seq: 1, event_kind: 'snapshot', captured_at_ms: 1760000000000,
    elapsed_s: 30, metrics: { speed_kmh: 20, cadence_rpm: 82 },
  };
  const completion = {
    kind: 'complete', owner, session_id: sessionId,
    client_completion_id: 'bike-complete-001', client_activity_id: 'bike-activity-001',
    status: 'completed', started_at_ms: 1760000000000,
    ended_at_ms: 1760000060000, duration_s: 60,
    summary: { distance_m: 300, avg_speed_kmh: 18 },
  };
  assert.ok(enqueueSportAgentItem(local, event, identity));
  assert.ok(enqueueSportAgentItem(local, completion, identity));
  assert.equal(local.values.has(SPORT_AGENT_OUTBOX_KEY), true);
  const seen = [];
  const result = await flushSportAgentOutbox({
    storage: local, identity,
    async request(options) {
      seen.push(options.url);
      if (seen.length === 1) return { statusCode: 200, data: {
        schema_version: 1, session_id: sessionId, client_event_id: event.client_event_id,
        seq: 1, locale: 'zh-CN', duplicate: false, decision: { speak: false }, ...owner,
      } };
      return { statusCode: 200, data: debrief({
        session_id: sessionId,
        client_completion_id: completion.client_completion_id,
        client_activity_id: completion.client_activity_id,
        canonical_summary: completion.summary,
      }) };
    },
  });
  assert.equal(result.acked, 2);
  assert.equal(readSportAgentOutbox(local, identity).length, 0);
  assert.equal(readSportAgentDebriefCache(local, identity).next_training.duration_sec, 1200);
  assert.equal(local.values.has(SPORT_AGENT_DEBRIEF_CACHE_KEY), true);
  assert.match(seen[0], /\/events$/);
  assert.match(seen[1], /\/complete$/);
});

test('event and debrief ACKs fail closed when the frozen locale is missing or wrong', async () => {
  const sessionId = 'sas_' + 'c'.repeat(24);
  const event = {
    kind: 'event', owner, session_id: sessionId, client_event_id: 'bike-event-locale-001',
    seq: 1, event_kind: 'snapshot', captured_at_ms: 1760000000000,
    elapsed_s: 30, metrics: { speed_kmh: 20 },
  };
  const arrayDecision = storage();
  enqueueSportAgentItem(arrayDecision, event, identity);
  const rejectedDecision = await flushSportAgentOutbox({
    storage: arrayDecision, identity,
    async request() {
      return { statusCode: 200, data: {
        schema_version: 1, session_id: sessionId,
        client_event_id: event.client_event_id, seq: 1, locale: 'zh-CN',
        duplicate: false, decision: [], ...owner,
      } };
    },
  });
  assert.equal(rejectedDecision.acked, 0);
  assert.equal(readSportAgentOutbox(arrayDecision, identity).length, 1);
  for (const locale of [undefined, 'en-US']) {
    const local = storage();
    enqueueSportAgentItem(local, event, identity);
    const result = await flushSportAgentOutbox({
      storage: local,
      identity,
      async request() {
        return { statusCode: 200, data: {
          schema_version: 1, session_id: sessionId,
          client_event_id: event.client_event_id, seq: 1,
          ...(locale ? { locale } : {}),
          duplicate: false, decision: { speak: false }, ...owner,
        } };
      },
    });
    assert.equal(result.acked, 0);
    assert.equal(result.pending, 1);
    assert.equal(readSportAgentOutbox(local, identity).length, 1);
  }

  const completion = {
    kind: 'complete', owner, session_id: sessionId,
    client_completion_id: 'bike-complete-locale-001',
    client_activity_id: 'bike-activity-locale-001', status: 'completed',
    started_at_ms: 1760000000000, ended_at_ms: 1760000060000, duration_s: 60,
    summary: { distance_m: 300 },
  };
  const local = storage();
  enqueueSportAgentItem(local, completion, identity);
  const result = await flushSportAgentOutbox({
    storage: local,
    identity,
    async request() {
      return { statusCode: 200, data: {
        schema_version: 1, locale: 'ja-JP',
        debrief_id: 'sad_' + 'd'.repeat(24), session_id: sessionId,
        client_completion_id: completion.client_completion_id,
        client_activity_id: completion.client_activity_id,
        review: { headline: '別言語' }, ...owner,
      } };
    },
  });
  assert.equal(result.acked, 0);
  assert.equal(result.pending, 1);
  assert.equal(readSportAgentOutbox(local, identity).length, 1);
});

test('planned aggregate completion keeps revision, full wire stages and source evidence', () => {
  const local = storage();
  const completion = {
    kind: 'complete', owner, session_id: 'sas_' + 'c'.repeat(24),
    client_completion_id: 'bike-complete-planned-001',
    client_activity_id: 'bike-activity-planned-001',
    status: 'completed', started_at_ms: 1760000000000,
    ended_at_ms: 1760000060000, duration_s: 60,
    summary: {
      distance_m: 300, avg_cadence_rpm: 84, max_cadence_rpm: 96,
      avg_power_w: 178, max_power_w: 260,
      source_coverage: { csc: 90, hrs: 80 }, sensor_sources: ['csc', 'hrs'],
    },
    workout_revision: 7,
    stage_results: [{
      stage_id: 'sps_' + 'b'.repeat(24), status: 'completed', duration_s: 60,
      distance_m: 300, metrics: {
        avg_speed_kmh: 18, avg_cadence_rpm: 84,
        avg_power_w: 178, avg_heart_rate_bpm: 142,
      },
    }],
  };
  const queued = enqueueSportAgentItem(local, completion, identity);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workout_revision, 7);
  assert.deepEqual(queued[0].stage_results, completion.stage_results);
  assert.equal(Object.hasOwn(queued[0].stage_results[0], 'duration_sec'), false);
  assert.deepEqual(queued[0].summary.sensor_sources, ['csc', 'hrs']);
  assert.equal(enqueueSportAgentItem(local, {
    ...completion, client_completion_id: 'bike-complete-bad-001',
    status: 'completed', stage_results: [{ ...completion.stage_results[0], status: 'partial' }],
  }, identity), null);
});

test('outbox preserves evidence on network failure and isolates owners', async () => {
  const local = storage();
  enqueueSportAgentItem(local, {
    kind: 'event', owner, session_id: 'sas_' + 'c'.repeat(24),
    client_event_id: 'bike-event-002', seq: 1, event_kind: 'snapshot',
    captured_at_ms: 1760000000000, elapsed_s: 1, metrics: {},
  }, identity);
  const result = await flushSportAgentOutbox({
    storage: local, identity, async request() { throw new Error('offline'); },
  });
  assert.equal(result.pending, 1);
  assert.equal(readSportAgentOutbox(local, { ...identity, ownership_epoch: 3 }).length, 0);
  assert.equal(readSportAgentOutbox(local, identity).length, 1);
});

test('started session outbox migrates only with an exact anonymous-claim proof', () => {
  const local = storage();
  const previousIdentity = {
    ...identity, ownership_epoch: 1, data_namespace: 'ns_' + 'a'.repeat(24),
  };
  const currentIdentity = {
    ...identity, ownership_epoch: 2, data_namespace: 'ns_' + 'b'.repeat(24),
    ownership_transition: {
      kind: 'anonymous_claim', previous_ownership_epoch: 1,
      previous_data_namespace: 'ns_' + 'a'.repeat(24),
      current_ownership_epoch: 2,
      current_data_namespace: 'ns_' + 'b'.repeat(24),
    },
  };
  enqueueSportAgentItem(local, {
    kind: 'event', owner: previousIdentity, session_id: 'sas_' + 'c'.repeat(24),
    client_event_id: 'bike-event-claim-001', seq: 1, event_kind: 'snapshot',
    captured_at_ms: 1760000000000, elapsed_s: 30, metrics: { speed_kmh: 18 },
  }, previousIdentity);
  const migrated = migrateSportAgentOutboxForAnonymousClaim(
    local, previousIdentity, currentIdentity,
  );
  assert.equal(migrated.length, 1);
  assert.deepEqual(migrated[0].owner, {
    public_device_id: identity.public_device_id,
    ownership_epoch: 2,
    data_namespace: 'ns_' + 'b'.repeat(24),
  });
  assert.equal(migrateSportAgentOutboxForAnonymousClaim(
    local, previousIdentity, { ...currentIdentity, ownership_transition: null },
  ), null);
});

test('v2 fails closed for legacy responses and blocked planned readiness before session start', async () => {
  const legacy = { statusCode: 200, data: {
    schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
    mode: 'free', locale: 'zh-CN', title: '旧自由骑', rationale: '旧契约',
    prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy, ...owner,
  } };
  assert.equal(parseSportAgentBriefingResponse(legacy, identity), null);

  const workoutId = 'spw_' + 'a'.repeat(24);
  const prescription = {
    workout_id: workoutId, revision: 1, title: '今日训练', type: 'endurance',
    scheduled_date: '2026-08-13', source: 'adaptive', rationale: '安全执行',
    issued_at_ms: 1760000000000, expires_at_ms: 1760086400000,
    safety_notes: [], stages: [{
      stage_id: 'sps_' + 'b'.repeat(24), order: 0, type: 'work', title: '主训练',
      duration_sec: 600, cue: '保持稳定',
      target: { kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 90 },
    }],
  };
  let calls = 0;
  const local = storage();
  const result = await prepareSportAgentSession({
    storage: local,
    identity, mode: 'planned', workoutId, workoutRevision: 1,
    clientSessionId: 'bike-session-blocked-001',
    async request() {
      calls += 1;
      return { statusCode: 200, data: {
        schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
        mode: 'planned', locale: 'zh-CN', title: '今日训练', rationale: '暂停训练',
        prescription, supervision_policy: policy, heart_rate_policy: hrPolicy,
        ...v2([{ stage_id: prescription.stages[0].stage_id, duration_s: 600,
          target: { kind: 'cycling', effort_min: 1, effort_max: 2 },
          source: 'readiness_reduction', fallback: 'effort' }]),
        readiness: { ...readiness, status: 'blocked', reason_codes: ['unresolved_pain'],
          launch_allowed: false },
        ...owner,
      } };
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 1, 'blocked planned briefing must not create a session');
});

test('v2 iteration counts and cadence ceiling exactly match the server contract', () => {
  const base = {
    schema_version: 1, briefing_id: 'sab_' + 'b'.repeat(24), sport: 'cycling',
    mode: 'planned', locale: 'zh-CN', title: '今日训练', rationale: '严格校验',
    prescription: {}, supervision_policy: policy, heart_rate_policy: hrPolicy,
    ...v2([{ stage_id: 'sps_' + 'b'.repeat(24), duration_s: 600,
      target: { kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 240,
        effort_min: 3, effort_max: 6 },
      source: 'prescription', fallback: 'cadence' }]),
    ...owner,
  };
  assert.ok(parseSportAgentBriefingResponse({ statusCode: 200, data: base }, identity));
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base,
    iteration: { ...iteration, recent_sessions: 3 },
  } }, identity), null, 'completed + partial + aborted must equal recent_sessions');
  assert.equal(parseSportAgentBriefingResponse({ statusCode: 200, data: {
    ...base,
    execution_stages: [{
      ...base.execution_stages[0],
      target: { kind: 'cycling', cadence_min_rpm: 80, cadence_max_rpm: 241,
        effort_min: 3, effort_max: 6 },
    }],
  } }, identity), null, 'server cadence ceiling is 240 rpm');
});

test('debrief cache is owner-bound, refreshes with no-store and preserves completion on cache failure', async () => {
  const local = storage();
  const parsed = parseSportAgentDebriefResponse({ statusCode: 200, data: debrief() }, identity, {
    sessionId: 'sas_' + 'c'.repeat(24),
    clientCompletionId: 'bike-complete-001',
    clientActivityId: 'bike-activity-001',
  });
  assert.equal(parsed.memory_status, 'pending');
  assert.equal(parsed.next_training.recommended_mode, 'endurance');
  let seen = null;
  const refreshed = await refreshSportAgentDebrief({
    storage: local, identity, sessionId: parsed.session_id,
    async request(options) {
      seen = options;
      return { statusCode: 200, data: debrief({ status: 'ai_ready', memory_status: 'complete' }) };
    },
  });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.header['Cache-Control'], 'no-store');
  assert.match(seen.url, /\/sessions\/sas_[a-f0-9]{24}\/debrief$/);
  assert.equal(refreshed.memory_status, 'complete');
  assert.equal(readSportAgentDebriefCache(local, { ...identity, ownership_epoch: 3 }), null);

  const failing = storage();
  const originalSet = failing.setStorageSync;
  let failCache = true;
  failing.setStorageSync = function setStorageSync(key, value) {
    if (key === SPORT_AGENT_DEBRIEF_CACHE_KEY && failCache) throw new Error('disk full');
    return originalSet.call(this, key, value);
  };
  const completion = {
    kind: 'complete', owner, session_id: parsed.session_id,
    client_completion_id: parsed.client_completion_id,
    client_activity_id: parsed.client_activity_id,
    status: 'completed', started_at_ms: 1760000000000,
    ended_at_ms: 1760000060000, duration_s: 60, summary: { distance_m: 300 },
  };
  enqueueSportAgentItem(failing, completion, identity);
  const held = await flushSportAgentOutbox({
    storage: failing, identity,
    async request() { return { statusCode: 200, data: debrief() }; },
  });
  assert.equal(held.acked, 0);
  assert.equal(readSportAgentOutbox(failing, identity).length, 1);
  failCache = false;
  const acked = await flushSportAgentOutbox({
    storage: failing, identity,
    async request() { return { statusCode: 200, data: debrief({ duplicate: true }) }; },
  });
  assert.equal(acked.acked, 1);
  assert.equal(readSportAgentOutbox(failing, identity).length, 0);
});
