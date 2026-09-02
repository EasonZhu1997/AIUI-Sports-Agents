<script type="application/json" def>
{
  "navigationBarTitleText": "AIBike AI 骑行"
}
</script>

<script setup>
import wx from 'wx';
import { Sound } from 'audio';
import { CadenceTone } from '../../lib/cadence_tone.js';
import { parseIndoorBikeData } from '../../lib/ftms.js';
import { parseHeartRateMeasurement, hrZone } from '../../lib/hr.js';
import { CyclingMetrics } from '../../lib/cycling_metrics.js';
import {
  CyclingImuActivity,
  SensorTimestampNormalizer,
} from '../../lib/cycling_imu.js';
import { CyclingMotionQualityGate } from '../../lib/cycling_motion_quality.js';
import {
  createAiuiWorldAwarenessDiagnostics,
  disableAiuiWorldAwareness,
  enableAiuiWorldAwareness,
  recordAiuiHeadGesture,
  recordAiuiOrientationStability,
  snapshotAiuiWorldAwareness,
} from '../../lib/aiui_world_awareness.js';
import {
  DEFAULT_BIKE_SETTINGS,
  formatCadenceTone,
  formatFtp,
  formatMaxHeartRate,
  formatRideGoal,
  formatSwitch,
  formatWheelCircumference,
  nextCadenceToneRpm,
  nextFtpW,
  nextMaxHeartRateBpm,
  nextRideGoal,
  nextWheelCircumferenceMm,
  readBikeSettings,
  writeBikeSettings,
} from '../../lib/bike_settings.js';
import { authorizeNetworkRequest } from '../../lib/network_policy.js';
import {
  formatBpm,
} from '../../lib/ride_format.js';
import {
  buildHudMetricDisplay,
  buildHudMetricClassFields,
  buildSummaryMetricDisplay,
} from '../../lib/ride_display.js';
import {
  matchesRideDevice,
  readRideDevice,
  rideDeviceDisplayName,
  writeRideDevice,
} from '../../lib/ride_devices.js';
import {
  readLastRideSummary,
  writeLastRideSummary,
} from '../../lib/ride_summary.js';
import {
  buildRideTrendText,
  persistRideHistorySummary,
  readRideHistory,
} from '../../lib/ride_history.js';
import {
  buildPostRideAdvice,
  buildPreRideBrief,
  nextRideCoachCue,
} from '../../lib/ride_coach.js';
import {
  RIDE_GUIDE_KIND,
  RIDE_RECOVERY_COMPLETION_TTS,
  RIDE_WARMUP_COMPLETION_TTS,
  RIDE_WARMUP_STEPS,
  getRideGuideOverview,
  getRideGuideRhythmTtsCue,
  getRideGuideStep,
  getRideGuideSteps,
  getRideGuideTtsCue,
  warmupSecondsRemaining,
} from '../../lib/ride_warmup.js';
import {
  decideHrsSourceHealth,
} from '../../lib/ride_source_health.js';
import {
  generateRideAiAdvice,
  RIDE_AI_ADVICE_PHASE,
} from '../../lib/ride_ai_advice.js';
import { LanguageModel } from 'language-model';
import {
  clearRideFinishedHint,
  writeRideFinishedHint,
  writeScanExitHint,
} from '../../lib/ride_surface.js';
import {
  appendPendingCyclingUploadEvents,
  captureCyclingUploadFinish,
  captureCyclingUploadSample,
  createCyclingUploadSession,
  readPendingCyclingUploadEvents,
} from '../../lib/cycling_upload.js';
import { flushPendingCyclingUploads } from '../../lib/cycling_upload_runtime.js';
import {
  CYCLING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
  CYCLING_LOCAL_FIELD_LOG_SCHEMA_VERSION,
  appendCyclingLocalFieldSamples,
  appendCyclingLocalLifecycleEvent,
  appendCyclingLocalTtsEvent,
  appendCyclingLocalUploadResult,
  beginCyclingLocalFieldLog,
  finishCyclingLocalFieldLog,
  readCyclingLocalFieldLogIndexResult,
} from '../../lib/cycling_local_field_log.js';
import {
  ensureCyclingUploadToken,
} from '../../lib/cycling_upload_auth.js';
import {
  clearSportsToken,
  ensureSportsIdentity,
  isSportsAnonymousClaimTransition,
  readSportsIdentity,
  sameSportsOwner,
} from '../../lib/sports_identity.js';
import {
  readSportsWorkoutCache,
  refreshSportsWorkout,
} from '../../lib/sports_workout.js';
import {
  createSportsWorkoutExecutor,
  finalizeSportsWorkout,
  sportsWorkoutHud,
  updateSportsWorkoutExecutor,
} from '../../lib/sports_workout_executor.js';
import {
  buildCyclingSportsMetrics,
  createSportsExecutionId,
  enqueueSportsOutbox,
  flushSportsOutbox,
  readSportsOutbox,
} from '../../lib/sports_outbox.js';
import { nextSportsCoachCue } from '../../lib/sports_coach.js';
import {
  buildSportAgentExecutionPlan,
  buildSportAgentEventMetrics,
  buildSportAgentRideSummary,
  activateSportAgentPrestart,
  abortRecoveredSportAgent,
  createSportAgentClientId,
  enqueueSportAgentItem,
  flushSportAgentOutbox,
  migrateSportAgentDebriefForAnonymousClaim,
  migrateSportAgentHandshakeForAnonymousClaim,
  migrateSportAgentOutboxForAnonymousClaim,
  markSportAgentCompletionQueued,
  prepareSportAgentSession,
  readSportAgentPrestart,
  readSportAgentActive,
  recoverSportAgentPlannedPrestart,
  reconcileSportAgentHandshakeOwner,
  readSportAgentDebriefCache,
  readSportAgentOutbox,
  refreshSportAgentDebrief,
  sportAgentCapabilitiesSignature,
} from '../../lib/sport_agent.js';

const TICK_MS = 1000;
const LOCAL_FIELD_LOG_BUFFER_SAMPLES = 3;
const BLE_CONNECT_TIMEOUT_MS = 10000;
const BLE_CLEANUP_STEP_WAIT_MS = 600;
const BLE_EXIT_CLEANUP_WAIT_MS = 800;
const BLE_NATIVE_SCAN_SETTLE_MS = 250;
const HUD_RECONNECT_DELAY_MS = 4000;
const HUD_RECONNECT_MAX = 5;
const END_CONFIRM_WINDOW_MS = 3000;
const CONFIRM_KEY_DEDUPE_MS = 400;
const SURFACE_CONFIRM_DEDUPE_MS = 400;
const SURFACE_ACTION_DEDUPE_MS = 600;
const DIRECTION_REPEAT_DEDUPE_MS = 220;
const DIRECTION_ALIAS_DEDUPE_MS = 600;
const GLOBAL_HOOK_DISAMBIGUATE_MS = 600;
const SEARCH_DOUBLE_TAP_WINDOW_MS = 420;
const SEARCH_DOUBLE_TAP_MIN_GAP_MS = 90;
// HUD 的两次真实镜腿轻触也必须绕开 400ms 键码别名去重，否则设备已经
// 派发了完整双击，页面却只停留在“再按一次结束”。
const HUD_DOUBLE_TAP_WINDOW_MS = 420;
const HUD_DOUBLE_TAP_MIN_GAP_MS = 90;
// 总结页的真实镜腿双击独立于确认键别名去重；否则第二次 GlobalHook
// 会被 400ms 的 Enter/Space 别名窗口吞掉，用户只能反复看到退出提示。
const SUMMARY_DOUBLE_TAP_WINDOW_MS = 420;
const SUMMARY_DOUBLE_TAP_MIN_GAP_MS = 90;
const SEARCH_CONNECT_RESUME_GRACE_MS = 180;
const DIRECTION_RELEASE_GUARD_MS = 600;
const SURFACE_ENTRY_CONFIRM_GRACE_MS = 700;
const MENU_ENTRY_CONFIRM_GRACE_MS = 800;
const HUD_CONFIRM_GRACE_MS = 1200;
const SUMMARY_CONFIRM_ENTRY_GRACE_MS = 600;
const SUMMARY_BACKSPACE_DEDUPE_MS = 400;
const SPORT_AGENT_EVENT_INTERVAL_MS = 30000;
const SPORT_AGENT_DEBRIEF_POLL_DELAYS_MS = [2000, 5000, 10000];
const SETTINGS_FOCUS_COUNT = 8;
const MAX_VISIBLE_DEVICES = 3;
const RIDE_GUIDE_TICK_MS = 250;
// AIUI Craft 0.15 的 frequency 是 best-effort 请求值。AR 录屏会显著
// 压低 Generic Sensor 实际回调率；采用已验证的 50/50/30Hz 请求，
// 让录屏限流后仍尽量保留 6–14Hz 的真实帧。所有
// 周期估算仍只使用事件真实 timestamp/实测 Hz，绝不把请求值当数据。
const IMU_HZ = 50;
const GYRO_HZ = 50;
const ORIENTATION_HZ = 30;
const IMU_FIRST_READING_TIMEOUT_MS = 5000;
const IMU_STALL_TIMEOUT_MS = 10000;
// AR 录屏结束有时只补发 onShow，不补发 onHide。此时不能继续等 10 秒
// watchdog；使用 3 秒恢复门，立刻重建已经停流的传感器。
const IMU_RESUME_STALE_MS = 3000;
const IMU_RESTART_DELAY_MS = 1200;
const IMU_RESTART_FAST_ATTEMPTS = 3;
const IMU_RESTART_MAX_DELAY_MS = 10000;
const IMU_CRITICAL_RATE_HZ = 4.5;
const IMU_MIN_RATE_HZ = 5;
const IMU_LOW_RATE_WINDOWS = 3;
// 原始 IMU 帧仍逐帧进入 CyclingImuActivity；交给 CyclingMetrics 前先过
// 250ms 硬门。门内只覆盖一个最新快照，到边界才构造状态 signature 并
// 转发，因此状态变化最多延迟 250ms，同时避免 50Hz 路径持续分配长数组。
const IMU_METRICS_STABLE_INTERVAL_MS = 250;
// HUD 同时接受 1Hz timer 与真实数据事件。AR 录屏可能
// 把 timer 压住几十秒，但 sensor/BLE 事件仍可从同一 500ms 门恢复显示。
const RIDE_SIGNAL_TICK_MIN_MS = 500;
const RIDE_SIGNAL_TICK_STALL_LOG_MS = 2500;
const HEART_RATE_DISPLAY_FRESH_MS = 8000;
const BLE_SOURCE_RECOVERY_COOLDOWN_MS = 15000;
const SUMMARY_AI_START_DELAY_MS = 80;
const SUMMARY_PERSIST_RETRY_DELAYS_MS = Object.freeze([120, 400, 1000]);
const HUD_DIAGNOSTIC_INTERVAL_MS = 5000;
const CYCLING_UPLOAD_BUFFER_SAMPLES = 5;
const CADENCE_TONE_AUDIO_SOURCES = Object.freeze({
  80: '../../assets/audio/metro_0468_bar_80.wav',
  90: '../../assets/audio/metro_0468_bar_90.wav',
  100: '../../assets/audio/metro_0468_bar_100.wav',
});
const CADENCE_TONE_BEATS_PER_PLAYBACK = 4;
// AIUI 0.15 playTTS only returns an utterance id and exposes no completion
// event. A bounded local flight prevents timer-driven coach ticks from
// enqueueing overlapping speech; accepted duplicate text has its own gate.
const TTS_IN_FLIGHT_MIN_MS = 5000;
const TTS_IN_FLIGHT_MAX_MS = 8000;
const TTS_SAME_TEXT_DEDUPE_MS = 8000;

const HR_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';
const CSC_SERVICE_UUID = '00001816-0000-1000-8000-00805f9b34fb';
const CSC_MEASUREMENT_UUID = '00002a5b-0000-1000-8000-00805f9b34fb';
const CYCLING_POWER_SERVICE_UUID = '00001818-0000-1000-8000-00805f9b34fb';
const CYCLING_POWER_MEASUREMENT_UUID = '00002a63-0000-1000-8000-00805f9b34fb';
const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
const FTMS_INDOOR_BIKE_UUID = '00002ad2-0000-1000-8000-00805f9b34fb';

const SOURCE_SPECS = [
  {
    source: 'hrs',
    service: HR_SERVICE_UUID,
    characteristic: HR_MEASUREMENT_UUID,
  },
  {
    source: 'csc',
    service: CSC_SERVICE_UUID,
    characteristic: CSC_MEASUREMENT_UUID,
  },
  {
    source: 'cps',
    service: CYCLING_POWER_SERVICE_UUID,
    characteristic: CYCLING_POWER_MEASUREMENT_UUID,
  },
  {
    source: 'ftms',
    service: FTMS_SERVICE_UUID,
    characteristic: FTMS_INDOOR_BIKE_UUID,
  },
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatHudClock(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return hour + ':' + minute;
}

function activeSourceSpecs(settings) {
  const heartRateEnabled = !settings || settings.autoHeartRate !== false;
  return SOURCE_SPECS.filter((spec) => spec.source !== 'hrs' || heartRateEnabled);
}

function servicesForSubscriptions(specs, results) {
  const services = new Set();
  for (let i = 0; i < specs.length; i += 1) {
    if (!results[i]) continue;
    services.add(specs[i].source);
  }
  return [...services];
}

function metricValue(metric) {
  if (!metric || (metric.state !== 'live' && metric.state !== 'explicit_zero')) return null;
  return finiteNumber(metric.value);
}

function sourceLabel(source) {
  if (source === 'csc') return 'CSC';
  if (source === 'cps') return '功率计';
  if (source === 'ftms') return '骑行台';
  if (source === 'imu') return '眼镜 IMU 估算';
  return '';
}

function notificationValue(event, characteristic) {
  return event && event.target && event.target.value != null
    ? event.target.value
    : (event && event.value != null ? event.value : characteristic && characteristic.value);
}

function deviceId(device) {
  return String(device && device.id != null ? device.id : '').trim();
}

function heartZoneDotFields(zone) {
  const value = Number(zone) || 0;
  return {
    dot5: value >= 5 ? 'dot dot-on' : 'dot',
    dot4: value >= 4 ? 'dot dot-on' : 'dot',
    dot3: value >= 3 ? 'dot dot-on' : 'dot',
    dot2: value >= 2 ? 'dot dot-on' : 'dot',
    dot1: value >= 1 ? 'dot dot-on' : 'dot',
  };
}

function rideMetricConfidence(summary) {
  const sources = new Set([
    ...(Array.isArray(summary && summary.sources) ? summary.sources : []),
    ...(Array.isArray(summary && summary.distanceSources)
      ? summary.distanceSources : []),
    ...(Array.isArray(summary && summary.cadenceSources)
      ? summary.cadenceSources : []),
  ]);
  const actualCycling = ['csc', 'cps', 'ftms'].some((source) => sources.has(source));
  const estimated = sources.has('imu');
  return {
    overall: actualCycling ? 'high' : (estimated ? 'medium' : 'unknown'),
    speed: actualCycling ? 'high' : (sources.has('imu') ? 'low' : 'unknown'),
    cadence: ['csc', 'cps', 'ftms'].some((source) => sources.has(source))
      ? 'high' : (sources.has('imu') ? 'low' : 'unknown'),
    distance: ['csc', 'ftms'].some((source) => sources.has(source))
      ? 'high' : (sources.has('imu') ? 'low' : 'unknown'),
    heartRate: sources.has('hrs') || sources.has('ftms') ? 'high' : 'unknown',
    power: sources.has('cps') || sources.has('ftms') ? 'high' : 'unknown',
  };
}

export default {
  data: {
    surfacePhase: 'ready',
    riding: false,
    paused: false,
    speed: '估算中',
    cadence: '识别中',
    distance: '待起步',
    elapsed: '刚开始',
    heartRate: '未连接',
    heartRateStatus: '心率',
    power: '未连接',
    powerChipText: '',
    showHeartRate: false,
    showPower: false,
    cyclingSourceText: '等待骑行数据',
    hudEnvironment: formatHudClock(Date.now()),
    hudHint: '',
    speedValueStateClass: 'ride-value-pending',
    cadenceValueStateClass: 'ride-value-pending',
    distanceValueStateClass: 'ride-value-pending',
    elapsedValueStateClass: 'ride-value-pending',
    heartRateValueStateClass: 'ride-value-pending',
    distanceMod: '',
    elapsedMod: '',
    gDistanceMod: '',
    gElapsedMod: '',
    menuHasWorkout: false,
    menuWorkoutClass: '',
    menuRideClass: 'feature-focused',
    menuSettingsClass: '',
    workoutSyncText: '同步今日训练',
    workoutPlanTitle: '今日训练',
    workoutPlanSub: '确认后联网校验 · 未同步不开始',
    agentStartText: '',
    workoutStageVisible: false,
    workoutStageTitle: '',
    workoutStageRemaining: '',
    workoutStageTarget: '',
    warmupHeading: '骑前拉伸',
    warmupOverview: '4项 · 每项20秒 · 共80秒',
    warmupStepCount: '动作 1 / 4',
    warmupTitle: '肩胸打开',
    warmupInstruction: '双手身后轻握，肩胛向后收',
    warmupSafety: '肩颈保持放松',
    warmupRemaining: '准备',
    warmupStatus: '确认开始后自动切换动作',
    warmupActionLabel: '开始热身',
    warmupSkipLabel: '跳过热身',
    warmupPrimaryClass: 'warmup-control-focused',
    warmupSkipClass: '',
    warmupFoot: '确认键开始 · 返回键回菜单',
    warmupFigure: 'chest',
    warmupImage: '',
    settingWheel: '2.105m',
    settingDevice: '开',
    settingMaxHeartRate: '190 bpm',
    settingFtp: '未设置',
    settingRideGoal: '自由骑',
    settingVoiceCue: '开',
    settingCadenceCue: '关闭',
    settingLocalLog: '无记录',
    settingHudSkin: '破风带',
    settingsSaveState: '已保存',
    settingWheelClass: 'setting-row-focused',
    settingDeviceClass: '',
    settingMaxHeartRateClass: '',
    settingFtpClass: '',
    settingRideGoalClass: '',
    settingVoiceCueClass: '',
    settingCadenceCueClass: '',
    settingLocalLogClass: '',
    settingHudSkinClass: '',
    searchText: '点击开始搜索',
    searchChip: '待启动',
    primaryLabel: '开始搜索',
    discoveredDevices: [],
    discoveredDeviceCount: 0,
    scanDiagnostic: '等待扫描启动',
    scanProgressText: '准备',
    scanKeyGuide: '往前 / 往后划：选择设备',
    scanExitGuide: '单击：确认选择 · 双击：退出',
    preRideBrief: '先确认设备与眼镜传感器，起步后注意路况。',
    preRideTrend: '近7天暂无骑行记录。',
    searchPrimaryClass: 'search-target-focused',
    sumDistance: '未形成',
    sumElapsed: '未完成',
    sumSpeed: '未记录',
    sumCadence: '未记录',
    sumHeartRate: '未使用',
    sumPower: '未使用',
    sumAdviceTitle: '骑行建议',
    sumReview: '',
    sumSourceNote: '',
    sumTrend: '',
    summaryUploadText: '测试日志待保存',
    summaryPlanText: '',
    summaryExitText: '前划进入骑后放松 · 返回或连续两次确认退出',
    summaryChartTitle: '每分钟速度',
    summaryChartUnit: 'km/h',
    summaryChartData: [],
    showSummaryChart: false,
    summaryChartEmptyText: '速度曲线未形成',
    summaryChartSeries: [{
      yName: 'value',
      xName: 'minute',
      color: '#40ff5e',
      width: 2,
      smooth: false,
    }],
    summaryChartYAxis: { minimum: 0, maximum: 40 },
    summaryChartXAxis: { minimum: 1, maximum: 2 },
    dot5: 'dot',
    dot4: 'dot',
    dot3: 'dot',
    dot2: 'dot',
    dot1: 'dot',
  },

  onLoad(query = {}) {
    this.pageVisible = true;
    this.returnToHomeCard = String(query && query.returnCard || '') === '1';
    this.agentExitDestination = 'app';
    this.surfaceGeneration = 0;
    this.bleLifecycleGeneration = 0;
    this.bleOperationGeneration = 0;
    this.connectAttemptId = 0;
    this.connectingAttemptId = null;
    this.connectingDevice = null;
    this.menuFocusIndex = 0;
    this.guideFocusIndex = 0;
    this.timedGuideKind = null;
    this.warmupTimer = null;
    this.warmupTimerGeneration = 0;
    this.warmupStepIndex = 0;
    this.warmupStarted = false;
    this.warmupCompleted = false;
    this.warmupPausedByHide = false;
    this.warmupRemainingSeconds = RIDE_WARMUP_STEPS[0].durationSec;
    this.warmupStepEndsAtMs = null;
    this.warmupMidpointCueSent = false;
    this.warmupFinalCountCueSent = false;
    this.warmupTtsGeneration = 0;
    this.warmupTtsTimer = null;
    this.settingFocusIndex = 0;
    this.searchFocusIndex = 0;
    this.discoveredDeviceRefs = {};
    this.discoveredDeviceOrder = [];
    this.scanSession = null;
    this.scanAttempted = false;
    this.scanStartedSuccessfully = false;
    this.scanDiscoveryPending = false;
    this.scanResumePending = false;
    this.searchConnectResumePending = false;
    this.searchConnectResumeTimer = null;
    this.connectedDevice = null;
    this.reconnectDevice = null;
    this.bleServer = null;
    this.notificationResources = [];
    this.notificationOwnerResources = [];
    this.notificationStopOperations = [];
    this.terminalDeferredNotificationResources = [];
    this.deferredBleServers = [];
    this.bleServerDisconnects = [];
    this.subscribedSources = {};
    this.gattDropListener = null;
    this.reconnectTimer = null;
    this.reconnectGeneration = 0;
    this.rideStartTimer = null;
    this.reconnectCount = 0;
    this.reconnectDeferred = false;
    this.connecting = false;
    this.connectingAutoResume = false;
    this.bleTerminated = false;
    this.metrics = null;
    this.rideSessionActive = false;
    this.autoPausedByHide = false;
    this.imuClassifier = null;
    this.imuMotionQuality = null;
    this.accelerometer = null;
    this.gyroscope = null;
    this.gyroscopeClock = null;
    this.gyroscopeReadingCount = 0;
    this.gyroscopeLastReadingAtMs = null;
    this.gyroscopeLastRateAtMs = null;
    this.gyroscopeLastRateCount = 0;
    this.gyroscopeObservedHz = null;
    this.gyroscopeResumeProbeAtMs = null;
    this.gyroscopeActivated = false;
    this.gyroscopeDiagnosticState = 'idle';
    this.gyroscopeExpected = false;
    this.gyroscopeStartedAtMs = null;
    this.gyroscopeWatchdogTimer = null;
    this.gyroscopeRestartTimer = null;
    this.gyroscopeRestartCount = 0;
    // AIUI 0.16 reserves `this.orientationSensor` for the page-private World
    // Awareness sensor. Keep the 0.15-owned/reference handle under a distinct
    // name so feature detection never overwrites the host property.
    this.rideOrientationSensor = null;
    this.rideOrientationSensorOwned = false;
    this.rideOrientationListeners = null;
    this.worldAwarenessDiagnostics = createAiuiWorldAwarenessDiagnostics();
    this.orientationClock = null;
    this.orientationReadingCount = 0;
    this.orientationLastReadingAtMs = null;
    this.orientationLastRateAtMs = null;
    this.orientationLastRateCount = 0;
    this.orientationObservedHz = null;
    this.orientationActivated = false;
    this.orientationDiagnosticState = 'idle';
    this.imuGeneration = 0;
    this.imuWatchdogTimer = null;
    this.imuRestartTimer = null;
    this.imuRestartCount = 0;
    this.imuStartedAtMs = null;
    this.imuFirstReadingAtMs = null;
    this.imuLastReadingAtMs = null;
    this.imuReadingCount = 0;
    this.imuLastRateAtMs = null;
    this.imuLastRateCount = 0;
    this.imuObservedHz = null;
    this.imuResumeProbeAtMs = null;
    this.accelerometerActivated = false;
    this.imuLowRateWindowCount = 0;
    this.imuDiagnosticState = 'idle';
    this.heartRateEverLive = false;
    this.heartRateExpected = false;
    this.lastHeartRateDisplayBpm = null;
    this.lastHeartRateDisplayAtMs = null;
    this.heartRateContactLostAtMs = null;
    this.heartRateSubscribedAtMs = null;
    this.lastHrsPacketAtMs = null;
    this.bleSourceRecoveryFlight = null;
    this.bleSourceRecoveryGeneration = 0;
    this.hrsRecoveryPending = false;
    this.lastBleSourceRecoveryAtMs = null;
    this.powerEverLive = false;
    this.minuteSeries = [];
    this.lastMinuteSample = 0;
    this.lastLockedImuHudEstimate = null;
    this.rideHudSpeedHoldRevoked = false;
    this.rideHudCadenceHoldRevoked = false;
    this.lastImuMetricsForwardAtMs = null;
    this.lastImuMetricsSignature = '';
    this.pendingImuMetricsActivity = null;
    this.pendingImuMetricsAtMs = null;
    this.imuMetricsPendingTimer = null;
    this.lastRideHudRenderData = null;
    this.rideHudHiddenHoldPending = false;
    this.rideCoachState = null;
    this.lastRideTickAtMs = null;
    this.rideTickInProgress = false;
    this.rideTickPendingTimer = null;
    this.rideTickPendingSource = '';
    this.blePacketDiagnosticCounts = {};
    this.lastHudDiagnosticAtMs = null;
    this.endArmedAtMs = null;
    this.lastConfirmKeyMs = null;
    this.hudTouchTapAtMs = null;
    this.summaryEnteredAtMs = null;
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    this.lastSummaryBackspaceMs = null;
    this.agentExitRequested = false;
    this.agentExitDispatched = false;
    this.agentExitDispatching = false;
    this.agentExitTimer = null;
    this.terminalBleSealed = false;
    this.terminalBleNativeCleanupStarted = false;
    this.terminalBleCleanupTimer = null;
    this.lastSurfaceActivationAtMs = null;
    this.lastSurfaceActivationId = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.lastSurfaceDirectionAtMs = null;
    this.lastSurfaceDirectionPhase = null;
    this.lastSurfaceDirectionDelta = null;
    this.lastSurfaceDirectionCode = null;
    this.pendingSurfaceGlobalHookTimer = null;
    this.pendingSurfaceGlobalHookPhase = null;
    this.pendingSurfaceGlobalHookAtMs = null;
    this.pendingSurfaceGlobalHookToken = 0;
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.menuEntryConfirmGuardUntilMs = null;
    this.hudEnteredAtMs = null;
    this.cadencePreviewTimer = null;
    this.ttsCadenceResumeTimer = null;
    this.ttsInFlightTimer = null;
    this.ttsInFlightUntilMs = null;
    this.ttsGeneration = 0;
    this.ttsLastAcceptedText = '';
    this.ttsLastAcceptedAtMs = null;
    this.cadenceTone = null;
    this.cadenceToneAudioSrc = '';
    this.blePacketDiagnosticCounts = {};
    this.lastHudDiagnosticAtMs = null;
    this.cyclingUploadSession = null;
    this.cyclingUploadBuffer = [];
    this.cyclingUploadSampleCount = 0;
    this.cyclingUploadFlight = null;
    this.cyclingUploadAuthFlight = null;
    this.cyclingHermesRequestEntries = [];
    this.localFieldLogRideId = '';
    this.localFieldLogStartedAtMs = null;
    this.localFieldLogBuffer = [];
    this.localFieldLogLastCapturedAtMs = null;
    this.localFieldLogWriteFailures = 0;
    this.localFieldLogLastErrorStatus = '';
    this.localFieldLogFinished = false;
    this.localFieldLogReplayTimer = null;
    this.localFieldLogFinishRetryTimer = null;
    this.localFieldLogFinishRetryCount = 0;
    this.hermesLifecycleGeneration = 1;
    this.pageUnloaded = false;
    this.lastCyclingUploadRideId = '';
    this.rideCoachState = null;
    this.sportsIdentity = readSportsIdentity(wx);
    if (this.sportsIdentity) reconcileSportAgentHandshakeOwner(wx, this.sportsIdentity);
    this.sportsIdentityFlight = null;
    this.sportsIdentityRequestFlight = null;
    this.sportsWorkoutFlight = null;
    this.sportsOutboxFlight = null;
    this.sportAgentPreparationFlight = null;
    this.sportAgentPreparationGeneration = 0;
    this.sportAgentPreparationKey = '';
    this.sportAgentClientSessionId = '';
    this.sportAgentStartFlight = null;
    this.sportAgentStartPending = false;
    this.pendingSportAgent = null;
    this.activeSportAgent = null;
    this.sportAgentOutboxFlight = null;
    this.sportAgentDebriefPollTimer = null;
    this.sportAgentDebriefPollCount = 0;
    this.sportAgentDebriefPollSessionId = '';
    this.lastSportAgentPlanRefreshSessionId = '';
    this.sportAgentSeq = 0;
    this.sportAgentLastQueuedAtMs = null;
    this.sportAgentLastStageId = '';
    this.sportsWorkoutEnvelope = this.sportsIdentity
      ? readSportsWorkoutCache(wx, this.sportsIdentity) : null;
    this.pendingSportsPlan = null;
    this.recoveredSportAgentPlan = this.sportsIdentity
      ? recoverSportAgentPlannedPrestart(wx, this.sportsIdentity) : null;
    this.blockingSportAgentActive = this.sportsIdentity
      ? readSportAgentActive(wx, this.sportsIdentity) : null;
    this.activeSportsPlan = null;
    this.sportsWorkoutExecutor = null;
    this.sportsCoachState = null;
    this.sportsExecutionId = '';
    this.sportsStartedAtMs = null;
    this.sportsOwnerAtStart = null;
    this.pendingSportsOutboxSaved = true;
    this.lastRideSummary = readLastRideSummary(wx);
    this.rideHistory = readRideHistory(wx);
    this.summaryAiGeneration = 0;
    this.summaryAiStartTimer = null;
    this.summaryLlmSession = null;
    this.summaryFinalizeTimer = null;
    this.summaryFinalizationStarted = false;
    this.summaryPersistenceConfirmed = false;
    this.summaryPersistenceFlight = null;
    this.summaryPersistenceRetryTimer = null;
    this.summaryPersistenceRetryResolve = null;
    this.summaryPersistenceGeneration = 0;
    this.summaryExitPending = false;
    this.pendingSummaryExitSource = '';
    this.pendingRideSummaryCommit = null;
    this.finishRideCommitted = false;
    this.rideSettings = writeBikeSettings(wx, readBikeSettings(wx));
    this.syncSettingsData();
    this.syncSportsWorkoutMenu();
    this.refreshPreRideBrief();
    const requestedMode = query && typeof query.mode === 'string' ? query.mode : 'free';
    if (requestedMode === 'menu') {
      if (query && String(query.inputGuard || '') === '1') {
        this.menuEntryConfirmGuardUntilMs = Date.now() + MENU_ENTRY_CONFIRM_GRACE_MS;
      }
      this.setData({ surfacePhase: 'menu' });
    } else if (requestedMode === 'settings') {
      this.setData({ surfacePhase: 'settings' });
    } else {
      this.setData({ surfacePhase: 'ready' });
      this.applyDeviceSettingToEntry();
    }
    this.setData({ hudEnvironment: formatHudClock(Date.now()) });
    this.recoverStaleCyclingLocalFieldLogs(Date.now());
  },

  onShow() {
    const now = Date.now();
    const resumedFromHidden = this.pageVisible !== true;
    let resumedRideResources = false;
    try {
      console.log('[AIBike Lifecycle] PAGE_SHOW phase='
        + String(this.data.surfacePhase || '')
        + ' riding=' + String(this.rideSessionActive === true));
    } catch (_ignored) {}
    if (!this.pageVisible) {
      this.bleLifecycleGeneration = (this.bleLifecycleGeneration || 0) + 1;
    }
    this.pageVisible = true;
    if (this.isTimedGuidePhase() && this.warmupPausedByHide) {
      this.resumeWarmupRoutine();
    }
    if (this.scanResumePending && this.isSearchPhase()
        && !this.agentExitRequested && !this.bleTerminated) {
      this.scanResumePending = false;
      this.setData({
        searchChip: '恢复扫描',
        searchText: '正在恢复骑行设备搜索...',
        scanDiagnostic: '页面恢复，重新启动扫描',
        scanProgressText: '启动中',
      });
      this.startDiscovery();
    }
    if (this.searchConnectResumePending && this.isSearchPhase()
        && !this.agentExitRequested && !this.bleTerminated) {
      const target = this.reconnectDevice;
      this.searchConnectResumePending = false;
      if (target && !this.hasHealthyBleConnection(target) && !this.connecting) {
        this.setData({
          searchChip: '恢复连接',
          searchText: '正在恢复骑行设备连接',
        });
        const lifecycleGeneration = this.bleLifecycleGeneration;
        this.searchConnectResumeTimer = setTimeout(() => {
          this.searchConnectResumeTimer = null;
          if (!this.pageVisible || this.bleTerminated || this.agentExitRequested
              || lifecycleGeneration !== this.bleLifecycleGeneration
              || !this.isSearchPhase() || this.connecting
              || this.hasHealthyBleConnection(target)) return;
          this.connectSelected(target, { reconnect: true, autoResume: true });
        }, SEARCH_CONNECT_RESUME_GRACE_MS);
      }
    }
    if (this.rideSessionActive && this.metrics && this.metrics.paused
        && this.autoPausedByHide === true) {
      if (this.metrics && typeof this.metrics.resume === 'function') this.metrics.resume(now);
      this.autoPausedByHide = false;
      this.setData({ paused: false });
      // hide 已销毁旧的 Generic Sensor bundle；show 只建立一个
      // 新 generation，避免复用被录屏切换作废的原生句柄。
      const imuResumed = this.startRideImu({
        restart: true,
        reason: 'show-resume',
      });
      this.startRideCadenceCue();
      this.startTicker();
      resumedRideResources = true;
      try {
        const snapshot = this.metrics && typeof this.metrics.snapshot === 'function'
          ? this.metrics.snapshot(now) : null;
        if (snapshot) this.queueSportAgentEvent(snapshot, now, 'resume');
      } catch (_error) {}
      this.recordCyclingLocalLifecycle('resumed', {
        atMs: now,
        reason: 'host_show',
        sensor: 'runtime',
        generation: this.imuGeneration,
      });
      this.recordCyclingLocalLifecycle('imu_rebuild', {
        atMs: now,
        reason: 'host_show',
        sensor: 'bundle',
        generation: this.imuGeneration,
      });
      try {
        console.log('[AIBike Lifecycle] RIDE_RESUMED imuMode='
          + String(imuResumed ? 'rebuilt' : 'unavailable'));
      } catch (_ignored) {}
    }
    if (this.rideSessionActive) {
      const imuMissing = !this.accelerometer && !this.gyroscope;
      const imuStartedAtMs = Number.isFinite(this.imuStartedAtMs)
        ? this.imuStartedAtMs : null;
      const accelReferenceAtMs = Number.isFinite(this.imuLastReadingAtMs)
        ? this.imuLastReadingAtMs : imuStartedAtMs;
      const gyroReferenceAtMs = Number.isFinite(this.gyroscopeLastReadingAtMs)
        ? this.gyroscopeLastReadingAtMs : this.gyroscopeStartedAtMs;
      const imuStale = !!(
        this.accelerometer && accelReferenceAtMs != null
        && now - accelReferenceAtMs > IMU_RESUME_STALE_MS
      );
      if (!resumedRideResources && (imuMissing || imuStale)) {
        if (!imuMissing) {
          this.stopRideImu({
            preserveRestartCount: true,
            diagnosticState: 'restarting',
          });
        }
        this.startRideImu({ restart: true, reason: 'show-stale' });
      }
      const gyroStale = this.gyroscopeExpected === true
        && (
          !this.gyroscope
          || gyroReferenceAtMs == null
          || now - gyroReferenceAtMs > IMU_RESUME_STALE_MS
        );
      if (!resumedRideResources && !imuMissing && !imuStale && gyroStale) {
        // Gyroscope 是无外设踏频的主证据。它单独停流时只重建自己，
        // 不拆掉仍健康的 Accelerometer、分类器和已锁定显示。
        this.scheduleRideGyroscopeRestart(
          this.imuGeneration,
          'show-stale',
          { immediate: true },
        );
      }
      if (!this.tickTimer) this.startTicker();
      const cadenceRpm = Number(
        this.rideSettings && this.rideSettings.cadenceToneRpm,
      ) || 0;
      if (cadenceRpm > 0 && this.metrics && this.metrics.paused !== true
          && (!this.cadenceTone || this.cadenceTone.running !== true)) {
        this.startRideCadenceCue();
      }
      // show 恢复与传感器帧共用 500ms HUD 门。
      this.requestRideTick(resumedFromHidden ? 'show-resume' : 'show', now);
      const target = this.connectedDevice || this.reconnectDevice;
      if (target && !this.hasHealthyBleConnection(target) && !this.connecting) {
        this.reconnectDeferred = false;
        this.scheduleReconnect(target);
      }
      if (this.hrsRecoveryPending && !this.bleSourceRecoveryFlight) {
        if (this.restartBleForStaleSource('hrs', now, { forceFull: true })) {
          this.hrsRecoveryPending = false;
        }
      }
      this.evaluateRideSourceHealth(now, 'show');
    } else {
      this.refreshStoredRideContext();
      if (readPendingCyclingUploadEvents(wx).length) {
        this.flushCyclingTestUploads({
          updateSummary: this.isSummaryPhase(),
          rideId: this.lastCyclingUploadRideId || '',
        });
      } else if (this.isSearchPhase()) {
        this.prewarmCyclingUploadAuth();
      }
      const outboxIdentity = this.sportsIdentity || readSportsIdentity(wx);
      if (outboxIdentity) {
        this.sportsIdentity = outboxIdentity;
        if (readSportsOutbox(wx, outboxIdentity).length) {
          this.flushSportsActivityOutbox({ updateSummary: this.isSummaryPhase() });
        }
        if (readSportAgentOutbox(wx, outboxIdentity).length) {
          this.flushSportAgentSessionOutbox({ updateSummary: this.isSummaryPhase() });
        }
        if (this.isSummaryPhase()) {
          const cachedDebrief = readSportAgentDebriefCache(wx, outboxIdentity);
          if (cachedDebrief) this.scheduleSportAgentDebriefPoll(cachedDebrief);
        }
      }
    }
  },

  onHide() {
    try {
      console.log('[AIBike Lifecycle] PAGE_HIDE phase='
        + String(this.data.surfacePhase || '')
        + ' riding=' + String(this.rideSessionActive === true));
    } catch (_ignored) {}
    if (this.isTimedGuidePhase() && !this.pauseWarmupRoutine()) {
      this.cancelWarmupTts();
    }
    const resumeTimerPending = Boolean(this.searchConnectResumeTimer);
    this.clearSearchConnectResumeTimer();
    this.scanResumePending = Boolean(
      this.isSearchPhase()
      && this.scanAttempted
      && (this.scanSession || this.scanDiscoveryPending),
    );
    this.scanDiscoveryPending = false;
    this.searchConnectResumePending = Boolean(
      this.isSearchPhase() && (this.connectingDevice || resumeTimerPending),
    );
    this.pageVisible = false;
    // 非骑行 Hermes 网络只属于当前可见 lifecycle。原生 task abort 后
    // promise 仍可能 settle，因此同时推进 generation，让迟到回调只做
    // 本地持久队列收尾，绝不改写隐藏页或下一次 show 的菜单/总结。
    this.invalidateHermesLifecycle();
    this.bleLifecycleGeneration = (this.bleLifecycleGeneration || 0) + 1;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.connectingAttemptId = null;
    if (this.connectingDevice && !this.reconnectDevice) {
      this.reconnectDevice = this.connectingDevice;
    }
    this.connectingDevice = null;
    this.connecting = false;
    this.connectingAutoResume = false;
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceDirectionBurst();
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearSurfaceActivationGate();
    this.stopScan();
    this.clearRideStartTimer();
    this.clearReconnectTimer();
    this.reconnectDeferred = Boolean(
      (this.connectedDevice || this.reconnectDevice)
      && this.rideSessionActive,
    );
    this.clearTtsRuntime();
    this.stopCadenceCue();
    if (this.rideSessionActive) {
      // 先原子暂停净时长和距离账本，再彻底释放录屏切换前的
      // Generic Sensor bundle。show 后用新
      // generation 重建，旧句柄的迟到帧会被对象与 generation fence 拒绝。
      const now = Date.now();
      let localSnapshot = null;
      try {
        const snapshot = this.metrics && typeof this.metrics.snapshot === 'function'
          ? this.metrics.snapshot(now) : null;
        localSnapshot = snapshot;
        if (snapshot) this.queueSportAgentEvent(snapshot, now, 'pause');
      } catch (_error) {}
      if (localSnapshot) {
        this.captureCyclingLocalFieldSample(
          localSnapshot,
          now,
          'unknown',
          true,
        );
      }
      this.flushCyclingLocalFieldLogBuffer();
      this.recordCyclingLocalLifecycle('paused', {
        atMs: now,
        elapsedMs: localSnapshot && localSnapshot.elapsedMs,
        reason: 'host_hidden',
        sensor: 'runtime',
        generation: this.imuGeneration,
      });
      this.recordCyclingLocalLifecycle('imu_stopped', {
        atMs: now,
        elapsedMs: localSnapshot && localSnapshot.elapsedMs,
        reason: 'host_hidden',
        sensor: 'bundle',
        generation: this.imuGeneration,
      });
      if (this.metrics && !this.metrics.paused) {
        if (typeof this.metrics.pause === 'function') this.metrics.pause(now);
        this.autoPausedByHide = true;
        this.setData({ paused: true });
      }
      this.rideHudHiddenHoldPending = true;
      this.stopTicker();
      this.stopRideImu({
        preserveRestartCount: true,
        diagnosticState: 'hidden',
      });
      try {
        console.log('[AIBike Lifecycle] RIDE_PAUSED sensorsStopped=true');
      } catch (_ignored) {}
    } else {
      this.stopRideImu();
      this.stopTicker();
    }
    this.flushCyclingUploadBuffer();
  },

  onUnload() {
    const unloadedAtMs = Date.now();
    if (this.rideSessionActive && this.metrics) {
      let snapshot = null;
      try { snapshot = this.metrics.snapshot(unloadedAtMs); } catch (_error) {}
      if (snapshot) {
        this.captureCyclingLocalFieldSample(
          snapshot,
          unloadedAtMs,
          'unknown',
          true,
        );
      }
      this.flushCyclingLocalFieldLogBuffer();
      this.recordCyclingLocalLifecycle('page_unloaded', {
        atMs: unloadedAtMs,
        elapsedMs: snapshot && snapshot.elapsedMs,
        reason: 'unload',
        sensor: 'runtime',
        generation: this.imuGeneration,
      });
      this.finishCyclingLocalFieldCapture(
        null,
        snapshot,
        unloadedAtMs,
        { aborted: true },
      );
    }
    this.pageVisible = false;
    this.pageUnloaded = true;
    if (this.localFieldLogReplayTimer) clearTimeout(this.localFieldLogReplayTimer);
    this.localFieldLogReplayTimer = null;
    if (this.localFieldLogFinishRetryTimer) {
      clearTimeout(this.localFieldLogFinishRetryTimer);
    }
    this.localFieldLogFinishRetryTimer = null;
    this.invalidateHermesLifecycle();
    this.clearSportAgentDebriefPoll();
    this.cancelSummaryAiAdvice();
    if (this.summaryFinalizeTimer) clearTimeout(this.summaryFinalizeTimer);
    this.summaryFinalizeTimer = null;
    if (this.isSummaryPhase()
        && this.summaryPersistenceConfirmed !== true) {
      this.persistRideSummaryCommit();
    }
    this.cancelSummaryPersistenceRetry();
    this.flushCyclingUploadBuffer();
    this.clearSurfaceTimers();
    this.stopTicker();
    this.stopRideImu();
    this.clearTtsRuntime({ resetDedupe: true });
    this.stopCadenceCue({ destroy: true });
    this.clearReconnectTimer();
    if (this.agentExitRequested && !this.agentExitDispatched) this.dispatchAgentExit();
    else this.clearAgentExitTimer();
    this.teardownBle({ terminal: true });
  },

  refreshPreRideBrief() {
    const sourceResources = this.notificationResources || [];
    const hasSource = (name) => sourceResources.some(
      (resource) => resource.active
        && resource.committed
        && resource.source === name,
    );
    const imuReady = typeof Accelerometer !== 'undefined'
      || typeof Gyroscope !== 'undefined';
    const capabilities = {
      imuReady,
      heartRateConnected: hasSource('hrs') || hasSource('ftms'),
      cyclingSensorConnected:
        hasSource('csc') || hasSource('cps') || hasSource('ftms'),
    };
    const brief = buildPreRideBrief(this.lastRideSummary, capabilities);
    const trend = buildRideTrendText(
      this.rideHistory || readRideHistory(wx),
      Date.now(),
      'pre',
    );
    const settings = this.rideSettings || DEFAULT_BIKE_SETTINGS;
    const profile = '目标 ' + formatRideGoal(settings.rideGoal)
      + (Number(settings.ftpW) > 0 ? ' · FTP ' + String(settings.ftpW) + 'W' : '');
    this.setData({
      preRideBrief: brief,
      preRideTrend: profile + ' · ' + trend,
    });
    return brief;
  },

  syncSettingsData() {
    const settings = this.rideSettings || DEFAULT_BIKE_SETTINGS;
    let localLogText = '无记录';
    try {
      const localIndex = readCyclingLocalFieldLogIndexResult(wx);
      const latest = localIndex && localIndex.ok === true
        && localIndex.index && Array.isArray(localIndex.index.rides)
        ? localIndex.index.rides[0] : null;
      if (latest) localLogText = '最近 ' + String(latest.sample_count || 0) + ' 条';
    } catch (_error) {}
    this.setData({
      settingWheel: formatWheelCircumference(settings.wheelCircumferenceMm),
      settingDevice: formatSwitch(settings.autoHeartRate),
      settingMaxHeartRate: formatMaxHeartRate(settings.maxHeartRateBpm),
      settingFtp: formatFtp(settings.ftpW),
      settingRideGoal: formatRideGoal(settings.rideGoal),
      settingVoiceCue: formatSwitch(settings.voiceCue),
      settingCadenceCue: formatCadenceTone(settings.cadenceToneRpm),
      settingLocalLog: localLogText,
      settingsSaveState: '已保存',
    });
  },

  applyDeviceSettingToEntry() {
    if (!this.rideSettings || this.rideSettings.autoHeartRate !== false) return;
    this.setData({
      searchText: '心率搜索已关闭',
      searchChip: '骑行设备可用',
      scanDiagnostic: '仍会搜索 CSC、功率计与骑行台',
    });
  },

  syncSportsWorkoutMenu() {
    const envelope = this.sportsWorkoutEnvelope;
    const recovered = this.blockingSportAgentActive ? null : this.recoveredSportAgentPlan;
    const plan = this.blockingSportAgentActive
      ? { title: this.blockingSportAgentActive.completion_queued
        ? '上次总结待同步' : '恢复未完成骑行' }
      : (recovered && recovered.plan
      ? recovered.plan
      : (envelope && envelope.available === true && envelope.fresh === true
        ? envelope.plan : null));
    this.setData({
      menuHasWorkout: Boolean(plan),
      workoutSyncText: this.sportsWorkoutFlight ? '正在同步'
        : (this.blockingSportAgentActive
          ? (this.blockingSportAgentActive.completion_queued
            ? '等待总结同步' : '需结束上次骑行')
          : (recovered ? '恢复已确认训练' : (plan ? '在线确认后开骑' : '同步今日训练'))),
      workoutPlanTitle: plan ? plan.title : '今日训练',
      workoutPlanSub: plan
        ? (this.blockingSportAgentActive
          ? (this.blockingSportAgentActive.completion_queued
            ? '点击重试同步 · 确认后可再骑' : '点击安全结束 · 总结待同步')
          : (recovered ? '已保留开骑确认 · 点击继续' : '已缓存预览 · 确认时再次联网校验'))
        : '确认后联网校验 · 未同步不开始',
    });
    if (!plan && this.menuFocusIndex === 0) this.menuFocusIndex = 1;
    this.setMenuFocus(this.menuFocusIndex == null ? (plan ? 0 : 1) : this.menuFocusIndex);
    return plan;
  },

  ensureCurrentSportsIdentity(options = {}) {
    if (this.rideSessionActive === true) return Promise.resolve(null);
    if (this.sportsIdentity && this.sportsIdentity.ready !== false
        && this.sportsIdentity.token && options.forceRefresh !== true) {
      return Promise.resolve(this.sportsIdentity);
    }
    if (this.sportsIdentityFlight) return this.sportsIdentityFlight;
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    if (this.sportsIdentityRequestFlight && options.forceRefresh !== true) {
      const shared = this.sportsIdentityRequestFlight.then(() => {
        if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return null;
        const identity = readSportsIdentity(wx);
        if (!identity || identity.ready === false || !identity.token) return null;
        const previous = this.sportsIdentity;
        this.sportsIdentity = identity;
        reconcileSportAgentHandshakeOwner(wx, identity);
        this.blockingSportAgentActive = readSportAgentActive(wx, identity);
        this.recoveredSportAgentPlan = recoverSportAgentPlannedPrestart(wx, identity);
        if (previous && !sameSportsOwner(previous, identity)) {
          this.sportsWorkoutEnvelope = null;
          this.pendingSportsPlan = null;
        } else {
          this.sportsWorkoutEnvelope = readSportsWorkoutCache(wx, identity);
        }
        this.syncSportsWorkoutMenu();
        return identity;
      }).catch(() => null).finally(() => {
        if (this.sportsIdentityFlight === shared) this.sportsIdentityFlight = null;
      });
      this.sportsIdentityFlight = shared;
      return shared;
    }
    const flight = ensureSportsIdentity({
      storage: wx,
      forceRefresh: options.forceRefresh === true,
      request: (requestOptions) => this.requestCyclingHermes(requestOptions),
    }).then((identity) => {
      if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return null;
      if (!identity || identity.ready !== true || !identity.token) return null;
      const previous = this.sportsIdentity;
      const claimed = previous && isSportsAnonymousClaimTransition(previous, identity);
      let handshakeMigration = null;
      if (claimed) {
        migrateSportAgentOutboxForAnonymousClaim(wx, previous, identity);
        migrateSportAgentDebriefForAnonymousClaim(wx, previous, identity);
        handshakeMigration = migrateSportAgentHandshakeForAnonymousClaim(
          wx,
          previous,
          identity,
        );
        if (!handshakeMigration) {
          try {
            console.log('[AIBike Sport Agent] CLAIM_HANDSHAKE_FAIL_CLOSED');
          } catch (_ignored) {}
        }
      }
      this.sportsIdentity = identity;
      reconcileSportAgentHandshakeOwner(wx, identity);
      this.blockingSportAgentActive = readSportAgentActive(wx, identity);
      this.recoveredSportAgentPlan = recoverSportAgentPlannedPrestart(wx, identity);
      if (previous && !sameSportsOwner(previous, identity)) {
        this.clearSportAgentDebriefPoll();
        this.sportsWorkoutEnvelope = null;
        this.pendingSportsPlan = null;
        // Memory state never crosses owners.  A committed durable session may
        // cross only the exact server-proven anonymous_claim transaction above
        // and only after its atomic write/readback succeeds; otherwise owner
        // reconciliation purges it and the next launch creates a new session.
        this.pendingSportAgent = null;
        this.sportAgentPreparationGeneration =
          (this.sportAgentPreparationGeneration || 0) + 1;
      } else {
        this.sportsWorkoutEnvelope = readSportsWorkoutCache(wx, identity);
      }
      this.syncSportsWorkoutMenu();
      return identity;
    }).catch(() => null).finally(() => {
      if (this.sportsIdentityFlight === flight) this.sportsIdentityFlight = null;
      if (this.sportsIdentityRequestFlight === flight) {
        this.sportsIdentityRequestFlight = null;
      }
    });
    this.sportsIdentityFlight = flight;
    this.sportsIdentityRequestFlight = flight;
    return flight;
  },

  refreshTodayWorkout(options = {}) {
    if (this.rideSessionActive === true || this.sportsWorkoutFlight) {
      return this.sportsWorkoutFlight || Promise.resolve(null);
    }
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    this.setData({ workoutSyncText: '正在同步' });
    const flight = this.ensureCurrentSportsIdentity().then((identity) => {
      if (!identity || !this.isHermesLifecycleCurrent(lifecycleGeneration)) return null;
      return refreshSportsWorkout({
        storage: wx,
        identity,
        request: (requestOptions) => this.requestCyclingHermes(requestOptions),
      });
    }).then((result) => {
      if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return null;
      const envelope = result && result.ready === true ? result.envelope : null;
      if (envelope) this.sportsWorkoutEnvelope = envelope;
      this.syncSportsWorkoutMenu();
      if (!envelope && options.jit === true) {
        this.setData({
          workoutSyncText: '同步失败',
          workoutPlanSub: '未获得在线确认 · 本次不能开始计划',
        });
      }
      return envelope;
    }).catch(() => {
      if (this.isHermesLifecycleCurrent(lifecycleGeneration)) {
        this.syncSportsWorkoutMenu();
      }
      return null;
    }).finally(() => {
      if (this.sportsWorkoutFlight === flight) {
        this.sportsWorkoutFlight = null;
        if (this.isHermesLifecycleCurrent(lifecycleGeneration)) {
          this.syncSportsWorkoutMenu();
        }
      }
    });
    this.sportsWorkoutFlight = flight;
    return flight;
  },

  sportAgentMode(plan = this.pendingSportsPlan) {
    if (plan && plan.workout_id) return 'planned';
    const goal = String(
      (this.rideSettings || DEFAULT_BIKE_SETTINGS).rideGoal || 'free',
    );
    return ['free', 'recovery', 'endurance'].includes(goal) ? goal : 'free';
  },

  sportAgentCapabilities() {
    const active = (source) => (this.notificationResources || []).some(
      (resource) => resource && resource.active && resource.committed
        && resource.source === source,
    );
    // Capability v2 freezes execution authority, not every local estimator.
    // Glasses IMU remains available for local HUD/recording, but it cannot
    // authorize a server cadence target before any real cycling notification.
    return {
      heartRate: active('hrs') || active('ftms'),
      cadence: active('csc') || active('cps') || active('ftms'),
      speed: active('csc') || active('cps') || active('ftms'),
      power: active('cps') || active('ftms'),
    };
  },

  sportAgentPreparationKeyFor(plan, capabilities = this.sportAgentCapabilities()) {
    const mode = this.sportAgentMode(plan);
    const workoutId = plan && plan.workout_id ? plan.workout_id : '';
    const revision = plan && Number.isFinite(Number(plan.revision))
      ? Number(plan.revision) : 0;
    const wireCapabilities = {
      heart_rate: capabilities.heartRate === true,
      pace: false,
      cadence: capabilities.cadence === true,
      speed: capabilities.speed === true,
      power: capabilities.power === true,
    };
    return [mode, workoutId, revision,
      sportAgentCapabilitiesSignature(wireCapabilities)].join('|');
  },

  resetPendingSportAgent() {
    this.sportAgentPreparationGeneration =
      (Number(this.sportAgentPreparationGeneration) || 0) + 1;
    this.sportAgentPreparationFlight = null;
    this.sportAgentPreparationKey = '';
    this.sportAgentClientSessionId = '';
    this.pendingSportAgent = null;
  },

  prepareCurrentSportAgent(options = {}) {
    if (this.rideSessionActive === true || this.agentExitRequested) {
      return Promise.resolve(null);
    }
    const plan = options.plan || this.pendingSportsPlan || null;
    const mode = this.sportAgentMode(plan);
    const workoutId = plan && plan.workout_id ? plan.workout_id : '';
    const capabilities = options.capabilities || this.sportAgentCapabilities();
    const preparationKey = this.sportAgentPreparationKeyFor(plan, capabilities);
    const existing = this.pendingSportAgent;
    if (options.force !== true && existing && existing.mode === mode
        && existing.workoutId === workoutId && existing.session
        && existing.preparationKey === preparationKey) {
      return Promise.resolve(existing);
    }
    if (this.sportAgentPreparationFlight && options.force !== true
        && this.sportAgentPreparationKey === preparationKey) {
      return this.sportAgentPreparationFlight;
    }
    const generation = (this.sportAgentPreparationGeneration || 0) + 1;
    this.sportAgentPreparationGeneration = generation;
    this.sportAgentPreparationKey = preparationKey;
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    const journalIdentity = this.sportsIdentity || readSportsIdentity(wx);
    const journal = journalIdentity ? readSportAgentPrestart(wx, journalIdentity) : null;
    const clientSessionId = journal
      && journal.mode === mode
      && (journal.workout_id || '') === workoutId
      && journal.workout_revision === (plan ? Number(plan.revision) : null)
      ? journal.client_session_id
      : (options.clientSessionId || createSportAgentClientId('bike-session'));
    this.sportAgentClientSessionId = clientSessionId;
    const flight = this.ensureCurrentSportsIdentity().then((identity) => {
      if (!identity || generation !== this.sportAgentPreparationGeneration
          || !this.isHermesLifecycleCurrent(lifecycleGeneration)
          || this.rideSessionActive === true || this.agentExitRequested) return null;
      return prepareSportAgentSession({
        storage: wx,
        identity,
        mode,
        workoutId,
        workoutRevision: plan ? plan.revision : undefined,
        clientSessionId,
        ...capabilities,
        request: (requestOptions) => this.requestCyclingHermes(requestOptions),
      }).then((prepared) => {
        if (!prepared || generation !== this.sportAgentPreparationGeneration
            || !this.isHermesLifecycleCurrent(lifecycleGeneration)
            || this.rideSessionActive === true || this.agentExitRequested
            || !sameSportsOwner(identity, this.sportsIdentity || identity)) return null;
        const value = {
          identity,
          mode,
          workoutId,
          clientSessionId,
          preparationKey,
          briefing: prepared.briefing,
          session: prepared.session,
        };
        this.pendingSportAgent = value;
        try {
          console.log('[AIBike Sport Agent] SESSION_READY mode=' + mode
            + ' workout=' + (workoutId || 'none'));
        } catch (_ignored) {}
        return value;
      });
    }).catch(() => null).finally(() => {
      if (this.sportAgentPreparationFlight === flight) {
        this.sportAgentPreparationFlight = null;
      }
    });
    this.sportAgentPreparationFlight = flight;
    return flight;
  },

  setMenuFocus(index) {
    const hasWorkout = this.data.menuHasWorkout === true;
    const order = hasWorkout ? [0, 1, 2] : [1, 2];
    const raw = Number(index);
    let next = order.includes(raw) ? raw : order[0];
    if (!order.includes(raw) && Number.isFinite(raw)) {
      const currentAt = Math.max(0, order.indexOf(this.menuFocusIndex));
      const delta = raw > Number(this.menuFocusIndex) ? 1 : -1;
      next = order[((currentAt + delta) % order.length + order.length) % order.length];
    }
    this.menuFocusIndex = next;
    this.setData({
      menuWorkoutClass: next === 0 ? 'feature-focused' : '',
      menuRideClass: next === 1 ? 'feature-focused' : '',
      menuSettingsClass: next === 2 ? 'feature-focused' : '',
    });
    return next;
  },

  onMenuFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.shouldAcceptHostFocus('menu', index, this.menuFocusIndex)) return false;
    this.setMenuFocus(index);
    return true;
  },

  refreshStoredRideContext() {
    if (this.rideSessionActive || this.isSummaryPhase()
        || this.pendingRideSummaryCommit) return false;
    const storedSummary = readLastRideSummary(wx);
    const storedHistory = readRideHistory(wx);
    if (storedSummary) this.lastRideSummary = storedSummary;
    const currentRides = this.rideHistory && Array.isArray(this.rideHistory.rides)
      ? this.rideHistory.rides : [];
    const storedRides = storedHistory && Array.isArray(storedHistory.rides)
      ? storedHistory.rides : [];
    // readRideHistory 在存储异常时安全返回空历史；不能因此覆盖已经确认的
    // 内存历史。首次失败后下次 onShow 读到非空记录即可恢复。
    if (storedRides.length || !currentRides.length) {
      this.rideHistory = storedHistory;
    }
    this.refreshPreRideBrief();
    return true;
  },

  setSettingFocus(index) {
    const raw = Number(index) || 0;
    const next = ((raw % SETTINGS_FOCUS_COUNT) + SETTINGS_FOCUS_COUNT)
      % SETTINGS_FOCUS_COUNT;
    if (next !== 6) this.stopCadenceCue();
    const names = [
      'Wheel',
      'Device',
      'MaxHeartRate',
      'Ftp',
      'RideGoal',
      'VoiceCue',
      'CadenceCue',
      'LocalLog',
    ];
    const patch = {};
    for (let i = 0; i < names.length; i += 1) {
      patch['setting' + names[i] + 'Class'] = i === next ? 'setting-row-focused' : '';
    }
    this.settingFocusIndex = next;
    this.setData(patch);
    return next;
  },

  onSettingFocus(event) {
    const index = event && event.currentTarget && event.currentTarget.dataset
      ? Number(event.currentTarget.dataset.index) : 0;
    if (!this.shouldAcceptHostFocus('settings', index, this.settingFocusIndex)) return false;
    this.setSettingFocus(index);
    return true;
  },

  onSettingTap(event) {
    if (this.data.surfacePhase !== 'settings') return false;
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const key = dataset && dataset.setting ? String(dataset.setting) : '';
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.claimSurfaceActivation('setting-' + key)) return false;
    this.setSettingFocus(index);
    const next = { ...(this.rideSettings || DEFAULT_BIKE_SETTINGS) };
    if (key === 'wheel') {
      next.wheelCircumferenceMm = nextWheelCircumferenceMm(next.wheelCircumferenceMm);
    } else if (key === 'device') {
      next.autoHeartRate = !next.autoHeartRate;
    } else if (key === 'max-heart-rate') {
      next.maxHeartRateBpm = nextMaxHeartRateBpm(next.maxHeartRateBpm);
      next.maxHeartRateExplicit = true;
    } else if (key === 'ftp') {
      next.ftpW = nextFtpW(next.ftpW);
    } else if (key === 'ride-goal') {
      next.rideGoal = nextRideGoal(next.rideGoal);
    } else if (key === 'voice') {
      next.voiceCue = !next.voiceCue;
    } else if (key === 'cadence') {
      next.cadenceToneRpm = nextCadenceToneRpm(next.cadenceToneRpm);
    } else if (key === 'local-log') {
      this.setData({ settingsSaveState: '诊断仅保存在本机，不输出日志' });
      return true;
    } else {
      return false;
    }
    this.rideSettings = writeBikeSettings(wx, next);
    if (this.metrics && typeof this.metrics.setWheelCircumferenceMm === 'function') {
      this.metrics.setWheelCircumferenceMm(
        this.rideSettings.wheelCircumferenceMm,
        Date.now(),
      );
    }
    this.syncSettingsData();
    if (key === 'cadence') {
      const rpm = Number(this.rideSettings.cadenceToneRpm) || 0;
      if (rpm > 0) {
        this.startCadenceCue(rpm, { previewBeats: 8 });
        this.setData({ settingsSaveState: '试听 ' + rpm + ' RPM' });
      } else {
        this.stopCadenceCue();
        this.setData({ settingsSaveState: '踏频提示关闭' });
      }
    } else if (key === 'ride-goal') {
      this.setData({
        settingsSaveState: '目标 ' + formatRideGoal(this.rideSettings.rideGoal),
      });
    }
    return true;
  },

  clearWarmupTimer() {
    this.warmupTimerGeneration = (this.warmupTimerGeneration || 0) + 1;
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = null;
  },

  isTimedGuidePhase() {
    return this.data.surfacePhase === 'warmup'
      || this.data.surfacePhase === 'recovery';
  },

  currentRideGuideKind() {
    return this.timedGuideKind === RIDE_GUIDE_KIND.RECOVERY
      ? RIDE_GUIDE_KIND.RECOVERY : RIDE_GUIDE_KIND.WARMUP;
  },

  setGuideFocus(index) {
    const count = this.data.surfacePhase === 'warmup' ? 2 : 1;
    const raw = Number(index) || 0;
    const next = ((raw % count) + count) % count;
    this.guideFocusIndex = next;
    this.setData({
      warmupPrimaryClass: next === 0 ? 'warmup-control-focused' : '',
      warmupSkipClass: next === 1 ? 'warmup-control-focused' : '',
    });
    return next;
  },

  onWarmupFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.shouldAcceptHostFocus(
      this.data.surfacePhase,
      index,
      this.guideFocusIndex,
    )) return false;
    this.setGuideFocus(index);
    return true;
  },

  cancelWarmupTts() {
    this.warmupTtsGeneration = (this.warmupTtsGeneration || 0) + 1;
    if (this.warmupTtsTimer) clearTimeout(this.warmupTtsTimer);
    this.warmupTtsTimer = null;
  },

  queueWarmupSpeech(text, delayMs = 0) {
    const cue = String(text || '').trim();
    if (!cue) return false;
    this.cancelWarmupTts();
    const generation = this.warmupTtsGeneration;
    this.warmupTtsTimer = setTimeout(() => {
      this.warmupTtsTimer = null;
      if (generation !== this.warmupTtsGeneration
          || !this.pageVisible || !this.isTimedGuidePhase()
          || this.agentExitRequested) return;
      this.speakCue(cue);
    }, Math.max(0, Math.min(1000, Number(delayMs) || 0)));
    return true;
  },

  queueWarmupStepTts(index, options = {}) {
    return this.queueWarmupSpeech(
      getRideGuideTtsCue(this.currentRideGuideKind(), index, options),
      options.delayMs,
    );
  },

  syncWarmupData() {
    const kind = this.currentRideGuideKind();
    const steps = getRideGuideSteps(kind);
    const step = getRideGuideStep(kind, this.warmupStepIndex) || steps[0];
    const recovery = kind === RIDE_GUIDE_KIND.RECOVERY;
    const total = steps.length;
    if (this.warmupCompleted) {
      this.setData({
        warmupStepCount: '4 个动作已完成',
        warmupHeading: recovery ? '骑后放松' : '骑前拉伸',
        warmupOverview: getRideGuideOverview(kind),
        warmupTitle: recovery ? '放松完成' : '热身完成',
        warmupInstruction: recovery
          ? '补充水分，待呼吸平稳后再休息'
          : '确认路况和设备后，再开始骑车',
        warmupSafety: recovery ? '如有不适请继续休息' : '如有不适请停止动作',
        warmupRemaining: '完成',
        warmupStatus: recovery ? '放松完成 · 确认退出' : '正在进入骑行准备',
        warmupActionLabel: recovery ? '完成并退出' : '进入骑行准备',
        warmupSkipLabel: '跳过剩余热身',
        warmupFoot: recovery ? '确认键退出 · 返回键回总结' : '确认键进入准备',
        warmupFigure: 'complete',
        warmupImage: steps[steps.length - 1].imagePath,
      });
      return true;
    }
    const remaining = warmupSecondsRemaining(
      step,
      Number(this.warmupRemainingSeconds) * 1000,
    );
    this.warmupRemainingSeconds = remaining;
    this.setData({
      warmupHeading: recovery ? '骑后放松' : '骑前拉伸',
      warmupOverview: getRideGuideOverview(kind),
      warmupStepCount: '动作 ' + String(this.warmupStepIndex + 1) + ' / ' + String(total),
      warmupTitle: step.title,
      warmupInstruction: step.instruction,
      warmupSafety: step.safetyNote,
      warmupRemaining: this.warmupStarted ? (String(remaining) + ' 秒') : '准备',
      warmupStatus: this.warmupPausedByHide
        ? '已暂停 · 返回后继续'
        : (this.warmupStarted ? '倒计时结束自动切换' : '确认开始后自动切换动作'),
      warmupActionLabel: this.warmupStarted
        ? (this.warmupStepIndex >= total - 1
          ? (recovery ? '完成放松' : '进入骑行准备')
          : '下一步')
        : (recovery ? '开始放松' : '开始热身'),
      warmupSkipLabel: '跳过剩余热身',
      warmupFoot: recovery
        ? '确认键下一步 · 返回键上一步/回总结'
        : '前后划选择 · 确认键执行 · 返回键上一步/回菜单',
      warmupFigure: step.id,
      warmupImage: step.imagePath,
    });
    return true;
  },

  resetWarmupRoutine(kind = RIDE_GUIDE_KIND.WARMUP) {
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.timedGuideKind = kind === RIDE_GUIDE_KIND.RECOVERY
      ? RIDE_GUIDE_KIND.RECOVERY : RIDE_GUIDE_KIND.WARMUP;
    this.warmupStepIndex = 0;
    this.warmupStarted = false;
    this.warmupCompleted = false;
    this.warmupPausedByHide = false;
    this.warmupMidpointCueSent = false;
    this.warmupFinalCountCueSent = false;
    this.warmupRemainingSeconds = getRideGuideSteps(this.timedGuideKind)[0].durationSec;
    this.warmupStepEndsAtMs = null;
    this.setGuideFocus(0);
    return this.syncWarmupData();
  },

  scheduleWarmupTick() {
    this.clearWarmupTimer();
    if (!this.isTimedGuidePhase() || !this.pageVisible
        || !this.warmupStarted || this.warmupCompleted
        || this.warmupPausedByHide) return false;
    const generation = this.warmupTimerGeneration;
    this.warmupTimer = setTimeout(() => {
      if (generation !== this.warmupTimerGeneration) return;
      this.warmupTimer = null;
      this.tickWarmupRoutine();
    }, RIDE_GUIDE_TICK_MS);
    return true;
  },

  tickWarmupRoutine(now = Date.now()) {
    if (!this.isTimedGuidePhase() || !this.pageVisible
        || !this.warmupStarted || this.warmupCompleted
        || this.warmupPausedByHide) return false;
    const kind = this.currentRideGuideKind();
    const step = getRideGuideStep(kind, this.warmupStepIndex);
    if (!step) return false;
    const remainingMs = Number(this.warmupStepEndsAtMs) - Number(now);
    if (remainingMs > 0) {
      this.warmupRemainingSeconds = warmupSecondsRemaining(
        step,
        remainingMs,
      );
      this.syncWarmupData();
      const midpoint = Math.floor(step.durationSec / 2);
      if (this.warmupRemainingSeconds <= midpoint
          && this.warmupRemainingSeconds > 3
          && !this.warmupMidpointCueSent) {
        this.warmupMidpointCueSent = true;
        const cue = getRideGuideRhythmTtsCue(kind, this.warmupStepIndex, midpoint);
        if (cue) this.queueWarmupSpeech(cue);
      }
      if (this.warmupRemainingSeconds <= 3
          && this.warmupRemainingSeconds > 0
          && !this.warmupFinalCountCueSent) {
        this.warmupFinalCountCueSent = true;
        const cue = getRideGuideRhythmTtsCue(kind, this.warmupStepIndex, 3);
        if (cue) this.queueWarmupSpeech(cue);
      }
      this.scheduleWarmupTick();
      return true;
    }
    if (this.warmupStepIndex >= getRideGuideSteps(kind).length - 1) {
      return this.finishWarmupRoutine();
    }
    return this.advanceWarmupStep({ automatic: true, now });
  },

  startWarmupRoutine(options = {}) {
    if (!this.isTimedGuidePhase() || this.warmupCompleted) return false;
    if (this.warmupStarted) return true;
    const step = getRideGuideStep(this.currentRideGuideKind(), this.warmupStepIndex);
    if (!step) return false;
    const seconds = warmupSecondsRemaining(step, Number(this.warmupRemainingSeconds) * 1000);
    this.warmupStarted = true;
    this.warmupPausedByHide = false;
    this.warmupMidpointCueSent = false;
    this.warmupFinalCountCueSent = false;
    this.warmupRemainingSeconds = seconds;
    this.warmupStepEndsAtMs = Date.now() + seconds * 1000;
    this.syncWarmupData();
    this.queueWarmupStepTts(this.warmupStepIndex, {
      includeIntro: options.includeIntro !== false,
    });
    this.scheduleWarmupTick();
    return true;
  },

  advanceWarmupStep(options = {}) {
    if (!this.isTimedGuidePhase() || this.warmupCompleted) return false;
    const steps = getRideGuideSteps(this.currentRideGuideKind());
    if (this.warmupStepIndex >= steps.length - 1) return false;
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.warmupStepIndex += 1;
    const step = steps[this.warmupStepIndex];
    this.warmupStarted = true;
    this.warmupPausedByHide = false;
    this.warmupMidpointCueSent = false;
    this.warmupFinalCountCueSent = false;
    this.warmupRemainingSeconds = step.durationSec;
    this.warmupStepEndsAtMs = Number(options.now || Date.now()) + step.durationSec * 1000;
    this.syncWarmupData();
    this.queueWarmupStepTts(this.warmupStepIndex, {
      delayMs: options.automatic === true ? 350 : 0,
    });
    this.setGuideFocus(0);
    this.scheduleWarmupTick();
    this.armSurfaceEntryInputGuard();
    return true;
  },

  finishWarmupRoutine() {
    if (!this.isTimedGuidePhase() || this.warmupCompleted) return false;
    const recovery = this.currentRideGuideKind() === RIDE_GUIDE_KIND.RECOVERY;
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.warmupStarted = false;
    this.warmupCompleted = true;
    this.warmupPausedByHide = false;
    this.warmupRemainingSeconds = 0;
    this.warmupStepEndsAtMs = null;
    this.syncWarmupData();
    if (recovery) {
      this.queueWarmupSpeech(RIDE_RECOVERY_COMPLETION_TTS, 250);
      return true;
    }
    this.speakCue(RIDE_WARMUP_COMPLETION_TTS);
    return this.enterRidePreparation();
  },

  pauseWarmupRoutine() {
    if (!this.isTimedGuidePhase() || !this.warmupStarted
        || this.warmupCompleted || this.warmupPausedByHide) return false;
    const step = getRideGuideStep(this.currentRideGuideKind(), this.warmupStepIndex);
    if (!step) return false;
    this.warmupRemainingSeconds = Math.max(1, warmupSecondsRemaining(
      step,
      Number(this.warmupStepEndsAtMs) - Date.now(),
    ));
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.warmupPausedByHide = true;
    this.warmupStepEndsAtMs = null;
    this.syncWarmupData();
    return true;
  },

  resumeWarmupRoutine() {
    if (!this.isTimedGuidePhase() || !this.pageVisible
        || !this.warmupStarted || this.warmupCompleted
        || !this.warmupPausedByHide) return false;
    const step = getRideGuideStep(this.currentRideGuideKind(), this.warmupStepIndex);
    if (!step) return false;
    const seconds = warmupSecondsRemaining(
      step,
      Number(this.warmupRemainingSeconds) * 1000,
    );
    this.warmupPausedByHide = false;
    this.warmupRemainingSeconds = seconds;
    this.warmupStepEndsAtMs = Date.now() + seconds * 1000;
    this.syncWarmupData();
    this.scheduleWarmupTick();
    return true;
  },

  enterRidePreparation() {
    if (this.data.surfacePhase !== 'warmup') return false;
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.timedGuideKind = null;
    this.warmupStarted = false;
    this.warmupCompleted = false;
    this.warmupPausedByHide = false;
    this.warmupStepEndsAtMs = null;
    this.armSurfaceEntryInputGuard();
    this.scanAttempted = false;
    this.scanStartedSuccessfully = false;
    this.resetDiscoveredDevices();
    this.setData({
      surfacePhase: 'ready',
      searchText: '点击开始搜索',
      searchChip: '待启动',
      primaryLabel: '开始搜索',
      scanDiagnostic: '等待扫描启动',
      scanProgressText: '准备',
    });
    this.applyDeviceSettingToEntry();
    this.prewarmCyclingUploadAuth();
    return true;
  },

  onWarmupPrimaryTap() {
    if (!this.isTimedGuidePhase()) return false;
    if (!this.claimSurfaceActivation(
      'guide-primary-' + this.currentRideGuideKind() + '-' + String(this.warmupStepIndex),
    )) return false;
    if (this.warmupCompleted) {
      return this.currentRideGuideKind() === RIDE_GUIDE_KIND.RECOVERY
        ? this.closeAgent('recovery-complete') : this.enterRidePreparation();
    }
    if (!this.warmupStarted) return this.startWarmupRoutine();
    const last = this.warmupStepIndex
      >= getRideGuideSteps(this.currentRideGuideKind()).length - 1;
    if (last) {
      if (this.currentRideGuideKind() === RIDE_GUIDE_KIND.RECOVERY) {
        return this.finishWarmupRoutine();
      }
      return this.enterRidePreparation();
    }
    return this.advanceWarmupStep({ automatic: false });
  },

  skipWarmup() {
    if (this.data.surfacePhase !== 'warmup') return false;
    if (!this.claimSurfaceActivation('guide-skip-warmup')) return false;
    return this.enterRidePreparation();
  },

  startRecoveryGuide() {
    if (this.data.surfacePhase !== 'summary' || this.agentExitRequested) return false;
    // 用户明确选择骑后放松时，撤销此前“保存成功后自动退出”的旧意图。
    // 持久化 flight 可以继续，但其完成回调不得在放松中途关闭页面。
    this.summaryExitPending = false;
    this.pendingSummaryExitSource = '';
    this.clearSummaryExitPrompt();
    this.cancelSummaryAiAdvice();
    this.resetWarmupRoutine(RIDE_GUIDE_KIND.RECOVERY);
    this.setData({ surfacePhase: 'recovery' });
    this.syncWarmupData();
    this.startWarmupRoutine({ includeIntro: true });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  onRideGuideBack() {
    if (!this.isTimedGuidePhase()) return false;
    if (this.warmupStepIndex > 0) {
      this.clearWarmupTimer();
      this.cancelWarmupTts();
      this.warmupStepIndex -= 1;
      const step = getRideGuideStep(this.currentRideGuideKind(), this.warmupStepIndex);
      this.warmupStarted = true;
      this.warmupCompleted = false;
      this.warmupPausedByHide = false;
      this.warmupMidpointCueSent = false;
      this.warmupFinalCountCueSent = false;
      this.warmupRemainingSeconds = step.durationSec;
      this.warmupStepEndsAtMs = Date.now() + step.durationSec * 1000;
      this.syncWarmupData();
      this.queueWarmupStepTts(this.warmupStepIndex);
      this.scheduleWarmupTick();
      this.armSurfaceEntryInputGuard();
      return true;
    }
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    if (this.data.surfacePhase === 'recovery') {
      this.timedGuideKind = null;
      this.warmupStarted = false;
      this.warmupCompleted = false;
      this.setData({
        surfacePhase: 'summary',
        summaryExitText: '前划进入骑后放松 · 返回或连续两次确认退出',
      });
      this.armSurfaceEntryInputGuard();
      return true;
    }
    return this.showFeatureMenu();
  },

  showFeatureMenu() {
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    this.timedGuideKind = null;
    this.warmupStarted = false;
    this.warmupCompleted = false;
    this.warmupPausedByHide = false;
    this.stopCadenceCue();
    this.clearSurfaceDirectionBurst();
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceActivationGate();
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.menuEntryConfirmGuardUntilMs = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.setMenuFocus(this.data.menuHasWorkout ? 0 : 1);
    this.setData({ surfacePhase: 'menu' });
    return true;
  },

  openFreeRideMode() {
    if (this.data.surfacePhase !== 'menu') return false;
    if (!this.claimMenuActivation('menu-ride')) return false;
    this.pendingSportsPlan = null;
    this.activeSportsPlan = null;
    this.resetPendingSportAgent();
    this.resetWarmupRoutine();
    this.setData({ surfacePhase: 'warmup' });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  openTodayWorkoutMode() {
    if (this.data.surfacePhase !== 'menu') return false;
    if (this.data.menuHasWorkout !== true) return false;
    if (this.blockingSportAgentActive) {
      if (this.blockingSportAgentActive.completion_queued === true) {
        this.flushSportAgentSessionOutbox({ updateSummary: false });
        return true;
      }
      const ended = abortRecoveredSportAgent(
        wx,
        this.sportsIdentity,
        { endedAtMs: Date.now() },
      );
      if (!ended) return false;
      this.blockingSportAgentActive = readSportAgentActive(wx, this.sportsIdentity);
      this.recoveredSportAgentPlan = null;
      this.sportsWorkoutEnvelope = null;
      this.syncSportsWorkoutMenu();
      this.flushSportAgentSessionOutbox({ updateSummary: false });
      return true;
    }
    if (!this.claimMenuActivation('menu-workout')) return false;
    const recovered = this.sportsIdentity
      ? recoverSportAgentPlannedPrestart(wx, this.sportsIdentity) : null;
    if (recovered) {
      this.recoveredSportAgentPlan = recovered;
      this.pendingSportsPlan = recovered.plan;
      this.resetPendingSportAgent();
      this.resetWarmupRoutine();
      this.setData({ surfacePhase: 'warmup' });
      this.armSurfaceEntryInputGuard();
      return Promise.resolve(true);
    }
    // Cached content is preview only. Each physical start requires a no-store
    // online refresh and exact owner match; failure never authorizes the cache.
    this.armSurfaceEntryInputGuard();
    return this.refreshTodayWorkout({ jit: true }).then((envelope) => {
      if (this.data.surfacePhase !== 'menu' || this.agentExitRequested) return false;
      if (!envelope || envelope.available !== true || envelope.fresh !== true) {
        this.armSurfaceEntryInputGuard();
        return false;
      }
      this.pendingSportsPlan = envelope.plan;
      this.resetPendingSportAgent();
      this.resetWarmupRoutine();
      this.setData({ surfacePhase: 'warmup' });
      this.armSurfaceEntryInputGuard();
      return true;
    });
  },

  openSettingsMode() {
    if (this.data.surfacePhase !== 'menu') return false;
    if (!this.claimMenuActivation('menu-settings')) return false;
    this.armSurfaceEntryInputGuard();
    this.syncSettingsData();
    this.setSettingFocus(0);
    this.setData({ surfacePhase: 'settings' });
    return true;
  },

  isSearchPhase() {
    return this.data.surfacePhase === 'ready' || this.data.surfacePhase === 'connecting';
  },

  isSummaryPhase() {
    // summaryEnteredAtMs 在 setData(summary) 前同步设置，确保 AIUI 0.15
    // 尚未镜像 surfacePhase 时的 Backspace/onUnload 仍走总结持久化链。
    return this.summaryEnteredAtMs != null
      || this.data.surfacePhase === 'summary';
  },

  isSummarySurfaceVisible() {
    return this.data.surfacePhase === 'summary';
  },

  clearSurfaceDirectionBurst() {
    this.lastSurfaceDirectionAtMs = null;
    this.lastSurfaceDirectionPhase = null;
    this.lastSurfaceDirectionDelta = null;
    this.lastSurfaceDirectionCode = null;
  },

  isSurfaceDirectionCode(code) {
    return code === 'ArrowUp' || code === 'ArrowDown'
      || code === 'ArrowLeft' || code === 'ArrowRight';
  },

  canHandleSurfaceDirection() {
    return this.data.surfacePhase === 'menu'
      || this.data.surfacePhase === 'settings'
      || this.data.surfacePhase === 'warmup'
      || this.data.surfacePhase === 'recovery'
      || this.isSearchPhase();
  },

  handleSurfaceDirection(code, now = Date.now()) {
    if (!this.isSurfaceDirectionCode(code) || !this.canHandleSurfaceDirection()) return false;
    this.clearPendingSurfaceGlobalHook();
    this.menuEntryConfirmGuardUntilMs = null;
    this.surfaceEntryConfirmGuardUntilMs = now + DIRECTION_RELEASE_GUARD_MS;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearSurfaceActivationGate();
    const delta = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;
    if (!this.claimSurfaceDirection(code, delta, now)) return true;
    if (this.data.surfacePhase === 'menu') {
      const order = this.data.menuHasWorkout === true ? [0, 1, 2] : [1, 2];
      const at = Math.max(0, order.indexOf(this.menuFocusIndex));
      this.setMenuFocus(order[((at + delta) % order.length + order.length) % order.length]);
    } else if (this.data.surfacePhase === 'settings') {
      this.setSettingFocus(this.settingFocusIndex + delta);
    } else if (this.data.surfacePhase === 'warmup') {
      this.setGuideFocus(this.guideFocusIndex + delta);
    } else if (this.data.surfacePhase === 'recovery') {
      // 骑后只有一个确认动作；拦截宿主滚动但不改变步骤。
      return true;
    } else {
      this.setSearchFocus(this.searchFocusIndex + delta);
    }
    return true;
  },

  claimSurfaceDirection(code, delta, now) {
    const phase = this.data.surfacePhase;
    const gapMs = this.lastSurfaceDirectionAtMs == null
      ? Number.POSITIVE_INFINITY : now - this.lastSurfaceDirectionAtMs;
    const sameSemantic = this.lastSurfaceDirectionPhase === phase
      && this.lastSurfaceDirectionDelta === delta
      && gapMs >= 0;
    const duplicate = sameSemantic && (
      (this.lastSurfaceDirectionCode === code && gapMs < DIRECTION_REPEAT_DEDUPE_MS)
      || (this.lastSurfaceDirectionCode !== code && gapMs < DIRECTION_ALIAS_DEDUPE_MS)
    );
    if (duplicate) return false;
    this.lastSurfaceDirectionAtMs = now;
    this.lastSurfaceDirectionPhase = phase;
    this.lastSurfaceDirectionDelta = delta;
    this.lastSurfaceDirectionCode = code;
    return true;
  },

  shouldAcceptHostFocus(phase, index, currentIndex, now = Date.now()) {
    const directionStillReleasing = this.lastSurfaceDirectionPhase === phase
      && this.lastSurfaceDirectionAtMs != null
      && now - this.lastSurfaceDirectionAtMs >= 0
      && now - this.lastSurfaceDirectionAtMs < DIRECTION_RELEASE_GUARD_MS;
    return !(directionStillReleasing && Number(index) !== Number(currentIndex));
  },

  isMultiTargetSurface() {
    return this.data.surfacePhase === 'menu'
      || this.data.surfacePhase === 'settings'
      || this.data.surfacePhase === 'warmup'
      || this.isSearchPhase();
  },

  clearPendingSurfaceGlobalHook(options = {}) {
    const hadPending = !!this.pendingSurfaceGlobalHookTimer
      || !!this.pendingSurfaceGlobalHookPhase;
    if (this.pendingSurfaceGlobalHookTimer) clearTimeout(this.pendingSurfaceGlobalHookTimer);
    this.pendingSurfaceGlobalHookTimer = null;
    this.pendingSurfaceGlobalHookPhase = null;
    this.pendingSurfaceGlobalHookAtMs = null;
    this.pendingSurfaceGlobalHookToken = (this.pendingSurfaceGlobalHookToken || 0) + 1;
    if (hadPending && options.keepGuard !== true) this.surfaceEntryConfirmGuardUntilMs = null;
    return hadPending;
  },

  isTimedInputGuarded(field, now = Date.now()) {
    const until = Number(this[field]);
    if (!Number.isFinite(until)) return false;
    if (now < until) return true;
    this[field] = null;
    return false;
  },

  isMenuEntryInputGuarded(now = Date.now()) {
    return this.isTimedInputGuarded('menuEntryConfirmGuardUntilMs', now);
  },

  isSurfaceEntryInputGuarded(now = Date.now()) {
    return this.isTimedInputGuarded('surfaceEntryConfirmGuardUntilMs', now);
  },

  armSurfaceEntryInputGuard(now = Date.now()) {
    this.surfaceEntryConfirmGuardUntilMs = now + SURFACE_ENTRY_CONFIRM_GRACE_MS;
  },

  releaseWarmupDirectionConfirmGuard(now = Date.now()) {
    const gapMs = this.lastSurfaceDirectionAtMs == null
      ? Number.POSITIVE_INFINITY : now - this.lastSurfaceDirectionAtMs;
    const directionJustCommitted = this.data.surfacePhase === 'warmup'
      && this.lastSurfaceDirectionPhase === 'warmup'
      && gapMs >= 0
      && gapMs < DIRECTION_RELEASE_GUARD_MS;
    if (!directionJustCommitted) return false;
    // 稳定确认不受上一笔方向释放窗影响。
    this.surfaceEntryConfirmGuardUntilMs = null;
    return true;
  },

  clearSurfaceActivationGate() {
    this.lastSurfaceActivationAtMs = null;
    this.lastSurfaceActivationId = null;
  },

  claimSurfaceActivation(actionId, now = Date.now()) {
    if (this.isSurfaceEntryInputGuarded(now)) return false;
    if (this.lastSurfaceActivationAtMs != null
        && now - this.lastSurfaceActivationAtMs < SURFACE_ACTION_DEDUPE_MS) return false;
    this.lastSurfaceActivationAtMs = now;
    this.lastSurfaceActivationId = actionId;
    return true;
  },

  claimMenuActivation(actionId, now = Date.now()) {
    if (this.isMenuEntryInputGuarded(now)) return false;
    return this.claimSurfaceActivation(actionId, now);
  },

  activateMultiTargetFocused() {
    if (this.data.surfacePhase === 'menu') {
      if (this.data.menuHasWorkout === true && this.menuFocusIndex === 0) {
        return this.openTodayWorkoutMode();
      }
      return this.menuFocusIndex === 2 ? this.openSettingsMode() : this.openFreeRideMode();
    }
    if (this.data.surfacePhase === 'warmup') {
      return this.guideFocusIndex === 1 ? this.skipWarmup() : this.onWarmupPrimaryTap();
    }
    if (this.data.surfacePhase === 'settings') {
      const keys = [
        'wheel',
        'device',
        'max-heart-rate',
        'ftp',
        'ride-goal',
        'voice',
        'cadence',
        'local-log',
      ];
      return this.onSettingTap({
        currentTarget: {
          dataset: {
            setting: keys[this.settingFocusIndex],
            index: this.settingFocusIndex,
          },
        },
      });
    }
    if (this.isSearchPhase()) return this.activateSearchFocused();
    return false;
  },

  deferSurfaceGlobalHook(now = Date.now()) {
    if (!this.isMultiTargetSurface()) return false;
    const phase = this.data.surfacePhase;
    if (this.isSearchPhase()
        && this.pendingSurfaceGlobalHookTimer
        && this.pendingSurfaceGlobalHookPhase === phase
        && this.pendingSurfaceGlobalHookAtMs != null) {
      const gapMs = now - this.pendingSurfaceGlobalHookAtMs;
      if (gapMs >= SEARCH_DOUBLE_TAP_MIN_GAP_MS
          && gapMs <= SEARCH_DOUBLE_TAP_WINDOW_MS) {
        this.clearPendingSurfaceGlobalHook({ keepGuard: true });
        this.surfaceEntryConfirmGuardUntilMs = now + DIRECTION_RELEASE_GUARD_MS;
        return this.closeAgent('search-double-tap');
      }
      if (gapMs >= 0 && gapMs < SEARCH_DOUBLE_TAP_MIN_GAP_MS) return true;
    }
    if ((phase === 'menu' && this.isMenuEntryInputGuarded(now))
        || this.isSurfaceEntryInputGuarded(now)) return false;
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceDirectionBurst();
    const generation = this.surfaceGeneration;
    const delayMs = this.isSearchPhase()
      ? Math.max(SEARCH_DOUBLE_TAP_WINDOW_MS, GLOBAL_HOOK_DISAMBIGUATE_MS)
      : GLOBAL_HOOK_DISAMBIGUATE_MS;
    const token = (this.pendingSurfaceGlobalHookToken || 0) + 1;
    this.pendingSurfaceGlobalHookToken = token;
    this.pendingSurfaceGlobalHookPhase = phase;
    this.pendingSurfaceGlobalHookAtMs = now;
    this.surfaceEntryConfirmGuardUntilMs = now + delayMs + 40;
    this.pendingSurfaceGlobalHookTimer = setTimeout(() => {
      if (token !== this.pendingSurfaceGlobalHookToken
          || generation !== this.surfaceGeneration
          || phase !== this.data.surfacePhase
          || !this.pageVisible) {
        if (token === this.pendingSurfaceGlobalHookToken
            && phase === this.pendingSurfaceGlobalHookPhase) {
          this.pendingSurfaceGlobalHookTimer = null;
          this.pendingSurfaceGlobalHookPhase = null;
          this.pendingSurfaceGlobalHookAtMs = null;
          this.surfaceEntryConfirmGuardUntilMs = null;
        }
        return;
      }
      this.pendingSurfaceGlobalHookTimer = null;
      this.pendingSurfaceGlobalHookPhase = null;
      this.pendingSurfaceGlobalHookAtMs = null;
      this.surfaceEntryConfirmGuardUntilMs = null;
      this.activateMultiTargetFocused();
    }, delayMs);
    return true;
  },

  resetDiscoveredDevices() {
    this.discoveredDeviceRefs = {};
    this.discoveredDeviceOrder = [];
    this.searchFocusIndex = 0;
    this.setData({
      discoveredDevices: [],
      discoveredDeviceCount: 0,
      searchPrimaryClass: 'search-target-focused',
    });
  },

  recordDiscoveredDevice(device) {
    const id = deviceId(device);
    if (!id) return false;
    if (!this.discoveredDeviceRefs[id]) this.discoveredDeviceOrder.push(id);
    this.discoveredDeviceRefs[id] = device;
    this.syncDiscoveredDevices();
    return true;
  },

  syncDiscoveredDevices() {
    const remembered = readRideDevice(wx);
    const rows = this.discoveredDeviceOrder.slice(0, MAX_VISIBLE_DEVICES).map((id, index) => {
      const device = this.discoveredDeviceRefs[id];
      const focusIndex = index + 1;
      return {
        deviceId: id,
        deviceName: rideDeviceDisplayName(device),
        deviceMeta: matchesRideDevice(device, remembered) ? '已记住' : '标准 BLE',
        status: this.connectedDevice && deviceId(this.connectedDevice) === id ? '已连接' : '可连接',
        focusIndex,
        deviceFocusClass: this.searchFocusIndex === focusIndex ? 'device-row-focused' : '',
      };
    });
    this.setData({
      discoveredDevices: rows,
      discoveredDeviceCount: this.discoveredDeviceOrder.length,
      scanDiagnostic: this.discoveredDeviceOrder.length
        ? '已发现 ' + this.discoveredDeviceOrder.length + ' 台附近设备'
        : this.data.scanDiagnostic,
    });
    return rows;
  },

  setSearchFocus(index) {
    const count = Math.min(this.discoveredDeviceOrder.length, MAX_VISIBLE_DEVICES) + 1;
    const raw = Number(index) || 0;
    const next = ((raw % count) + count) % count;
    this.searchFocusIndex = next;
    this.setData({ searchPrimaryClass: next === 0 ? 'search-target-focused' : '' });
    this.syncDiscoveredDevices();
    return next;
  },

  onSearchFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = Number(dataset && dataset.focusIndex) || 0;
    if (!this.shouldAcceptHostFocus(
      this.data.surfacePhase,
      index,
      this.searchFocusIndex,
    )) return false;
    this.setSearchFocus(index);
    return true;
  },

  activateSearchFocused() {
    const index = this.setSearchFocus(this.searchFocusIndex);
    if (index === 0) return this.onScanTap();
    const id = this.discoveredDeviceOrder[index - 1];
    return this.connectSelected(this.discoveredDeviceRefs[id]);
  },

  onScanTap() {
    if (!this.isSearchPhase() || this.agentExitRequested) return false;
    if (!this.claimSurfaceActivation('search-primary')) return false;
    if (this.scanAttempted) {
      // Native bindtap cannot await. Keep the activation accepted while the
      // JIT handshake continues on this visible preparation screen.
      this.proceedToHud();
      return true;
    }
    this.scanAttempted = true;
    this.setData({
      primaryLabel: '下一步',
      searchChip: '启动中',
      searchText: '正在搜索骑行设备...',
      scanProgressText: '启动中',
    });
    this.startDiscovery();
    return true;
  },

  async startDiscovery() {
    if (!this.pageVisible || !this.isSearchPhase()) return false;
    if (typeof navigator === 'undefined' || !navigator.bluetooth
        || typeof navigator.bluetooth.scanDevices !== 'function') {
      this.setData({
        searchChip: '不可用',
        searchText: '蓝牙当前不可用',
        scanDiagnostic: '蓝牙扫描接口不可用',
        scanProgressText: '不可用',
      });
      return false;
    }
    const operation = (this.bleOperationGeneration || 0) + 1;
    this.bleOperationGeneration = operation;
    const lifecycleGeneration = this.bleLifecycleGeneration || 0;
    this.scanDiscoveryPending = true;
    this.scanResumePending = false;
    this.stopScan();
    if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) {
      this.scanDiscoveryPending = false;
      return false;
    }
    this.bleDebug('SCAN_REQUEST', 'sources=' + activeSourceSpecs(this.rideSettings).length);
    try {
      const sourceSpecs = activeSourceSpecs(this.rideSettings);
      const services = sourceSpecs.map((spec) => spec.service);
      const scan = await navigator.bluetooth.scanDevices({
        filters: services.map((service) => ({ services: [service] })),
        optionalServices: services,
      });
      if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) {
        try { scan.stop(); } catch (_error) {}
        this.bleDebug('SCAN_DISCARDED', 'reason=stale-operation');
        return false;
      }
      this.scanSession = scan;
      this.scanStartedSuccessfully = true;
      const listener = (event) => {
        if (this.scanSession !== scan
            || !this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) return;
        const device = event && event.device ? event.device : event;
        this.recordDiscoveredDevice(device);
      };
      this.scanListener = listener;
      if (scan && typeof scan.onDeviceFound === 'function') scan.onDeviceFound(listener);
      this.setData({
        searchChip: '扫描中',
        searchText: '正在搜索骑行设备...',
        scanDiagnostic: '扫描已启动，等待设备广播',
        scanProgressText: '扫描中',
      });
      this.bleDebug('SCAN_ACTIVE', 'services=' + services.length);
      return true;
    } catch (error) {
      if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) return false;
      this.bleDebug('SCAN_FAILED', this.bleErrorText(error));
      this.setData({
        searchChip: '扫描失败',
        searchText: '扫描失败，可直接骑行',
        scanDiagnostic: '扫描启动失败',
        scanProgressText: '失败',
      });
      return false;
    } finally {
      if (operation === this.bleOperationGeneration) {
        this.scanDiscoveryPending = false;
      }
    }
  },

  bleErrorText(error) {
    const message = String(error && (error.message || error.errMsg) || '')
      .toLowerCase();
    if (/timeout|timed out/.test(message)) return 'timeout';
    if (/cancel|canceled|cancelled/.test(message)) return 'cancelled';
    if (/permission|denied|not allowed|security/.test(message)) return 'permission';
    if (/not found|missing/.test(message)) return 'not_found';
    if (/not supported|unsupported|unavailable/.test(message)) return 'unsupported';
    if (/disconnect|connection lost/.test(message)) return 'disconnected';
    if (/busy|in progress/.test(message)) return 'busy';
    if (/connect|gatt|bluetooth/.test(message)) return 'connection_failed';
    return 'unknown';
  },

  bleDebug(event, details = '') {
    try {
      console.log('[AIBike BLE] ' + event + (details ? ' ' + details : ''));
    } catch (_error) {}
  },

  isBleOperationCurrent(operation, lifecycleGeneration) {
    return this.bleTerminated !== true
      && this.agentExitRequested !== true
      && this.pageVisible === true
      && operation === this.bleOperationGeneration
      && lifecycleGeneration === this.bleLifecycleGeneration
      && !this.isSummaryPhase();
  },

  isBleAttemptCurrent(attempt, operation, lifecycleGeneration) {
    return this.connectAttemptId === attempt
      && this.connectingAttemptId === attempt
      && this.isBleOperationCurrent(operation, lifecycleGeneration);
  },

  isDiscoveryOperationCurrent(operation, lifecycleGeneration) {
    return this.isBleOperationCurrent(operation, lifecycleGeneration)
      && this.isSearchPhase();
  },

  stopScan() {
    const scan = this.scanSession;
    this.scanSession = null;
    if (!scan) return false;
    try {
      if (typeof scan.offDeviceFound === 'function') scan.offDeviceFound(this.scanListener);
    } catch (_error) {}
    try { scan.stop(); } catch (_error) {}
    this.scanListener = null;
    return true;
  },

  selectDevice(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const id = String(dataset && dataset.id ? dataset.id : '');
    if (!this.claimSurfaceActivation('search-device-' + id)) return false;
    return this.connectSelected(this.discoveredDeviceRefs[id]);
  },

  waitForPromise(value, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('timeout'));
      }, timeoutMs);
      Promise.resolve(value).then((result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      }, (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  },

  pendingNotificationStopEntry(characteristic) {
    return (this.notificationStopOperations || [])
      .find((item) => item.characteristic === characteristic) || null;
  },

  pendingNotificationStop(characteristic) {
    const entry = this.pendingNotificationStopEntry(characteristic);
    return entry ? entry.barrierPromise : null;
  },

  completeNotificationStop(entry, invalidated = false) {
    if (!entry || entry.completed) return false;
    entry.completed = true;
    entry.invalidated = invalidated;
    this.notificationStopOperations = (this.notificationStopOperations || [])
      .filter((item) => item !== entry);
    entry.resolveBarrier();
    return true;
  },

  invalidateNotificationStopsForServer(server) {
    if (!server) return false;
    const matches = (this.notificationStopOperations || [])
      .filter((entry) => entry.server === server);
    for (const entry of matches) this.completeNotificationStop(entry, true);
    return matches.length > 0;
  },

  beginNotificationStop(characteristic, server = null) {
    if (!characteristic || typeof characteristic.stopNotifications !== 'function') {
      return null;
    }
    const pending = this.pendingNotificationStop(characteristic);
    if (pending) return pending;
    let rawPromise;
    try {
      rawPromise = Promise.resolve(characteristic.stopNotifications());
    } catch (_error) {
      return null;
    }
    let resolveBarrier;
    const barrierPromise = new Promise((resolve) => {
      resolveBarrier = resolve;
    });
    const entry = {
      characteristic,
      server,
      rawPromise,
      barrierPromise,
      resolveBarrier,
      completed: false,
      invalidated: false,
    };
    this.notificationStopOperations.push(entry);
    rawPromise.then(
      () => this.completeNotificationStop(entry, false),
      () => this.completeNotificationStop(entry, false),
    );
    return barrierPromise;
  },

  async releaseNotificationResource(resource, stopNotifications = true) {
    if (!resource) return false;
    resource.active = false;
    this.notificationOwnerResources = (this.notificationOwnerResources || [])
      .filter((item) => item !== resource);
    try {
      if (resource.characteristic && resource.listener) {
        resource.characteristic.removeEventListener(
          'characteristicvaluechanged',
          resource.listener,
        );
      }
    } catch (_error) {}
    if (stopNotifications && this.terminalBleSealed
        && !this.terminalBleNativeCleanupStarted) {
      if (!(this.terminalDeferredNotificationResources || []).includes(resource)) {
        this.terminalDeferredNotificationResources.push(resource);
      }
      return true;
    }
    const replacementOwnsCharacteristic = (this.notificationOwnerResources || [])
      .some((item) => item.active && item.characteristic === resource.characteristic);
    if (stopNotifications && !replacementOwnsCharacteristic && resource.characteristic
        && typeof resource.characteristic.stopNotifications === 'function') {
      try {
        if (!resource.notificationStopPromise) {
          resource.notificationStopPromise = this.beginNotificationStop(
            resource.characteristic,
            resource.server || null,
          );
        }
        if (resource.notificationStopPromise) {
          await this.waitForPromise(
            resource.notificationStopPromise,
            BLE_CLEANUP_STEP_WAIT_MS,
          );
        }
      } catch (_error) {}
    }
    return true;
  },

  async releaseConnectionAttempt(
    resources,
    server,
    disconnect = true,
    device = null,
    attempt = null,
  ) {
    for (const resource of resources || []) {
      await this.releaseNotificationResource(resource, true);
    }
    const replacementConnectingSameDevice = device
      && attempt != null
      && this.connectAttemptId !== attempt
      && this.connectingDevice === device;
    if (disconnect && server && replacementConnectingSameDevice) {
      this.rememberDeferredBleServer(server, device);
    }
    if (disconnect && server && server !== this.bleServer
        && !replacementConnectingSameDevice
        && typeof server.disconnect === 'function') {
      await this.disconnectBleServer(server);
    }
  },

  rememberDeferredBleServer(server, device) {
    if (!server || server === this.bleServer) return false;
    if (!(this.deferredBleServers || []).some(
      (item) => item.server === server && item.device === device,
    )) {
      this.deferredBleServers.push({ server, device });
    }
    return true;
  },

  async disconnectBleServer(server, options = {}) {
    if (!server || typeof server.disconnect !== 'function') return false;
    if (options.force !== true && server === this.bleServer) return false;
    if (server.connected === false) {
      this.invalidateNotificationStopsForServer(server);
      return false;
    }
    if (this.terminalBleSealed && !this.terminalBleNativeCleanupStarted) {
      this.rememberDeferredBleServer(server, null);
      return false;
    }
    let entry = (this.bleServerDisconnects || [])
      .find((item) => item.server === server);
    if (!entry) {
      try {
        entry = {
          server,
          promise: Promise.resolve(server.disconnect()),
        };
      } catch (_error) {
        this.invalidateNotificationStopsForServer(server);
        return false;
      }
      this.bleServerDisconnects.push(entry);
      entry.promise.then(
        () => {
          this.bleServerDisconnects = (this.bleServerDisconnects || [])
            .filter((item) => item !== entry);
        },
        () => {
          this.bleServerDisconnects = (this.bleServerDisconnects || [])
            .filter((item) => item !== entry);
        },
      );
    }
    this.invalidateNotificationStopsForServer(server);
    try {
      await this.waitForPromise(entry.promise, BLE_CLEANUP_STEP_WAIT_MS);
    } catch (_error) {}
    return true;
  },

  async releaseDeferredBleServers(device = null, adoptedServer = null) {
    const releasable = [];
    const retained = [];
    for (const item of this.deferredBleServers || []) {
      if (device != null && item.device !== device) retained.push(item);
      else releasable.push(item);
    }
    this.deferredBleServers = retained;
    const handled = [];
    for (const item of releasable) {
      const server = item.server;
      if (!server || server === adoptedServer || server === this.bleServer
          || handled.includes(server)) continue;
      handled.push(server);
      await this.disconnectBleServer(server);
    }
  },

  async subscribeSource(server, spec, context) {
    let characteristic = null;
    let resource = null;
    let startPromise = null;
    try {
      const service = await this.waitForPromise(
        server.getPrimaryService(spec.service),
        BLE_CONNECT_TIMEOUT_MS,
      );
      if (!this.isBleAttemptCurrent(
        context.attempt,
        context.operation,
        context.lifecycleGeneration,
      )) throw new Error('stale BLE service');

      characteristic = await this.waitForPromise(
        service.getCharacteristic(spec.characteristic),
        BLE_CONNECT_TIMEOUT_MS,
      );
      if (!this.isBleAttemptCurrent(
        context.attempt,
        context.operation,
        context.lifecycleGeneration,
      )) throw new Error('stale BLE characteristic');

      const pendingStop = this.pendingNotificationStop(characteristic);
      if (pendingStop) {
        await this.waitForPromise(pendingStop, BLE_CONNECT_TIMEOUT_MS);
        if (!this.isBleAttemptCurrent(
          context.attempt,
          context.operation,
          context.lifecycleGeneration,
        )) throw new Error('stale BLE stop barrier');
      }

      resource = {
        characteristic,
        server,
        listener: null,
        source: spec.source,
        device: context.device,
        attempt: context.attempt,
        active: true,
        committed: false,
      };
      this.notificationOwnerResources.push(resource);
      const listener = (event) => {
        const hiddenActiveRide = this.pageVisible !== true
          && this.canContinueRideInBackground();
        if (!resource.active || !resource.committed
            || this.bleTerminated || this.agentExitRequested
            || (!this.pageVisible && !hiddenActiveRide)
            || this.connectedDevice !== context.device
            || !this.notificationResources.includes(resource)) return;
        this.onSourceMeasurement(
          spec.source,
          notificationValue(event, characteristic),
          Date.now(),
          { backgroundRide: hiddenActiveRide },
        );
      };
      resource.listener = listener;
      characteristic.addEventListener('characteristicvaluechanged', listener);
      startPromise = Promise.resolve(characteristic.startNotifications());
      try {
        await this.waitForPromise(startPromise, BLE_CONNECT_TIMEOUT_MS);
      } catch (error) {
        // startNotifications 超时后仍可能迟到成功；成功时再清一次自己的资源，
        // 防止旧尝试在新连接之后复活通知。
        startPromise.then(
          () => this.releaseNotificationResource(resource, true),
          () => false,
        ).catch(() => false);
        throw error;
      }
      if (!this.isBleAttemptCurrent(
        context.attempt,
        context.operation,
        context.lifecycleGeneration,
      )) throw new Error('stale BLE notifications');
      return resource;
    } catch (error) {
      if (resource) await this.releaseNotificationResource(resource, true);
      if (!/unsupported|not found|not supported/i.test(this.bleErrorText(error))) {
        this.bleDebug('SOURCE_UNAVAILABLE',
          'source=' + spec.source + ' reason=' + this.bleErrorText(error));
      }
      return null;
    }
  },

  async connectSelected(device, options = {}) {
    if (options.autoResume !== true) {
      this.clearSearchConnectResumeTimer();
      this.searchConnectResumePending = false;
      if (this.connecting && this.connectingAutoResume) {
        this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
        this.connectAttemptId = (this.connectAttemptId || 0) + 1;
        this.connectingAttemptId = null;
        this.connectingDevice = null;
        this.connecting = false;
        this.connectingAutoResume = false;
      }
    }
    if (!device || !device.gatt || this.connecting || this.agentExitRequested
        || this.bleTerminated || !this.pageVisible) return false;
    const operation = (this.bleOperationGeneration || 0) + 1;
    this.bleOperationGeneration = operation;
    const lifecycleGeneration = this.bleLifecycleGeneration || 0;
    const attempt = (this.connectAttemptId || 0) + 1;
    this.connectAttemptId = attempt;
    this.connectingAttemptId = attempt;
    this.connectingDevice = device;
    this.reconnectDevice = device;
    this.connecting = true;
    this.connectingAutoResume = options.autoResume === true;
    this.searchConnectResumePending = false;
    this.scanResumePending = false;
    this.scanDiscoveryPending = false;
    this.stopScan();
    this.setData({
      surfacePhase: this.rideSessionActive ? 'hud' : 'connecting',
      searchChip: '连接中',
      searchText: '正在连接并验证标准骑行服务',
    });
    this.bleDebug('GATT_CONNECT', 'attempt=' + attempt);
    let server = null;
    let resources = [];
    let connectPromise = null;
    try {
      connectPromise = Promise.resolve().then(() => device.gatt.connect());
      try {
        server = await this.waitForPromise(connectPromise, BLE_CONNECT_TIMEOUT_MS);
      } catch (error) {
        if (this.bleErrorText(error) === 'timeout') {
          connectPromise.then((lateServer) => {
            const replacementOwnsServer = lateServer && lateServer === this.bleServer;
            const replacementConnectingSameDevice = this.connectAttemptId !== attempt
              && this.connectingDevice === device;
            if (!replacementOwnsServer && replacementConnectingSameDevice) {
              this.rememberDeferredBleServer(lateServer, device);
            } else if (!replacementOwnsServer && lateServer
                && typeof lateServer.disconnect === 'function') {
              this.disconnectBleServer(lateServer).catch(() => false);
            }
          }, () => false).catch(() => false);
        }
        throw error;
      }
      if (!this.isBleAttemptCurrent(attempt, operation, lifecycleGeneration)) {
        await this.releaseConnectionAttempt(resources, server, true, device, attempt);
        return false;
      }

      const sourceSpecs = activeSourceSpecs(this.rideSettings);
      const context = {
        attempt,
        operation,
        lifecycleGeneration,
        device,
      };
      const results = await Promise.all(sourceSpecs.map(
        (spec) => this.subscribeSource(server, spec, context),
      ));
      resources = results.filter(Boolean);
      if (!this.isBleAttemptCurrent(attempt, operation, lifecycleGeneration)) {
        await this.releaseConnectionAttempt(resources, server, true, device, attempt);
        return false;
      }
      if (!resources.length) {
        await this.releaseConnectionAttempt(resources, server, true, device, attempt);
        this.setData({
          surfacePhase: this.rideSessionActive ? 'hud' : 'ready',
          searchChip: '不兼容',
          searchText: '未发现标准心率或骑行通知服务',
        });
        return false;
      }

      const oldDevice = this.connectedDevice;
      const oldDropListener = this.gattDropListener;
      const oldServer = this.bleServer;
      const oldResources = this.notificationResources.slice();
      if (!this.isBleAttemptCurrent(attempt, operation, lifecycleGeneration)) {
        await this.releaseConnectionAttempt(resources, server, true, device, attempt);
        return false;
      }
      if (server && server.connected === false) {
        await this.releaseConnectionAttempt(resources, server, false, device, attempt);
        throw new Error('BLE server disconnected before commit');
      }
      if (oldDevice && oldDropListener && typeof oldDevice.removeEventListener === 'function') {
        try {
          oldDevice.removeEventListener('gattserverdisconnected', oldDropListener);
        } catch (_error) {}
      }
      this.gattDropListener = null;

      this.connectedDevice = device;
      this.reconnectDevice = device;
      this.bleServer = server;
      this.notificationResources = resources;
      this.subscribedSources = {};
      const now = Date.now();
      for (const resource of resources) {
        resource.committed = true;
        this.subscribedSources[resource.source] = true;
        if (this.metrics && typeof this.metrics.markSourceSubscribed === 'function') {
          this.metrics.markSourceSubscribed(resource.source, now);
        }
      }
      if (this.subscribedSources.hrs) {
        this.heartRateSubscribedAtMs = now;
      }
      if (this.rideSessionActive && this.subscribedSources.hrs) {
        this.heartRateExpected = true;
        this.setData({
          showHeartRate: true,
          heartRateStatus: this.lastHeartRateDisplayBpm != null
            ? '心率实时' : '心率等待',
        });
      }
      const subscribedResults = sourceSpecs.map(
        (spec) => resources.some((resource) => resource.source === spec.source),
      );
      writeRideDevice(wx, {
        deviceId: deviceId(device),
        deviceName: rideDeviceDisplayName(device),
        services: servicesForSubscriptions(sourceSpecs, subscribedResults),
      });
      if (!options.reconnect) this.reconnectCount = 0;
      this.clearReconnectTimer();
      this.reconnectDeferred = false;
      if (typeof device.addEventListener === 'function') {
        const dropListener = () => {
          if (this.gattDropListener !== dropListener) return;
          this.onGattDropped(device, server);
        };
        this.gattDropListener = dropListener;
        try { device.addEventListener('gattserverdisconnected', dropListener); } catch (_error) {}
      }
      this.syncDiscoveredDevices();
      this.refreshPreRideBrief();
      this.setData({
        surfacePhase: this.rideSessionActive ? 'hud' : 'ready',
        searchChip: '已连接',
        searchText: '骑行设备已连接',
        primaryLabel: '下一步',
      });
      const oldResourceCleanup = Promise.all(
        oldResources.map((resource) => this.releaseNotificationResource(resource, true)),
      );
      if (oldServer && oldServer !== server) {
        oldResourceCleanup
          .then(() => {
            if (this.bleServer === oldServer) return false;
            const pendingOldStop = oldResources.some(
              (resource) => this.pendingNotificationStop(resource.characteristic),
            );
            if (oldDevice && this.connectingDevice === oldDevice && !pendingOldStop) {
              return false;
            }
            return this.disconnectBleServer(oldServer);
          })
          .catch(() => false);
      } else {
        oldResourceCleanup.catch(() => false);
      }
      this.releaseDeferredBleServers(device, server).catch(() => false);
      this.bleDebug('GATT_CONNECTED',
        'attempt=' + attempt + ' sources=' + Object.keys(this.subscribedSources).join(','));
      return true;
    } catch (error) {
      await this.releaseConnectionAttempt(resources, server, true, device, attempt);
      if (this.isBleAttemptCurrent(attempt, operation, lifecycleGeneration)) {
        this.bleDebug('GATT_FAILED',
          'attempt=' + attempt + ' reason=' + this.bleErrorText(error));
        this.setData({
          surfacePhase: this.rideSessionActive ? 'hud' : 'ready',
          searchChip: '可重试',
          searchText: options.reconnect ? '自动重连失败' : '连接失败，可直接骑行',
        });
      }
      return false;
    } finally {
      if (this.connectingAttemptId === attempt) {
        this.connectingAttemptId = null;
        this.connectingDevice = null;
        this.connecting = false;
        this.connectingAutoResume = false;
        await this.releaseDeferredBleServers(
          device,
          this.connectedDevice === device ? this.bleServer : null,
        );
      }
    }
  },

  applyHeartRateDisplay(bpm, now = Date.now(), options = {}) {
    if (!this.canAcceptRideRuntimeData()) return false;
    this.heartRateExpected = true;
    if (options.contactLost === true) {
      this.lastHeartRateDisplayBpm = null;
      this.lastHeartRateDisplayAtMs = null;
      this.heartRateContactLostAtMs = now;
      this.setData({
        heartRate: '未贴',
        heartRateStatus: '心率未贴合',
        showHeartRate: true,
        ...heartZoneDotFields(0),
      });
      return true;
    }
    const value = finiteNumber(bpm);
    if (value == null || value <= 0 || value >= 255) return false;
    this.lastHeartRateDisplayBpm = value;
    this.lastHeartRateDisplayAtMs = now;
    this.heartRateContactLostAtMs = null;
    this.heartRateEverLive = true;
    this.setData({
      heartRate: formatBpm(value),
      heartRateStatus: '心率实时',
      showHeartRate: true,
      ...heartZoneDotFields(hrZone(
        value,
        Number((this.rideSettings || DEFAULT_BIKE_SETTINGS).maxHeartRateBpm),
      )),
    });
    return true;
  },

  recentHeartRateDisplay(now = Date.now()) {
    if (this.lastHeartRateDisplayAtMs == null
        || now - this.lastHeartRateDisplayAtMs > HEART_RATE_DISPLAY_FRESH_MS) {
      return null;
    }
    return finiteNumber(this.lastHeartRateDisplayBpm);
  },

  onSourceMeasurement(source, value, now = Date.now(), options = {}) {
    const displayOnly = options.displayOnly === true
      && (source === 'hrs' || source === 'ftms');
    const backgroundRide = options.backgroundRide === true
      && this.canContinueRideInBackground();
    if (!this.canAcceptRideRuntimeData()
        || (!this.pageVisible && !displayOnly && !backgroundRide)
    ) return false;
    const packetCount = (this.blePacketDiagnosticCounts[source] || 0) + 1;
    this.blePacketDiagnosticCounts[source] = packetCount;
    if (packetCount <= 3) {
      this.bleDebug('PACKET', 'source=' + source + ' count=' + packetCount);
    }
    let accepted = false;
    if (source === 'hrs') {
      const parsed = parseHeartRateMeasurement(value);
      if (parsed) this.lastHrsPacketAtMs = now;
      if (parsed && parsed.sensorContact === 'no-contact'
          && typeof this.metrics.onHeartRateContactLost === 'function') {
        this.applyHeartRateDisplay(null, now, { contactLost: true });
        accepted = displayOnly
          ? true : this.metrics.onHeartRateContactLost(now);
      } else if (parsed && Number.isFinite(parsed.bpm) && parsed.bpm > 0) {
        this.applyHeartRateDisplay(parsed.bpm, now);
        accepted = displayOnly
          ? true : this.metrics.onHeartRate(parsed.bpm, now);
      }
    } else if (source === 'csc') {
      accepted = this.metrics.onCsc(value, now);
    } else if (source === 'cps') {
      accepted = this.metrics.onCyclingPower(value, now);
    } else if (source === 'ftms') {
      const parsed = value && typeof value === 'object'
        && Object.prototype.hasOwnProperty.call(value, 'speedKmh')
        ? value : parseIndoorBikeData(value);
      const ftmsHeartRate = parsed && Number.isFinite(parsed.heartRateBpm)
        && parsed.heartRateBpm > 0 && parsed.heartRateBpm < 255
        ? parsed.heartRateBpm : null;
      if (ftmsHeartRate != null) this.applyHeartRateDisplay(ftmsHeartRate, now);
      if (displayOnly) return ftmsHeartRate != null;
      accepted = parsed ? this.metrics.onFtms(parsed, now) : false;
    }
    if (accepted && source === 'hrs') {
      // HRS 逐包刷新心率，并在 ticker 受限时推进完整 HUD。
      this.requestRideTick('hrs', now);
      return true;
    }
    if (accepted) {
      this.reconnectCount = 0;
      // 数据已经先进入 metrics；完整 HUD 统一走 500ms 硬门，最多只会
      // 延迟半秒显示，不会丢通知或距离增量。
      this.requestRideTick(source, now);
    }
    return accepted;
  },

  onGattDropped(device = this.connectedDevice, server = this.bleServer) {
    if (this.bleTerminated || device !== this.connectedDevice
        || (server && this.bleServer && server !== this.bleServer)) return;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.connectingAttemptId = null;
    this.connectingDevice = null;
    this.connecting = false;
    const now = Date.now();
    const heartRateDropped = Boolean(
      this.subscribedSources.hrs
        || (this.subscribedSources.ftms && this.heartRateEverLive),
    );
    for (const source of Object.keys(this.subscribedSources || {})) {
      if (this.metrics && typeof this.metrics.markSourceDisconnected === 'function') {
        this.metrics.markSourceDisconnected(source, now);
      }
    }
    const resources = this.notificationResources.slice();
    this.notificationResources = [];
    for (const resource of resources) {
      resource.active = false;
      this.notificationOwnerResources = (this.notificationOwnerResources || [])
        .filter((item) => item !== resource);
      try {
        resource.characteristic.removeEventListener(
          'characteristicvaluechanged',
          resource.listener,
        );
      } catch (_error) {}
    }
    if (device && this.gattDropListener && typeof device.removeEventListener === 'function') {
      try {
        device.removeEventListener('gattserverdisconnected', this.gattDropListener);
      } catch (_error) {}
    }
    this.gattDropListener = null;
    this.subscribedSources = {};
    this.heartRateSubscribedAtMs = null;
    this.lastHrsPacketAtMs = null;
    if (heartRateDropped && this.canAcceptRideRuntimeData()) {
      this.heartRateExpected = true;
      this.setData({
        heartRate: this.lastHeartRateDisplayBpm != null
          ? formatBpm(this.lastHeartRateDisplayBpm) : '重连',
        heartRateStatus: '心率重连',
        showHeartRate: true,
        ...heartZoneDotFields(0),
      });
    }
    this.bleServer = null;
    this.connectedDevice = device;
    this.reconnectDevice = device;
    this.bleDebug('GATT_DROPPED',
      'visible=' + String(this.pageVisible) + ' reconnect=' + this.reconnectCount);
    if (this.rideSessionActive) {
      if (this.pageVisible) this.scheduleReconnect(device);
      else this.reconnectDeferred = true;
    }
  },

  hasHealthyBleConnection(target = this.connectedDevice) {
    return Boolean(
      target
      && this.connectedDevice === target
      && this.bleServer
      && this.bleServer.connected !== false
      && (this.notificationResources || [])
        .some((resource) => resource.active && resource.committed),
    );
  },

  heartRateSampleAtMs() {
    return Number.isFinite(this.lastHrsPacketAtMs)
      ? this.lastHrsPacketAtMs : null;
  },

  evaluateRideSourceHealth(now = Date.now(), lifecycle = 'active') {
    if (!this.canAcceptRideRuntimeData()) return null;
    const hrsSupported = this.hasActiveSubscribedSource('hrs');
    const hrs = decideHrsSourceHealth({
      supported: hrsSupported,
      sessionActive: true,
      startedAtMs: this.heartRateSubscribedAtMs,
      lastPacketAtMs: this.heartRateSampleAtMs(now),
      nowMs: now,
      lifecycle,
      hasLastValue: this.heartRateEverLive === true,
    });
    this.rideSourceHealth = { hrs };
    if (hrs.shouldRestart && this.pageVisible && !this.connecting) {
      this.setData({
        heartRateStatus: hrs.reason === 'first-packet-timeout'
          ? '心率首包恢复' : '心率恢复',
        showHeartRate: true,
      });
      this.restartBleForStaleSource('hrs', now);
    }
    return this.rideSourceHealth;
  },

  restartHrsNotification(resource, now = Date.now()) {
    if (!resource || resource.source !== 'hrs' || !resource.active
        || !resource.committed || !resource.characteristic) return false;
    const recoveryGeneration = (this.bleSourceRecoveryGeneration || 0) + 1;
    this.bleSourceRecoveryGeneration = recoveryGeneration;
    const characteristic = resource.characteristic;
    const server = resource.server || this.bleServer;
    const device = resource.device || this.connectedDevice;
    const lifecycleGeneration = this.bleLifecycleGeneration;
    this.bleSourceRecoveryFlight = (async () => {
      try {
        if (typeof characteristic.stopNotifications === 'function') {
          await this.waitForPromise(
            characteristic.stopNotifications(),
            BLE_CLEANUP_STEP_WAIT_MS,
          );
        }
        if (!this.pageVisible
            || lifecycleGeneration !== this.bleLifecycleGeneration) {
          // AIUI 0.15 的 startNotifications 必须留在可交互 InkView 生命周期。
          // 若 AR 正好在 stop 完成后隐藏页面，保留资源并交给 onShow 全量恢复。
          this.hrsRecoveryPending = Boolean(device && this.rideSessionActive);
          return false;
        }
        if (this.bleTerminated || this.agentExitRequested
            || !this.canAcceptRideRuntimeData()
            || recoveryGeneration !== this.bleSourceRecoveryGeneration
            || !resource.active || !resource.committed
            || this.bleServer !== server
            || !this.notificationResources.includes(resource)) return false;
        await this.waitForPromise(
          characteristic.startNotifications(),
          BLE_CONNECT_TIMEOUT_MS,
        );
        if (!this.pageVisible
            || lifecycleGeneration !== this.bleLifecycleGeneration) {
          this.hrsRecoveryPending = Boolean(device && this.rideSessionActive);
          return false;
        }
        if (this.bleTerminated || this.agentExitRequested
            || recoveryGeneration !== this.bleSourceRecoveryGeneration
            || !resource.active || !resource.committed
            || this.bleServer !== server
            || !this.notificationResources.includes(resource)) return false;
        const restartedAtMs = Date.now();
        this.heartRateSubscribedAtMs = restartedAtMs;
        this.lastHrsPacketAtMs = null;
        this.hrsRecoveryPending = false;
        if (this.metrics && typeof this.metrics.markSourceDisconnected === 'function') {
          this.metrics.markSourceDisconnected('hrs', restartedAtMs);
        }
        if (this.metrics && typeof this.metrics.markSourceSubscribed === 'function') {
          this.metrics.markSourceSubscribed('hrs', restartedAtMs);
        }
        this.bleDebug('SOURCE_RECOVERED', 'source=hrs mode=notification');
        return true;
      } catch (_error) {
        this.bleDebug('SOURCE_RECOVERY_FAILED', 'source=hrs mode=notification');
        if (!this.pageVisible
            || lifecycleGeneration !== this.bleLifecycleGeneration) {
          this.hrsRecoveryPending = Boolean(device && this.rideSessionActive);
          return false;
        }
        if (resource.active && resource.committed
            && this.notificationResources.includes(resource)) {
          resource.active = false;
          this.notificationResources = this.notificationResources.filter(
            (item) => item !== resource,
          );
          this.notificationOwnerResources = this.notificationOwnerResources.filter(
            (item) => item !== resource,
          );
          try {
            characteristic.removeEventListener(
              'characteristicvaluechanged',
              resource.listener,
            );
          } catch (_ignored) {}
        }
        if (this.subscribedSources) delete this.subscribedSources.hrs;
        this.hrsRecoveryPending = Boolean(device && this.rideSessionActive);
        if (this.pageVisible && this.rideSessionActive && device
            && !this.bleTerminated && !this.agentExitRequested) {
          setTimeout(() => {
            if (this.restartBleForStaleSource(
              'hrs',
              Date.now(),
              { forceFull: true },
            )) {
              this.hrsRecoveryPending = false;
            }
          }, 0);
        }
        return false;
      }
    })().finally(() => {
      if (recoveryGeneration === this.bleSourceRecoveryGeneration) {
        this.bleSourceRecoveryFlight = null;
        if (this.hrsRecoveryPending && this.pageVisible
            && this.rideSessionActive && !this.bleTerminated
            && !this.agentExitRequested) {
          setTimeout(() => {
            if (this.restartBleForStaleSource(
              'hrs',
              Date.now(),
              { forceFull: true },
            )) {
              this.hrsRecoveryPending = false;
            }
          }, 0);
        }
      }
    });
    return true;
  },

  restartBleForStaleSource(source, now = Date.now(), options = {}) {
    if (this.bleSourceRecoveryFlight || !this.pageVisible
        || !this.rideSessionActive || this.bleTerminated
        || this.agentExitRequested) return false;
    if (options.forceFull !== true
        && this.lastBleSourceRecoveryAtMs != null
        && now - this.lastBleSourceRecoveryAtMs
          < BLE_SOURCE_RECOVERY_COOLDOWN_MS) return false;
    const device = this.connectedDevice || this.reconnectDevice;
    const server = this.bleServer;
    if (!device || !server) return false;
    this.lastBleSourceRecoveryAtMs = now;
    if (options.forceFull === true) this.hrsRecoveryPending = false;
    const sourceResource = (this.notificationResources || []).find(
      (resource) => resource.active
        && resource.committed
        && resource.source === source,
    );
    const dropListener = this.gattDropListener;
    if (source === 'hrs' && sourceResource && options.forceFull !== true) {
      try {
        console.log('[AIBike BLE] SOURCE_RECOVERY source=hrs mode=notification');
      } catch (_ignored) {}
      return this.restartHrsNotification(sourceResource, now);
    }
    if (dropListener && typeof device.removeEventListener === 'function') {
      try {
        device.removeEventListener('gattserverdisconnected', dropListener);
      } catch (_error) {}
    }
    this.gattDropListener = null;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.clearReconnectTimer();
    for (const name of Object.keys(this.subscribedSources || {})) {
      if (this.metrics && typeof this.metrics.markSourceDisconnected === 'function') {
        this.metrics.markSourceDisconnected(name, now);
      }
    }
    this.subscribedSources = {};
    this.heartRateSubscribedAtMs = null;
    this.lastHrsPacketAtMs = null;
    try {
      console.log('[AIBike BLE] SOURCE_RECOVERY source=' + String(source));
    } catch (_ignored) {}
    this.bleSourceRecoveryFlight = (async () => {
      await this.releaseNotificationResources(true, true);
      if (!this.pageVisible || !this.canAcceptRideRuntimeData()) return false;
      if (this.bleServer === server) this.bleServer = null;
      if (this.connectedDevice === device) this.connectedDevice = null;
      this.reconnectDevice = device;
      const connected = await this.connectSelected(device, { reconnect: true });
      if (!connected && this.pageVisible && this.rideSessionActive
          && !this.bleTerminated) {
        this.scheduleReconnect(device);
      }
      return connected;
    })().catch(() => false).finally(() => {
      this.bleSourceRecoveryFlight = null;
    });
    return true;
  },

  hasActiveSubscribedSource(sourceNames) {
    const expected = Array.isArray(sourceNames) ? sourceNames : [sourceNames];
    return Boolean(
      this.bleServer
      && this.bleServer.connected !== false
      && (this.notificationResources || []).some(
        (resource) => resource.active
          && resource.committed
          && expected.includes(resource.source),
      ),
    );
  },

  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectGeneration = (this.reconnectGeneration || 0) + 1;
  },

  clearSearchConnectResumeTimer() {
    if (this.searchConnectResumeTimer) clearTimeout(this.searchConnectResumeTimer);
    this.searchConnectResumeTimer = null;
  },

  scheduleReconnect(target = this.connectedDevice || this.reconnectDevice) {
    this.clearReconnectTimer();
    const generation = this.reconnectGeneration;
    if (!target || this.reconnectCount >= HUD_RECONNECT_MAX
        || this.agentExitRequested) return false;
    if (this.hasHealthyBleConnection(target)) return false;
    if (!this.pageVisible) {
      this.reconnectDeferred = true;
      return false;
    }
    this.reconnectDevice = target;
    this.reconnectDeferred = false;
    this.bleDebug('RECONNECT_SCHEDULED',
      'attempt=' + String(this.reconnectCount + 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.reconnectGeneration
          || this.hasHealthyBleConnection(target)) return;
      if (!this.pageVisible || !this.rideSessionActive) {
        this.reconnectDeferred = true;
        return;
      }
      this.reconnectCount += 1;
      this.connectSelected(target, { reconnect: true }).then((connected) => {
        if (generation !== this.reconnectGeneration
            || connected || this.hasHealthyBleConnection(target)) return;
        this.scheduleReconnect(target);
      });
    }, HUD_RECONNECT_DELAY_MS);
    return true;
  },

  clearRideStartTimer() {
    if (this.rideStartTimer) clearTimeout(this.rideStartTimer);
    this.rideStartTimer = null;
  },

  async proceedToHud() {
    if (!this.isSearchPhase() || this.agentExitRequested) return false;
    if (this.sportAgentStartPending || this.sportAgentStartFlight) return false;
    this.clearSearchConnectResumeTimer();
    this.scanResumePending = false;
    this.scanDiscoveryPending = false;
    this.searchConnectResumePending = false;
    if (!this.connecting) {
      this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    }
    this.stopScan();
    this.clearRideStartTimer();
    // 设备订阅已稳定后才冻结一次能力快照，并建立唯一的
    // briefing -> session。骑中零网络，因此必须等这条有界 JIT 完成后
    // 才能切换 HUD。计划骑失败/阻断时 fail-closed；自由骑失败时明确
    // 降级到本地安全模式。
    this.sportAgentStartPending = true;
    this.setData({
      searchChip: '准备中',
      searchText: '正在确认训练与设备能力',
      agentStartText: 'Hermes 正在准备骑行',
    });
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    const plan = this.pendingSportsPlan || null;
    const planned = Boolean(plan && plan.workout_id);
    const capabilities = this.sportAgentCapabilities();
    this.resetPendingSportAgent();
    const flight = this.prepareCurrentSportAgent({
      plan,
      capabilities,
      force: true,
    }).then((prepared) => {
      if (!this.isHermesLifecycleCurrent(lifecycleGeneration)
          || this.agentExitRequested || this.rideSessionActive) return false;
      if (!prepared) {
        if (planned) {
          this.setData({
            surfacePhase: 'ready',
            searchChip: '暂不能开始',
            searchText: '今日训练未通过在线安全确认',
            agentStartText: '返回菜单可改选自由骑',
          });
          this.armSurfaceEntryInputGuard();
          return false;
        }
        this.setData({
          searchChip: '本地模式',
          searchText: '网络不可用 · 使用本地安全骑行',
          agentStartText: '本场不使用云端训练督导',
        });
        return this.startRide({ localSafeMode: true });
      }
      const session = prepared.session;
      if (planned && (!session.readiness || session.readiness.launch_allowed !== true)) {
        this.setData({
          surfacePhase: 'ready',
          searchChip: '暂不能开始',
          searchText: '今日训练因恢复状态被暂停',
          agentStartText: '请返回菜单选择自由骑或休息',
        });
        this.armSurfaceEntryInputGuard();
        return false;
      }
      return this.startRide();
    }).catch(() => {
      if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return false;
      if (planned) {
        this.setData({
          surfacePhase: 'ready',
          searchChip: '暂不能开始',
          searchText: '今日训练在线确认失败',
          agentStartText: '返回菜单可改选自由骑',
        });
        this.armSurfaceEntryInputGuard();
        return false;
      }
      this.setData({
        searchChip: '本地模式',
        searchText: '网络不可用 · 使用本地安全骑行',
        agentStartText: '本场不使用云端训练督导',
      });
      return this.startRide({ localSafeMode: true });
    }).finally(() => {
      if (this.sportAgentStartFlight === flight) this.sportAgentStartFlight = null;
      this.sportAgentStartPending = false;
    });
    this.sportAgentStartFlight = flight;
    return flight;
  },

  startRide(options = {}) {
    if (!this.pageVisible || this.bleTerminated || this.agentExitRequested) return false;
    if (this.rideSessionActive) return false;
    if (this.blockingSportAgentActive && !this.pendingSportAgent) return false;
    this.finishRideCommitted = false;
    this.clearSearchConnectResumeTimer();
    this.stopScan();
    this.scanResumePending = false;
    this.scanDiscoveryPending = false;
    this.searchConnectResumePending = false;
    const now = Date.now();
    const plannedPlan = this.pendingSportsPlan || null;
    const expectedAgentMode = this.sportAgentMode(plannedPlan);
    const expectedAgentWorkoutId = plannedPlan ? plannedPlan.workout_id : '';
    const preparedAgent = this.pendingSportAgent;
    this.activeSportAgent = preparedAgent
      && preparedAgent.mode === expectedAgentMode
      && preparedAgent.workoutId === expectedAgentWorkoutId
      && preparedAgent.session
      && preparedAgent.identity
      && sameSportsOwner(preparedAgent.identity, this.sportsIdentity || preparedAgent.identity)
      ? preparedAgent : null;
    if (plannedPlan && !this.activeSportAgent) return false;
    if (plannedPlan) {
      this.activeSportsPlan = buildSportAgentExecutionPlan(
        plannedPlan,
        this.activeSportAgent.session,
      );
      if (!this.activeSportsPlan) {
        this.activeSportAgent = null;
        return false;
      }
    } else {
      this.activeSportsPlan = null;
    }
    if (this.activeSportAgent) {
      const activeSnapshot = activateSportAgentPrestart(
        wx,
        this.activeSportAgent.identity,
        this.activeSportAgent.session,
        { startedAtMs: now },
      );
      if (!activeSnapshot) {
        // A cloud session must never become a local active ride until its
        // owner-bound snapshot has survived a storage readback.  Planned rides
        // fail closed.  Free rides explicitly drop cloud supervision and keep
        // the pre-start journal available for exact replay/recovery.
        if (plannedPlan) {
          this.activeSportAgent = null;
          this.activeSportsPlan = null;
          return false;
        }
        this.activeSportAgent = null;
      } else {
        this.blockingSportAgentActive = activeSnapshot;
        this.recoveredSportAgentPlan = null;
      }
    }
    this.pendingSportsPlan = null;
    this.pendingSportAgent = null;
    this.sportAgentPreparationGeneration = (this.sportAgentPreparationGeneration || 0) + 1;
    this.sportAgentSeq = 0;
    this.sportAgentLastQueuedAtMs = null;
    this.sportAgentLastStageId = '';
    this.sportsWorkoutExecutor = this.activeSportsPlan
      ? createSportsWorkoutExecutor(this.activeSportsPlan, now) : null;
    if (this.sportsWorkoutExecutor) {
      const heartRatePolicy = this.activeSportAgent
        && this.activeSportAgent.session.heart_rate_policy;
      this.sportsWorkoutExecutor.maxHeartRateBpm = heartRatePolicy
        ? Number(heartRatePolicy.max_hr_bpm) : null;
      this.sportsWorkoutExecutor.heartRateAuthoritative = Boolean(
        heartRatePolicy && heartRatePolicy.authoritative === true,
      );
    }
    this.sportsCoachState = null;
    this.sportsExecutionId = createSportsExecutionId(now);
    this.sportsStartedAtMs = now;
    this.sportsOwnerAtStart = this.activeSportAgent
      ? this.activeSportAgent.identity
      : (this.sportsIdentity || readSportsIdentity(wx));
    if (!this.sportsIdentity && this.sportsOwnerAtStart) {
      this.sportsIdentity = this.sportsOwnerAtStart;
    }
    this.surfaceGeneration += 1;
    this.metrics = new CyclingMetrics({
      startMs: now,
      wheelCircumferenceMm: (this.rideSettings || DEFAULT_BIKE_SETTINGS)
        .wheelCircumferenceMm,
      imuMetersPerCrank: (this.rideSettings || DEFAULT_BIKE_SETTINGS)
        .imuMetersPerCrank,
      maxSpeedKmh: 120,
    });
    this.rideSessionActive = true;
    this.autoPausedByHide = false;
    // 若准备页恰好仍在补传上一场，开始新骑行时中止其网络任务。待传
    // 事件只有服务端明确 ACK 才会删除，因此中止后仍可在本场结束补传。
    this.abortCyclingHermesRequests();
    this.cyclingUploadSession = createCyclingUploadSession(now);
    this.cyclingUploadBuffer = [];
    this.cyclingUploadSampleCount = 0;
    for (const source of Object.keys(this.subscribedSources || {})) {
      this.metrics.markSourceSubscribed(source, now);
    }
    this.heartRateExpected = Boolean(this.subscribedSources.hrs);
    this.heartRateEverLive = false;
    this.lastHeartRateDisplayBpm = null;
    this.lastHeartRateDisplayAtMs = null;
    this.heartRateContactLostAtMs = null;
    this.heartRateSubscribedAtMs = this.subscribedSources.hrs ? now : null;
    this.lastHrsPacketAtMs = null;
    this.powerEverLive = false;
    this.minuteSeries = [];
    this.lastMinuteSample = 0;
    this.lastLockedImuHudEstimate = null;
    this.rideHudSpeedHoldRevoked = false;
    this.rideHudCadenceHoldRevoked = false;
    this.lastImuMetricsForwardAtMs = null;
    this.lastImuMetricsSignature = '';
    this.lastRideHudRenderData = null;
    this.rideHudHiddenHoldPending = false;
    this.lastRideTickAtMs = null;
    this.rideTickInProgress = false;
    this.hudEnteredAtMs = now;
    this.endArmedAtMs = null;
    this.hudTouchTapAtMs = null;
    const firstHudFrame = {
      surfacePhase: 'hud',
      riding: true,
      speed: '估算中',
      cadence: '识别中',
      distance: '待起步',
      elapsed: '刚开始',
      heartRate: this.heartRateExpected ? '等待' : '未连接',
      heartRateStatus: this.heartRateExpected ? '心率等待' : '心率',
      powerChipText: '',
      showHeartRate: this.heartRateExpected,
      showPower: false,
      cyclingSourceText: Object.keys(this.subscribedSources).length
        ? '骑行通知 / IMU 预热'
        : (options.localSafeMode === true ? '本地安全模式 · 眼镜 IMU' : '眼镜 IMU 预热'),
      hudHint: '',
      hudEnvironment: formatHudClock(now),
      workoutStageVisible: Boolean(this.sportsWorkoutExecutor),
      workoutStageTitle: this.activeSportsPlan ? this.activeSportsPlan.title : '',
      workoutStageRemaining: '',
      workoutStageTarget: '',
      ...heartZoneDotFields(0),
    };
    Object.assign(firstHudFrame, buildHudMetricClassFields(firstHudFrame));
    this.setData(firstHudFrame);
    this.rememberRideHudRenderData(firstHudFrame);
    if (this.cyclingUploadSession) {
      this.beginCyclingLocalFieldCapture(
        this.cyclingUploadSession.startedAtMs,
        this.cyclingUploadSession.testRideId,
      );
      this.recordCyclingLocalLifecycle('hud_visible', {
        atMs: now,
        elapsedMs: 0,
        reason: 'user',
        sensor: 'runtime',
        generation: this.imuGeneration,
      });
    }
    const imuStarted = this.startRideImu();
    if (imuStarted) {
      this.recordCyclingLocalLifecycle('imu_started', {
        atMs: Date.now(),
        elapsedMs: 0,
        reason: 'user',
        sensor: 'bundle',
        generation: this.imuGeneration,
      });
    }
    this.startTicker();
    this.startRideCadenceCue();
    this.speakCue('开始骑行，注意路况。', 'ride_start');
    if (!imuStarted) {
      this.recordCyclingLocalLifecycle('imu_error', {
        atMs: Date.now(),
        elapsedMs: 0,
        reason: 'sensor_error',
        sensor: 'bundle',
        generation: this.imuGeneration,
      });
    }
    const target = this.connectedDevice || this.reconnectDevice;
    if (target && !this.hasHealthyBleConnection(target) && !this.connecting) {
      this.scheduleReconnect(target);
    }
    return true;
  },

  imuMetricsActivitySignature(activity) {
    if (!activity || typeof activity !== 'object') return '';
    const rounded = (value, scale = 1) => {
      if (value == null || value === '') return '';
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.round(numeric * scale) : '';
    };
    const confidence = Number(activity.confidence);
    const cadenceConfidence = Number(
      activity.effectiveCadenceConfidence ?? activity.cadenceConfidence,
    );
    return [
      activity.motionState || 'unknown',
      activity.fresh === true,
      activity.autoPauseSuggested === true,
      activity.autoResumeSuggested === true,
      Number.isFinite(confidence) && confidence >= 0.7,
      Number.isFinite(confidence) && confidence >= 0.8,
      activity.cadenceState || 'unknown',
      activity.cadenceEstimateLevel || 'none',
      activity.cadenceSensorSource || 'none',
      activity.cadenceUsable === true,
      activity.availabilityCadenceUsable === true,
      rounded(activity.candidateCadenceRpm),
      rounded(activity.finalCadenceRpm),
      rounded(activity.effectiveCadenceRpm),
      Number.isFinite(cadenceConfidence) && cadenceConfidence >= 0.55,
      Number.isFinite(cadenceConfidence) && cadenceConfidence >= 0.58,
      Number.isFinite(cadenceConfidence) && cadenceConfidence >= 0.65,
      activity.simpleGyroAnalysisState || 'none',
      activity.simpleGyroCadenceMethod || 'none',
      activity.simpleGyroDisplayFresh === true,
      activity.simpleGyroLedgerFresh === true,
      activity.motionQualityState || 'unavailable',
      activity.motionArtifact || 'none',
      activity.rawMotionArtifact || 'none',
      activity.accelerationUnit || 'unknown',
      activity.accelerationCalibrated === true,
      rounded(activity.metersPerCrank, 100),
    ].join('|');
  },

  clearRideImuMetricsPending() {
    if (this.imuMetricsPendingTimer) clearTimeout(this.imuMetricsPendingTimer);
    this.imuMetricsPendingTimer = null;
    this.pendingImuMetricsActivity = null;
    this.pendingImuMetricsAtMs = null;
  },

  flushRideImuActivity(activity, activityAtMs, forwardedAtMs = Date.now()) {
    if (!activity || !this.metrics
        || typeof this.metrics.onImuActivity !== 'function') return false;
    const sampleAtMs = Number(activityAtMs);
    const gateAtMs = Number(forwardedAtMs);
    if (!Number.isFinite(sampleAtMs) || !Number.isFinite(gateAtMs)) return false;

    // signature 的数组与 join 只允许出现在 250ms 边界之后，不能回到
    // 50Hz Accel/Gyro 原始帧路径。
    this.lastImuMetricsSignature = this.imuMetricsActivitySignature(activity);
    this.lastImuMetricsForwardAtMs = gateAtMs;
    const accepted = this.metrics.onImuActivity(activity, sampleAtMs);
    if (accepted) this.requestRideTick('imu', gateAtMs);
    return accepted;
  },

  scheduleRideImuMetricsFlush(delayMs) {
    if (this.imuMetricsPendingTimer || !this.pendingImuMetricsActivity) return false;
    this.imuMetricsPendingTimer = setTimeout(() => {
      this.imuMetricsPendingTimer = null;
      const activity = this.pendingImuMetricsActivity;
      const activityAtMs = this.pendingImuMetricsAtMs;
      this.pendingImuMetricsActivity = null;
      this.pendingImuMetricsAtMs = null;
      if (!activity || !this.canRunRideImu()) return;
      this.flushRideImuActivity(activity, activityAtMs, Date.now());
    }, Math.max(0, Number(delayMs) || 0));
    return true;
  },

  forwardRideImuActivity(activity, now = Date.now()) {
    if (!activity || !this.metrics
        || typeof this.metrics.onImuActivity !== 'function') return false;
    const atMs = Number(now);
    if (!Number.isFinite(atMs)) return false;
    const lastAtMs = this.lastImuMetricsForwardAtMs != null
      && Number.isFinite(Number(this.lastImuMetricsForwardAtMs))
      ? Number(this.lastImuMetricsForwardAtMs) : null;
    if (lastAtMs != null
        && atMs - lastAtMs < IMU_METRICS_STABLE_INTERVAL_MS) {
      // 门内不读 activity 字段、不构造 signature，只保留宿主已经产生的
      // 最新分类快照引用；即使下一帧停流，单一定时器也会在边界转发它。
      this.pendingImuMetricsActivity = activity;
      this.pendingImuMetricsAtMs = atMs;
      this.scheduleRideImuMetricsFlush(
        IMU_METRICS_STABLE_INTERVAL_MS - Math.max(0, atMs - lastAtMs),
      );
      return false;
    }

    this.clearRideImuMetricsPending();
    return this.flushRideImuActivity(activity, atMs, atMs);
  },

  rememberRideHudRenderData(values) {
    if (!values || typeof values !== 'object') return false;
    const previous = this.lastRideHudRenderData || this.data || {};
    this.lastRideHudRenderData = { ...previous, ...values };
    return true;
  },

  commitRideHudRenderData(values) {
    if (!values || typeof values !== 'object') return false;
    const previous = this.lastRideHudRenderData || this.data || {};
    const patch = {};
    for (const key of Object.keys(values)) {
      if (previous[key] !== values[key]) patch[key] = values[key];
    }
    this.rememberRideHudRenderData(values);
    if (!Object.keys(patch).length) return false;
    this.setData(patch);
    return true;
  },

  startTicker() {
    this.stopTicker();
    this.tickTimer = setInterval(
      () => this.requestRideTick('timer'),
      TICK_MS,
    );
  },

  stopTicker() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.rideTickPendingTimer) clearTimeout(this.rideTickPendingTimer);
    this.tickTimer = null;
    this.rideTickPendingTimer = null;
    this.rideTickPendingSource = '';
    this.lastRideTickAtMs = null;
    this.rideTickInProgress = false;
  },

  scheduleRideTickBoundary(source, delayMs) {
    if (this.rideTickPendingTimer || !this.canAcceptRideRuntimeData()) return false;
    this.rideTickPendingSource = String(source || 'signal');
    this.rideTickPendingTimer = setTimeout(() => {
      this.rideTickPendingTimer = null;
      const pendingSource = this.rideTickPendingSource || 'signal';
      this.rideTickPendingSource = '';
      this.requestRideTick(pendingSource, Date.now());
    }, Math.max(0, Number(delayMs) || 0));
    return true;
  },

  requestRideTick(source = 'signal', requestedAtMs = Date.now()) {
    if (!this.canAcceptRideRuntimeData()
        || (this.pageVisible !== true && !this.canContinueRideInBackground())
        || this.metrics.paused === true
    ) return false;
    const now = Number.isFinite(Number(requestedAtMs))
      ? Number(requestedAtMs) : Date.now();
    const lastAt = this.lastRideTickAtMs != null
      && Number.isFinite(Number(this.lastRideTickAtMs))
      ? Number(this.lastRideTickAtMs) : null;
    if (lastAt != null && now - lastAt < RIDE_SIGNAL_TICK_MIN_MS) {
      this.scheduleRideTickBoundary(
        source,
        RIDE_SIGNAL_TICK_MIN_MS - Math.max(0, now - lastAt),
      );
      return false;
    }
    if (this.rideTickInProgress === true) return false;
    if (this.rideTickPendingTimer) clearTimeout(this.rideTickPendingTimer);
    this.rideTickPendingTimer = null;
    this.rideTickPendingSource = '';
    if (this.pageVisible === true
        && ['imu', 'csc', 'cps', 'ftms'].includes(source)) {
      this.rideHudHiddenHoldPending = false;
    }
    if (source !== 'timer'
        && lastAt != null
        && now - lastAt >= RIDE_SIGNAL_TICK_STALL_LOG_MS) {
      try {
        console.log('[AIBike HUD] SIGNAL_RECOVERY source=' + String(source)
          + ' gapMs=' + String(Math.round(now - lastAt)));
      } catch (_ignored) {}
    }
    this.rideTickInProgress = true;
    try {
      const snapshot = this.tick(now, source);
      if (!snapshot) return false;
      this.lastRideTickAtMs = now;
      return true;
    } finally {
      this.rideTickInProgress = false;
    }
  },

  updateRideCoach(snapshot, now = Date.now()) {
    if (this.sportsWorkoutExecutor) {
      const heartRatePolicy = this.activeSportAgent
        && this.activeSportAgent.session
        && this.activeSportAgent.session.heart_rate_policy;
      const maxHeartRateBpm = heartRatePolicy
        ? Number(heartRatePolicy.max_hr_bpm) : null;
      const heartRateAuthoritative = Boolean(
        heartRatePolicy && heartRatePolicy.authoritative === true,
      );
      updateSportsWorkoutExecutor(this.sportsWorkoutExecutor, snapshot, {
        maxHeartRateBpm,
        heartRateAuthoritative,
      });
      const hud = sportsWorkoutHud(this.sportsWorkoutExecutor, snapshot, {
        maxHeartRateBpm,
        heartRateAuthoritative,
      });
      this.commitRideHudRenderData({
        workoutStageVisible: hud.visible,
        workoutStageTitle: hud.title,
        workoutStageRemaining: hud.remaining,
        workoutStageTarget: hud.target,
      });
      const trained = nextSportsCoachCue(
        this.sportsCoachState,
        this.sportsWorkoutExecutor,
        snapshot,
        {
          now,
          maxHeartRateBpm,
          heartRateAuthoritative,
        },
      );
      this.sportsCoachState = trained.state;
      if (!trained.cue) return null;
      try { console.log('[AIBike Sports Coach] ' + trained.reason); } catch (_ignored) {}
      this.speakCue(trained.cue);
      return trained.cue;
    }
    const result = nextRideCoachCue(this.rideCoachState, snapshot, now);
    this.rideCoachState = result.state;
    if (!result.cue) return null;
    try {
      console.log('[AIBike Coach] CUE ' + result.cue);
    } catch (_ignored) {}
    this.speakCue(result.cue);
    return result.cue;
  },

  currentSportAgentStageId() {
    const executor = this.sportsWorkoutExecutor;
    if (!executor || !executor.plan || !Array.isArray(executor.plan.stages)) return '';
    const index = Math.max(0, Math.min(
      Number(executor.stageIndex) || 0,
      executor.plan.stages.length - 1,
    ));
    const stage = executor.plan.stages[index];
    return stage && typeof stage.stage_id === 'string' ? stage.stage_id : '';
  },

  queueSportAgentEvent(snapshot, now = Date.now(), requestedKind = 'snapshot') {
    const active = this.activeSportAgent;
    if (!active || !active.session || !active.identity || !snapshot) return false;
    const capturedAtMs = Number(now);
    if (!Number.isFinite(capturedAtMs)) return false;
    const stageId = this.currentSportAgentStageId();
    const stageChanged = stageId && stageId !== this.sportAgentLastStageId;
    const eventKind = requestedKind === 'snapshot' && stageChanged
      ? 'stage_change' : requestedKind;
    if (eventKind === 'snapshot' && this.sportAgentLastQueuedAtMs != null
        && capturedAtMs - this.sportAgentLastQueuedAtMs < SPORT_AGENT_EVENT_INTERVAL_MS) {
      return false;
    }
    const pending = readSportAgentOutbox(wx, active.identity);
    // Reserve one durable slot for completion even after a long offline ride.
    if (pending.length >= 299) return false;
    const seq = (Number(this.sportAgentSeq) || 0) + 1;
    const clientEventId = active.clientSessionId + '.evt.' + String(seq);
    const item = {
      kind: 'event',
      owner: active.identity,
      session_id: active.session.session_id,
      client_event_id: clientEventId,
      seq,
      event_kind: eventKind,
      captured_at_ms: Math.round(capturedAtMs),
      elapsed_s: Math.max(0, Math.round(Number(snapshot.elapsedMs || 0) / 1000)),
      ...(stageId ? { stage_id: stageId } : {}),
      metrics: buildSportAgentEventMetrics(snapshot),
    };
    const stored = enqueueSportAgentItem(wx, item, active.identity);
    const confirmed = !!stored && stored.some(
      (entry) => entry.kind === 'event' && entry.client_event_id === clientEventId,
    );
    if (!confirmed) return false;
    this.sportAgentSeq = seq;
    this.sportAgentLastQueuedAtMs = capturedAtMs;
    if (stageId) this.sportAgentLastStageId = stageId;
    return true;
  },

  tick(requestedAtMs = Date.now(), source = 'timer') {
    if (!this.canAcceptRideRuntimeData()) return null;
    const now = Number.isFinite(Number(requestedAtMs))
      ? Number(requestedAtMs) : Date.now();
    // 在可见 HUD 的任一真实事件入口复核传感器健康；
    // setInterval 被录屏压住时，Accelerometer/BLE 帧仍能救活停流 Gyroscope。
    this.ensureRideImuHealth(now);
    if (this.endArmedAtMs != null && now - this.endArmedAtMs > END_CONFIRM_WINDOW_MS) {
      this.endArmedAtMs = null;
      this.hudTouchTapAtMs = null;
      if (this.data.hudHint === '再按一次结束') this.setData({ hudHint: '' });
    }
    const snapshot = this.updateHudFromMetrics(now);
    this.evaluateRideSourceHealth(now, 'active');
    this.updateRideCoach(snapshot, now);
    this.queueSportAgentEvent(snapshot, now);
    this.captureCyclingTestSample(snapshot, now);
    this.captureCyclingLocalFieldSample(snapshot, now, source);
    return snapshot;
  },

  requestCyclingHermes(options) {
    // 运动会话业务边界：活动骑行内不发网络。即使旧补传 promise
    // 在开始骑行后才走到下一请求，这一层也会把它挡在 wx.request 之前。
    if (this.rideSessionActive === true || this.pageVisible !== true
        || this.pageUnloaded === true) {
      return Promise.resolve({ statusCode: 0, errMsg: 'ride active' });
    }
    const authorized = authorizeNetworkRequest(
      options,
      this.rideSettings || DEFAULT_BIKE_SETTINGS,
    );
    if (!authorized) {
      return Promise.resolve({ statusCode: 0, errMsg: 'offline policy' });
    }
    return new Promise((resolve) => {
      let settled = false;
      let task = null;
      const entry = { task: null, finish: null };
      if (!Array.isArray(this.cyclingHermesRequestEntries)) {
        this.cyclingHermesRequestEntries = [];
      }
      this.cyclingHermesRequestEntries.push(entry);
      const timeoutMs = Math.max(1000, Number(authorized.timeout) || 12000);
      const finish = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        const index = this.cyclingHermesRequestEntries.indexOf(entry);
        if (index >= 0) this.cyclingHermesRequestEntries.splice(index, 1);
        resolve(response || { statusCode: 0 });
      };
      entry.finish = finish;
      const watchdog = setTimeout(() => {
        try {
          if (task && typeof task.abort === 'function') task.abort();
        } catch (_error) {}
        finish({ statusCode: 0, errMsg: 'request timeout' });
      }, timeoutMs + 1000);
      try {
        task = wx.request({
          ...authorized,
          success(response) { finish(response); },
          fail(error) {
            finish({
              statusCode: 0,
              errMsg: String(error && error.errMsg ? error.errMsg : error || ''),
            });
          },
        });
        entry.task = task;
      } catch (error) {
        finish({
          statusCode: 0,
          errMsg: String(error && error.message ? error.message : error || ''),
        });
      }
    });
  },

  prewarmCyclingUploadAuth() {
    // 只在设备准备页预取低权限 token。失败不影响扫描、连接或开始骑行；
    // startRide 的同步网络硬门会中止尚未完成的请求，骑中绝不联网。
    if (this.pageVisible !== true || !this.isSearchPhase()
        || this.rideSessionActive === true || this.agentExitRequested) {
      return Promise.resolve(false);
    }
    if (this.cyclingUploadAuthFlight) return this.cyclingUploadAuthFlight;
    if (this.sportsIdentityRequestFlight) return this.sportsIdentityRequestFlight;
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    const flight = ensureCyclingUploadToken({
      storage: wx,
      request: (requestOptions) => this.requestCyclingHermes(requestOptions),
    }).then((auth) => {
      if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return false;
      if (!auth || auth.ready !== true || !auth.token) return false;
      const previous = this.sportsIdentity;
      const claimed = previous && isSportsAnonymousClaimTransition(previous, auth);
      let handshakeMigration = null;
      if (claimed) {
        migrateSportAgentOutboxForAnonymousClaim(wx, previous, auth);
        migrateSportAgentDebriefForAnonymousClaim(wx, previous, auth);
        handshakeMigration = migrateSportAgentHandshakeForAnonymousClaim(
          wx,
          previous,
          auth,
        );
        if (!handshakeMigration) {
          try {
            console.log('[AIBike Sport Agent] CLAIM_HANDSHAKE_FAIL_CLOSED');
          } catch (_ignored) {}
        }
      }
      this.sportsIdentity = auth;
      reconcileSportAgentHandshakeOwner(wx, auth);
      this.blockingSportAgentActive = readSportAgentActive(wx, auth);
      this.recoveredSportAgentPlan = recoverSportAgentPlannedPrestart(wx, auth);
      if (!previous || sameSportsOwner(previous, auth)) {
        this.sportsWorkoutEnvelope = readSportsWorkoutCache(wx, auth);
      } else {
        this.clearSportAgentDebriefPoll();
        this.sportsWorkoutEnvelope = null;
        this.pendingSportsPlan = null;
        this.pendingSportAgent = null;
        this.sportAgentPreparationGeneration =
          (this.sportAgentPreparationGeneration || 0) + 1;
      }
      this.syncSportsWorkoutMenu();
      return true;
    })
      .catch(() => false)
      .finally(() => {
        if (this.cyclingUploadAuthFlight === flight) {
          this.cyclingUploadAuthFlight = null;
        }
        if (this.sportsIdentityRequestFlight === flight) {
          this.sportsIdentityRequestFlight = null;
        }
      });
    this.cyclingUploadAuthFlight = flight;
    this.sportsIdentityRequestFlight = flight;
    return flight;
  },

  abortCyclingHermesRequests() {
    const entries = Array.isArray(this.cyclingHermesRequestEntries)
      ? this.cyclingHermesRequestEntries.splice(0) : [];
    for (let index = 0; index < entries.length; index += 1) {
      const task = entries[index] && entries[index].task;
      try {
        if (task && typeof task.abort === 'function') task.abort();
      } catch (_error) {}
      try {
        if (entries[index] && typeof entries[index].finish === 'function') {
          entries[index].finish({ statusCode: 0, errMsg: 'request aborted' });
        }
      } catch (_error) {}
    }
    return entries.length;
  },

  isHermesLifecycleCurrent(generation) {
    return this.pageVisible === true && this.pageUnloaded !== true
      && Number(generation) === Number(this.hermesLifecycleGeneration);
  },

  invalidateHermesLifecycle() {
    this.hermesLifecycleGeneration =
      (Number(this.hermesLifecycleGeneration) || 0) + 1;
    this.sportAgentPreparationGeneration =
      (Number(this.sportAgentPreparationGeneration) || 0) + 1;
    this.abortCyclingHermesRequests();
    // Promise 对象本身不可取消；移除共享引用，让下一次 show 只能创建
    // 属于新 generation 的 flight。旧 finally 采用同一对象比较，无法
    // 再清掉新的 flight。
    this.cyclingUploadFlight = null;
    this.cyclingUploadAuthFlight = null;
    this.sportsIdentityFlight = null;
    this.sportsIdentityRequestFlight = null;
    this.sportsWorkoutFlight = null;
    this.sportsOutboxFlight = null;
    this.sportAgentPreparationFlight = null;
    this.sportAgentOutboxFlight = null;
    this.sportAgentStartFlight = null;
    this.sportAgentStartPending = false;
    this.clearSportAgentDebriefPoll();
    return this.hermesLifecycleGeneration;
  },

  noteCyclingLocalFieldLogResult(result, operation = 'write') {
    if (result && result.ok === true) {
      return true;
    }
    this.localFieldLogWriteFailures =
      (Number(this.localFieldLogWriteFailures) || 0) + 1;
    const status = String(result && result.status || 'exception');
    const shouldLog = this.localFieldLogLastErrorStatus !== status
      || this.localFieldLogWriteFailures === 1
      || this.localFieldLogWriteFailures % 10 === 0;
    this.localFieldLogLastErrorStatus = status;
    if (shouldLog) {
      try {
        console.log('[AIBike LocalLog] WRITE_FAILED operation='
          + String(operation) + ' status=' + status
          + ' count=' + String(this.localFieldLogWriteFailures));
      } catch (_ignored) {}
    }
    return false;
  },

  runCyclingLocalFieldLogMutation(operation, mutate) {
    try {
      return this.noteCyclingLocalFieldLogResult(mutate(), operation);
    } catch (_error) {
      return this.noteCyclingLocalFieldLogResult(null, operation);
    }
  },

  recoverStaleCyclingLocalFieldLogs(now = Date.now()) {
    let indexResult = null;
    try { indexResult = readCyclingLocalFieldLogIndexResult(wx); } catch (_error) {}
    if (!indexResult || indexResult.ok !== true
        || !indexResult.index || !Array.isArray(indexResult.index.rides)) {
      if (indexResult && indexResult.ok === false) {
        this.noteCyclingLocalFieldLogResult(indexResult, 'recover-read');
      }
      return 0;
    }
    const active = indexResult.index.rides.filter(
      (ride) => ride && ride.status === 'active',
    );
    let recovered = 0;
    for (let position = 0; position < active.length; position += 1) {
      const ride = active[position];
      const endedAtMs = Math.max(
        Number(ride.started_at_ms) || 0,
        Number(now) || Date.now(),
      );
      this.runCyclingLocalFieldLogMutation('recover-lifecycle', () => (
        appendCyclingLocalLifecycleEvent(wx, ride.ride_id, {
          at_ms: endedAtMs,
          elapsed_ms: Number(ride.last_elapsed_ms) || 0,
          event: 'page_unloaded',
          reason: 'unload',
          sensor: 'runtime',
        })
      ));
      const summary = {
        elapsed_ms: Number(ride.last_elapsed_ms) || 0,
        distance_m: Number.isFinite(Number(ride.last_distance_m))
          ? Number(ride.last_distance_m) : undefined,
        distance_coverage_ms:
          Number.isFinite(Number(ride.last_distance_coverage_ms))
            ? Number(ride.last_distance_coverage_ms) : undefined,
        sample_count: Number(ride.sample_count) || 0,
      };
      if (this.runCyclingLocalFieldLogMutation('recover-abort', () => (
        finishCyclingLocalFieldLog(wx, ride.ride_id, {
          endedAtMs,
          aborted: true,
          summary,
        })
      ))) recovered += 1;
    }
    if (recovered > 0) {
      try {
        console.log('[AIBike LocalLog] RECOVERED_ABORTED count='
          + String(recovered));
      } catch (_ignored) {}
    }
    return recovered;
  },

  scheduleCyclingLocalFieldLogDiagnostics() {
    // Public builds never emit stored ride telemetry to logcat.
    return false;
  },

  replayCyclingLocalFieldLog() {
    return false;
  },

  startCyclingLocalFieldLogReplay() {
    return false;
  },

  beginCyclingLocalFieldCapture(startedAtMs, rideId) {
    if (!rideId || !Number.isFinite(Number(startedAtMs))) return false;
    this.localFieldLogRideId = String(rideId);
    this.localFieldLogStartedAtMs = Number(startedAtMs);
    this.localFieldLogBuffer = [];
    this.localFieldLogLastCapturedAtMs = null;
    this.localFieldLogFinished = false;
    this.localFieldLogFinishRetryCount = 0;
    if (this.localFieldLogFinishRetryTimer) {
      clearTimeout(this.localFieldLogFinishRetryTimer);
    }
    this.localFieldLogFinishRetryTimer = null;
    return this.runCyclingLocalFieldLogMutation('begin', () => (
      beginCyclingLocalFieldLog(wx, {
        rideId: this.localFieldLogRideId,
        startedAtMs: this.localFieldLogStartedAtMs,
      })
    ));
  },

  ensureCyclingLocalFieldCaptureStarted() {
    if (!this.localFieldLogRideId
        || !Number.isFinite(Number(this.localFieldLogStartedAtMs))) return false;
    return this.runCyclingLocalFieldLogMutation('ensure-begin', () => (
      beginCyclingLocalFieldLog(wx, {
        rideId: this.localFieldLogRideId,
        startedAtMs: this.localFieldLogStartedAtMs,
      })
    ));
  },

  cyclingLocalFieldTrigger(source, now = Date.now()) {
    if (['hrs', 'csc', 'cps', 'ftms', 'finish'].includes(source)) return source;
    if (source === 'timer') return 'ticker';
    if (source === 'orientation') return 'orientation';
    if (source === 'imu' || source === 'imu-frame') {
      const gyroFresh = Number.isFinite(Number(this.gyroscopeLastReadingAtMs))
        && now - Number(this.gyroscopeLastReadingAtMs) < IMU_STALL_TIMEOUT_MS;
      return gyroFresh ? 'gyroscope' : 'accelerometer';
    }
    return 'unknown';
  },

  cyclingLocalSensorState(value) {
    const state = String(value || 'idle');
    if (state === 'hidden') return 'paused';
    if (state === 'failed') return 'error';
    return state;
  },

  buildCyclingLocalFieldSample(snapshot, now = Date.now(), source = 'timer') {
    if (!snapshot) return null;
    const metrics = snapshot.metrics || {};
    const speed = metrics.speed || {};
    const cadence = metrics.cadence || {};
    const power = metrics.power || {};
    const heartRate = metrics.heartRate || {};
    const imu = snapshot.imuAssist || (this.imuClassifier
      ? this.imuClassifier.snapshot(now) : {}) || {};
    const awareness = snapshotAiuiWorldAwareness(
      this.worldAwarenessDiagnostics,
      now,
    );
    const tickGapMs = Number.isFinite(Number(this.lastRideTickAtMs))
      ? Math.max(0, now - Number(this.lastRideTickAtMs)) : 0;
    const sensorAge = (atMs) => atMs != null && Number.isFinite(Number(atMs))
      ? Math.max(0, now - Number(atMs)) : null;
    return {
      captured_at_ms: now,
      elapsed_ms: snapshot.elapsedMs,
      moving_ms: snapshot.movingMs,
      distance_coverage_ms: snapshot.distanceCoverageMs,
      distance_ever_available: snapshot.distanceEverAvailable === true,
      speed_kmh: metricValue(speed),
      cadence_rpm: metricValue(cadence),
      candidate_cadence_rpm: finiteNumber(imu.candidateCadenceRpm),
      distance_m: snapshot.distanceEverAvailable === true
        ? finiteNumber(snapshot.distanceM) : null,
      power_w: metricValue(power),
      heart_rate_bpm: metricValue(heartRate),
      final_speed_kmh: speed.source === 'imu' ? metricValue(speed) : null,
      effective_speed_kmh: finiteNumber(imu.estimatedSpeedKmh),
      raw_speed_kmh: finiteNumber(imu.rawEstimatedSpeedKmh),
      stabilized_speed_kmh: finiteNumber(imu.stabilizedSpeedKmh),
      final_cadence_rpm: finiteNumber(imu.finalCadenceRpm),
      effective_cadence_rpm: finiteNumber(imu.effectiveCadenceRpm),
      raw_cadence_rpm: finiteNumber(imu.rawEstimatedCadenceRpm),
      stabilized_cadence_rpm: finiteNumber(imu.stabilizedCadenceRpm),
      distance_ledger_eligible: imu.distanceLedgerEligible === true,
      simple_gyro_ledger_fresh: imu.simpleGyroLedgerFresh === true,
      simple_gyro_method: imu.simpleGyroCadenceMethod || 'none',
      simple_gyro_analysis: imu.simpleGyroAnalysisState || 'none',
      estimate_level: imu.cadenceEstimateLevel || 'none',
      estimate_usable: imu.availabilityCadenceUsable === true
        || imu.cadenceUsable === true,
      estimate_stabilized: imu.estimateStabilized === true,
      raw_artifact: imu.rawMotionArtifact || 'none',
      walking_like: imu.walkingLike === true,
      walking_confidence: finiteNumber(imu.walkingLikeConfidence),
      speed_profile: imu.speedEstimateProfile || 'unavailable',
      imu_motion_confidence: finiteNumber(imu.confidence),
      imu_cadence_confidence: finiteNumber(imu.cadenceConfidence),
      imu_cadence_correlation: finiteNumber(imu.cadenceCorrelation),
      reconnect_count: Number(this.reconnectCount) || 0,
      tick_gap_ms: tickGapMs,
      sensor_generation: Number(this.imuGeneration) || 0,
      imu_restart_count: Number(this.imuRestartCount) || 0,
      gyroscope_restart_count: Number(this.gyroscopeRestartCount) || 0,
      orientation_restart_count: 0,
      accelerometer_age_ms: sensorAge(this.imuLastReadingAtMs),
      gyroscope_age_ms: sensorAge(this.gyroscopeLastReadingAtMs),
      orientation_age_ms: sensorAge(this.orientationLastReadingAtMs),
      accelerometer_hz: finiteNumber(this.imuObservedHz),
      gyroscope_hz: finiteNumber(this.gyroscopeObservedHz),
      orientation_hz: finiteNumber(this.orientationObservedHz),
      accelerometer_frames: Number(this.imuReadingCount) || 0,
      gyroscope_frames: Number(this.gyroscopeReadingCount) || 0,
      orientation_frames: Number(this.orientationReadingCount) || 0,
      accelerometer_activated: this.accelerometerActivated === true,
      gyroscope_activated: this.gyroscopeActivated === true,
      orientation_activated: this.orientationActivated === true,
      orientation_stable: awareness.orientationStable,
      orientation_stability_age_ms: awareness.orientationStabilityAgeMs,
      orientation_stability_change_count:
        awareness.orientationStabilityChangeCount,
      head_gesture: awareness.headGesture,
      head_gesture_age_ms: awareness.headGestureAgeMs,
      head_gesture_count: awareness.headGestureCount,
      head_nod_count: awareness.headNodCount,
      head_shake_count: awareness.headShakeCount,
      world_awareness_state: awareness.state,
      paused: snapshot.paused === true,
      page_visible: this.pageVisible === true,
      imu_fresh: imu.fresh === true,
      speed_source: speed.source || 'none',
      cadence_source: cadence.source || 'none',
      power_source: power.source || 'none',
      heart_rate_source: heartRate.source || 'none',
      distance_source: snapshot.distanceSource || 'none',
      distance_mode: snapshot.distanceMode || 'none',
      speed_state: speed.state || 'unsupported',
      cadence_state: cadence.state || 'unsupported',
      power_state: power.state || 'unsupported',
      heart_rate_state: heartRate.state || 'unsupported',
      distance_state: snapshot.distanceState || 'unsupported',
      ble_state: this.cyclingBleState(),
      imu_motion_state: imu.motionState || 'unknown',
      imu_cadence_state: imu.cadenceState || 'warming',
      imu_quality_state: imu.motionQualityState || 'unavailable',
      imu_artifact: imu.motionArtifact || 'none',
      trigger: this.cyclingLocalFieldTrigger(source, now),
      accelerometer_state: this.cyclingLocalSensorState(this.imuDiagnosticState),
      gyroscope_state: this.cyclingLocalSensorState(
        this.gyroscopeDiagnosticState,
      ),
      orientation_state: this.cyclingLocalSensorState(
        this.orientationDiagnosticState,
      ),
    };
  },

  flushCyclingLocalFieldLogBuffer() {
    const buffer = Array.isArray(this.localFieldLogBuffer)
      ? this.localFieldLogBuffer.slice() : [];
    if (!buffer.length) return true;
    if (!this.ensureCyclingLocalFieldCaptureStarted()) return false;
    let result = null;
    try {
      result = appendCyclingLocalFieldSamples(
        wx,
        this.localFieldLogRideId,
        buffer,
      );
    } catch (_error) {}
    if (!this.noteCyclingLocalFieldLogResult(result, 'append-samples')) {
      return false;
    }
    this.localFieldLogBuffer = [];
    return true;
  },

  captureCyclingLocalFieldSample(
    snapshot,
    now = Date.now(),
    source = 'timer',
    force = false,
  ) {
    if (!this.localFieldLogRideId || !snapshot
        || this.localFieldLogFinished === true) return false;
    if (force !== true && this.localFieldLogLastCapturedAtMs != null
        && now - this.localFieldLogLastCapturedAtMs
          < CYCLING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) return false;
    const sample = this.buildCyclingLocalFieldSample(snapshot, now, source);
    if (!sample) return false;
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.flushCyclingLocalFieldLogBuffer();
    }
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.localFieldLogBuffer.shift();
    }
    this.localFieldLogBuffer.push(sample);
    this.localFieldLogLastCapturedAtMs = now;
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.flushCyclingLocalFieldLogBuffer();
    }
    return true;
  },

  recordCyclingLocalLifecycle(event, options = {}) {
    if (!this.localFieldLogRideId || this.localFieldLogFinished === true) return false;
    const now = Number.isFinite(Number(options.atMs))
      ? Number(options.atMs) : Date.now();
    let elapsedMs = Number(options.elapsedMs);
    if (!Number.isFinite(elapsedMs) && this.metrics
        && typeof this.metrics.elapsedMs === 'function') {
      elapsedMs = this.metrics.elapsedMs(now);
    }
    return this.runCyclingLocalFieldLogMutation('lifecycle-' + String(event), () => (
      appendCyclingLocalLifecycleEvent(wx, this.localFieldLogRideId, {
        at_ms: now,
        elapsed_ms: Math.max(0, Number(elapsedMs) || 0),
        event,
        reason: options.reason || 'unknown',
        sensor: options.sensor || 'runtime',
        generation: Number.isFinite(Number(options.generation))
          ? Number(options.generation) : Number(this.imuGeneration) || 0,
      })
    ));
  },

  recordCyclingLocalTts(status, options = {}) {
    if (!this.localFieldLogRideId || this.localFieldLogFinished === true) return false;
    const now = Number.isFinite(Number(options.atMs))
      ? Number(options.atMs) : Date.now();
    return this.runCyclingLocalFieldLogMutation('tts-' + String(status), () => (
      appendCyclingLocalTtsEvent(wx, this.localFieldLogRideId, {
        at_ms: now,
        elapsed_ms: this.metrics && typeof this.metrics.elapsedMs === 'function'
          ? this.metrics.elapsedMs(now) : 0,
        status,
        cue: options.cue || 'unknown',
        result: options.result || 'unknown',
        in_flight_ms: options.inFlightMs,
        stage_index: this.sportsWorkoutExecutor
          ? Number(this.sportsWorkoutExecutor.stageIndex) || 0 : undefined,
      })
    ));
  },

  recordCyclingLocalUpload(status, options = {}, rideId = '') {
    const targetRideId = rideId || this.localFieldLogRideId
      || this.lastCyclingUploadRideId || '';
    if (!targetRideId) return false;
    return this.runCyclingLocalFieldLogMutation('upload-' + String(status), () => (
      appendCyclingLocalUploadResult(wx, targetRideId, {
        at_ms: Date.now(),
        status,
        http_status: options.statusCode,
        acked: options.acked,
        pending: options.pending,
        quarantined: options.quarantined,
        request_count: options.requestCount,
        server_samples: options.serverSamples,
        finish_received: options.finishReceived,
        reason: options.reason || 'unknown',
        conflict_code: options.conflictCode,
      })
    ));
  },

  cyclingLocalUploadReason(statusCode, fallback = 'unknown') {
    const status = Number(statusCode) || 0;
    if (status === 401 || status === 403) return 'auth';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'server';
    if (status === 0 && fallback === 'pending') return 'network';
    const allowed = [
      'auth', 'network', 'rate_limit', 'server', 'storage', 'ack',
      'budget', 'conflict', 'unavailable', 'aborted', 'unknown',
    ];
    return allowed.includes(fallback) ? fallback : 'unknown';
  },

  finishCyclingLocalFieldCapture(summary, snapshot, endedAtMs, options = {}) {
    if (!this.localFieldLogRideId) return true;
    if (this.localFieldLogFinished === true) return true;
    if (snapshot) {
      this.captureCyclingLocalFieldSample(
        snapshot,
        endedAtMs,
        'finish',
        true,
      );
    }
    if (!this.flushCyclingLocalFieldLogBuffer()) return false;
    if (options.aborted !== true) {
      this.recordCyclingLocalLifecycle('summary_entered', {
        atMs: endedAtMs,
        elapsedMs: summary && summary.elapsedMs,
        reason: 'summary',
        sensor: 'runtime',
      });
    }
    const localSummary = summary ? {
      elapsed_ms: summary.elapsedMs,
      moving_ms: summary.movingMs,
      distance_m: summary.distanceM,
      distance_coverage_ms: snapshot && snapshot.distanceCoverageMs,
      avg_speed_kmh: summary.avgSpeedKmh,
      max_speed_kmh: summary.maxSpeedKmh,
      avg_cadence_rpm: summary.avgCadenceRpm,
      max_cadence_rpm: summary.maxCadenceRpm,
      avg_power_w: summary.avgPowerW,
      max_power_w: summary.maxPowerW,
      avg_heart_rate_bpm: summary.avgBpm,
      max_heart_rate_bpm: summary.maxBpm,
      sources: summary.sources,
      distance_sources: summary.distanceSources,
      cadence_sources: summary.cadenceSources,
    } : null;
    const completed = this.runCyclingLocalFieldLogMutation('finish', () => (
      finishCyclingLocalFieldLog(wx, this.localFieldLogRideId, {
        endedAtMs,
        aborted: options.aborted === true,
        summary: localSummary,
      })
    ));
    if (completed) this.localFieldLogFinished = true;
    return completed;
  },

  retryCyclingLocalFieldLogFinish(commit) {
    if (!commit || commit.localFieldLogSaved === true
        || this.localFieldLogFinished === true || this.pageUnloaded === true) {
      return false;
    }
    if (this.localFieldLogFinishRetryTimer) return true;
    if ((Number(this.localFieldLogFinishRetryCount) || 0) >= 5) return false;
    this.localFieldLogFinishRetryTimer = setTimeout(() => {
      this.localFieldLogFinishRetryTimer = null;
      this.localFieldLogFinishRetryCount =
        (Number(this.localFieldLogFinishRetryCount) || 0) + 1;
      commit.localFieldLogSaved = this.finishCyclingLocalFieldCapture(
        commit.summary,
        commit.snapshot,
        commit.endedAtMs,
      );
      if (!commit.localFieldLogSaved) {
        this.retryCyclingLocalFieldLogFinish(commit);
      }
    }, 1000);
    return true;
  },

  cyclingBleState() {
    if (this.connecting) return 'connecting';
    if (this.bleServer && this.bleServer.connected !== false) return 'connected';
    if (this.reconnectTimer || this.reconnectDeferred) return 'reconnecting';
    if (this.scanSession) return 'scanning';
    return 'idle';
  },

  buildCyclingTestSample(snapshot, now = Date.now()) {
    if (!snapshot) return null;
    const metrics = snapshot.metrics || {};
    const speed = metrics.speed || {};
    const cadence = metrics.cadence || {};
    const power = metrics.power || {};
    const heartRate = metrics.heartRate || {};
    const imu = this.imuClassifier
      ? this.imuClassifier.snapshot(now) : {};
    return {
      elapsed_ms: snapshot.elapsedMs,
      speed_kmh: metricValue(speed),
      cadence_rpm: metricValue(cadence),
      candidate_cadence_rpm: finiteNumber(imu.candidateCadenceRpm),
      distance_m: snapshot.distanceEverAvailable === true
        ? finiteNumber(snapshot.distanceM) : null,
      power_w: metricValue(power),
      heart_rate_bpm: metricValue(heartRate),
      imu_motion_confidence: finiteNumber(imu.confidence),
      imu_cadence_confidence: finiteNumber(imu.cadenceConfidence),
      imu_cadence_correlation: finiteNumber(imu.cadenceCorrelation),
      reconnect_count: Number(this.reconnectCount) || 0,
      paused: snapshot.paused === true,
      imu_fresh: imu.fresh === true,
      speed_source: speed.source || 'none',
      cadence_source: cadence.source || 'none',
      power_source: power.source || 'none',
      heart_rate_source: heartRate.source || 'none',
      distance_source: snapshot.distanceSource || 'none',
      distance_mode: snapshot.distanceMode || 'none',
      speed_state: speed.state || 'unsupported',
      cadence_state: cadence.state || 'unsupported',
      power_state: power.state || 'unsupported',
      heart_rate_state: heartRate.state || 'unsupported',
      distance_state: snapshot.distanceState || 'unsupported',
      ble_state: this.cyclingBleState(),
      imu_motion_state: imu.motionState || 'unknown',
      imu_cadence_state: imu.cadenceState || 'warming',
      imu_quality_state: imu.motionQualityState || 'unavailable',
      imu_artifact: imu.motionArtifact || 'none',
    };
  },

  flushCyclingUploadBuffer() {
    const buffer = Array.isArray(this.cyclingUploadBuffer)
      ? this.cyclingUploadBuffer.slice() : [];
    if (!buffer.length) return true;
    const queued = appendPendingCyclingUploadEvents(wx, buffer);
    if (!queued) return false;
    const ids = {};
    for (let index = 0; index < queued.length; index += 1) {
      ids[queued[index].event_id] = true;
    }
    if (!buffer.every((event) => ids[event.event_id])) return false;
    this.cyclingUploadBuffer = [];
    return true;
  },

  queueCyclingUploadEvent(event) {
    if (!event) return false;
    this.cyclingUploadBuffer.push(event);
    if (this.cyclingUploadBuffer.length >= CYCLING_UPLOAD_BUFFER_SAMPLES) {
      return this.flushCyclingUploadBuffer();
    }
    return true;
  },

  captureCyclingTestSample(snapshot, now = Date.now(), force = false) {
    if (!this.cyclingUploadSession || !snapshot) return false;
    const event = captureCyclingUploadSample(
      this.cyclingUploadSession,
      this.buildCyclingTestSample(snapshot, now),
      { capturedAtMs: now, force },
    );
    if (!event) return false;
    this.cyclingUploadSampleCount += 1;
    return this.queueCyclingUploadEvent(event);
  },

  flushCyclingTestUploads(options = {}) {
    if (this.rideSessionActive === true) {
      this.recordCyclingLocalUpload('deferred', {
        pending: readPendingCyclingUploadEvents(wx).length,
        reason: 'aborted',
      }, options.rideId || this.localFieldLogRideId || '');
      return Promise.resolve({
        status: 'deferred',
        acked: 0,
        pending: readPendingCyclingUploadEvents(wx).length,
      });
    }
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    if (this.cyclingUploadFlight) {
      const activeFlight = this.cyclingUploadFlight;
      if (options.updateSummary === true) {
        return activeFlight.then((upload) => {
          if (!this.isHermesLifecycleCurrent(lifecycleGeneration)) return upload;
          if (!readPendingCyclingUploadEvents(wx).length) {
            this.applyCyclingUploadSummary(upload, options.rideId || '');
            return upload;
          }
          return this.flushCyclingTestUploads(options);
        });
      }
      return activeFlight;
    }
    this.flushCyclingUploadBuffer();
    const rideId = options.rideId || '';
    const updateSummary = options.updateSummary === true;
    const flight = flushPendingCyclingUploads({
      storage: wx,
      request: (requestOptions) => this.requestCyclingHermes(requestOptions),
      priorityRideId: rideId,
      onProgress: (detail) => {
        if (!detail) return;
        const phase = String(detail.phase || '');
        if (rideId) {
          if (phase === 'uploading') {
            this.recordCyclingLocalUpload('uploading', {
              requestCount: detail.requestCount,
              reason: 'unknown',
            }, rideId);
          } else if (phase === 'acked') {
            this.recordCyclingLocalUpload('acked', {
              acked: detail.acked,
              pending: detail.pending,
              reason: 'ack',
            }, rideId);
          } else if (phase === 'retrying') {
            this.recordCyclingLocalUpload('pending', {
              statusCode: detail.statusCode,
              requestCount: detail.retryNumber,
              reason: this.cyclingLocalUploadReason(
                detail.statusCode,
                'pending',
              ),
            }, rideId);
          } else if (phase === 'rejected') {
            this.recordCyclingLocalUpload('rejected', {
              statusCode: detail.statusCode,
              quarantined: detail.count,
              reason: 'conflict',
              conflictCode: detail.conflictCode || 'permanent_rejection',
            }, rideId);
          }
        }
        if (phase !== 'rejected') return;
        try {
          console.log('[AIBike Hermes] REJECT code='
            + String(detail.conflictCode || 'permanent_rejection')
            + ' status=' + String(detail.statusCode || 0)
            + ' scope=' + String(detail.scope || 'event')
            + ' count=' + String(detail.count || 1));
        } catch (_error) {}
      },
    }).then((upload) => {
      const organized = (upload.organizedRides || []).find(
        (ride) => ride.test_ride_id === rideId,
      );
      if (rideId) {
        const finalStatus = upload.priorityRideQuarantined === true
          ? 'quarantined'
          : (upload.status === 'uploaded'
              || upload.status === 'uploaded_with_quarantine'
            ? 'acked' : (upload.status === 'empty' ? 'empty' : 'pending'));
        this.recordCyclingLocalUpload(finalStatus, {
          statusCode: upload.statusCode,
          acked: upload.acked,
          pending: upload.pending,
          quarantined: upload.quarantined,
          requestCount: upload.requestCount,
          serverSamples: organized && organized.samples,
          finishReceived: organized && organized.finish_received,
          reason: finalStatus === 'acked' ? 'ack'
            : this.cyclingLocalUploadReason(
              upload.statusCode,
              upload.reason || 'unknown',
            ),
        }, rideId);
      }
      if (updateSummary && this.isHermesLifecycleCurrent(lifecycleGeneration)) {
        this.applyCyclingUploadSummary(upload, rideId);
      }
      if (organized && organized.finish_received) {
        try {
          console.log('[AIBike Hermes] UPLOAD_OK ride='
            + organized.test_ride_id
            + ' samples=' + String(organized.samples)
            + ' acked=' + String(upload.acked));
        } catch (_error) {}
      }
      return upload;
    }).catch(() => {
      if (rideId) {
        this.recordCyclingLocalUpload('pending', {
          pending: readPendingCyclingUploadEvents(wx).length,
          reason: 'network',
        }, rideId);
      }
      if (updateSummary && this.isSummaryPhase()
          && this.isHermesLifecycleCurrent(lifecycleGeneration)) {
        this.setData({ summaryUploadText: '日志已保存 · 待补传' });
      }
      return {
        status: 'pending',
        acked: 0,
        pending: readPendingCyclingUploadEvents(wx).length,
      };
    }).finally(() => {
      if (this.cyclingUploadFlight === flight) this.cyclingUploadFlight = null;
    });
    this.cyclingUploadFlight = flight;
    return flight;
  },

  applyCyclingUploadSummary(upload, rideId = '') {
    if (!upload || !this.isSummaryPhase() || this.pageVisible !== true
        || this.pageUnloaded === true) return false;
    const organized = Array.isArray(upload.organizedRides)
      ? upload.organizedRides.find((ride) => ride.test_ride_id === rideId)
      : null;
    if (upload.priorityRideQuarantined === true) {
      this.setData({
        summaryUploadText: '本场日志冲突 · 已安全隔离',
      });
    } else if (organized && organized.finish_received) {
      this.setData({
        summaryUploadText: '测试日志已上传 · '
          + String(organized.samples) + ' 个采样',
      });
    } else if (upload.status === 'uploaded') {
      this.setData({
        summaryUploadText: '测试日志已上传 · '
          + String(upload.acked) + ' 条',
      });
    } else {
      this.setData({ summaryUploadText: '日志已保存 · 待补传' });
    }
    return true;
  },

  recordMinuteSpeed(snapshot, speed) {
    if (!snapshot || !(snapshot.elapsedMs > 0) || speed == null) return;
    const minute = Math.floor(snapshot.elapsedMs / 60000);
    if (minute <= 0 || minute <= this.lastMinuteSample) return;
    this.lastMinuteSample = minute;
    const series = this.minuteSeries.slice(-11);
    series.push({ minute, value: Number(speed.toFixed(1)) });
    this.minuteSeries = series;
  },

  formatRideImuStatus(imuRuntime, now = Date.now()) {
    const state = String(this.imuDiagnosticState || 'idle');
    const count = Math.max(0, Number(this.imuReadingCount) || 0);
    const gyroCount = Math.max(0, Number(this.gyroscopeReadingCount) || 0);
    const totalCount = count + gyroCount;
    const sensorText = count > 0 && gyroCount > 0
      ? '双 IMU 已就绪'
      : (count > 0 ? '加速度已就绪' : '陀螺仪已就绪');
    const hz = finiteNumber(this.imuObservedHz);
    if (state === 'unavailable') return '眼镜传感器不可用';
    if (state === 'failed' || state === 'start-failed' || state === 'error') {
      return '眼镜传感器恢复中';
    }
    if (state === 'restarting' || state === 'stalled') return 'IMU 恢复中';
    if (totalCount === 0) {
      const waitingMs = Number.isFinite(this.imuStartedAtMs)
        ? Math.max(0, now - this.imuStartedAtMs) : 0;
      return waitingMs >= 3000 ? 'IMU 恢复中' : 'IMU 准备中';
    }
    const artifact = imuRuntime && imuRuntime.motionArtifact;
    const heldCadence = finiteNumber(
      imuRuntime && imuRuntime.finalCadenceRpm,
    );
    if (imuRuntime && imuRuntime.simpleGyroDisplayHolding === true
        && heldCadence != null && Math.round(heldCadence) > 0) {
      return '陀螺仪 ' + String(Math.round(heldCadence))
        + 'rpm · 录屏掉帧保持';
    }
    if (artifact && artifact !== 'none') {
      const action = artifact === 'head_turn' ? '转头已过滤'
        : (artifact === 'touch' ? '触碰已过滤' : '晃动已过滤');
      return sensorText + ' · ' + action;
    }
    const candidate = finiteNumber(
      imuRuntime && imuRuntime.candidateCadenceRpm,
    );
    if (imuRuntime && imuRuntime.simpleGyroCadenceFresh === true
        && candidate != null && Math.round(candidate) > 0) {
      return '陀螺仪估算 ' + String(Math.round(candidate)) + 'rpm';
    }
    if (candidate != null && Math.round(candidate) > 0) {
      return '候选 ' + String(Math.round(candidate)) + 'rpm · 继续保持';
    }
    if (Number.isFinite(hz) && hz < IMU_MIN_RATE_HZ) {
      return 'IMU 采样偏低 · 自动恢复中';
    }
    if (count > 0 && imuRuntime && imuRuntime.accelerationCalibrated !== true) {
      return '加速度已就绪 · 踏频识别中';
    }
    if (count === 0 && gyroCount > 0) {
      return '陀螺仪已就绪 · 踏频识别中';
    }
    if (imuRuntime && imuRuntime.fresh === false) {
      return 'IMU 恢复中 · 距离已保留';
    }
    return sensorText + ' · 踏频识别中';
  },

  updateHudFromMetrics(now = Date.now()) {
    const snapshot = this.metrics ? this.metrics.snapshot(now) : null;
    if (!snapshot) return null;
    const speed = metricValue(snapshot.metrics && snapshot.metrics.speed);
    const cadence = metricValue(snapshot.metrics && snapshot.metrics.cadence);
    const power = metricValue(snapshot.metrics && snapshot.metrics.power);
    const heartRateMetric = snapshot.metrics && snapshot.metrics.heartRate
      ? snapshot.metrics.heartRate : {};
    const heartRate = metricValue(heartRateMetric);
    const recentHeartRate = this.recentHeartRateDisplay(now);
    const heldHeartRate = heartRate == null && recentHeartRate == null
      && this.heartRateEverLive && finiteNumber(this.lastHeartRateDisplayBpm) != null
      ? finiteNumber(this.lastHeartRateDisplayBpm) : null;
    const displayedHeartRate = heartRate != null
      ? heartRate : (recentHeartRate != null ? recentHeartRate : heldHeartRate);
    const heartRateHeld = heldHeartRate != null
      && heartRate == null && recentHeartRate == null;
    if (displayedHeartRate != null && displayedHeartRate > 0) {
      this.heartRateEverLive = true;
    }
    if (power != null) this.powerEverLive = true;
    this.recordMinuteSpeed(snapshot, speed);
    const distanceAvailable = snapshot.distanceEverAvailable === true;
    const source = snapshot.metrics && snapshot.metrics.speed
      ? snapshot.metrics.speed.source : '';
    const cadenceSource = snapshot.metrics && snapshot.metrics.cadence
      ? snapshot.metrics.cadence.source : '';
    const speedState = snapshot.metrics && snapshot.metrics.speed
      ? snapshot.metrics.speed.state : '';
    const cadenceState = snapshot.metrics && snapshot.metrics.cadence
      ? snapshot.metrics.cadence.state : '';
    const imuRuntime = this.imuClassifier
      ? this.imuClassifier.snapshot(now) : null;
    const filteringArtifact = imuRuntime
      && imuRuntime.motionArtifact
      && imuRuntime.motionArtifact !== 'none';
    const rolloutBlocked = Boolean(
      (snapshot.rollout && snapshot.rollout.suppressImu === true)
        || (snapshot.imuAssist && snapshot.imuAssist.suppressImu === true),
    );
    const fallbackCadence = finiteNumber(
      imuRuntime && imuRuntime.effectiveCadenceRpm,
    );
    const fallbackEstimateLevel = String(
      imuRuntime && imuRuntime.cadenceEstimateLevel || 'none',
    );
    const fallbackWalkingLike = Boolean(
      (imuRuntime && imuRuntime.walkingLike === true)
        || (snapshot.imuAssist && snapshot.imuAssist.walkingLike === true),
    );
    const fallbackAvailabilityUsable = Boolean(
      imuRuntime && imuRuntime.availabilityCadenceUsable === true,
    );
    // 低频 g 输入在最终锁定前会先形成经过多窗一致性门的高置信 candidate。
    // 该值只用于 HUD 提前显示，不进入 metrics、距离、总结或 Hermes；底层
    // availability/final 门仍决定是否真正入账。
    const displayCandidateUsable = Boolean(
      imuRuntime
        && imuRuntime.fresh === true
        && fallbackEstimateLevel === 'candidate'
        && fallbackCadence != null && fallbackCadence > 0
        && Number((imuRuntime.effectiveCadenceConfidence
          ?? imuRuntime.cadenceConfidence) || 0) >= 0.8
        && String(imuRuntime.cadenceSensorSource || 'none') !== 'none'
        && String(imuRuntime.motionArtifact || 'none') === 'none',
    );
    const displayAvailabilityUsable = fallbackAvailabilityUsable
      || displayCandidateUsable;
    const authoritativeSpeed = speed != null
      && source && source !== 'imu';
    const authoritativeCadence = cadence != null
      && cadenceSource && cadenceSource !== 'imu';
    const currentImuCadence = cadenceSource === 'imu'
      && cadence != null && cadence > 0 ? cadence : null;
    const currentImuSpeed = source === 'imu'
      && speed != null && speed > 0 ? speed : null;
    // 核心数字只读取 CyclingMetrics 的可信账本。分类器 candidate 仍可用于
    // “候选/识别中”状态文字，但不得绕过质量门直接成为 HUD 数值。
    const liveImuCadence = currentImuCadence;
    const liveImuSpeed = currentImuSpeed;
    const authoritativePositiveSpeed = Boolean(
      authoritativeSpeed && Number(speed) > 1.5,
    );
    const authoritativePositiveCadence = Boolean(
      authoritativeCadence && Number(cadence) > 0,
    );
    const imuStationary = Boolean(
      imuRuntime
        && imuRuntime.fresh === true
        && imuRuntime.motionState === 'stationary'
        && Number(imuRuntime.confidence || 0) >= 0.8
        && !(fallbackAvailabilityUsable
          && fallbackCadence != null && fallbackCadence > 0)
        && !authoritativePositiveSpeed
        && !authoritativePositiveCadence
        && !(Number(power) > 5),
    );
    const speedExplicitZero = speedState === 'explicit_zero';
    const cadenceExplicitZero = cadenceState === 'explicit_zero';
    // 本场出现过的可信显示只被新的可信数值推进。HUD 断流时依次使用
    // 本场真实均值和最后可信值；两级保持都只存在显示层，距离、总结与
    // Hermes 上传仍严格读取 metrics snapshot，绝不回写显示兜底。
    // 新的 explicit_zero / 高置信 stationary 会撤销相应保持；只有新的
    // 正向可信实时值才能重新打开，避免静止信号过期后旧均值再次弹回。
    const previousEstimate = { ...(this.lastLockedImuHudEstimate || {}) };
    const cadenceHoldRevokedNow = cadenceExplicitZero || imuStationary;
    const speedHoldRevokedNow = speedExplicitZero || imuStationary;
    if (cadenceHoldRevokedNow || speedHoldRevokedNow) {
      this.rideHudHiddenHoldPending = false;
    }
    if (cadenceHoldRevokedNow) {
      this.rideHudCadenceHoldRevoked = true;
      previousEstimate.cadenceRpm = null;
      previousEstimate.cadenceSource = '';
    }
    if (speedHoldRevokedNow) {
      this.rideHudSpeedHoldRevoked = true;
      previousEstimate.speedKmh = null;
      previousEstimate.speedSource = '';
    }
    if (previousEstimate.cadenceRpm == null && previousEstimate.speedKmh == null) {
      this.lastLockedImuHudEstimate = null;
    } else {
      this.lastLockedImuHudEstimate = previousEstimate;
    }
    const trustedCadence = !cadenceHoldRevokedNow
      && cadence != null && cadence > 0 ? cadence : null;
    const trustedSpeed = !speedHoldRevokedNow
      && speed != null && speed > 0 ? speed : null;
    if (trustedCadence != null) this.rideHudCadenceHoldRevoked = false;
    if (trustedSpeed != null) this.rideHudSpeedHoldRevoked = false;
    const nextTrustedCadence = trustedCadence != null
      ? trustedCadence : finiteNumber(previousEstimate.cadenceRpm);
    const nextTrustedSpeed = trustedSpeed != null
      ? trustedSpeed : finiteNumber(previousEstimate.speedKmh);
    if ((trustedCadence != null || trustedSpeed != null)
        && (nextTrustedCadence != null || nextTrustedSpeed != null)) {
      this.lastLockedImuHudEstimate = {
        cadenceRpm: nextTrustedCadence,
        speedKmh: nextTrustedSpeed,
        cadenceSource: trustedCadence != null
          ? (cadenceSource || 'imu') : String(previousEstimate.cadenceSource || ''),
        speedSource: trustedSpeed != null
          ? (source || 'imu') : String(previousEstimate.speedSource || ''),
        atMs: now,
      };
    }
    const heldEstimate = this.rideSessionActive
      && this.lastLockedImuHudEstimate
      ? this.lastLockedImuHudEstimate : null;
    const sessionAverageCadence = this.rideHudCadenceHoldRevoked !== true
      && finiteNumber(snapshot.avgCadenceRpm) > 0
      ? finiteNumber(snapshot.avgCadenceRpm) : null;
    const sessionAverageSpeed = this.rideHudSpeedHoldRevoked !== true
      && finiteNumber(snapshot.avgSpeedKmh) > 0
      ? finiteNumber(snapshot.avgSpeedKmh) : null;
    const heldCadence = this.rideHudCadenceHoldRevoked !== true
      && heldEstimate && finiteNumber(heldEstimate.cadenceRpm) > 0
      ? finiteNumber(heldEstimate.cadenceRpm) : null;
    const heldSpeed = this.rideHudSpeedHoldRevoked !== true
      && heldEstimate && finiteNumber(heldEstimate.speedKmh) > 0
      ? finiteNumber(heldEstimate.speedKmh) : null;
    const displayedCurrentImuCadence = this.rideHudCadenceHoldRevoked !== true
      ? liveImuCadence : null;
    const displayedCurrentImuSpeed = this.rideHudSpeedHoldRevoked !== true
      ? liveImuSpeed : null;
    const cadenceDisplayTier = cadenceHoldRevokedNow
      ? 'revoked'
      : ((authoritativeCadence || displayedCurrentImuCadence != null)
        ? 'current'
        : (sessionAverageCadence != null
          ? 'average' : (heldCadence != null ? 'last' : 'none')));
    const speedDisplayTier = speedHoldRevokedNow
      ? 'revoked'
      : ((authoritativeSpeed || displayedCurrentImuSpeed != null)
        ? 'current'
        : (sessionAverageSpeed != null
          ? 'average' : (heldSpeed != null ? 'last' : 'none')));
    const displayedCadence = cadenceHoldRevokedNow
      ? 0
      : (authoritativeCadence
      ? cadence
      : (displayedCurrentImuCadence != null
        ? displayedCurrentImuCadence
        : (sessionAverageCadence != null
          ? sessionAverageCadence : heldCadence)));
    const displayedSpeed = speedHoldRevokedNow
      ? 0
      : (authoritativeSpeed
      ? speed
      : (displayedCurrentImuSpeed != null
        ? displayedCurrentImuSpeed
        : (sessionAverageSpeed != null ? sessionAverageSpeed : heldSpeed)));
    const averageHoldActive = cadenceDisplayTier === 'average'
      || speedDisplayTier === 'average';
    const lastHoldActive = cadenceDisplayTier === 'last'
      || speedDisplayTier === 'last';
    const heldMetricActive = averageHoldActive || lastHoldActive;
    const simpleGyroEstimate = imuRuntime
      && (imuRuntime.simpleGyroDisplayFresh === true
        || imuRuntime.simpleGyroCadenceFresh === true)
      && !rolloutBlocked;
    const availabilityEstimate = imuRuntime
      && imuRuntime.fresh === true
      && imuRuntime.cadenceEstimateLevel === 'candidate'
      && displayAvailabilityUsable
      && fallbackCadence != null && fallbackCadence > 0
      && !rolloutBlocked;
    const activeSource = speed != null ? source : (cadence != null ? cadenceSource : '');
    const imuStatus = this.formatRideImuStatus(imuRuntime, now);
    const heldSource = heldEstimate
      ? (sourceLabel(heldEstimate.speedSource)
        || sourceLabel(heldEstimate.cadenceSource)
        || '本场数据') : '本场数据';
    const heldSourceShort = heldSource.includes('IMU') ? 'IMU' : heldSource;
    const explicitRideStateText = snapshot.paused === true
      ? '骑行已暂停 · 距离已保留'
      : (imuStationary || speedExplicitZero
        ? '当前静止 · 距离已保留'
        : (cadenceExplicitZero && Number(speed) > 1.5
          ? '滑行中 · 距离继续计算' : ''));
    const backgroundHoldText = averageHoldActive
      ? '后台保持·本场均值' : '后台保持·上次值';
    const neutralHoldText = averageHoldActive
      ? '本场数据 · 本场均值' : heldSourceShort + ' · 上次值';
    const heldDisplayText = this.rideHudHiddenHoldPending === true
      ? (averageHoldActive ? '本场数据' : heldSourceShort)
        + ' · ' + backgroundHoldText
      : neutralHoldText;
    const sourceText = explicitRideStateText || (heldMetricActive
      ? heldDisplayText
        : (fallbackWalkingLike
          ? '步行特征 · 保守运动估算'
          : (availabilityEstimate
          ? ((currentImuCadence != null || currentImuSpeed != null)
            ? '陀螺仪粗估 · 踏频/速度/距离'
            : '陀螺仪候选 · 继续稳定踩踏')
          : (filteringArtifact
        ? imuStatus
        : (rolloutBlocked
      ? '动作更像步行 · 稳定骑行后恢复'
          : (snapshot.distanceState === 'stale'
        && speed == null && cadence == null
        ? '距离已保留 · 数据恢复中'
        : (simpleGyroEstimate ? '陀螺仪估算 · 踏频/速度/距离' : '')
          || sourceLabel(activeSource)
          || (cadence == null ? imuStatus : '')
          || (
            snapshot.imuAssist && snapshot.imuAssist.fresh
              ? '请稳定踩踏约 5 秒'
              : (Object.keys(this.subscribedSources || {}).length
                ? '等待骑行数据'
                : '眼镜 IMU 等待中')
          )))))));
    const heartRateExpected = Boolean(
      this.heartRateExpected
        || this.subscribedSources.hrs
        || this.heartRateEverLive,
    );
    const heartRateStatus = heartRateHeld
      ? '心率恢复中'
      : (displayedHeartRate != null
      ? '心率实时'
      : (this.heartRateContactLostAtMs != null
        ? '心率未贴合'
        : (heartRateExpected
          ? (this.hasActiveSubscribedSource(['hrs', 'ftms'])
            ? '心率等待' : '心率重连')
          : '心率')));
    const heartRateMode = displayedHeartRate != null
      ? 'live'
      : (this.heartRateContactLostAtMs != null
        ? 'contact-lost'
        : (heartRateExpected
          ? (this.hasActiveSubscribedSource(['hrs', 'ftms'])
            ? 'waiting' : 'reconnecting')
          : 'idle'));
    const display = buildHudMetricDisplay({
      speedKmh: displayedSpeed,
      cadenceRpm: displayedCadence,
      distanceM: snapshot.distanceM,
      elapsedMs: snapshot.elapsedMs,
      heartRateBpm: displayedHeartRate,
      powerW: power,
      speedState,
      cadenceState,
      paused: snapshot.paused === true,
      stationary: imuStationary,
      moving: Number(speed) > 1.5 || Number(cadence) > 0,
      heartRateMode,
      powerEverLive: this.powerEverLive,
    });
    const zone = hrZone(
      displayedHeartRate || 0,
      Number((this.rideSettings || DEFAULT_BIKE_SETTINGS).maxHeartRateBpm),
    );
    this.commitRideHudRenderData({
      speed: display.speed,
      cadence: display.cadence,
      distance: display.distance,
      elapsed: display.elapsed,
      heartRate: display.heartRate,
      heartRateStatus,
      powerChipText: display.powerChipText,
      showHeartRate: heartRateExpected,
      showPower: display.showPower,
      cyclingSourceText: sourceText,
      hudEnvironment: formatHudClock(now),
      ...buildHudMetricClassFields(display),
      ...heartZoneDotFields(zone),
    });
    this.logHudDiagnostic(snapshot, now);
    return snapshot;
  },

  logHudDiagnostic(snapshot, now = Date.now()) {
    if (!snapshot || (this.lastHudDiagnosticAtMs != null
        && now - this.lastHudDiagnosticAtMs < HUD_DIAGNOSTIC_INTERVAL_MS)) return false;
    this.lastHudDiagnosticAtMs = now;
    const metricToken = (name) => {
      const metric = snapshot.metrics && snapshot.metrics[name];
      if (!metric) return name + '=none';
      return name + '=' + String(metric.source || 'none')
        + '/' + String(metric.state || 'unknown')
        + '/' + String(metric.ageMs == null ? '-' : Math.round(metric.ageMs));
    };
    const imu = snapshot.imuAssist || {};
    const rollout = snapshot.rollout || {};
    const imuQuality = this.imuClassifier
      ? this.imuClassifier.snapshot(now) : {};
    const awareness = snapshotAiuiWorldAwareness(
      this.worldAwarenessDiagnostics,
      now,
    );
    const bleState = this.connecting ? 'connecting'
      : this.bleServer && this.bleServer.connected !== false ? 'connected' : 'idle';
    try {
      console.log('[AIBike HUD] STATUS '
        + metricToken('speed') + ' '
        + metricToken('cadence') + ' '
        + metricToken('power') + ' '
        + metricToken('heartRate')
        + ' distance=' + Number(snapshot.distanceM || 0).toFixed(2)
        + '/' + String(snapshot.distanceMode || 'none')
        + '/' + String(snapshot.distanceState || 'unknown')
        + ' timeline=' + String(Math.round(Number(snapshot.elapsedMs || 0)))
        + '/' + String(Math.round(Number(snapshot.distanceCoverageMs || 0)))
        + ' ledger=' + String(imu.distanceLedgerEligible === true)
        + '/' + String(imu.simpleGyroLedgerFresh === true)
        + '/' + String(imu.simpleGyroCadenceMethod || 'none')
        + '/' + String(imu.simpleGyroAnalysisState || 'none')
        + '/' + String(imu.cadenceEstimateLevel || 'none')
        + '/' + String(imu.availabilityCadenceUsable === true)
        + '/' + String(imu.estimateStabilized === true)
        + ' rawArtifact=' + String(imu.rawMotionArtifact || 'none')
        + ' ble=' + bleState
        + ' reconnect=' + String(this.reconnectCount || 0)
        + ' imu=' + String(imu.motionState || 'unknown')
        + '/' + String(imu.fresh === true)
        + ' imuCadence=' + String(imu.candidateCadenceRpm == null
          ? '-' : Math.round(imu.candidateCadenceRpm))
        + '/' + String(imu.finalCadenceRpm == null
          ? '-' : Math.round(imu.finalCadenceRpm))
        + '/' + String(Number(imu.cadenceConfidence || 0).toFixed(2))
        + '/' + String(imu.cadenceState || 'unknown')
        + ' rollout=' + String(rollout.calibrationState || 'default')
        + '/' + String(Number(
          rollout.metersPerCrank || DEFAULT_BIKE_SETTINGS.imuMetersPerCrank,
        ).toFixed(2))
        + '/' + String(Number(rollout.confidence || 0).toFixed(2))
        + '/' + String(rollout.likelyWalk === true)
        + ' imuRuntime=' + String(this.imuDiagnosticState || 'unknown')
        + '/' + String(this.imuObservedHz == null
          ? '-' : Number(this.imuObservedHz).toFixed(1))
        + '/' + String(this.imuReadingCount || 0)
        + ' imuQuality=' + String(imuQuality.motionQualityState || 'unavailable')
        + '/' + String(imuQuality.motionArtifact || 'none')
        + '/' + String(Number(imuQuality.motionQualityScore || 0).toFixed(2))
        + ' imuWalk=' + String(imu.walkingLike === true)
        + '/' + String(Number(imu.walkingLikeConfidence || 0).toFixed(2))
        + '/' + String(imu.speedEstimateProfile || 'unavailable')
        + ' gyro=' + String(this.gyroscopeDiagnosticState || 'idle')
        + '/' + String(this.gyroscopeLastReadingAtMs == null
          ? '-' : Math.max(0, now - this.gyroscopeLastReadingAtMs))
        + '/' + String(this.gyroscopeReadingCount || 0)
        + ' gyroRate=' + String(this.gyroscopeObservedHz == null
          ? '-' : Number(this.gyroscopeObservedHz).toFixed(1))
        + ' sensorAccess=' + String(this.accelerometerActivated === true)
        + '/' + String(this.gyroscopeActivated === true)
        + ' orientation=' + String(this.orientationDiagnosticState || 'idle')
        + '/' + String(this.orientationLastReadingAtMs == null
          ? '-' : Math.max(0, now - this.orientationLastReadingAtMs))
        + '/' + String(this.orientationReadingCount || 0)
        + ' awareness=' + String(awareness.state)
        + '/' + String(awareness.orientationStable == null
          ? 'unknown' : awareness.orientationStable ? 'stable' : 'unstable')
        + '/' + String(awareness.headGesture || 'none')
        + '/' + String(awareness.headGestureCount || 0)
      );
      return true;
    } catch (_error) {
      return false;
    }
  },

  canRunRideImu() {
    return this.canAcceptRideRuntimeData()
      && !!this.metrics
      && this.metrics.paused !== true
      && this.agentExitRequested !== true;
  },

  ensureRideImuHealth(now = Date.now()) {
    if (this.pageVisible !== true || !this.canRunRideImu()) return false;
    const generation = this.imuGeneration;
    const gyroFresh = this.gyroscopeLastReadingAtMs != null
      && now - this.gyroscopeLastReadingAtMs < IMU_STALL_TIMEOUT_MS;
    const accelFresh = this.imuLastReadingAtMs != null
      && now - this.imuLastReadingAtMs < IMU_STALL_TIMEOUT_MS;
    let recoveryRequested = false;

    if (this.gyroscopeExpected === true) {
      const gyroFirstDeadline = Number.isFinite(this.gyroscopeResumeProbeAtMs)
        ? this.gyroscopeResumeProbeAtMs
        : (Number.isFinite(this.gyroscopeStartedAtMs)
          ? this.gyroscopeStartedAtMs + IMU_FIRST_READING_TIMEOUT_MS : now);
      const gyroMissing = !this.gyroscope;
      const gyroFirstFrameMissing = this.gyroscope
        && this.gyroscopeLastReadingAtMs == null && now >= gyroFirstDeadline;
      const gyroStalled = this.gyroscope
        && this.gyroscopeLastReadingAtMs != null
        && now - this.gyroscopeLastReadingAtMs >= IMU_STALL_TIMEOUT_MS;
      if (gyroMissing || gyroFirstFrameMissing || gyroStalled) {
        recoveryRequested = this.scheduleRideGyroscopeRestart(
          generation,
          gyroMissing ? 'visible-missing' : 'visible-stalled',
          { immediate: true },
        ) || recoveryRequested;
      }
    }

    if (this.accelerometer) {
      const accelFirstDeadline = Number.isFinite(this.imuResumeProbeAtMs)
        ? this.imuResumeProbeAtMs
        : (Number.isFinite(this.imuStartedAtMs)
          ? this.imuStartedAtMs + IMU_FIRST_READING_TIMEOUT_MS : now);
      const accelFirstFrameMissing = this.imuLastReadingAtMs == null
        && now >= accelFirstDeadline;
      const accelStalled = this.imuLastReadingAtMs != null
        && now - this.imuLastReadingAtMs >= IMU_STALL_TIMEOUT_MS;
      // Gyroscope 是无外设骑行的主证据。它仍健康时不为辅助 Accel 停流
      // 拆掉整套句柄；只有两路都失效才重建完整 bundle。
      if ((accelFirstFrameMissing || accelStalled) && !gyroFresh) {
        recoveryRequested = this.scheduleRideImuRestart(
          generation,
          accelFirstFrameMissing ? 'visible-accel-first-timeout' : 'visible-accel-stalled',
        ) || recoveryRequested;
      } else if ((accelFirstFrameMissing || accelStalled) && gyroFresh) {
        this.imuDiagnosticState = 'gyro-reading';
      }
    } else if (!this.gyroscope && !accelFresh
        && (typeof Accelerometer !== 'undefined'
          || typeof Gyroscope !== 'undefined')
        && !this.imuRestartTimer) {
      recoveryRequested = this.startRideImu({ restart: true, reason: 'visible-missing' })
        || recoveryRequested;
    }
    return recoveryRequested;
  },

  canAcceptRideRuntimeData() {
    // AIUI 0.15 的 setData 可能由宿主异步镜像；采集、通知和 ticker
    // 必须以同步会话状态为准。finishRideCommitted 会在总结首帧前同步置位，
    // 因而这里也不会把迟到回调写进总结。
    return this.rideSessionActive === true
      && this.finishRideCommitted !== true
      && !!this.metrics
      && this.agentExitRequested !== true
      && this.bleTerminated !== true;
  },

  canContinueRideInBackground() {
    // hidden 已先 pause；show 后才重新接纳回调。
    return this.canAcceptRideRuntimeData()
      && this.metrics.paused !== true
      && this.agentExitRequested !== true;
  },

  clearRideGyroscopeTimers() {
    if (this.gyroscopeWatchdogTimer) clearTimeout(this.gyroscopeWatchdogTimer);
    if (this.gyroscopeRestartTimer) clearTimeout(this.gyroscopeRestartTimer);
    this.gyroscopeWatchdogTimer = null;
    this.gyroscopeRestartTimer = null;
  },

  detachRideGyroscope(diagnosticState = 'stopped') {
    const gyro = this.gyroscope;
    if (gyro && this.metrics
        && typeof this.metrics.markImuDiscontinuity === 'function') {
      this.metrics.markImuDiscontinuity(Date.now());
    }
    this.clearRideGyroscopeTimers();
    this.gyroscope = null;
    this.gyroscopeClock = null;
    this.gyroscopeReadingCount = 0;
    this.gyroscopeLastReadingAtMs = null;
    this.gyroscopeLastRateAtMs = null;
    this.gyroscopeLastRateCount = 0;
    this.gyroscopeObservedHz = null;
    this.gyroscopeResumeProbeAtMs = null;
    this.gyroscopeActivated = false;
    this.gyroscopeStartedAtMs = null;
    this.gyroscopeDiagnosticState = diagnosticState;
    if (this.imuMotionQuality
        && typeof this.imuMotionQuality.dropGyro === 'function') {
      this.imuMotionQuality.dropGyro(Date.now());
    }
    try { if (gyro) gyro.stop(); } catch (_ignored) {}
    return !!gyro;
  },

  scheduleRideGyroscopeWatchdog(generation) {
    if (this.gyroscopeWatchdogTimer) clearTimeout(this.gyroscopeWatchdogTimer);
    this.gyroscopeWatchdogTimer = null;
    if (!this.gyroscope || this.imuGeneration !== generation
        || !this.canRunRideImu()) return false;
    const now = Date.now();
    const startedAtMs = Number.isFinite(this.gyroscopeStartedAtMs)
      ? this.gyroscopeStartedAtMs : now;
    const deadline = Number.isFinite(this.gyroscopeLastReadingAtMs)
      ? this.gyroscopeLastReadingAtMs + IMU_STALL_TIMEOUT_MS
      : (Number.isFinite(this.gyroscopeResumeProbeAtMs)
        ? this.gyroscopeResumeProbeAtMs
        : startedAtMs + IMU_FIRST_READING_TIMEOUT_MS);
    this.gyroscopeWatchdogTimer = setTimeout(() => {
      this.gyroscopeWatchdogTimer = null;
      if (!this.gyroscope || this.imuGeneration !== generation
          || !this.canRunRideImu()) return;
      const checkAt = Date.now();
      const firstMissing = this.gyroscopeLastReadingAtMs == null
        && checkAt >= (Number.isFinite(this.gyroscopeResumeProbeAtMs)
          ? this.gyroscopeResumeProbeAtMs
          : (Number.isFinite(this.gyroscopeStartedAtMs)
            ? this.gyroscopeStartedAtMs : checkAt) + IMU_FIRST_READING_TIMEOUT_MS);
      const stalled = Number.isFinite(this.gyroscopeLastReadingAtMs)
        && checkAt - this.gyroscopeLastReadingAtMs >= IMU_STALL_TIMEOUT_MS;
      if (!firstMissing && !stalled) {
        this.scheduleRideGyroscopeWatchdog(generation);
        return;
      }
      const reason = firstMissing
        ? 'gyro-first-reading-timeout'
        : 'gyro-reading-stalled';
      try {
        console.log('[AIBike IMU] GYRO_STALLED reason=' + reason
          + ' count=' + String(this.gyroscopeReadingCount || 0));
      } catch (_ignored) {}
      this.scheduleRideGyroscopeRestart(generation, reason);
    }, Math.max(250, deadline - now));
    return true;
  },

  scheduleRideGyroscopeRestart(generation, reason, options = {}) {
    if (this.imuGeneration !== generation || !this.canRunRideImu()
        || this.gyroscopeExpected !== true) return false;
    if (this.gyroscope) this.detachRideGyroscope('restarting');
    if (options.immediate === true) {
      if (this.gyroscopeRestartTimer) clearTimeout(this.gyroscopeRestartTimer);
      this.gyroscopeRestartTimer = null;
      const restarted = this.startRideGyroscope(generation);
      if (!restarted && !this.gyroscope && !this.gyroscopeRestartTimer) {
        return this.scheduleRideGyroscopeRestart(generation, reason);
      }
      return restarted;
    }
    if (this.gyroscopeRestartTimer) return true;
    const nextAttempt = Number(this.gyroscopeRestartCount || 0) + 1;
    this.gyroscopeRestartCount = Math.min(nextAttempt, 30);
    const backoffPower = Math.max(
      0,
      nextAttempt - IMU_RESTART_FAST_ATTEMPTS,
    );
    const retryDelayMs = Math.min(
      IMU_RESTART_MAX_DELAY_MS,
      IMU_RESTART_DELAY_MS * Math.pow(2, backoffPower),
    );
    this.gyroscopeDiagnosticState = 'restarting';
    this.gyroscopeRestartTimer = setTimeout(() => {
      this.gyroscopeRestartTimer = null;
      if (this.imuGeneration !== generation || !this.canRunRideImu()
          || this.gyroscopeExpected !== true || this.gyroscope) return;
      try {
        console.log('[AIBike IMU] GYRO_RESTART attempt='
          + String(nextAttempt) + ' reason=' + String(reason || 'unknown'));
      } catch (_ignored) {}
      const restarted = this.startRideGyroscope(generation);
      if (!restarted && !this.gyroscope && !this.gyroscopeRestartTimer) {
        this.scheduleRideGyroscopeRestart(
          generation,
          'start-unavailable',
        );
      }
    }, retryDelayMs);
    return true;
  },

  recordRideGyroscopeReading(now, generation) {
    if (this.imuGeneration !== generation || !this.canRunRideImu()) return;
    this.gyroscopeReadingCount = (Number(this.gyroscopeReadingCount) || 0) + 1;
    this.gyroscopeLastReadingAtMs = now;
    this.gyroscopeResumeProbeAtMs = null;
    if (this.gyroscopeReadingCount === 1) {
      this.gyroscopeLastRateAtMs = now;
      this.gyroscopeLastRateCount = 1;
      return;
    }
    const rateWindowMs = now - (Number.isFinite(this.gyroscopeLastRateAtMs)
      ? this.gyroscopeLastRateAtMs : now);
    if (rateWindowMs < HUD_DIAGNOSTIC_INTERVAL_MS) return;
    const sampleDelta = this.gyroscopeReadingCount
      - Number(this.gyroscopeLastRateCount || 0);
    this.gyroscopeObservedHz = sampleDelta * 1000 / rateWindowMs;
    this.gyroscopeLastRateAtMs = now;
    this.gyroscopeLastRateCount = this.gyroscopeReadingCount;
    try {
      console.log('[AIBike IMU] GYRO_RATE hz='
        + Number(this.gyroscopeObservedHz).toFixed(1)
        + ' samples=' + String(this.gyroscopeReadingCount)
        + ' activated=' + String(this.gyroscopeActivated === true));
    } catch (_ignored) {}
  },

  startRideGyroscope(generation) {
    if (this.gyroscope || !this.imuMotionQuality || !this.imuClassifier
        || !this.canRunRideImu() || this.imuGeneration !== generation) {
      return false;
    }
    this.gyroscopeExpected = typeof Gyroscope !== 'undefined';
    if (!this.gyroscopeExpected) {
      this.gyroscopeDiagnosticState = 'unsupported';
      try {
        console.log('[AIBike IMU] GYRO_UNAVAILABLE generation='
          + String(generation) + ' reason=api-missing');
      } catch (_ignored) {}
      return false;
    }

    if (this.gyroscopeRestartTimer) clearTimeout(this.gyroscopeRestartTimer);
    if (this.gyroscopeWatchdogTimer) clearTimeout(this.gyroscopeWatchdogTimer);
    this.gyroscopeRestartTimer = null;
    this.gyroscopeWatchdogTimer = null;
    let gyro = null;
    try {
      gyro = new Gyroscope({ frequency: GYRO_HZ });
      const clock = new SensorTimestampNormalizer({ frequency: GYRO_HZ });
      this.gyroscope = gyro;
      this.gyroscopeClock = clock;
      this.gyroscopeReadingCount = 0;
      this.gyroscopeLastReadingAtMs = null;
      this.gyroscopeLastRateAtMs = null;
      this.gyroscopeLastRateCount = 0;
      this.gyroscopeObservedHz = null;
      this.gyroscopeResumeProbeAtMs = null;
      this.gyroscopeActivated = false;
      this.gyroscopeStartedAtMs = Date.now();
      this.gyroscopeDiagnosticState = 'starting';
      gyro.addEventListener('activate', (event) => {
        if (this.gyroscope !== gyro || this.imuGeneration !== generation) return;
        this.gyroscopeActivated = true;
        try {
          console.log('[AIBike IMU] GYRO_ACTIVATED generation='
            + String(generation)
            + ' session=' + String(Boolean(event && event.sessionId))
            + ' activated=' + String(gyro.activated === true));
        } catch (_ignored) {}
      });
      gyro.addEventListener('reading', (event) => {
        if (this.gyroscope !== gyro
            || this.gyroscopeClock !== clock
            || this.imuGeneration !== generation
            || !this.canRunRideImu()
            || !this.imuMotionQuality
            || !this.imuClassifier) return;
        const eventReading = event && typeof event === 'object' ? event : {};
        const x = finiteNumber(eventReading.x) ?? finiteNumber(gyro.x);
        const y = finiteNumber(eventReading.y) ?? finiteNumber(gyro.y);
        const z = finiteNumber(eventReading.z) ?? finiteNumber(gyro.z);
        const timestamp = finiteNumber(eventReading.timestamp)
          ?? finiteNumber(gyro.timestamp);
        if (x == null || y == null || z == null) return;
        const now = Date.now();
        const activity = this.imuClassifier.onGyroscopeReading({
          x,
          y,
          z,
          timestamp,
        }, now);
        // liveness 必须记录所有合法 Gyroscope 帧，不能只记录恰好完成一次
        // 分类分析的帧；低帧率录屏否则会被误判为“零帧”并反复重建。
        this.recordRideGyroscopeReading(now, generation);
        if (this.gyroscopeReadingCount >= 3
            && now - Number(this.gyroscopeStartedAtMs || now) >= 1000) {
          this.gyroscopeRestartCount = 0;
        }
        if (!this.accelerometer) this.imuDiagnosticState = 'gyro-reading';
        if (this.gyroscopeDiagnosticState !== 'reading') {
          this.gyroscopeDiagnosticState = 'reading';
          try {
            console.log('[AIBike IMU] GYRO_FIRST_READING generation='
              + String(generation));
          } catch (_ignored) {}
        }
        if (activity) this.forwardRideImuActivity(activity, now);
        // 真实帧同时作为事件时钟入口；不生成任何运动数值。
        this.requestRideTick('imu-frame', now);
      });
      gyro.addEventListener('error', (error) => {
        if (this.gyroscope !== gyro || this.imuGeneration !== generation) return;
        this.detachRideGyroscope('error');
        if (!this.accelerometer) this.imuDiagnosticState = 'error';
        try {
          console.log('[AIBike IMU] GYRO_ERROR generation='
            + String(generation) + ' reason=' + this.bleErrorText(error));
        } catch (_ignored) {}
        this.scheduleRideGyroscopeRestart(generation, 'gyro-error');
      });
      gyro.start();
      if (this.gyroscope !== gyro || this.imuGeneration !== generation) {
        try { gyro.stop(); } catch (_ignored) {}
        return false;
      }
      this.gyroscopeDiagnosticState = 'started';
      this.scheduleRideGyroscopeWatchdog(generation);
      try {
        console.log('[AIBike IMU] GYRO_STARTED generation='
          + String(generation) + ' requestedHz=' + String(GYRO_HZ));
      } catch (_ignored) {}
      return true;
    } catch (error) {
      if (this.gyroscope === gyro) this.gyroscope = null;
      this.gyroscopeClock = null;
      this.gyroscopeLastRateAtMs = null;
      this.gyroscopeLastRateCount = 0;
      this.gyroscopeObservedHz = null;
      this.gyroscopeActivated = false;
      this.gyroscopeStartedAtMs = null;
      this.gyroscopeDiagnosticState = 'unavailable';
      if (this.imuMotionQuality
          && typeof this.imuMotionQuality.dropGyro === 'function') {
        this.imuMotionQuality.dropGyro(Date.now());
      }
      try { if (gyro) gyro.stop(); } catch (_ignored) {}
      try {
        console.log('[AIBike IMU] GYRO_UNAVAILABLE generation='
          + String(generation) + ' reason=' + this.bleErrorText(error));
      } catch (_ignored) {}
      this.scheduleRideGyroscopeRestart(generation, 'start-failed');
      return false;
    }
  },

  startRideWorldAwareness(generation) {
    this.worldAwarenessDiagnostics = enableAiuiWorldAwareness(
      this,
      this.worldAwarenessDiagnostics,
      { generation, now: Date.now() },
    );
    const snapshot = snapshotAiuiWorldAwareness(
      this.worldAwarenessDiagnostics,
      Date.now(),
    );
    try {
      console.log('[AIBike IMU] WORLD_AWARENESS state='
        + String(snapshot.state) + ' generation=' + String(generation));
    } catch (_ignored) {}
    return snapshot.enabled === true;
  },

  stopRideWorldAwareness(reason = 'stopped') {
    const before = snapshotAiuiWorldAwareness(
      this.worldAwarenessDiagnostics,
      Date.now(),
    );
    this.worldAwarenessDiagnostics = disableAiuiWorldAwareness(
      this,
      this.worldAwarenessDiagnostics,
      { now: Date.now() },
    );
    if (before.enabled) {
      try {
        console.log('[AIBike IMU] WORLD_AWARENESS_STOPPED reason='
          + String(reason));
      } catch (_ignored) {}
    }
    return before.enabled === true;
  },

  noteRideHeadGesture(event, generation = this.imuGeneration) {
    if (!this.canRunRideImu()) return false;
    const before = this.worldAwarenessDiagnostics;
    this.worldAwarenessDiagnostics = recordAiuiHeadGesture(before, event, {
      generation,
      now: Date.now(),
    });
    return this.worldAwarenessDiagnostics !== before;
  },

  noteRideOrientationStability(event, generation = this.imuGeneration) {
    if (!this.canRunRideImu()) return false;
    const before = this.worldAwarenessDiagnostics;
    this.worldAwarenessDiagnostics = recordAiuiOrientationStability(
      before,
      event,
      { generation, now: Date.now() },
    );
    return this.worldAwarenessDiagnostics !== before;
  },

  canAcceptRideWorldAwarenessPageEvent() {
    return this.canRunRideImu()
      && !!this.worldAwarenessDiagnostics
      && this.worldAwarenessDiagnostics.enabled === true
      && !!this.rideOrientationSensor
      && this.rideOrientationSensorOwned !== true
      && this.rideOrientationSensor === this.orientationSensor
      && (this.orientationActivated === true
        || Number(this.orientationReadingCount || 0) > 0);
  },

  // AIUI 0.16 page-level callbacks. These remain diagnostics only: they never
  // call the classifier, metrics, HUD, TTS, navigation or key handlers.
  onHeadGesture(event) {
    if (!this.canAcceptRideWorldAwarenessPageEvent()) return;
    this.noteRideHeadGesture(event, this.imuGeneration);
  },

  onOrientationStabilityChange(event) {
    if (!this.canAcceptRideWorldAwarenessPageEvent()) return;
    this.noteRideOrientationStability(event, this.imuGeneration);
  },

  removeRideOrientationListeners(orientation, listeners) {
    if (!orientation || !listeners
        || typeof orientation.removeEventListener !== 'function') return;
    for (const [type, listener] of Object.entries(listeners)) {
      try { orientation.removeEventListener(type, listener); } catch (_ignored) {}
    }
  },

  bindRideOrientationSensor(orientation, generation, options = {}) {
    const owned = options.owned === true;
    if (!orientation || typeof orientation.addEventListener !== 'function'
        || (!owned && typeof orientation.removeEventListener !== 'function')
        || !this.imuMotionQuality || !this.canRunRideImu()
        || this.imuGeneration !== generation) return false;
    const clock = new SensorTimestampNormalizer({
      frequency: ORIENTATION_HZ,
    });
    this.rideOrientationSensor = orientation;
    this.rideOrientationSensorOwned = owned;
    this.orientationClock = clock;
    this.orientationReadingCount = 0;
    this.orientationLastReadingAtMs = null;
    this.orientationLastRateAtMs = null;
    this.orientationLastRateCount = 0;
    this.orientationObservedHz = null;
    this.orientationActivated = orientation.activated === true;
    this.orientationDiagnosticState = 'starting';

    const onActivate = () => {
      if (this.rideOrientationSensor !== orientation
          || this.imuGeneration !== generation) return;
      this.orientationActivated = true;
    };
    const onReading = (event) => {
      if (this.rideOrientationSensor !== orientation
          || this.orientationClock !== clock
          || this.imuGeneration !== generation
          || !this.canRunRideImu()
          || !this.imuMotionQuality) return;
      const eventReading = event && typeof event === 'object' ? event : {};
      const eventQuaternion = eventReading.quaternion
        && typeof eventReading.quaternion.length === 'number'
        ? eventReading.quaternion
        : [eventReading.x, eventReading.y, eventReading.z, eventReading.w];
      const quaternion = eventQuaternion
        && eventQuaternion.length >= 4
        && Array.from(eventQuaternion).slice(0, 4).every(
          (value) => finiteNumber(value) != null,
        )
        ? Array.from(eventQuaternion).slice(0, 4).map(Number)
        : orientation.quaternion;
      if (!quaternion || typeof quaternion.length !== 'number'
          || quaternion.length < 4) return;
      const now = Date.now();
      const timestamp = finiteNumber(eventReading.timestamp)
        ?? finiteNumber(orientation.timestamp);
      const sampleAt = clock.normalize(timestamp, now);
      const accepted = this.imuMotionQuality.pushOrientation(
        quaternion,
        sampleAt,
      );
      if (!accepted || accepted.accepted !== true) return;
      this.orientationReadingCount += 1;
      this.orientationLastReadingAtMs = now;
      if (this.orientationReadingCount === 1) {
        this.orientationLastRateAtMs = now;
        this.orientationLastRateCount = 1;
      } else {
        const rateWindowMs = now
          - (Number.isFinite(this.orientationLastRateAtMs)
            ? this.orientationLastRateAtMs : now);
        if (rateWindowMs >= HUD_DIAGNOSTIC_INTERVAL_MS) {
          const sampleDelta = this.orientationReadingCount
            - Number(this.orientationLastRateCount || 0);
          this.orientationObservedHz = sampleDelta * 1000 / rateWindowMs;
          this.orientationLastRateAtMs = now;
          this.orientationLastRateCount = this.orientationReadingCount;
        }
      }
      if (this.orientationDiagnosticState !== 'reading') {
        this.orientationDiagnosticState = 'reading';
        try {
          console.log('[AIBike IMU] ORIENTATION_FIRST_READING generation='
            + String(generation));
        } catch (_ignored) {}
      }
    };
    const onStability = (event) => {
      if (this.rideOrientationSensor !== orientation
          || this.imuGeneration !== generation
          || (this.orientationActivated !== true
            && Number(this.orientationReadingCount || 0) <= 0)) return;
      this.noteRideOrientationStability(event, generation);
    };
    const onError = (error) => {
      if (this.rideOrientationSensor !== orientation
          || this.imuGeneration !== generation) return;
      const wasOwned = this.rideOrientationSensorOwned === true;
      const listeners = this.rideOrientationListeners;
      this.removeRideOrientationListeners(orientation, listeners);
      this.rideOrientationSensor = null;
      this.rideOrientationSensorOwned = false;
      this.rideOrientationListeners = null;
      this.orientationClock = null;
      this.orientationActivated = false;
      this.orientationDiagnosticState = 'error';
      if (this.imuMotionQuality
          && typeof this.imuMotionQuality.dropOrientation === 'function') {
        this.imuMotionQuality.dropOrientation(Date.now());
      }
      if (wasOwned) {
        try { orientation.stop(); } catch (_ignored) {}
      } else {
        this.stopRideWorldAwareness('orientation-error');
      }
      try {
        console.log('[AIBike IMU] ORIENTATION_ERROR generation='
          + String(generation) + ' reason=' + this.bleErrorText(error));
      } catch (_ignored) {}
    };
    const listeners = {
      activate: onActivate,
      reading: onReading,
      error: onError,
    };
    // 0.15 legacy sensors may reject an unknown 0.16 event name. Only the
    // World Awareness managed instance receives the new stability listener.
    if (!owned) listeners.orientationstabilitychange = onStability;
    this.rideOrientationListeners = listeners;
    try {
      for (const [type, listener] of Object.entries(listeners)) {
        orientation.addEventListener(type, listener);
      }
      if (owned) orientation.start();
      if (this.rideOrientationSensor !== orientation
          || this.imuGeneration !== generation) {
        this.removeRideOrientationListeners(orientation, listeners);
        if (owned) {
          try { orientation.stop(); } catch (_ignored) {}
        }
        return false;
      }
      this.orientationDiagnosticState = 'started';
      try {
        console.log('[AIBike IMU] ORIENTATION_STARTED generation='
          + String(generation) + ' requestedHz=' + String(ORIENTATION_HZ)
          + ' owner=' + String(owned ? 'page' : 'world-awareness'));
      } catch (_ignored) {}
      return true;
    } catch (error) {
      this.removeRideOrientationListeners(orientation, listeners);
      if (this.rideOrientationSensor === orientation) {
        this.rideOrientationSensor = null;
      }
      this.rideOrientationSensorOwned = false;
      this.rideOrientationListeners = null;
      this.orientationClock = null;
      this.orientationActivated = false;
      this.orientationDiagnosticState = 'unavailable';
      if (this.imuMotionQuality
          && typeof this.imuMotionQuality.dropOrientation === 'function') {
        this.imuMotionQuality.dropOrientation(Date.now());
      }
      if (owned) {
        try { orientation.stop(); } catch (_ignored) {}
      } else {
        this.stopRideWorldAwareness('orientation-bind-failed');
      }
      try {
        console.log('[AIBike IMU] ORIENTATION_UNAVAILABLE generation='
          + String(generation) + ' reason=' + this.bleErrorText(error));
      } catch (_ignored) {}
      return false;
    }
  },

  startRideAuxImuSensors(generation) {
    if (!this.imuMotionQuality || !this.canRunRideImu()
        || this.imuGeneration !== generation) return false;

    this.startRideGyroscope(generation);
    const awarenessEnabled = this.startRideWorldAwareness(generation);
    if (awarenessEnabled) {
      const managedOrientation = this.orientationSensor;
      if (managedOrientation
          && typeof managedOrientation.addEventListener === 'function'
          && typeof managedOrientation.removeEventListener === 'function') {
        this.bindRideOrientationSensor(managedOrientation, generation, {
          owned: false,
        });
      } else {
        // The 0.16 contract says the page sensor is present synchronously after
        // enable. Fail closed for this generation instead of creating a second
        // sensor that could race a late host-owned instance.
        this.orientationDiagnosticState = 'unavailable';
        this.stopRideWorldAwareness('orientation-missing');
        try {
          console.log('[AIBike IMU] ORIENTATION_UNAVAILABLE generation='
            + String(generation) + ' reason=world-awareness-sensor-missing');
        } catch (_ignored) {}
      }
    } else if (typeof AbsoluteOrientationSensor === 'undefined') {
      this.orientationDiagnosticState = 'unsupported';
      try {
        console.log('[AIBike IMU] ORIENTATION_UNAVAILABLE generation='
          + String(generation) + ' reason=api-missing');
      } catch (_ignored) {}
    } else if (this.worldAwarenessDiagnostics
        && this.worldAwarenessDiagnostics.supported === true) {
      // A 0.16 host that throws during enable may still create its managed
      // sensor later. Do not start a competing manual instance.
      this.orientationDiagnosticState = 'unavailable';
      this.stopRideWorldAwareness('enable-failed');
    } else {
      let orientation = null;
      try {
        orientation = new AbsoluteOrientationSensor({ frequency: ORIENTATION_HZ });
        this.bindRideOrientationSensor(orientation, generation, { owned: true });
      } catch (error) {
        this.orientationDiagnosticState = 'unavailable';
        if (this.imuMotionQuality
            && typeof this.imuMotionQuality.dropOrientation === 'function') {
          this.imuMotionQuality.dropOrientation(Date.now());
        }
        try { if (orientation) orientation.stop(); } catch (_ignored) {}
        try {
          console.log('[AIBike IMU] ORIENTATION_UNAVAILABLE generation='
            + String(generation) + ' reason=' + this.bleErrorText(error));
        } catch (_ignored) {}
      }
    }
    return !!(this.gyroscope || this.rideOrientationSensor);
  },

  clearRideImuTimers() {
    if (this.imuWatchdogTimer) clearTimeout(this.imuWatchdogTimer);
    if (this.imuRestartTimer) clearTimeout(this.imuRestartTimer);
    this.imuWatchdogTimer = null;
    this.imuRestartTimer = null;
    this.clearRideGyroscopeTimers();
  },

  scheduleRideImuWatchdog(generation) {
    if (this.imuWatchdogTimer) clearTimeout(this.imuWatchdogTimer);
    this.imuWatchdogTimer = null;
    if (!this.accelerometer || this.imuGeneration !== generation
        || !this.canRunRideImu()) return false;
    const now = Date.now();
    const startedAtMs = Number.isFinite(this.imuStartedAtMs)
      ? this.imuStartedAtMs : now;
    const deadline = Number.isFinite(this.imuFirstReadingAtMs)
      ? this.imuLastReadingAtMs + IMU_STALL_TIMEOUT_MS
      : (Number.isFinite(this.imuResumeProbeAtMs)
        ? this.imuResumeProbeAtMs
        : startedAtMs + IMU_FIRST_READING_TIMEOUT_MS);
    const delayMs = Math.max(250, deadline - now);
    this.imuWatchdogTimer = setTimeout(() => {
      this.imuWatchdogTimer = null;
      if (!this.accelerometer || this.imuGeneration !== generation
          || !this.canRunRideImu()) return;
      const checkAt = Date.now();
      const sensorStartedAtMs = Number.isFinite(this.imuStartedAtMs)
        ? this.imuStartedAtMs : checkAt;
      const firstMissing = this.imuFirstReadingAtMs == null
        && checkAt >= (Number.isFinite(this.imuResumeProbeAtMs)
          ? this.imuResumeProbeAtMs
          : sensorStartedAtMs + IMU_FIRST_READING_TIMEOUT_MS);
      const stalled = Number.isFinite(this.imuLastReadingAtMs)
        && checkAt - this.imuLastReadingAtMs >= IMU_STALL_TIMEOUT_MS;
      if (!firstMissing && !stalled) {
        this.scheduleRideImuWatchdog(generation);
        return;
      }
      const reason = firstMissing
        ? 'accel-first-reading-timeout'
        : 'accel-reading-stalled';
      this.imuDiagnosticState = 'stalled';
      try {
        console.log('[AIBike IMU] ACCEL_STALLED reason=' + reason
          + ' count=' + String(this.imuReadingCount || 0));
      } catch (_ignored) {}
      this.scheduleRideImuRestart(generation, reason);
    }, delayMs);
    return true;
  },

  recordRideImuReading(now, generation) {
    if (this.imuGeneration !== generation || !this.canRunRideImu()) return;
    this.imuReadingCount = (Number(this.imuReadingCount) || 0) + 1;
    this.imuLastReadingAtMs = now;
    this.imuResumeProbeAtMs = null;
    if (this.imuFirstReadingAtMs == null) {
      this.imuFirstReadingAtMs = now;
      this.imuLastRateAtMs = now;
      this.imuLastRateCount = this.imuReadingCount;
      this.imuDiagnosticState = 'reading';
      try { console.log('[AIBike IMU] ACCEL_FIRST_READING'); } catch (_ignored) {}
      return;
    }
    const rateWindowMs = now - (Number.isFinite(this.imuLastRateAtMs)
      ? this.imuLastRateAtMs : now);
    if (rateWindowMs < HUD_DIAGNOSTIC_INTERVAL_MS) return;
    const sampleDelta = this.imuReadingCount - Number(this.imuLastRateCount || 0);
    this.imuObservedHz = sampleDelta * 1000 / rateWindowMs;
    this.imuLastRateAtMs = now;
    this.imuLastRateCount = this.imuReadingCount;
    try {
      console.log('[AIBike IMU] ACCEL_RATE hz='
        + Number(this.imuObservedHz).toFixed(1)
        + ' samples=' + String(this.imuReadingCount));
    } catch (_ignored) {}
    if (this.imuObservedHz < IMU_MIN_RATE_HZ) {
      this.imuLowRateWindowCount = (Number(this.imuLowRateWindowCount) || 0) + 1;
      const gyroFresh = this.gyroscopeLastReadingAtMs != null
        && now - this.gyroscopeLastReadingAtMs < IMU_STALL_TIMEOUT_MS;
      this.imuDiagnosticState = gyroFresh ? 'gyro-reading' : 'low-rate';
      try {
        console.log('[AIBike IMU] ACCEL_LOW_RATE hz='
          + Number(this.imuObservedHz).toFixed(1)
          + ' windows=' + String(this.imuLowRateWindowCount));
      } catch (_ignored) {}
      if (!gyroFresh && (this.imuObservedHz < IMU_CRITICAL_RATE_HZ
          || this.imuLowRateWindowCount >= IMU_LOW_RATE_WINDOWS)) {
        this.scheduleRideImuRestart(generation, 'low-sample-rate');
      }
      return;
    }
    this.imuLowRateWindowCount = 0;
    this.imuDiagnosticState = 'reading';
    this.imuRestartCount = 0;
  },

  scheduleRideImuRestart(generation, reason) {
    if (this.imuGeneration !== generation || !this.canRunRideImu()) return false;
    const nextAttempt = Number(this.imuRestartCount || 0) + 1;
    this.stopRideImu({ preserveRestartCount: true, diagnosticState: 'restarting' });
    if (!this.canAcceptRideRuntimeData()) return false;
    this.imuRestartCount = Math.min(nextAttempt, 30);
    const backoffPower = Math.max(
      0,
      nextAttempt - IMU_RESTART_FAST_ATTEMPTS,
    );
    const retryDelayMs = Math.min(
      IMU_RESTART_MAX_DELAY_MS,
      IMU_RESTART_DELAY_MS * Math.pow(2, backoffPower),
    );
    const stoppedGeneration = this.imuGeneration;
    this.imuRestartTimer = setTimeout(() => {
      this.imuRestartTimer = null;
      if (this.imuGeneration !== stoppedGeneration || !this.canRunRideImu()) return;
      try {
        console.log('[AIBike IMU] ACCEL_RESTART attempt=' + String(nextAttempt)
          + ' reason=' + String(reason));
      } catch (_ignored) {}
      this.startRideImu({ restart: true });
    }, retryDelayMs);
    return true;
  },

  createRideImuAnalysis(startedAt) {
    this.imuMotionQuality = new CyclingMotionQualityGate({
      minSampleRateHz: IMU_MIN_RATE_HZ,
    });
    this.imuClassifier = new CyclingImuActivity({
      startMs: startedAt,
      sampleHz: IMU_HZ,
      gyroscopeSampleHz: GYRO_HZ,
      minEffectiveSampleHz: IMU_MIN_RATE_HZ,
      cadenceAnalysisIntervalMs: 500,
      motionQualityGate: this.imuMotionQuality,
      metersPerCrank: (this.rideSettings || DEFAULT_BIKE_SETTINGS)
        .imuMetersPerCrank,
      accelerationCalibration: {
        windowMs: 1200,
        minWindowMs: 700,
        minSamples: 6,
      },
    });
    return this.imuClassifier;
  },

  startRideImu(_options = {}) {
    if (this.accelerometer || this.gyroscope) return false;
    if (!this.canRunRideImu()) return false;
    this.clearRideImuTimers();
    this.clearRideImuMetricsPending();
    this.gyroscopeExpected = typeof Gyroscope !== 'undefined';
    const generation = (Number(this.imuGeneration) || 0) + 1;
    this.imuGeneration = generation;
    const startedAt = Date.now();
    this.imuStartedAtMs = startedAt;
    this.imuFirstReadingAtMs = null;
    this.imuLastReadingAtMs = null;
    this.imuReadingCount = 0;
    this.imuLastRateAtMs = startedAt;
    this.imuLastRateCount = 0;
    this.imuObservedHz = null;
    this.imuResumeProbeAtMs = null;
    this.imuLowRateWindowCount = 0;
    this.accelerometerActivated = false;
    this.lastImuMetricsForwardAtMs = null;
    this.lastImuMetricsSignature = '';
    this.imuDiagnosticState = 'starting';
    this.createRideImuAnalysis(startedAt);

    let sensor = null;
    let accelerometerStarted = false;
    const accelerometerAvailable = typeof Accelerometer !== 'undefined';
    if (!accelerometerAvailable) {
      try { console.log('[AIBike IMU] ACCEL_UNAVAILABLE'); } catch (_ignored) {}
    } else {
      try {
        sensor = new Accelerometer({ frequency: IMU_HZ });
        sensor.addEventListener('activate', (event) => {
          if (this.accelerometer !== sensor
              || this.imuGeneration !== generation) return;
          this.accelerometerActivated = true;
          try {
            console.log('[AIBike IMU] ACCEL_ACTIVATED generation='
              + String(generation)
              + ' session=' + String(Boolean(event && event.sessionId))
              + ' activated=' + String(sensor.activated === true));
          } catch (_ignored) {}
        });
        sensor.addEventListener('reading', (event) => {
          if (this.accelerometer !== sensor
              || this.imuGeneration !== generation
              || !this.canRunRideImu()
              || !this.imuClassifier) return;
          const now = Date.now();
          // AIUI 0.15 reading 事件可直接携带三轴与时间戳；部分宿主同时
          // 更新 sensor 属性，部分只填事件。事件优先并保留属性兼容回退。
          const eventReading = event && typeof event === 'object' ? event : {};
          const x = finiteNumber(eventReading.x) ?? finiteNumber(sensor.x);
          const y = finiteNumber(eventReading.y) ?? finiteNumber(sensor.y);
          const z = finiteNumber(eventReading.z) ?? finiteNumber(sensor.z);
          const timestamp = finiteNumber(eventReading.timestamp)
            ?? finiteNumber(sensor.timestamp);
          const readingValid = x != null && y != null && z != null;
          if (!readingValid) return;
          const activity = this.imuClassifier.onReading({
            x,
            y,
            z,
            timestamp,
          }, now);
          this.recordRideImuReading(now, generation);
          if (this.accelerometer !== sensor || this.imuGeneration !== generation
              || !this.canRunRideImu()) return;
          if (activity) {
            // 首个可信候选就作为有明确来源文字的骑行场景估算进入 HUD；严格 final 仍在
            // 后台继续稳定，不再让用户面对一个无解释的空值。稳态快照在
            // forwardRideImuActivity 的 250ms 边界合并，上面的分类器仍逐帧
            // 接收原始三轴输入。
            this.forwardRideImuActivity(activity, now);
          }
          // Gyroscope 是主刷新时钟。它健康时 Accelerometer 只补充
          // 分类器，不重复触发 HUD；无 Gyroscope 或 Gyroscope 停流
          // 时才用 Accel 帧救活统一 500ms 门。
          const gyroReferenceAtMs = Number.isFinite(this.gyroscopeLastReadingAtMs)
            ? this.gyroscopeLastReadingAtMs : this.gyroscopeStartedAtMs;
          const gyroFresh = !!(
            this.gyroscope
            && Number.isFinite(gyroReferenceAtMs)
            && now - gyroReferenceAtMs < IMU_STALL_TIMEOUT_MS
          );
          if (!gyroFresh) this.requestRideTick('imu-frame', now);
        });
        sensor.addEventListener('error', (error) => {
          if (this.accelerometer !== sensor
              || this.imuGeneration !== generation) return;
          this.imuDiagnosticState = 'error';
          try {
            console.log('[AIBike IMU] ACCEL_ERROR reason='
              + this.bleErrorText(error));
          } catch (_ignored) {}
          // 运行时错误重建完整 bundle，避免 accelerometer 永久缺失。
          this.scheduleRideImuRestart(generation, 'sensor-error');
        });
        this.accelerometer = sensor;
        sensor.start();
        if (this.accelerometer !== sensor || this.imuGeneration !== generation) {
          try { sensor.stop(); } catch (_ignored) {}
          this.accelerometer = null;
        } else {
          accelerometerStarted = true;
        }
      } catch (error) {
        if (this.accelerometer === sensor) this.accelerometer = null;
        try { if (sensor) sensor.stop(); } catch (_ignored) {}
        try {
          console.log('[AIBike IMU] ACCEL_START_FAILED reason='
            + this.bleErrorText(error));
        } catch (_ignored) {}
      }
    }

    this.startRideAuxImuSensors(generation);
    const gyroscopeStarted = !!this.gyroscope;
    if (!accelerometerStarted && !gyroscopeStarted) {
      const retryableSensorApi = accelerometerAvailable
        || typeof Gyroscope !== 'undefined';
      if (retryableSensorApi && this.canAcceptRideRuntimeData()) {
        this.imuDiagnosticState = 'start-failed';
        this.scheduleRideImuRestart(generation, 'start-failed');
      } else {
        this.stopRideImu({ diagnosticState: 'unavailable' });
      }
      return false;
    }

    this.imuDiagnosticState = accelerometerStarted ? 'started' : 'gyro-started';
    this.scheduleRideImuWatchdog(generation);
    if (accelerometerStarted) {
      try {
        console.log('[AIBike IMU] ACCEL_STARTED requestedHz=' + String(IMU_HZ));
      } catch (_ignored) {}
    } else {
      try {
        console.log('[AIBike IMU] GYRO_FALLBACK_ACTIVE generation='
          + String(generation));
      } catch (_ignored) {}
    }
    return true;
  },

  stopRideImu(options = {}) {
    const sensor = this.accelerometer;
    const gyro = this.gyroscope;
    const orientation = this.rideOrientationSensor;
    const orientationOwned = this.rideOrientationSensorOwned === true;
    const orientationListeners = this.rideOrientationListeners;
    const qualityGate = this.imuMotionQuality;
    this.clearRideImuTimers();
    this.clearRideImuMetricsPending();
    this.accelerometer = null;
    this.imuClassifier = null;
    this.imuMotionQuality = null;
    this.gyroscope = null;
    this.gyroscopeClock = null;
    this.gyroscopeReadingCount = 0;
    this.gyroscopeLastReadingAtMs = null;
    this.gyroscopeLastRateAtMs = null;
    this.gyroscopeLastRateCount = 0;
    this.gyroscopeObservedHz = null;
    this.gyroscopeResumeProbeAtMs = null;
    this.gyroscopeActivated = false;
    this.gyroscopeStartedAtMs = null;
    this.gyroscopeDiagnosticState = options.diagnosticState || 'stopped';
    this.rideOrientationSensor = null;
    this.rideOrientationSensorOwned = false;
    this.rideOrientationListeners = null;
    this.orientationClock = null;
    this.orientationReadingCount = 0;
    this.orientationLastReadingAtMs = null;
    this.orientationLastRateAtMs = null;
    this.orientationLastRateCount = 0;
    this.orientationObservedHz = null;
    this.orientationActivated = false;
    this.orientationDiagnosticState = options.diagnosticState || 'stopped';
    this.imuGeneration = (Number(this.imuGeneration) || 0) + 1;
    this.imuStartedAtMs = null;
    this.imuFirstReadingAtMs = null;
    this.imuLastReadingAtMs = null;
    this.imuReadingCount = 0;
    this.imuLastRateAtMs = null;
    this.imuLastRateCount = 0;
    this.imuObservedHz = null;
    this.imuResumeProbeAtMs = null;
    this.imuLowRateWindowCount = 0;
    this.accelerometerActivated = false;
    this.lastImuMetricsForwardAtMs = null;
    this.lastImuMetricsSignature = '';
    if (options.preserveRestartCount !== true) this.imuRestartCount = 0;
    if (options.preserveRestartCount !== true) this.gyroscopeRestartCount = 0;
    this.imuDiagnosticState = options.diagnosticState || 'stopped';
    try {
      if (qualityGate && typeof qualityGate.pause === 'function') {
        qualityGate.pause();
      }
    } catch (_error) {}
    try { if (sensor) sensor.stop(); } catch (_error) {}
    try { if (gyro) gyro.stop(); } catch (_error) {}
    this.removeRideOrientationListeners(orientation, orientationListeners);
    if (orientationOwned) {
      try { if (orientation) orientation.stop(); } catch (_error) {}
    }
    this.stopRideWorldAwareness(options.diagnosticState || 'stopped');
  },

  ensureCadenceTone(rpmValue) {
    const rpm = Math.round(Number(rpmValue));
    const audioSrc = CADENCE_TONE_AUDIO_SOURCES[rpm];
    if (!audioSrc) return null;
    if (this.cadenceTone && !this.cadenceTone.destroyed
        && this.cadenceToneAudioSrc === audioSrc) return this.cadenceTone;
    if (this.cadenceTone) {
      try { this.cadenceTone.stop(); } catch (_error) {}
      try { this.cadenceTone.destroy(); } catch (_error) {}
      this.cadenceTone = null;
      this.cadenceToneAudioSrc = '';
    }
    try {
      this.cadenceTone = new CadenceTone({
        SoundCtor: Sound,
        src: audioSrc,
        bpm: 0,
        beatsPerPlayback: CADENCE_TONE_BEATS_PER_PLAYBACK,
        onError: (error) => {
          try {
            console.log('[AIBike Audio] PLAYBACK_ERROR ' + this.bleErrorText(error));
          } catch (_ignored) {}
          if (this.data.surfacePhase === 'settings') {
            this.setData({ settingsSaveState: '暂时无法播放' });
          }
        },
      });
      this.cadenceToneAudioSrc = audioSrc;
      try {
        console.log('[AIBike Audio] SOUND_READY rpm=' + rpm + ' src=' + audioSrc);
      } catch (_ignored) {}
      return this.cadenceTone;
    } catch (error) {
      try {
        console.log('[AIBike Audio] SOUND_INIT_FAILED ' + this.bleErrorText(error));
      } catch (_ignored) {}
      this.cadenceTone = null;
      this.cadenceToneAudioSrc = '';
      return null;
    }
  },

  startCadenceCue(rpm, options = {}) {
    this.stopCadenceCue();
    const cadence = Number(rpm) || 0;
    if (cadence <= 0) return false;
    const tone = this.ensureCadenceTone(cadence);
    if (!tone) return false;
    try {
      tone.setBpm(cadence);
      if (!tone.start()) return false;
    } catch (_error) {
      this.stopCadenceCue({ destroy: true });
      return false;
    }
    const previewBeats = Math.max(0, Number(options.previewBeats) || 0);
    if (previewBeats > 0) {
      const previewMs = Math.ceil(previewBeats * 60000 / cadence);
      this.cadencePreviewTimer = setTimeout(() => {
        this.cadencePreviewTimer = null;
        if (this.cadenceTone === tone) tone.stop();
      }, previewMs);
    }
    return true;
  },

  startRideCadenceCue() {
    if (!this.rideSessionActive || !this.pageVisible
        || !this.metrics || this.metrics.paused) return false;
    const rpm = Number(this.rideSettings && this.rideSettings.cadenceToneRpm) || 0;
    return rpm > 0 ? this.startCadenceCue(rpm) : false;
  },

  stopCadenceCue(options = {}) {
    if (this.ttsCadenceResumeTimer) clearTimeout(this.ttsCadenceResumeTimer);
    this.ttsCadenceResumeTimer = null;
    if (this.cadencePreviewTimer) clearTimeout(this.cadencePreviewTimer);
    this.cadencePreviewTimer = null;
    try { if (this.cadenceTone) this.cadenceTone.stop(); } catch (_error) {}
    if (options.destroy === true && this.cadenceTone) {
      try { this.cadenceTone.destroy(); } catch (_error) {}
      this.cadenceTone = null;
      this.cadenceToneAudioSrc = '';
    }
  },

  clearTtsRuntime(options = {}) {
    const cancelledInFlight = this.ttsInFlightUntilMs != null
      && Number.isFinite(Number(this.ttsInFlightUntilMs))
      && Date.now() < Number(this.ttsInFlightUntilMs);
    if (cancelledInFlight) {
      this.recordCyclingLocalTts('cancelled', {
        cue: 'unknown',
        result: this.pageUnloaded === true ? 'unloaded' : 'hidden',
      });
    }
    this.ttsGeneration = (this.ttsGeneration || 0) + 1;
    if (this.ttsInFlightTimer) clearTimeout(this.ttsInFlightTimer);
    if (this.ttsCadenceResumeTimer) clearTimeout(this.ttsCadenceResumeTimer);
    this.ttsInFlightTimer = null;
    this.ttsCadenceResumeTimer = null;
    this.ttsInFlightUntilMs = null;
    if (options.resetDedupe === true) {
      this.ttsLastAcceptedText = '';
      this.ttsLastAcceptedAtMs = null;
    }
  },

  cyclingLocalTtsCue(text, requestedCue = 'unknown') {
    const allowed = [
      'ride_start', 'safety', 'stage_change', 'target_high', 'target_low',
      'source_loss', 'source_recovered', 'high_heart_rate', 'ride_finish',
      'unknown',
    ];
    if (requestedCue !== 'unknown' && allowed.includes(requestedCue)) {
      return requestedCue;
    }
    const cue = String(text || '');
    if (cue.includes('开始骑行')) return 'ride_start';
    if (cue.includes('心率') && (cue.includes('偏高') || cue.includes('过高'))) {
      return 'high_heart_rate';
    }
    if (cue.includes('恢复')) return 'source_recovered';
    if (cue.includes('中断') || cue.includes('丢失') || cue.includes('未连接')) {
      return 'source_loss';
    }
    if (cue.includes('阶段')) return 'stage_change';
    if (cue.includes('降低') || cue.includes('偏高')) return 'target_high';
    if (cue.includes('提高') || cue.includes('偏低')) return 'target_low';
    if (cue.includes('安全') || cue.includes('路况')) return 'safety';
    return 'unknown';
  },

  speakCue(text, requestedCue = 'unknown') {
    const cue = String(text || '').trim();
    if (!this.rideSettings || this.rideSettings.voiceCue === false || !cue) return false;
    const now = Date.now();
    const localCue = this.cyclingLocalTtsCue(cue, requestedCue);
    const hasInFlightDeadline = this.ttsInFlightUntilMs != null
      && Number.isFinite(Number(this.ttsInFlightUntilMs));
    const inFlightUntilMs = hasInFlightDeadline
      ? Number(this.ttsInFlightUntilMs) : null;
    if (hasInFlightDeadline && now < inFlightUntilMs) {
      try { console.log('[AIBike TTS] SKIPPED reason=in_flight'); } catch (_ignored) {}
      this.recordCyclingLocalTts('skipped', {
        atMs: now,
        cue: localCue,
        result: 'in_flight',
      });
      return false;
    }
    if (hasInFlightDeadline) {
      // The deadline may have elapsed while the JS queue was busy. Retire only
      // the speech flight here; keep the independently scheduled cadence
      // resume alive when a duplicate cue is rejected at the same boundary.
      this.ttsGeneration = (this.ttsGeneration || 0) + 1;
      if (this.ttsInFlightTimer) clearTimeout(this.ttsInFlightTimer);
      this.ttsInFlightTimer = null;
      this.ttsInFlightUntilMs = null;
    }
    if (this.ttsLastAcceptedText === cue
        && this.ttsLastAcceptedAtMs != null
        && Number.isFinite(Number(this.ttsLastAcceptedAtMs))
        && now - Number(this.ttsLastAcceptedAtMs) < TTS_SAME_TEXT_DEDUPE_MS) {
      try { console.log('[AIBike TTS] SKIPPED reason=duplicate'); } catch (_ignored) {}
      this.recordCyclingLocalTts('skipped', {
        atMs: now,
        cue: localCue,
        result: 'deduped',
      });
      return false;
    }
    const cadenceRpm = Number(this.rideSettings.cadenceToneRpm) || 0;
    const resumeCadence = cadenceRpm > 0
      && this.pageVisible
      && this.canAcceptRideRuntimeData()
      && this.metrics
      && this.metrics.paused !== true;
    if (!wx.speech || typeof wx.speech.playTTS !== 'function') {
      this.recordCyclingLocalTts('failed', {
        atMs: now,
        cue: localCue,
        result: 'unsupported',
      });
      return false;
    }
    this.recordCyclingLocalTts('requested', {
      atMs: now,
      cue: localCue,
      result: 'unknown',
    });
    if (resumeCadence) this.stopCadenceCue();
    try {
      const utteranceId = wx.speech.playTTS(cue);
      // AIUI 0.15 明确以空字符串表示创建播报请求失败。失败时立刻恢复
      // 踏频节拍，不能让一次无声 TTS 留下任何占用状态。这里只记录
      // 诊断日志，绝不再播放“失败”类替代文案。
      if (typeof utteranceId !== 'string' || utteranceId.length === 0) {
        try {
          console.log('[AIBike TTS] REJECTED reason=empty_utterance_id chars='
            + String(Array.from(cue).length));
        } catch (_ignored) {}
        this.recordCyclingLocalTts('failed', {
          atMs: now,
          cue: localCue,
          result: 'empty_id',
        });
        if (resumeCadence) this.startRideCadenceCue();
        return false;
      }
      const inFlightMs = Math.max(
        TTS_IN_FLIGHT_MIN_MS,
        Math.min(TTS_IN_FLIGHT_MAX_MS, 1200 + Array.from(cue).length * 140),
      );
      const generation = (this.ttsGeneration || 0) + 1;
      this.ttsGeneration = generation;
      this.ttsLastAcceptedText = cue;
      this.ttsLastAcceptedAtMs = now;
      this.ttsInFlightUntilMs = now + inFlightMs;
      this.recordCyclingLocalTts('started', {
        atMs: now,
        cue: localCue,
        result: 'played',
        inFlightMs,
      });
      this.ttsInFlightTimer = setTimeout(() => {
        if (generation !== this.ttsGeneration) return;
        this.ttsInFlightTimer = null;
        this.ttsInFlightUntilMs = null;
      }, inFlightMs);
      if (resumeCadence) {
        // 与 in-flight 使用相同预算，防止节拍在长句未播完时提前恢复。
        // 页面隐藏或结束会同时取消两个本地定时器。
        this.ttsCadenceResumeTimer = setTimeout(() => {
          this.ttsCadenceResumeTimer = null;
          if (this.pageVisible && this.canAcceptRideRuntimeData()
              && this.metrics && this.metrics.paused !== true) {
            this.startRideCadenceCue();
          }
        }, inFlightMs);
      }
      return true;
    } catch (error) {
      try {
        console.log('[AIBike TTS] REJECTED reason=exception detail='
          + this.bleErrorText(error));
      } catch (_ignored) {}
      this.recordCyclingLocalTts('failed', {
        atMs: now,
        cue: localCue,
        result: 'exception',
      });
      if (resumeCadence) this.startRideCadenceCue();
    }
    return false;
  },

  cancelSummaryAiAdvice() {
    this.summaryAiGeneration = (this.summaryAiGeneration || 0) + 1;
    if (this.summaryAiStartTimer) clearTimeout(this.summaryAiStartTimer);
    this.summaryAiStartTimer = null;
    const session = this.summaryLlmSession;
    this.summaryLlmSession = null;
    try {
      if (session && typeof session.destroy === 'function') session.destroy();
    } catch (_error) {}
  },

  startSummaryAiAdvice(summary, localAdvice) {
    if (!summary || this.agentExitRequested || !this.isSummarySurfaceVisible()) {
      return false;
    }
    this.cancelSummaryAiAdvice();
    const generation = this.summaryAiGeneration;
    const history = this.rideHistory && Array.isArray(this.rideHistory.rides)
      ? this.rideHistory.rides.filter(
        (ride) => ride.endedAtMs !== summary.endedAtMs,
      ).slice(0, 5)
      : [];
    const settings = this.rideSettings || DEFAULT_BIKE_SETTINGS;
    this.summaryAiStartTimer = setTimeout(() => {
      this.summaryAiStartTimer = null;
      if (generation !== this.summaryAiGeneration || this.agentExitRequested
          || !this.isSummarySurfaceVisible()) return;
      generateRideAiAdvice({
        enabled: true,
        phase: RIDE_AI_ADVICE_PHASE,
        summary,
        history,
        goal: settings.rideGoal,
        confidence: rideMetricConfidence(summary),
        languageModel: LanguageModel,
        onSessionCreated: (session) => {
          if (generation !== this.summaryAiGeneration
              || this.agentExitRequested
              || !this.isSummarySurfaceVisible()) {
            try {
              if (session && typeof session.destroy === 'function') session.destroy();
            } catch (_error) {}
            return;
          }
          this.summaryLlmSession = session;
        },
        onSessionClosed: (session) => {
          if (this.summaryLlmSession === session) this.summaryLlmSession = null;
        },
      }).then((result) => {
        if (generation !== this.summaryAiGeneration || this.agentExitRequested
            || !this.isSummarySurfaceVisible()
            || !result || result.shouldReplaceLocal !== true || !result.text) return;
        const localSource = String(localAdvice && localAdvice.sourceNote || '')
          .replace(/^本地规则；?/, '');
        this.setData({
          sumAdviceTitle: 'AI 骑后建议',
          sumReview: result.text,
          sumSourceNote: '端侧模型仅使用聚合数据；' + localSource,
        });
        if (this.pageVisible) this.speakCue(result.text);
      }).catch(() => false);
    }, SUMMARY_AI_START_DELAY_MS);
    return true;
  },

  onHudConfirmKey(code = '') {
    if (!this.canAcceptRideRuntimeData()) return false;
    const now = Date.now();
    if (this.hudEnteredAtMs != null
        && now - this.hudEnteredAtMs < HUD_CONFIRM_GRACE_MS) return false;
    if (code === 'GlobalHook') {
      const previousTapAtMs = this.hudTouchTapAtMs;
      const tapGapMs = previousTapAtMs == null ? null : now - previousTapAtMs;
      if (tapGapMs != null
          && tapGapMs >= HUD_DOUBLE_TAP_MIN_GAP_MS
          && tapGapMs <= HUD_DOUBLE_TAP_WINDOW_MS) {
        this.hudTouchTapAtMs = null;
        this.endArmedAtMs = null;
        this.bleDebug('HUD_DOUBLE_TAP_FINISH', 'gap=' + String(tapGapMs));
        return this.finishRideToSummary();
      }
      if (tapGapMs != null && tapGapMs >= 0
          && tapGapMs < HUD_DOUBLE_TAP_MIN_GAP_MS) {
        this.bleDebug('HUD_GLOBAL_HOOK_DUPLICATE', 'gap=' + String(tapGapMs));
        return false;
      }
      this.hudTouchTapAtMs = now;
    }
    if (this.lastConfirmKeyMs != null
        && now - this.lastConfirmKeyMs < CONFIRM_KEY_DEDUPE_MS) return false;
    this.lastConfirmKeyMs = now;
    if (this.endArmedAtMs != null && now - this.endArmedAtMs <= END_CONFIRM_WINDOW_MS) {
      this.endArmedAtMs = null;
      return this.finishRideToSummary();
    }
    this.endArmedAtMs = now;
    this.setData({ hudHint: '再按一次结束' });
    return false;
  },

  buildSummaryChart(snapshot) {
    let data = this.minuteSeries.slice(-12);
    if (!data.length) {
      const average = finiteNumber(snapshot && snapshot.avgSpeedKmh);
      if (average != null) data = [{ minute: 1, value: Number(average.toFixed(1)) }];
    }
    const values = data.map((item) => Number(item.value)).filter((value) => value >= 0);
    const maximum = values.length ? Math.ceil(Math.max(...values) + 5) : 40;
    const lastMinute = data.length ? data[data.length - 1].minute : 2;
    return {
      summaryChartData: data,
      showSummaryChart: data.length > 0,
      summaryChartEmptyText: '速度曲线未形成',
      summaryChartYAxis: { minimum: 0, maximum: Math.max(10, maximum) },
      summaryChartXAxis: { minimum: 1, maximum: Math.max(2, lastMinute) },
    };
  },

  finishRideToSummary() {
    if (!this.canAcceptRideRuntimeData()) return false;
    this.finishRideCommitted = true;
    const now = Date.now();
    let snapshot = null;
    try {
      if (this.metrics && typeof this.metrics.finalizeDistance === 'function') {
        this.metrics.finalizeDistance(now);
      }
      snapshot = this.metrics ? this.metrics.snapshot(now) : null;
    } catch (_error) {
      snapshot = null;
    }
    const distanceAvailable = snapshot && snapshot.distanceEverAvailable === true;
    const summarySources = new Set();
    if (snapshot && snapshot.metrics) {
      for (const metric of Object.values(snapshot.metrics)) {
        if (metric && metric.source
            && (metric.state === 'live' || metric.state === 'explicit_zero')) {
          summarySources.add(metric.source);
        }
      }
    }
    if (snapshot && Array.isArray(snapshot.summarySourcesUsed)) {
      for (const source of snapshot.summarySourcesUsed) summarySources.add(source);
    }
    if (snapshot && snapshot.distanceSource) summarySources.add(snapshot.distanceSource);
    const summary = snapshot ? {
      endedAtMs: now,
      elapsedMs: snapshot.elapsedMs,
      movingMs: snapshot.movingMs,
      distanceM: distanceAvailable ? finiteNumber(snapshot.distanceM) : null,
      avgSpeedKmh: finiteNumber(snapshot.avgSpeedKmh),
      maxSpeedKmh: finiteNumber(snapshot.maxSpeedKmh),
      avgCadenceRpm: finiteNumber(snapshot.avgCadenceRpm),
      maxCadenceRpm: finiteNumber(snapshot.maxCadenceRpm),
      avgBpm: finiteNumber(snapshot.avgBpm),
      maxBpm: finiteNumber(snapshot.maxBpm),
      avgPowerW: finiteNumber(snapshot.avgPowerW),
      maxPowerW: finiteNumber(snapshot.maxPowerW),
      sources: [...summarySources],
      distanceSources: Array.isArray(snapshot.distanceSourcesUsed)
        ? snapshot.distanceSourcesUsed.slice() : [],
      cadenceSources: snapshot.metricSourcesUsed
        && Array.isArray(snapshot.metricSourcesUsed.cadence)
        ? snapshot.metricSourcesUsed.cadence.slice() : [],
    } : null;
    const workoutResult = finalizeSportsWorkout(this.sportsWorkoutExecutor);
    const advice = buildPostRideAdvice(summary);
    const summaryDisplay = buildSummaryMetricDisplay(summary ? {
      ...summary,
      heartRateConnected: Boolean(
        this.subscribedSources.hrs || this.heartRateEverLive,
      ),
      powerConnected: Boolean(
        this.subscribedSources.cps || this.powerEverLive,
      ),
    } : null);
    const priorHistory = this.rideHistory || { schemaVersion: 1, rides: [] };
    const trendText = buildRideTrendText(priorHistory, now, 'pre');
    const uploadRideId = this.cyclingUploadSession
      ? this.cyclingUploadSession.testRideId : '';
    const deepSportAgent = this.activeSportAgent;
    if (deepSportAgent && snapshot) {
      this.queueSportAgentEvent(snapshot, now, 'snapshot');
    }
    this.lastCyclingUploadRideId = uploadRideId;
    this.pendingRideSummaryCommit = {
      summary,
      snapshot,
      advice,
      priorHistory,
      uploadRideId,
      workoutResult,
      sportsExecutionId: this.sportsExecutionId,
      sportsStartedAtMs: this.sportsStartedAtMs,
      sportsOwner: this.sportsOwnerAtStart,
      deepSportAgent,
      endedAtMs: now,
      finalSampleCaptured: false,
      finishEvent: null,
      eventsPrepared: false,
      summarySaved: summary == null,
      historySaved: summary == null,
      uploadSaved: false,
      uploadStarted: false,
      localFieldUploadQueued: false,
      sportsEventPrepared: false,
      sportsEvent: null,
      sportsSaved: summary == null || !this.sportsOwnerAtStart,
      deepSportsEventPrepared: false,
      deepSportsCompletion: null,
      deepSportsSaved: summary == null || !deepSportAgent,
      localFieldLogSaved: false,
    };
    this.summaryEnteredAtMs = now;
    this.rideSessionActive = false;
    this.activeSportAgent = null;
    this.rideHudHiddenHoldPending = false;
    this.lastRideHudRenderData = null;
    this.summaryFinalizationStarted = false;
    this.summaryPersistenceConfirmed = false;
    this.summaryExitPending = false;
    this.pendingSummaryExitSource = '';
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    this.lastSummaryBackspaceMs = null;
    // 首帧必须先于任何 storage、上传队列和原生清理桥。真机 storage 偶发
    // 变慢时，用户仍会立即看到完整六项总结和可用退出入口。
    this.setData({
      surfacePhase: 'summary',
      riding: false,
      paused: false,
      hudHint: '',
      sumDistance: summaryDisplay.distance,
      sumElapsed: summaryDisplay.elapsed,
      sumSpeed: summaryDisplay.speed,
      sumCadence: summaryDisplay.cadence,
      sumHeartRate: summaryDisplay.heartRate,
      sumPower: summaryDisplay.power,
      sumAdviceTitle: advice.headline,
      sumReview: advice.detail,
      sumSourceNote: advice.sourceNote,
      sumTrend: trendText,
      summaryUploadText: '日志整理中',
      summaryPlanText: workoutResult
        ? ('训练完成 ' + String(workoutResult.completion_percent) + '% · 阶段达标 '
          + (workoutResult.target_percent == null ? '待设备数据'
            : String(workoutResult.target_percent) + '%')
          + ' · 来源覆盖 ' + String(workoutResult.source_coverage_percent) + '%')
        : '自由骑 · 已生成本地总结',
      summaryExitText: '前划进入骑后放松 · 返回或连续两次确认退出',
      ...this.buildSummaryChart(snapshot),
    });
    // 首帧提交后立即封住 JS 通知入口，避免总结页再接收尾包；真正的
    // stopNotifications / disconnect 仍延后一任务，不阻塞总结显示。
    for (const resource of this.notificationResources || []) {
      resource.active = false;
    }
    this.stopTicker();
    this.summaryFinalizeTimer = setTimeout(
      () => this.finalizeRideAfterSummaryCommit(),
      0,
    );
    return true;
  },

  persistRideSummaryCommit() {
    const commit = this.pendingRideSummaryCommit;
    if (!commit) {
      this.summaryPersistenceConfirmed = true;
      return true;
    }
    const summary = commit.summary;
    if (commit.localFieldLogSaved !== true) {
      commit.localFieldLogSaved = this.finishCyclingLocalFieldCapture(
        summary,
        commit.snapshot,
        commit.endedAtMs,
      );
      if (!commit.localFieldLogSaved) {
        this.retryCyclingLocalFieldLogFinish(commit);
      }
    }
    if (!commit.eventsPrepared) {
      if (!commit.finalSampleCaptured && commit.snapshot) {
        this.captureCyclingTestSample(commit.snapshot, commit.endedAtMs, true);
        commit.finalSampleCaptured = true;
      }
      if (this.cyclingUploadSession && summary && !commit.finishEvent) {
        commit.finishEvent = captureCyclingUploadFinish(
          this.cyclingUploadSession,
          {
            ...summary,
            sampleCount: this.cyclingUploadSampleCount,
          },
          { capturedAtMs: commit.endedAtMs },
        );
        if (commit.finishEvent) {
          this.queueCyclingUploadEvent(commit.finishEvent);
          if (!commit.localFieldUploadQueued) {
            commit.localFieldUploadQueued = this.recordCyclingLocalUpload(
              'queued',
              {
                pending: readPendingCyclingUploadEvents(wx).length
                  + this.cyclingUploadBuffer.length,
                reason: 'unknown',
              },
              commit.uploadRideId,
            );
          }
        }
      }
      commit.eventsPrepared = true;
      this.cyclingUploadSession = null;
    }

    if (!commit.sportsEventPrepared) {
      const owner = commit.sportsOwner;
      const executionId = commit.sportsExecutionId;
      // 已启动 Sport Agent session 的骑行只走共享 complete；否则才回退
      // legacy Sports v1 主账本。两条链互斥，避免同一 client activity
      // 被创建两次并触发 workout_id 唯一冲突。
      if (summary && owner && executionId && !commit.deepSportAgent) {
        const baseEvent = {
          kind: commit.workoutResult ? 'completion' : 'activity',
          owner,
          client_execution_id: executionId,
          status: commit.workoutResult
            ? (commit.workoutResult.completion_percent >= 100 ? 'completed' : 'partial')
            : 'completed',
          started_at_ms: commit.sportsStartedAtMs,
          ended_at_ms: commit.endedAtMs,
          duration_sec: Math.max(0, Math.round(Number(summary.elapsedMs || 0) / 1000)),
          distance_m: Math.max(0, Number(summary.distanceM) || 0),
          metrics: buildCyclingSportsMetrics(summary, {
            source_coverage: commit.workoutResult
              ? commit.workoutResult.source_coverage : undefined,
          }),
        };
        if (commit.workoutResult) {
          baseEvent.workout_id = commit.workoutResult.workout_id;
          baseEvent.revision = commit.workoutResult.revision;
          baseEvent.stage_results = commit.workoutResult.stage_results;
        }
        commit.sportsEvent = baseEvent;
      }
      commit.sportsEventPrepared = true;
    }

    if (!commit.deepSportsEventPrepared) {
      const deep = commit.deepSportAgent;
      if (summary && deep && deep.session && deep.identity) {
        const completedWorkout = !commit.workoutResult
          || commit.workoutResult.stage_results.every(
            (stage) => stage.status === 'completed',
          );
        const completion = {
          kind: 'complete',
          owner: deep.identity,
          session_id: deep.session.session_id,
          client_completion_id: deep.clientSessionId + '.complete',
          client_activity_id: commit.sportsExecutionId,
          status: completedWorkout ? 'completed' : 'partial',
          started_at_ms: commit.sportsStartedAtMs,
          ended_at_ms: commit.endedAtMs,
          duration_s: Math.max(0, Math.round(Number(summary.elapsedMs || 0) / 1000)),
          summary: buildSportAgentRideSummary(summary, {
            sourceCoverage: commit.workoutResult
              ? commit.workoutResult.source_coverage : undefined,
            sensorSources: commit.workoutResult
              ? commit.workoutResult.sensor_sources : undefined,
          }),
        };
        if (commit.workoutResult) {
          completion.workout_revision = commit.workoutResult.revision;
          completion.stage_results = commit.workoutResult.stage_results.map((stage) => ({
            stage_id: stage.stage_id,
            status: stage.status,
            duration_s: stage.duration_sec,
            distance_m: stage.distance_m,
            metrics: stage.metrics,
          }));
        }
        commit.deepSportsCompletion = completion;
      }
      commit.deepSportsEventPrepared = true;
    }

    if (!commit.summarySaved && summary) {
      const storedSummary = writeLastRideSummary(wx, summary);
      commit.summarySaved = !!storedSummary;
      if (storedSummary) this.lastRideSummary = storedSummary;
    }
    if (!commit.historySaved && summary) {
      const historyResult = persistRideHistorySummary(wx, summary);
      commit.historySaved = !!(historyResult && historyResult.persisted);
      if (commit.historySaved) {
        this.rideHistory = historyResult.history;
        this.setData({
          sumTrend: buildRideTrendText(this.rideHistory, commit.endedAtMs, 'post'),
        });
      }
    }
    if (!commit.uploadSaved) {
      commit.uploadSaved = this.flushCyclingUploadBuffer();
    }
    if (commit.sportsSaved !== true) {
      if (!commit.sportsEvent) commit.sportsSaved = true;
      else {
        const queued = enqueueSportsOutbox(wx, commit.sportsEvent, commit.sportsOwner);
        commit.sportsSaved = !!queued && queued.some(
          (item) => item.client_execution_id === commit.sportsEvent.client_execution_id,
        );
      }
    }
    if (commit.deepSportsSaved !== true) {
      if (!commit.deepSportsCompletion) commit.deepSportsSaved = true;
      else {
        const queued = enqueueSportAgentItem(
          wx,
          commit.deepSportsCompletion,
          commit.deepSportAgent.identity,
        );
        commit.deepSportsSaved = !!queued && queued.some(
          (item) => item.kind === 'complete'
            && item.client_completion_id
              === commit.deepSportsCompletion.client_completion_id,
        );
        if (commit.deepSportsSaved) {
          commit.deepSportsSaved = Boolean(markSportAgentCompletionQueued(
            wx,
            commit.deepSportAgent.identity,
            commit.deepSportsCompletion,
          ));
          if (commit.deepSportsSaved) {
            this.blockingSportAgentActive = readSportAgentActive(
              wx,
              commit.deepSportAgent.identity,
            );
          }
        }
      }
    }
    const stored = commit.summarySaved && commit.historySaved
      && commit.uploadSaved && commit.sportsSaved && commit.deepSportsSaved;
    this.summaryPersistenceConfirmed = stored;
    if (stored) {
      this.setData({
        summaryUploadText: commit.finishEvent
          ? '日志已保存 · 上传中'
          : '本次无测试日志',
      });
    } else {
      const trend = commit.historySaved
        ? buildRideTrendText(this.rideHistory, commit.endedAtMs, 'post')
        : '本次历史未保存。'
          + buildRideTrendText(commit.priorHistory, commit.endedAtMs, 'pre');
      this.setData({
        sumTrend: trend,
        summaryUploadText: '日志保存中 · 正在重试',
      });
    }
    return stored;
  },

  startCommittedRideUpload() {
    const commit = this.pendingRideSummaryCommit;
    if (!commit || commit.uploadStarted
        || this.summaryPersistenceConfirmed !== true) return false;
    commit.uploadStarted = true;
    if (commit.finishEvent) {
      this.flushCyclingTestUploads({
        updateSummary: true,
        rideId: commit.uploadRideId,
      });
    }
    this.flushSportsActivityOutbox({ updateSummary: true });
    this.flushSportAgentSessionOutbox({ updateSummary: true });
    return true;
  },

  applySportAgentDebriefToSummary(debrief) {
    if (!debrief || typeof debrief !== 'object' || !this.isSummaryPhase()) return false;
    const review = debrief.review && typeof debrief.review === 'object'
      ? debrief.review : {};
    const next = debrief.next_training && typeof debrief.next_training === 'object'
      ? debrief.next_training : null;
    const detail = review.ai_review || review.detail || '';
    const memoryText = debrief.memory_status === 'complete'
      ? '长期记忆已更新'
      : (debrief.memory_status === 'skipped_no_consent'
        ? '长期记忆未启用'
        : (debrief.memory_status === 'failed'
          ? '长期记忆待重试' : '长期记忆整理中'));
    this.setData({
      sumAdviceTitle: review.headline || 'Hermes 骑后建议',
      ...(detail ? { sumReview: detail } : {}),
      sumSourceNote: [
        review.focus ? ('下次重点 · ' + review.focus) : '',
        next && next.message ? next.message : '',
        memoryText,
      ].filter(Boolean).join(' · '),
    });
    return true;
  },

  clearSportAgentDebriefPoll() {
    if (this.sportAgentDebriefPollTimer) clearTimeout(this.sportAgentDebriefPollTimer);
    this.sportAgentDebriefPollTimer = null;
    this.sportAgentDebriefPollCount = 0;
    this.sportAgentDebriefPollSessionId = '';
  },

  refreshCompletedSportAgentPlan(sessionId) {
    if (!sessionId || this.lastSportAgentPlanRefreshSessionId === sessionId
        || this.rideSessionActive || !this.pageVisible) return Promise.resolve(null);
    this.lastSportAgentPlanRefreshSessionId = sessionId;
    return this.refreshTodayWorkout({ force: true }).then((envelope) => {
      if (!this.pageVisible || this.rideSessionActive) return null;
      if (!envelope || envelope.available !== true) {
        this.sportsWorkoutEnvelope = envelope || null;
        this.pendingSportsPlan = null;
        this.syncSportsWorkoutMenu();
      }
      if (!envelope && this.lastSportAgentPlanRefreshSessionId === sessionId) {
        this.lastSportAgentPlanRefreshSessionId = '';
      }
      return envelope;
    }).catch(() => {
      if (this.lastSportAgentPlanRefreshSessionId === sessionId) {
        this.lastSportAgentPlanRefreshSessionId = '';
      }
      return null;
    });
  },

  scheduleSportAgentDebriefPoll(debrief) {
    if (!debrief || !debrief.session_id || !this.pageVisible
        || !this.isSummaryPhase() || this.rideSessionActive) return false;
    this.applySportAgentDebriefToSummary(debrief);
    this.refreshCompletedSportAgentPlan(debrief.session_id);
    const reviewTerminal = ['local_ready', 'ai_ready', 'failed'].includes(debrief.status);
    const memoryTerminal = ['complete', 'skipped_no_consent', 'failed']
      .includes(debrief.memory_status);
    if (reviewTerminal && memoryTerminal) {
      this.clearSportAgentDebriefPoll();
      return false;
    }
    if (this.sportAgentDebriefPollTimer
        && this.sportAgentDebriefPollSessionId === debrief.session_id) return true;
    if (this.sportAgentDebriefPollSessionId
        && this.sportAgentDebriefPollSessionId !== debrief.session_id) {
      this.clearSportAgentDebriefPoll();
    }
    if (this.sportAgentDebriefPollCount >= SPORT_AGENT_DEBRIEF_POLL_DELAYS_MS.length) {
      this.clearSportAgentDebriefPoll();
      return false;
    }
    const identity = this.sportsIdentity || readSportsIdentity(wx);
    if (!identity) return false;
    const sessionId = debrief.session_id;
    const delay = SPORT_AGENT_DEBRIEF_POLL_DELAYS_MS[this.sportAgentDebriefPollCount];
    this.sportAgentDebriefPollCount += 1;
    this.sportAgentDebriefPollSessionId = sessionId;
    this.sportAgentDebriefPollTimer = setTimeout(() => {
      this.sportAgentDebriefPollTimer = null;
      if (!this.pageVisible || !this.isSummaryPhase()
          || sessionId !== this.sportAgentDebriefPollSessionId) return;
      const refreshIdentity = () => {
        clearSportsToken(wx);
        return this.ensureCurrentSportsIdentity({ forceRefresh: true });
      };
      refreshSportAgentDebrief({
        storage: wx,
        identity,
        sessionId,
        clientCompletionId: debrief.client_completion_id,
        clientActivityId: debrief.client_activity_id,
        request: (requestOptions) => this.requestCyclingHermes(requestOptions),
        refreshIdentity,
      }).then((updated) => {
        if (updated && this.pageVisible && this.isSummaryPhase()) {
          this.scheduleSportAgentDebriefPoll(updated);
        } else {
          this.clearSportAgentDebriefPoll();
        }
      }).catch(() => this.clearSportAgentDebriefPoll());
    }, delay);
    return true;
  },

  flushSportAgentSessionOutbox(options = {}) {
    if (this.rideSessionActive === true) {
      const identity = this.sportsIdentity || readSportsIdentity(wx);
      return Promise.resolve({
        status: 'deferred',
        pending: identity ? readSportAgentOutbox(wx, identity).length : 0,
      });
    }
    if (this.sportAgentOutboxFlight) return this.sportAgentOutboxFlight;
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    const identity = this.sportsIdentity || readSportsIdentity(wx);
    if (!identity) return Promise.resolve({ status: 'pending', pending: 0 });
    const refreshIdentity = () => {
      clearSportsToken(wx);
      return this.ensureCurrentSportsIdentity({ forceRefresh: true });
    };
    const flight = flushSportAgentOutbox({
      storage: wx,
      identity,
      request: (requestOptions) => this.requestCyclingHermes(requestOptions),
      refreshIdentity,
    }).then((result) => {
      if (options.updateSummary === true && this.isSummaryPhase()
          && this.isHermesLifecycleCurrent(lifecycleGeneration)) {
        if (result.debrief) this.scheduleSportAgentDebriefPoll(result.debrief);
        if (result.pending > 0) {
          this.setData({ summaryUploadText: '总结已保存 · 待联网同步' });
        } else if (result.status === 'acked') {
          this.setData({ summaryUploadText: '训练总结已同步' });
        }
      }
      this.blockingSportAgentActive = readSportAgentActive(wx, identity);
      this.syncSportsWorkoutMenu();
      return result;
    }).catch(() => ({
      status: 'pending',
      pending: readSportAgentOutbox(wx, identity).length,
      debrief: null,
    })).finally(() => {
      if (this.sportAgentOutboxFlight === flight) this.sportAgentOutboxFlight = null;
    });
    this.sportAgentOutboxFlight = flight;
    return flight;
  },

  flushSportsActivityOutbox(options = {}) {
    if (this.rideSessionActive === true) {
      return Promise.resolve({
        status: 'deferred',
        pending: this.sportsIdentity ? readSportsOutbox(wx, this.sportsIdentity).length : 0,
      });
    }
    if (this.sportsOutboxFlight) return this.sportsOutboxFlight;
    const lifecycleGeneration = this.hermesLifecycleGeneration;
    const identity = this.sportsIdentity || readSportsIdentity(wx);
    if (!identity) return Promise.resolve({ status: 'pending', pending: 0 });
    const refreshIdentity = () => {
      clearSportsToken(wx);
      return this.ensureCurrentSportsIdentity({ forceRefresh: true });
    };
    const flight = flushSportsOutbox({
      storage: wx,
      identity,
      request: (requestOptions) => this.requestCyclingHermes(requestOptions),
      refreshIdentity,
    }).then((result) => {
      if (options.updateSummary === true && this.isSummaryPhase()
          && this.isHermesLifecycleCurrent(lifecycleGeneration)) {
        if (result.review && result.review.detail) {
          this.setData({
            sumAdviceTitle: result.review.headline || 'Hermes 骑后建议',
            sumReview: result.review.detail,
            sumSourceNote: result.review.next_focus
              ? ('下次重点 · ' + result.review.next_focus) : this.data.sumSourceNote,
          });
        }
        if (result.pending > 0) {
          this.setData({ summaryUploadText: '总结已保存 · 待联网同步' });
        }
      }
      return result;
    }).catch(() => ({ status: 'pending', pending: readSportsOutbox(wx, identity).length }))
      .finally(() => {
        if (this.sportsOutboxFlight === flight) this.sportsOutboxFlight = null;
      });
    this.sportsOutboxFlight = flight;
    return flight;
  },

  cancelSummaryPersistenceRetry() {
    this.summaryPersistenceGeneration = (this.summaryPersistenceGeneration || 0) + 1;
    if (this.summaryPersistenceRetryTimer) {
      clearTimeout(this.summaryPersistenceRetryTimer);
    }
    this.summaryPersistenceRetryTimer = null;
    const resolve = this.summaryPersistenceRetryResolve;
    this.summaryPersistenceRetryResolve = null;
    this.summaryPersistenceFlight = null;
    if (typeof resolve === 'function') {
      try { resolve(false); } catch (_error) {}
    }
  },

  retryRideSummaryPersistence() {
    if (this.summaryPersistenceConfirmed) return Promise.resolve(true);
    if (this.summaryPersistenceFlight) return this.summaryPersistenceFlight;
    const generation = (this.summaryPersistenceGeneration || 0) + 1;
    this.summaryPersistenceGeneration = generation;
    this.summaryPersistenceFlight = new Promise((resolve) => {
      this.summaryPersistenceRetryResolve = resolve;
      const attempt = (index) => {
        if (generation !== this.summaryPersistenceGeneration) {
          resolve(false);
          return;
        }
        if (this.persistRideSummaryCommit()) {
          resolve(true);
          return;
        }
        if (index >= SUMMARY_PERSIST_RETRY_DELAYS_MS.length) {
          resolve(false);
          return;
        }
        this.summaryPersistenceRetryTimer = setTimeout(() => {
          this.summaryPersistenceRetryTimer = null;
          attempt(index + 1);
        }, SUMMARY_PERSIST_RETRY_DELAYS_MS[index]);
      };
      attempt(0);
    }).then((stored) => {
      if (generation !== this.summaryPersistenceGeneration) return stored;
      this.summaryPersistenceRetryTimer = null;
      this.summaryPersistenceRetryResolve = null;
      this.summaryPersistenceFlight = null;
      if (stored) {
        this.startCommittedRideUpload();
      } else if (this.isSummaryPhase() && !this.agentExitRequested) {
        this.summaryExitPending = false;
        this.pendingSummaryExitSource = '';
        this.setData({
          summaryUploadText: '日志保存失败 · 请重试',
          summaryExitText: '保存失败，请再按返回键重试',
        });
      }
      return stored;
    });
    return this.summaryPersistenceFlight;
  },

  finalizeRideAfterSummaryCommit() {
    if (this.summaryFinalizationStarted) {
      return this.summaryPersistenceConfirmed;
    }
    this.summaryFinalizationStarted = true;
    this.summaryFinalizeTimer = null;
    const commit = this.pendingRideSummaryCommit;
    const stored = this.persistRideSummaryCommit();
    if (stored) this.startCommittedRideUpload();
    else this.retryRideSummaryPersistence();
    try { this.stopRideImu(); } catch (_error) {}
    this.clearTtsRuntime();
    try { this.stopCadenceCue({ destroy: true }); } catch (_error) {}
    this.beginTerminalBleCleanup();
    if (commit) this.startSummaryAiAdvice(commit.summary, commit.advice);
    return stored;
  },

  clearSummaryExitPrompt(options = {}) {
    if (this.summaryExitPromptTimer) clearTimeout(this.summaryExitPromptTimer);
    this.summaryExitPromptTimer = null;
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    if (options.keepText !== true && this.isSummaryPhase()
        && this.data.summaryExitText !== '前划进入骑后放松 · 返回或连续两次确认退出') {
      this.setData({
        summaryExitText: '前划进入骑后放松 · 返回或连续两次确认退出',
      });
    }
  },

  armSummaryExitPrompt(now = Date.now()) {
    this.summaryExitArmedAtMs = now;
    this.setData({ summaryExitText: '再按一次确认键退出' });
    if (this.summaryExitPromptTimer) clearTimeout(this.summaryExitPromptTimer);
    this.summaryExitPromptTimer = setTimeout(() => {
      this.summaryExitPromptTimer = null;
      this.summaryExitArmedAtMs = null;
      this.lastSummaryConfirmKeyMs = null;
      this.summaryTouchTapAtMs = null;
      if (this.isSummaryPhase() && !this.agentExitRequested) {
        this.setData({
          summaryExitText: '前划进入骑后放松 · 返回或连续两次确认退出',
        });
      }
    }, END_CONFIRM_WINDOW_MS);
  },

  onSummaryConfirmKey(code = '') {
    if (!this.isSummaryPhase() || this.agentExitRequested) return false;
    const now = Date.now();
    // HUD 的结束手势可能在总结首帧后尾随 Enter/GlobalHook。入场窗内完全
    // 隔离，并且不写 summaryTouchTapAtMs，避免污染下一次真实双击。
    if (this.summaryEnteredAtMs != null
        && now - this.summaryEnteredAtMs < SUMMARY_CONFIRM_ENTRY_GRACE_MS) return false;
    if (code === 'GlobalHook') {
      const previousTapAtMs = this.summaryTouchTapAtMs;
      const tapGapMs = previousTapAtMs == null ? null : now - previousTapAtMs;
      if (tapGapMs != null
          && tapGapMs >= SUMMARY_DOUBLE_TAP_MIN_GAP_MS
          && tapGapMs <= SUMMARY_DOUBLE_TAP_WINDOW_MS) {
        this.clearSummaryExitPrompt({ keepText: true });
        this.bleDebug('SUMMARY_DOUBLE_TAP_EXIT', 'gap=' + String(tapGapMs));
        return this.closeAgent('summary-double-tap');
      }
      if (tapGapMs != null && tapGapMs >= 0
          && tapGapMs < SUMMARY_DOUBLE_TAP_MIN_GAP_MS) {
        this.bleDebug('SUMMARY_GLOBAL_HOOK_DUPLICATE', 'gap=' + String(tapGapMs));
        return false;
      }
      this.summaryTouchTapAtMs = now;
    }
    if (this.lastSummaryConfirmKeyMs != null
        && now - this.lastSummaryConfirmKeyMs < CONFIRM_KEY_DEDUPE_MS) return false;
    this.lastSummaryConfirmKeyMs = now;
    if (this.summaryExitArmedAtMs != null
        && now - this.summaryExitArmedAtMs <= END_CONFIRM_WINDOW_MS) {
      this.clearSummaryExitPrompt({ keepText: true });
      return this.closeAgent('summary-double-confirm');
    }
    this.armSummaryExitPrompt(now);
    return false;
  },

  async releaseNotificationResources(disconnect = true, includePending = false) {
    const resources = this.notificationResources.slice();
    if (includePending) {
      for (const item of [
        ...(this.notificationOwnerResources || []),
        ...(this.terminalDeferredNotificationResources || []),
      ]) {
        if (item && !resources.includes(item)) resources.push(item);
      }
    }
    const server = this.bleServer;
    this.notificationResources = [];
    if (includePending) {
      this.notificationOwnerResources = [];
      this.terminalDeferredNotificationResources = [];
    }
    for (const item of resources) {
      item.active = false;
      this.notificationOwnerResources = (this.notificationOwnerResources || [])
        .filter((resource) => resource !== item);
      try {
        item.characteristic.removeEventListener(
          'characteristicvaluechanged',
          item.listener,
        );
      } catch (_error) {}
    }
    const stoppedCharacteristics = [];
    for (const item of resources) {
      try {
        const replacementOwnsCharacteristic = (this.notificationOwnerResources || [])
          .some((resource) => (
            resource.active && resource.characteristic === item.characteristic
          ));
        if (!replacementOwnsCharacteristic
            && !stoppedCharacteristics.includes(item.characteristic)
            && typeof item.characteristic.stopNotifications === 'function') {
          stoppedCharacteristics.push(item.characteristic);
          const sameCharacteristicResources = resources.filter(
            (resource) => resource.characteristic === item.characteristic,
          );
          let stopPromise = sameCharacteristicResources
            .map((resource) => resource.notificationStopPromise)
            .find(Boolean);
          if (!stopPromise) {
            stopPromise = this.beginNotificationStop(
              item.characteristic,
              item.server || server || null,
            );
            for (const resource of sameCharacteristicResources) {
              resource.notificationStopPromise = stopPromise;
            }
          }
          if (stopPromise) {
            await this.waitForPromise(
              stopPromise,
              BLE_CLEANUP_STEP_WAIT_MS,
            );
          }
        }
      } catch (_error) {}
    }
    if (disconnect && server && typeof server.disconnect === 'function') {
      await this.disconnectBleServer(server, { force: true });
    }
  },

  sealTerminalBleState() {
    if (this.terminalBleSealed) return false;
    this.terminalBleSealed = true;
    this.bleTerminated = true;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.connectingAttemptId = null;
    this.connectingDevice = null;
    this.connecting = false;
    this.connectingAutoResume = false;
    this.clearSearchConnectResumeTimer();
    this.clearRideStartTimer();
    this.clearReconnectTimer();
    const now = Date.now();
    for (const source of Object.keys(this.subscribedSources || {})) {
      if (this.metrics && typeof this.metrics.markSourceDisconnected === 'function') {
        this.metrics.markSourceDisconnected(source, now);
      }
    }
    this.subscribedSources = {};
    for (const resource of this.notificationOwnerResources || []) {
      resource.active = false;
    }
    return true;
  },

  teardownBle(options = {}) {
    if (options.terminal === true) {
      this.sealTerminalBleState();
      this.terminalBleNativeCleanupStarted = true;
    } else {
      this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
      this.connectAttemptId = (this.connectAttemptId || 0) + 1;
      this.connectingAttemptId = null;
      this.connectingDevice = null;
      this.connecting = false;
      this.connectingAutoResume = false;
    }
    this.scanResumePending = false;
    this.scanDiscoveryPending = false;
    this.searchConnectResumePending = false;
    this.clearSearchConnectResumeTimer();
    this.stopScan();
    this.clearRideStartTimer();
    this.clearReconnectTimer();
    const device = this.connectedDevice;
    const dropListener = this.gattDropListener;
    if (device && dropListener && typeof device.removeEventListener === 'function') {
      try { device.removeEventListener('gattserverdisconnected', dropListener); } catch (_error) {}
    }
    this.gattDropListener = null;
    const now = Date.now();
    for (const source of Object.keys(this.subscribedSources || {})) {
      if (this.metrics && typeof this.metrics.markSourceDisconnected === 'function') {
        this.metrics.markSourceDisconnected(source, now);
      }
    }
    this.subscribedSources = {};
    const cleanup = this.releaseNotificationResources(true, true);
    this.connectedDevice = null;
    this.reconnectDevice = null;
    this.reconnectDeferred = false;
    this.bleServer = null;
    const deferredCleanup = this.releaseDeferredBleServers();
    this.bleDebug('BLE_TEARDOWN', 'terminal=' + String(options.terminal === true));
    return Promise.all([cleanup, deferredCleanup]);
  },

  beginTerminalBleCleanup() {
    if (this.terminalBleCleanupPromise) return this.terminalBleCleanupPromise;
    this.sealTerminalBleState();
    this.terminalBleCleanupPromise = new Promise((resolve) => {
      this.terminalBleCleanupTimer = setTimeout(() => {
        this.terminalBleCleanupTimer = null;
        Promise.resolve(this.teardownBle({ terminal: true }))
          .then(resolve, () => resolve(false));
      }, 0);
    });
    return this.terminalBleCleanupPromise;
  },

  clearAgentExitTimer() {
    if (this.agentExitTimer) clearTimeout(this.agentExitTimer);
    this.agentExitTimer = null;
  },

  dispatchAgentExit() {
    if (this.agentExitDispatched || this.agentExitDispatching) return false;
    this.agentExitDispatching = true;
    this.clearAgentExitTimer();
    let exited = false;
    let returnHintStored = false;
    try {
      if (this.agentExitDestination === 'home'
          && typeof wx.navigateBack === 'function') {
        // 正常首页入口始终在当前沉浸页下一层。先写一次性完成标记，
        // 再退回 448x150 对话流卡片；首页只读取已经通过写后读回门的总结。
        returnHintStored = writeRideFinishedHint(wx) === true;
        if (returnHintStored) {
          wx.navigateBack({ delta: 1 });
        } else {
          // 无法证明首页能启动防尾击门时不冒险回卡；保留已保存总结，
          // 直接使用宿主正式退出能力，下一次进入仍可读取最近骑行。
          wx.exitMiniProgram({});
        }
      } else {
        wx.exitMiniProgram({});
      }
      exited = true;
    } catch (_error) {
      try {
        if (this.agentExitDestination === 'home') {
          if (returnHintStored) clearRideFinishedHint(wx);
          wx.exitMiniProgram({});
          exited = true;
        }
      } catch (_ignored) {}
    }
    this.agentExitDispatching = false;
    if (exited) {
      this.agentExitDispatched = true;
      return true;
    }
    if (!exited) {
      this.agentExitRequested = false;
      return false;
    }
    return false;
  },

  closeAgent(source = 'backspace') {
    if (this.agentExitRequested) return false;
    if (this.isSummaryPhase()
        && this.summaryPersistenceConfirmed !== true) {
      if (!this.summaryFinalizationStarted) {
        this.finalizeRideAfterSummaryCommit();
      } else if (this.persistRideSummaryCommit()) {
        this.startCommittedRideUpload();
      }
      if (this.summaryPersistenceConfirmed !== true) {
        this.summaryExitPending = true;
        this.pendingSummaryExitSource = source;
        this.setData({
          summaryUploadText: '日志保存中 · 正在重试',
          summaryExitText: '正在保存，请稍候',
        });
        this.retryRideSummaryPersistence().then((stored) => {
          if (!stored || !this.summaryExitPending || this.agentExitRequested) return;
          const pendingSource = this.pendingSummaryExitSource || source;
          this.summaryExitPending = false;
          this.pendingSummaryExitSource = '';
          this.completeAgentExit(pendingSource);
        });
        return false;
      }
    }
    return this.completeAgentExit(source);
  },

  completeAgentExit(source = 'backspace') {
    if (this.agentExitRequested) return false;
    this.summaryExitPending = false;
    this.pendingSummaryExitSource = '';
    this.agentExitRequested = true;
    this.agentExitDestination = this.returnToHomeCard === true
      && this.summaryEnteredAtMs != null ? 'home' : 'app';
    this.pageVisible = false;
    this.cancelSummaryAiAdvice();
    this.clearSummaryExitPrompt();
    this.clearSurfaceTimers();
    this.stopTicker();
    this.stopRideImu();
    this.clearTtsRuntime({ resetDedupe: true });
    this.stopCadenceCue({ destroy: true });
    this.agentExitTimer = setTimeout(
      () => this.dispatchAgentExit(),
      BLE_EXIT_CLEANUP_WAIT_MS,
    );
    Promise.resolve(this.beginTerminalBleCleanup())
      .catch(() => false)
      .then(() => this.dispatchAgentExit());
    return source !== '';
  },

  clearSurfaceTimers() {
    this.surfaceGeneration = (this.surfaceGeneration || 0) + 1;
    this.clearPendingSurfaceGlobalHook();
    this.clearSearchConnectResumeTimer();
    this.clearRideStartTimer();
    this.clearWarmupTimer();
    this.cancelWarmupTts();
    if (this.summaryExitPromptTimer) clearTimeout(this.summaryExitPromptTimer);
    this.summaryExitPromptTimer = null;
    if (this.summaryFinalizeTimer) clearTimeout(this.summaryFinalizeTimer);
    this.summaryFinalizeTimer = null;
  },

  onHostFocus() {
    // 新版宿主可能在同一次滑动的 keydown 与 keyup 之间重建焦点会话。
    // 页面只在 keyup 提交方向，这里不改焦点，也不清方向去重历史。
  },

  onHostBlur() {
    // blur 只取消尚未判定的轻触；迟到方向别名仍须与滑动前半段收敛。
    const guardUntilMs = this.surfaceEntryConfirmGuardUntilMs;
    this.clearPendingSurfaceGlobalHook();
    this.surfaceEntryConfirmGuardUntilMs = guardUntilMs;
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (!this.isSurfaceDirectionCode(code) || !this.canHandleSurfaceDirection()) return;
    // AIUI 0.15 的焦点迁移统一在 onKeyUp 提交；
    // keydown 不改焦点，也不生成任何用户可见文字。
  },

  onKeyUp(event) {
    const code = event && event.code;
    const isStableConfirm = code === 'Enter' || code === 'NumpadEnter'
      || code === 'Space';
    const isSurfaceConfirm = isStableConfirm || code === 'GlobalHook';
    // GlobalHook 是宿主镜腿触摸通道；只要页面收到 keyup，就必须同步拦截
    // 宿主默认动作。后续每个分支都会提供页面自己的单击、双击或等待语义。
    if (code === 'GlobalHook'
        && event && typeof event.preventDefault === 'function') event.preventDefault();
    if (this.agentExitRequested) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }
    // AIUI 0.15 的 setData 可能迟于同步 session 真值。活动骑行必须在任何
    // surfacePhase/多目标页判断之前接管确认，否则 stale ready 会把双击误送到
    // search-double-tap 并直接 wx.exitMiniProgram。两击都只走 HUD 结束状态机。
    if (this.canAcceptRideRuntimeData() && isSurfaceConfirm) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.clearPendingSurfaceGlobalHook();
      this.onHudConfirmKey(code);
      return;
    }
    if (code === 'Backspace') {
      this.clearPendingSurfaceGlobalHook();
      if (this.isTimedGuidePhase()) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.onRideGuideBack();
        return;
      }
      if (this.isSummaryPhase()) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const now = Date.now();
        if (this.summaryEnteredAtMs != null
            && now - this.summaryEnteredAtMs < SUMMARY_CONFIRM_ENTRY_GRACE_MS) {
          return;
        }
        if (this.lastSummaryBackspaceMs != null
            && now - this.lastSummaryBackspaceMs < SUMMARY_BACKSPACE_DEDUPE_MS) {
          return;
        }
        this.lastSummaryBackspaceMs = now;
        this.closeAgent('summary-backspace');
        return;
      }
      if (this.data.surfacePhase === 'settings') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.showFeatureMenu();
        return;
      }
      if (this.canAcceptRideRuntimeData()) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.finishRideToSummary();
        return;
      }
      if (this.isSearchPhase()) {
        writeScanExitHint(wx);
        this.stopScan();
        this.teardownBle({ terminal: true });
      }
      return;
    }
    if (this.data.surfacePhase === 'summary'
        && (code === 'ArrowDown' || code === 'ArrowRight')) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.startRecoveryGuide();
      return;
    }
    if (this.isSurfaceDirectionCode(code) && this.canHandleSurfaceDirection()) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.handleSurfaceDirection(code, Date.now());
      return;
    }
    const isMultiTarget = this.isMultiTargetSurface();
    if (code === 'GlobalHook' && isMultiTarget) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.deferSurfaceGlobalHook(Date.now());
      return;
    }
    if (this.isTimedGuidePhase() && isSurfaceConfirm) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      const pendingWarmupConfirmAlias = isStableConfirm
        && this.data.surfacePhase === 'warmup'
        && this.pendingSurfaceGlobalHookTimer
        && this.pendingSurfaceGlobalHookPhase === 'warmup';
      if (pendingWarmupConfirmAlias) {
        // 稳定确认接管同一实体确认的 GlobalHook 尾包。
        this.clearPendingSurfaceGlobalHook();
      } else if (isStableConfirm && this.data.surfacePhase === 'warmup') {
        this.releaseWarmupDirectionConfirmGuard(now);
      }
      if (this.isSurfaceEntryInputGuarded(now)) return;
      if (this.data.surfacePhase === 'warmup' && this.guideFocusIndex === 1) {
        this.skipWarmup();
      } else {
        this.onWarmupPrimaryTap();
      }
      return;
    }
    if (this.isSummaryPhase() && isSurfaceConfirm) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.onSummaryConfirmKey(code);
      return;
    }
    const pendingSearchAlias = isStableConfirm
      && this.isSearchPhase()
      && this.pendingSurfaceGlobalHookTimer
      && this.pendingSurfaceGlobalHookPhase === this.data.surfacePhase;
    if (pendingSearchAlias) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }
    if (isStableConfirm && isMultiTarget) this.clearPendingSurfaceGlobalHook();
    if (isSurfaceConfirm && code !== 'GlobalHook'
        && this.isSearchPhase() && this.searchFocusIndex === 0) return;
    if (isSurfaceConfirm && isMultiTarget) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (this.data.surfacePhase === 'menu' && this.isMenuEntryInputGuarded(now)) return;
      if (this.isSurfaceEntryInputGuarded(now)) return;
      if (this.lastSurfaceConfirmKeyMs != null
          && now - this.lastSurfaceConfirmKeyMs < SURFACE_CONFIRM_DEDUPE_MS) return;
      this.lastSurfaceConfirmKeyMs = now;
      this.activateMultiTargetFocused();
      return;
    }
  },
};
</script>

<page>
  <view class="immersive-root">
    <view class="feature-menu" ink:if="{{ surfacePhase === 'menu' }}">
      <view class="feature-head">
        <view class="feature-brand">
          <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
          <text class="feature-name">AIBike</text>
        </view>
        <text class="feature-chip">AI 骑行</text>
      </view>
      <text class="feature-slogan">自由骑行，智能相伴</text>
      <view class="feature-nav" role="navigation">
        <button
          ink:if="{{ menuHasWorkout }}"
          class="feature-main {{ menuWorkoutClass }}"
          tabindex="0"
          data-index="0"
          bindfocus="onMenuFocus"
          bindtap="openTodayWorkoutMode"
        >
          <text class="feature-main-title">{{ workoutPlanTitle }}</text>
          <text class="feature-main-sub">{{ workoutPlanSub }} · {{ workoutSyncText }}</text>
        </button>
        <button
          class="feature-main {{ menuRideClass }}"
          tabindex="1"
          data-index="1"
          bindfocus="onMenuFocus"
          bindtap="openFreeRideMode"
        >
          <text class="feature-main-title">自由骑</text>
          <text class="feature-main-sub">搜索骑行设备 · 进入骑行 HUD</text>
        </button>
        <button
          class="feature-secondary {{ menuSettingsClass }}"
          tabindex="2"
          data-index="2"
          bindfocus="onMenuFocus"
          bindtap="openSettingsMode"
        >
          <text class="feature-secondary-title">设置</text>
          <text class="feature-secondary-sub">轮周 · 设备 · 踏频提示</text>
        </button>
      </view>
    </view>

    <view class="warmup-screen" ink:if="{{ surfacePhase === 'warmup' || surfacePhase === 'recovery' }}">
      <view class="warmup-head">
        <view class="warmup-brand">
          <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
          <text class="warmup-title">{{ warmupHeading }}</text>
          <text class="warmup-overview">{{ warmupOverview }}</text>
        </view>
        <text class="warmup-step-count">{{ warmupStepCount }}</text>
      </view>
      <view class="warmup-card">
        <view class="warmup-figure">
          <text class="warmup-figure-step">{{ warmupStepCount }}</text>
          <view class="warmup-figure-line warmup-figure-line-long"></view>
          <view class="warmup-figure-line"></view>
          <view class="warmup-figure-line warmup-figure-line-short"></view>
          <text class="warmup-figure-label">跟随文字动作</text>
        </view>
        <view class="warmup-copy">
          <text class="warmup-action-title">{{ warmupTitle }}</text>
          <text class="warmup-instruction">{{ warmupInstruction }}</text>
          <text class="warmup-safety">{{ warmupSafety }}</text>
          <view class="warmup-countdown">
            <text class="warmup-remaining">{{ warmupRemaining }}</text>
            <text class="warmup-status">{{ warmupStatus }}</text>
          </view>
          <view class="warmup-nav" role="navigation">
            <button class="warmup-primary {{ warmupPrimaryClass }}" tabindex="0" data-index="0" bindfocus="onWarmupFocus" bindtap="onWarmupPrimaryTap">{{ warmupActionLabel }}</button>
            <button class="warmup-skip {{ warmupSkipClass }}" ink:if="{{ surfacePhase === 'warmup' }}" tabindex="1" data-index="1" bindfocus="onWarmupFocus" bindtap="skipWarmup">{{ warmupSkipLabel }}</button>
          </view>
        </view>
      </view>
      <text class="warmup-foot">{{ warmupFoot }}</text>
    </view>

    <view class="settings-screen" ink:if="{{ surfacePhase === 'settings' }}">
      <view class="settings-top">
        <text class="settings-title">骑行设置</text>
        <text class="settings-chip">{{ settingsSaveState }}</text>
      </view>
      <scroll-view class="settings-scroll" scroll-y="true">
      <view class="settings-list" role="navigation">
        <button class="setting-row {{ settingWheelClass }}" tabindex="0" data-setting="wheel" data-index="0" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">轮周</text><text class="setting-value">{{ settingWheel }}</text>
        </button>
        <button class="setting-row {{ settingDeviceClass }}" tabindex="1" data-setting="device" data-index="1" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">心率设备</text><text class="setting-value">{{ settingDevice }}</text>
        </button>
        <button class="setting-row {{ settingMaxHeartRateClass }}" tabindex="2" data-setting="max-heart-rate" data-index="2" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">最大心率</text><text class="setting-value">{{ settingMaxHeartRate }}</text>
        </button>
        <button class="setting-row {{ settingFtpClass }}" tabindex="3" data-setting="ftp" data-index="3" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">FTP</text><text class="setting-value">{{ settingFtp }}</text>
        </button>
        <button class="setting-row {{ settingRideGoalClass }}" tabindex="4" data-setting="ride-goal" data-index="4" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">骑行目标</text><text class="setting-value">{{ settingRideGoal }}</text>
        </button>
        <button class="setting-row {{ settingVoiceCueClass }}" tabindex="5" data-setting="voice" data-index="5" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">语音提示</text><text class="setting-value">{{ settingVoiceCue }}</text>
        </button>
        <button class="setting-row {{ settingCadenceCueClass }}" tabindex="6" data-setting="cadence" data-index="6" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">踏频提示</text><text class="setting-value">{{ settingCadenceCue }}</text>
        </button>
        <button class="setting-row {{ settingLocalLogClass }}" tabindex="7" data-setting="local-log" data-index="7" bindfocus="onSettingFocus" bindtap="onSettingTap">
          <text class="setting-name">本地诊断</text><text class="setting-value">{{ settingLocalLog }}</text>
        </button>
        <view class="setting-info">
          <text class="setting-name">无外设模式</text><text class="setting-value">眼镜 IMU 估算三项</text>
        </view>
      </view>
      </scroll-view>
      <text class="settings-foot">确认键切换 · 返回训练菜单</text>
    </view>

    <view class="search-screen" ink:if="{{ surfacePhase === 'ready' || surfacePhase === 'connecting' }}">
      <view class="search-head">
        <view class="search-brand">
          <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
          <text class="search-title">准备骑行</text>
        </view>
        <text class="search-subtitle">{{ searchText }}</text>
      </view>
      <view class="control-card">
        <text class="card-kicker">标准骑行设备</text>
        <text class="card-subtitle">{{ searchChip }} · {{ scanProgressText }}</text>
        <text class="agent-start-text" ink:if="{{ agentStartText }}">{{ agentStartText }}</text>
        <view class="search-primary-nav" role="navigation">
          <button
            class="primary-button {{ searchPrimaryClass }}"
            tabindex="0"
            data-focus-index="0"
            bindfocus="onSearchFocus"
            bindtap="onScanTap"
          >{{ primaryLabel }}</button>
        </view>
        <view class="scan-key-guide">
          <text class="scan-key-line">{{ scanKeyGuide }}</text>
          <text class="scan-key-line">{{ scanExitGuide }}</text>
        </view>
      </view>
      <view class="list-card">
        <text class="card-kicker">设备列表</text>
        <text class="pre-ride-brief">{{ preRideBrief }}</text>
        <text class="pre-ride-trend" ink:if="{{ discoveredDeviceCount === 0 }}">{{ preRideTrend }}</text>
        <text class="hint" ink:if="{{ discoveredDeviceCount === 0 }}">{{ scanDiagnostic }}</text>
        <button
          class="device-row {{ item.deviceFocusClass }}"
          ink:for="{{ discoveredDevices }}"
          ink:key="deviceId"
          data-id="{{ item.deviceId }}"
          data-focus-index="{{ item.focusIndex }}"
          tabindex="{{ item.focusIndex }}"
          bindfocus="onSearchFocus"
          bindtap="selectDevice"
        >
          <text class="device-row-name">{{ item.deviceName }}</text>
          <text class="device-row-meta">{{ item.deviceMeta }}</text>
          <text class="device-row-status">{{ item.status }}</text>
        </button>
      </view>
    </view>

    <view class="summary-wrap" ink:if="{{ surfacePhase === 'summary' }}">
      <view class="summary-card">
        <view class="summary-head">
          <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
          <text class="summary-title">骑行总结</text>
          <text class="summary-chip">{{summaryUploadText}}</text>
        </view>
        <view class="summary-grid">
          <view class="summary-cell">
            <text class="summary-value">{{ sumDistance }}</text>
            <text class="summary-label">公里</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ sumElapsed }}</text>
            <text class="summary-label">用时</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ sumSpeed }}</text>
            <text class="summary-label">均速 km/h</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ sumCadence }}</text>
            <text class="summary-label">平均踏频 rpm</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ sumHeartRate }}</text>
            <text class="summary-label">平均心率 bpm</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ sumPower }}</text>
            <text class="summary-label">平均功率 W</text>
          </view>
        </view>
        <view class="summary-chart-card" ink:if="{{ showSummaryChart }}">
          <view class="summary-chart-head">
            <text class="summary-chart-title">{{ summaryChartTitle }}</text>
            <text class="summary-chart-unit">{{ summaryChartUnit }}</text>
          </view>
          <chart
            class="summary-chart"
            type="line"
            series="{{ summaryChartSeries }}"
            data="{{ summaryChartData }}"
            y-axis="{{ summaryChartYAxis }}"
            x-axis="{{ summaryChartXAxis }}"
            width="420"
            height="34"
            smooth="false"
            animate="false"
          ></chart>
        </view>
        <view class="summary-chart-card summary-chart-empty" ink:else>
          <text class="summary-chart-empty-text">{{ summaryChartEmptyText }}</text>
        </view>
        <view class="summary-advice">
          <text class="summary-plan">{{ summaryPlanText }}</text>
          <text class="summary-advice-title">{{ sumAdviceTitle }}</text>
          <text class="summary-review">{{ sumReview }}</text>
          <text class="summary-trend">{{ sumTrend }}</text>
          <text class="summary-source-note">{{ sumSourceNote }}</text>
        </view>
        <text class="summary-exit">{{ summaryExitText }}</text>
      </view>
    </view>

    <view class="hud-wrap" ink:if="{{ surfacePhase === 'hud' }}">
      <view class="hud">
        <view class="ride-screen">
          <view class="hud-top">
            <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
            <text class="hud-environment" ink:if="{{ !hudHint }}">{{ hudEnvironment }}</text>
            <text class="hud-hint" ink:if="{{ hudHint }}">{{ hudHint }}</text>
            <view class="hud-status-group">
              <text class="mode-chip" ink:if="{{ !hudHint }}">{{ cyclingSourceText }}</text>
              <text class="mode-chip" ink:if="{{ showPower && !hudHint }}">{{ powerChipText }}</text>
            </view>
          </view>

          <view class="workout-stage" ink:if="{{ workoutStageVisible && !hudHint }}">
            <text class="workout-stage-title">{{ workoutStageTitle }}</text>
            <text class="workout-stage-time">{{ workoutStageRemaining }}</text>
            <text class="workout-stage-target">{{ workoutStageTarget }}</text>
          </view>

          <view class="unified-grid" ink:if="{{ showHeartRate }}">
            <view class="zone">
              <view class="{{ dot5 }}"></view>
              <view class="{{ dot4 }}"></view>
              <view class="{{ dot3 }}"></view>
              <view class="{{ dot2 }}"></view>
              <view class="{{ dot1 }}"></view>
            </view>
            <view class="ride-metric">
              <text class="ride-value {{ heartRateValueStateClass }}">{{ heartRate }}</text>
              <text class="metric-label metric-label-status">{{ heartRateStatus }}</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value {{ cadenceValueStateClass }}">{{ cadence }}</text>
              <text class="metric-label">踏频</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value {{ distanceValueStateClass }} {{ distanceMod }}">{{ distance }}</text>
              <text class="metric-label">距离</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value {{ elapsedValueStateClass }} {{ elapsedMod }}">{{ elapsed }}</text>
              <text class="metric-label">时长</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value {{ speedValueStateClass }}">{{ speed }}</text>
              <text class="metric-label">速度</text>
            </view>
          </view>

          <view class="glasses-grid" ink:if="{{ !showHeartRate }}">
            <view class="ride-metric">
              <text class="ride-value ride-value-big {{ cadenceValueStateClass }}">{{ cadence }}</text>
              <text class="metric-label">踏频</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value ride-value-big {{ distanceValueStateClass }} {{ gDistanceMod }}">{{ distance }}</text>
              <text class="metric-label">距离</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value ride-value-big {{ elapsedValueStateClass }} {{ gElapsedMod }}">{{ elapsed }}</text>
              <text class="metric-label">时长</text>
            </view>
            <view class="ride-metric">
              <text class="ride-value ride-value-big {{ speedValueStateClass }}">{{ speed }}</text>
              <text class="metric-label">速度</text>
            </view>
          </view>
        </view>
      </view>
    </view>
  </view>
</page>

<style>
.immersive-root {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  margin: 0 auto;
  padding: 0;
  background-color: var(--color-background, #000000);
  overflow: hidden;
}

.feature-menu,
.settings-screen,
.search-screen,
.summary-wrap,
.hud-wrap {
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  background-color: var(--color-background, #000000);
}

.feature-menu,
.settings-screen,
.search-screen,
.summary-card {
  display: flex;
  flex-direction: column;
}

.feature-menu {
  padding: 12px 18px;
}

.feature-head,
.feature-brand,
.settings-top,
.search-head,
.search-brand,
.summary-head,
.summary-chart-head,
.setting-row,
.setting-info,
.device-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.feature-head,
.settings-top,
.summary-head,
.summary-chart-head {
  justify-content: space-between;
}

.feature-brand,
.search-brand {
  justify-content: flex-start;
}

.bike-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  margin: 0 10px 0 0;
  border-width: 2px;
  border-style: solid;
  border-color: var(--color-primary, #40ff5e);
  border-radius: 12px;
}

.bike-logo-text {
  color: var(--color-primary, #40ff5e);
  font-size: 12px;
  line-height: 16px;
  font-weight: bold;
  font-family: monospace;
}

.feature-name,
.search-title,
.settings-title,
.summary-title {
  color: var(--color-primary, #40ff5e);
  font-size: 24px;
  line-height: 32px;
  font-weight: bold;
  font-family: monospace;
}

.feature-chip,
.settings-chip,
.summary-chip,
.mode-chip {
  box-sizing: border-box;
  padding: 4px 10px;
  color: var(--color-primary, #40ff5e);
  font-size: 13px;
  line-height: 18px;
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  border-radius: 12px;
}

.feature-slogan {
  margin: 5px 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 18px;
  line-height: 24px;
  text-align: center;
}

.feature-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.feature-main,
.feature-secondary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  width: 444px;
  height: 70px;
  padding: 7px 18px;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  border: 0;
  border-radius: 12px;
}

.feature-main-title,
.feature-secondary-title {
  color: var(--color-primary, #40ff5e);
  font-size: 21px;
  line-height: 26px;
  font-weight: bold;
}

.feature-main-sub,
.feature-secondary-sub {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 17px;
}

.feature-main.feature-focused,
.feature-secondary.feature-focused,
.setting-row.setting-row-focused,
.primary-button.search-target-focused,
.device-row.device-row-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.warmup-screen {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  padding: 12px 18px 8px;
  background-color: var(--color-background, #000000);
}

.warmup-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 444px;
  height: 38px;
}

.warmup-brand {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
}

.warmup-title {
  color: var(--color-primary, #40ff5e);
  font-size: 24px;
  line-height: 32px;
  font-weight: bold;
  font-family: monospace;
}

.warmup-overview {
  margin-left: 8px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 16px;
}

.warmup-step-count,
.warmup-status,
.warmup-safety,
.warmup-foot {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 18px;
}

.warmup-card {
  display: flex;
  flex-direction: row;
  align-items: center;
  box-sizing: border-box;
  width: 444px;
  height: 258px;
  margin-top: 6px;
  padding: 10px 14px;
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  border-radius: 12px;
  background-color: var(--color-surface, #000000);
}

.warmup-figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex-shrink: 0;
  width: 176px;
  height: 220px;
  margin-right: 18px;
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  border-radius: 12px;
}

.warmup-figure-step,
.warmup-figure-label {
  color: var(--color-primary, #40ff5e);
  font-family: monospace;
  text-align: center;
}

.warmup-figure-step {
  font-size: 20px;
  line-height: 28px;
  font-weight: bold;
}

.warmup-figure-label {
  margin-top: 12px;
  font-size: 12px;
  line-height: 18px;
}

.warmup-figure-line {
  width: 82px;
  height: 2px;
  margin-top: 12px;
  background-color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.warmup-figure-line-long {
  width: 112px;
}

.warmup-figure-line-short {
  width: 54px;
}

.warmup-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  width: 222px;
  height: 232px;
}

.warmup-action-title {
  color: var(--color-primary, #40ff5e);
  font-size: 22px;
  line-height: 28px;
  font-weight: bold;
}

.warmup-instruction {
  margin-top: 6px;
  color: var(--color-primary, #40ff5e);
  font-size: 14px;
  line-height: 20px;
}

.warmup-safety {
  margin-top: 5px;
}

.warmup-countdown {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}

.warmup-remaining {
  color: var(--color-primary, #40ff5e);
  font-size: 24px;
  line-height: 30px;
  font-weight: bold;
  font-family: monospace;
}

.warmup-primary,
.warmup-skip {
  box-sizing: border-box;
  width: 222px;
  height: 30px;
  margin-top: 6px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.warmup-nav {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 222px;
}

.warmup-primary {
  color: var(--color-primary, #40ff5e);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.warmup-skip {
  margin-top: 4px;
  color: var(--color-primary, #40ff5e);
  background-color: transparent;
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.warmup-primary.warmup-control-focused,
.warmup-skip.warmup-control-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.warmup-foot {
  display: block;
  width: 444px;
  margin-top: 4px;
  text-align: center;
}

.settings-screen {
  padding: 14px 18px;
}

.settings-top {
  height: 40px;
}

.settings-scroll {
  width: 444px;
  height: 260px;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0;
}

.setting-row,
.setting-info {
  justify-content: space-between;
  box-sizing: border-box;
  width: 444px;
  height: 38px;
  padding: 0 12px;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  border: 0;
  border-radius: 12px;
}

.setting-info {
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

.setting-name {
  color: var(--color-primary, #40ff5e);
  font-size: 15px;
  line-height: 20px;
}

.setting-value {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 20px;
}

.settings-foot {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}

.search-screen {
  padding: 12px 18px;
}

.search-head {
  justify-content: space-between;
  height: 42px;
}

.search-subtitle {
  width: 240px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 20px;
  text-align: right;
}

.control-card,
.list-card,
.summary-chart-card {
  box-sizing: border-box;
  width: 444px;
  background-color: var(--color-surface, #000000);
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  border-radius: 12px;
}

.control-card {
  height: 130px;
  padding: 8px 12px;
}

.list-card {
  height: 156px;
  margin-top: 8px;
  padding: 8px 12px;
}

.card-kicker {
  color: var(--color-primary, #40ff5e);
  font-size: 14px;
  line-height: 18px;
  font-weight: bold;
}

.card-subtitle,
.agent-start-text,
.hint,
.scan-key-line,
.device-row-meta,
.device-row-status {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 16px;
}

.pre-ride-brief {
  margin: 4px 0 1px;
  color: var(--color-primary, #40ff5e);
  font-size: 12px;
  line-height: 16px;
}

.pre-ride-trend {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 15px;
}

.search-primary-nav {
  width: 418px;
  height: 40px;
  margin: 6px 0;
}

.primary-button {
  box-sizing: border-box;
  width: 418px;
  height: 40px;
  padding: 0;
  color: var(--color-primary, #40ff5e);
  font-size: 17px;
  line-height: 22px;
  font-weight: bold;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  border: 0;
  border-radius: 12px;
}

.scan-key-guide {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
}

.device-row {
  justify-content: space-between;
  box-sizing: border-box;
  width: 418px;
  height: 34px;
  padding: 0 8px;
  background-color: transparent;
  border: 0;
  border-radius: 8px;
}

.device-row-name {
  width: 220px;
  color: var(--color-primary, #40ff5e);
  font-size: 14px;
  line-height: 18px;
}

.device-row-meta {
  width: 80px;
  text-align: center;
}

.device-row-status {
  width: 72px;
  text-align: right;
}

.summary-wrap {
  padding: 12px 18px;
}

.summary-card {
  height: 328px;
}

.summary-head {
  height: 38px;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 4px;
  margin: 6px 0;
}

.summary-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 44px;
  border-width: 1px;
  border-style: solid;
  border-color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  border-radius: 12px;
}

.summary-value {
  color: var(--color-primary, #40ff5e);
  font-size: 17px;
  line-height: 21px;
  font-weight: bold;
  font-family: monospace;
}

.summary-label {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 10px;
  line-height: 13px;
}

.summary-chart-card {
  height: 64px;
  padding: 5px 10px;
}

.summary-chart-head {
  height: 18px;
}

.summary-chart-title,
.summary-chart-unit {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 16px;
}

.summary-chart {
  width: 420px;
  height: 34px;
}

.summary-chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}

.summary-chart-empty-text {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 18px;
}

.summary-advice {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 98px;
  margin: 3px 0 0;
}

.summary-advice-title {
  color: var(--color-primary, #40ff5e);
  font-size: 14px;
  line-height: 18px;
  font-weight: bold;
  text-align: center;
}

.summary-plan {
  color: var(--color-primary, #40ff5e);
  font-size: 11px;
  line-height: 15px;
  text-align: center;
}

.summary-review {
  color: var(--color-primary, #40ff5e);
  font-size: 12px;
  line-height: 16px;
  text-align: center;
}

.summary-trend {
  color: var(--color-primary, #40ff5e);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
}

.summary-source-note {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 10px;
  line-height: 13px;
  text-align: center;
}

.summary-exit {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.hud-wrap {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
}

.hud {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: var(--color-background, #000000);
  border-radius: var(--radius-md, 12px);
}

/* 实时信息贴底，中央道路视野保持完整空白。 */
.ride-screen {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  box-sizing: border-box;
  width: 476px;
  height: 348px;
  padding: 5px 10px 4px;
}

.hud-top {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  width: 456px;
  height: 26px;
  margin: 0 0 3px;
}

.hud-top .bike-logo {
  width: 26px;
  height: 26px;
  margin: 0;
}

.hud-environment {
  width: 154px;
  height: 26px;
  margin: 0 0 0 8px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 15px;
  line-height: 26px;
  font-weight: bold;
}

.hud-hint {
  margin: 0 0 0 8px;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 14px;
  line-height: 26px;
}

.mode-chip {
  height: 24px;
  padding: 0 9px;
  border-width: 2px;
  border-style: solid;
  border-color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  border-radius: 12px;
  color: var(--color-primary, #40ff5e);
  font-size: 16px;
  line-height: 22px;
  font-weight: bold;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.hud-status-group {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  flex-grow: 1;
  column-gap: 6px;
  height: 26px;
}

.workout-stage {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  width: 456px;
  height: 24px;
  margin: 0 0 3px;
  padding: 0 8px;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  border-radius: 8px;
}

.workout-stage-title,
.workout-stage-time,
.workout-stage-target {
  color: var(--color-primary, #40ff5e);
  font-size: 13px;
  line-height: 24px;
  font-weight: bold;
}

.workout-stage-title {
  width: 120px;
}

.workout-stage-time {
  width: 70px;
  font-family: monospace;
}

.workout-stage-target {
  flex-grow: 1;
  text-align: right;
}

.unified-grid,
.glasses-grid {
  display: grid;
  width: 456px;
  height: 76px;
  column-gap: 5px;
  align-items: center;
}

.unified-grid {
  grid-template-columns: 14px 68px 60px 80px 94px 115px;
}

.glasses-grid {
  grid-template-columns: 84px 92px 116px 149px;
}

.ride-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 76px;
  border: 0;
  border-radius: 0;
  background-color: transparent;
}

.ride-value {
  color: var(--color-primary, #40ff5e);
  font-size: 28px;
  line-height: 32px;
  font-weight: bold;
  font-family: monospace;
  text-align: center;
}

.ride-value-big {
  font-size: 34px;
  line-height: 36px;
}

.ride-value-pending {
  font-size: 14px;
  line-height: 20px;
}

.v-mid {
  font-size: 23px;
  line-height: 28px;
}

.v-sm {
  font-size: 14px;
  line-height: 20px;
}

.g-mid {
  font-size: 28px;
  line-height: 32px;
}

.g-sm {
  font-size: 24px;
  line-height: 28px;
}

.glasses-grid .ride-value-pending {
  font-size: 21px;
  line-height: 27px;
}

.metric-label {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 18px;
  line-height: 20px;
  font-weight: bold;
  text-align: center;
}

.metric-label-status {
  font-size: 12px;
  line-height: 20px;
}

.zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 76px;
}

.dot {
  width: 10px;
  height: 6px;
  margin: 0 0 5px;
  border-radius: 3px;
  background-color: var(--color-primary-16, rgba(64, 255, 94, 0.16));
}

.dot.dot-on {
  background-color: var(--color-primary, #40ff5e);
}
</style>
