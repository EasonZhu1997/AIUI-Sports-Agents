<script type="application/json" def>
{
  "navigationBarTitleText": "跑步教练"
}
</script>

<script setup>
// 主动开跑数据页:进入 02 后在可交互前台循环搜索心率；“下一步”始终立即开始记录。
//   03 跑步页是纯展示卡片；眼镜模式不占心率位，后续接入心率后同屏补充心率列。
//   距离/配速/步频：眼镜自带加速度计计步 → 步长积分估算(无需任何外设,粗估仅供参考)。
//   息屏/切页自动暂停记录,回来自动继续 —— 时长与距离口径一致,不会"时长照走距离冻结"。
//   跑步中 Backspace 只清空三次确认进度；三次独立确认才进入跑后放松。
//   总结页 Backspace、镜腿双击或双确认都是“清理资源后关闭智能体”的明确替代动作。
import wx from 'wx';
import { Sound } from 'audio';
import { RunSession } from '../../lib/session.js';
import { parseHeartRateMeasurement } from '../../lib/hr.js';
import {
  clearHeartRatePolicyStorage,
  heartRatePolicyConfidence,
  heartRateZoneFromPolicy,
  isConservativeHighHeartRate,
  isPersistableHeartRatePolicy,
  normalizeHeartRatePolicy,
  readHeartRatePolicy,
  sameHeartRatePolicyOwner,
  writeHeartRatePolicy,
} from '../../lib/heart_rate_policy.js';
import { StepDetector, SensorTimestampNormalizer } from '../../lib/imu.js';
import { ImuArmingGate } from '../../lib/imu_arming.js';
import { ImuActivityGate } from '../../lib/imu_activity_gate.js';
import { DualStepArbiter } from '../../lib/dual_step_detector.js';
import { MotionMetrics, MOTION_SOURCE } from '../../lib/motion_metrics.js';
import {
  MOTION_QUALITY_STATE,
  MotionQualityGate,
} from '../../lib/motion_quality.js';
import {
  ADAPTIVE_STRIDE_LEGACY_STORAGE_KEYS,
  ADAPTIVE_STRIDE_STORAGE_KEY,
  AdaptiveStrideModel,
  effectiveImuStepLengthM,
} from '../../lib/adaptive_stride.js';
import { MotionSpeedFusion } from '../../lib/speed_fusion.js';
import { SensorAlignment } from '../../lib/sensor_alignment.js';
import { parseRscMeasurement } from '../../lib/rsc.js';
import { Metronome } from '../../lib/metronome.js';
import { nextProactiveCue } from '../../lib/coach.js';
import { writeLiveSnapshot, clearLiveSnapshot } from '../../lib/live.js';
import { buildLocalRunMemoryContext } from '../../lib/local_run_memory.js';
import {
  buildRunUploadPayload,
  buildRunUploadRequest,
  enqueueRunUpload,
  isPermanentRunUploadRejection,
  normalizeRunUploadPayload,
  parseRunUploadResponse,
  readPendingRunUploadsState,
  removePendingRunUpload,
} from '../../lib/run_upload.js';
import {
  AIUI_CALIBRATION_BATCH_SIZE,
  AIUI_CALIBRATION_MAX_EVENTS,
  appendPendingAiuiCalibrationEvents,
  buildAiuiCalibrationRequest,
  captureAiuiCalibrationEvent,
  createAiuiCalibrationStream,
  isPermanentAiuiCalibrationRejection,
  parseAiuiCalibrationResponse,
  readPendingAiuiCalibrationEventsState,
  removePendingAiuiCalibrationEvents,
} from '../../lib/aiui_calibration.js';
import {
  RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS,
  appendRunningLocalFieldEvent,
  appendRunningLocalFieldSamples,
  beginRunningLocalFieldLog,
  buildLatestRunningLocalFieldLogDigest,
  buildRunningLocalFieldLogReplayLines,
  createRunningLocalFieldLogId,
  finishRunningLocalFieldLog,
  readLatestRunningLocalFieldLog,
  readRunningLocalFieldLogIndexResult,
  recoverActiveRunningLocalFieldLogs,
} from '../../lib/running_local_field_log.js';
import {
  appendRunUploadReceipt,
  createCalibrationUploadReceipt,
  createRunSummaryUploadReceipt,
  quarantineAiuiCalibrationEvent,
  quarantineRunUpload,
  readQuarantinedAiuiCalibrationEventsState,
  readQuarantinedRunUploadsState,
  summarizeRunUploadReceipts,
} from '../../lib/run_upload_records.js';
import {
  writePendingRunSummary, readPendingRunSummary, readPendingRunSummaryState,
  fallbackRunSummary,
  buildRunSummaryPrompt, finalizeRunSummaryText,
} from '../../lib/run_summary.js';
import { archivePendingRunSummary } from '../../lib/run_summary_archive.js';
import { flushPendingAiuiRecords } from '../../lib/aiui_record_upload.js';
import {
  readRunSettings,
  writeRunSettings,
  isRunSettingsPersisted,
  DEFAULT_RUN_SETTINGS,
  formatStrideM,
  formatSwitch,
  formatMetronomeBpm,
  nextStrideM,
  nextMetronomeBpm,
} from '../../lib/settings.js';
import {
  resolveCoachBackendConfig, COACH_TOKEN_STORAGE_KEY,
} from '../../lib/coach_api.js';
import {
  bootstrapDeviceIdentity,
  clearDeviceAuth,
  AIUI_ID_STORAGE_KEY,
  DEVICE_BINDING_STORAGE_KEY,
  DEVICE_CREDENTIAL_STORAGE_KEY,
  DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY,
  DEVICE_RECOVERY_STATE_STORAGE_KEY,
  DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY,
  DEVICE_SECRET_STORAGE_KEY,
  HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY,
  INSTALLATION_ID_STORAGE_KEY,
  LEGACY_COACH_TOKEN_STORAGE_KEY,
  LEGACY_DEVICE_ID_STORAGE_KEY,
  LEGACY_MIGRATION_STATE_STORAGE_KEY,
  IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
  PREIDENTITY_OWNER_STORAGE_KEY,
  PREIDENTITY_OWNER_VALUE,
  DEVICE_TOKEN_STORAGE_KEY,
  PUBLIC_DEVICE_ID_STORAGE_KEY,
  formatAiuiId,
  hasOwnerScopedPrivateData,
  recoverFreshAnonymousDeviceIdentity,
  ownerScopedDataAvailable,
} from '../../lib/device_identity.js';
import {
  markHostBackspaceIntent, writeRunFinishedHint, writeScanExitHint,
} from '../../lib/surface_resume.js';
import {
  unifiedPaceMod, unifiedDistMod, unifiedElapsedMod, glassesDistMod, glassesElapsedMod,
} from '../../lib/hud.js';
import {
  deviceDisplayName,
  matchesHeartRateDevice,
  readHeartRateDevice,
  writeHeartRateDevice,
} from '../../lib/devices.js';
import {
  CADENCE_PENDING,
  estimatePaceSecPerKmFromCadence,
  formatCadence, formatElapsed, formatPace, formatDistanceKm, formatBpm,
} from '../../lib/format.js';
import {
  normalizeWxJsonResponse, isJsonObjectResponse,
} from '../../lib/wx_json.js';
import {
  buildCurrentWorkoutRequest,
  parseCurrentWorkoutResponse,
  sameWorkoutPrescription,
} from '../../lib/workout_contract.js';
import {
  clearCachedWorkout,
  clearWorkoutExecutionCheckpoint,
  readCachedWorkout,
  readWorkoutExecutionCheckpoint,
  writeCachedWorkout,
  writeWorkoutExecutionCheckpoint,
} from '../../lib/workout_cache.js';
import {
  advanceWorkoutExecution,
  createWorkoutExecution,
  finishWorkoutExecution,
  normalizeWorkoutExecution,
  restoreWorkoutExecution,
  workoutProgressView,
} from '../../lib/workout_executor.js';
import {
  buildWorkoutCompletion,
  buildWorkoutCompletionRequest,
  enqueueWorkoutCompletion,
  isPermanentWorkoutCompletionRejection,
  parseWorkoutCompletionResponse,
  readPendingWorkoutCompletionsState,
  readQuarantinedWorkoutCompletionsState,
  quarantineWorkoutCompletion,
  removePendingWorkoutCompletion,
} from '../../lib/workout_completion.js';
import { initializeWorkoutOwnerStorage } from '../../lib/workout_owner_storage.js';
import {
  buildTrainingPreset,
  TRAINING_PRESET_IDS,
} from '../../lib/training_presets.js';
import {
  getRecoveryRhythmTtsCue,
  getRecoveryTtsCue,
  getRecoveryViewModel,
  RECOVERY_COMPLETION_TTS,
  RECOVERY_OVERVIEW_COPY,
  RECOVERY_STEP_DURATION_SEC,
  RECOVERY_STEP_COUNT,
} from '../../lib/recovery_guide.js';
import {
  getWarmupRhythmTtsCue,
  getWarmupTtsCue,
  getWarmupViewModel,
  WARMUP_OVERVIEW_COPY,
  WARMUP_STEP_COUNT,
} from '../../lib/warmup_guide.js';

function formatHudClock(nowMs = Date.now()) {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) return '--:--';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return hours + ':' + minutes;
}

const TICK_MS = 1000;
// AIUI 真机录屏/系统浮层可能把 setInterval 压到几十秒后才派发，但同一时期
// BLE notify 与 Generic Sensor reading 仍在到达。HUD 因此使用“定时器 +
// 数据事件”双入口；所有入口共用同一限频门，既能从计时器饥饿中恢复，也
// 不会让 50Hz IMU 把 setData 跨桥调用放大。
const SIGNAL_TICK_MIN_MS = 500;
const SIGNAL_TICK_STALL_LOG_MS = 2500;
const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';
const RSC_SERVICE_UUID = '00001814-0000-1000-8000-00805f9b34fb';
const RSC_MEASUREMENT_UUID = '00002a53-0000-1000-8000-00805f9b34fb';
const RSC_FEATURE_UUID = '00002a54-0000-1000-8000-00805f9b34fb';
const RSC_FRESH_MS = 2500;
// 当前步频断流后只短暂保留最后可信值，吸收相邻落步/1Hz HUD 采样的空档。
// 超过该窗口必须回到停步占位；全程平均步频只属于总结，不能冒充实时值。
const CADENCE_DISPLAY_HOLD_MS = 3500;
const IMU_HZ = 50;          // 加速度计采样率
const GYRO_HZ = 50;         // 角速度只做运动质量门，不积分距离
const ORIENTATION_HZ = 30;  // AIUI 0.15 绝对姿态；frequency 仍是 best-effort
const IMU_DIAGNOSTIC_INTERVAL_MS = 5000;
const CALIBRATION_PERSIST_EVERY = 5;
const CALIBRATION_DIAGNOSTIC_FRESH_MS = 3000;
const CALIBRATION_SATURATED_CAPTURE_INTERVAL_MS = 30000;
const LOCAL_FIELD_LOG_BUFFER_SAMPLES = 2;
const LOCAL_FIELD_LOG_REPLAY_BATCH_LINES = 8;
const LOCAL_FIELD_LOG_REPLAY_YIELD_MS = 16;
// RSC 服务存在但 2A53 长期无包时，5 秒重探会产生重复诊断。每一种噪声
// token 最多每 5 分钟落一次；首条立即保存，hide/summary 再强制保存窗口内
// 最新一条，避免长跑用数万次同步 index 写拖慢 HUD 或耗电。
const LOCAL_FIELD_LOG_NOISY_EVENT_INTERVAL_MS = 5 * 60 * 1000;
const LOCAL_FIELD_LOG_NOISY_EVENTS = [
  'RSC_PROBE_RETRY',
  'RSC_RETRY_SCHEDULED',
  'RSC_UNAVAILABLE',
  'RSC_SERVICE_FOUND',
  'RSC_SUBSCRIBED',
  'RSC_FEATURE',
  'RSC_FEATURE_INVALID',
  'RSC_FEATURE_UNAVAILABLE',
  'RSC_PACKET_INVALID',
  'RSC_DATA',
  'RSC_PROBE_TIMEOUT',
  'RSC_SILENT',
];
// 姿态投影已经去除大部分重力方向变化，使用比原始模长更低延迟的独立参数。
// 模长通道仍保留 StepDetector 默认门限，二者由 DualStepArbiter 只提交一次。
const PROJECTED_STEP_OPTIONS = Object.freeze({
  threshold: 0.24,
  noiseOffset: 0.05,
  noiseMultiplier: 2.8,
  smoothingTimeConstantMs: 25,
  signalThresholdRatio: 0.24,
});
const STRIDE_CALIBRATION_GAP_MS = 3500;
const DEFAULT_STRIDE_M = DEFAULT_RUN_SETTINGS.strideM;  // 粗估步长,可在设置页调整
const INITIAL_PACE = formatPace(null);
// 真机 bridge 冷启动可能远慢于模拟器；超时只结束 JS 等待并转入退避重试，
// 不再按代次拉黑（拉黑曾把一次慢调用放大成"整页蓝牙永久哑火"）。
const BLE_STOP_WAIT_MS = 1500;      // 异步扫描停止桥的最长等待
// 官方运行时的 BluetoothScan.stop() 在 JS 边界同步返回，但原生停扫是异步的。
// 给原生 BLE 栈一个很短的释放窗口，避免紧接着 connect() 偶发撞上尚未退出的扫描。
const BLE_NATIVE_SCAN_SETTLE_MS = 250;
// stopNotifications()/disconnect() 串行清理的单步上限：宿主 Promise 悬空也不能吞掉重试。
const BLE_CLEANUP_STEP_WAIT_MS = 600;
// 一条 HR+RSC+GATT 清理链最多约 1800ms；额外余量覆盖已经排队的前一条清理。
// 新扫描/连接只在该有界窗口内等待，超时后本次操作安全失败，绝不与旧 disconnect 竞跑。
const BLE_OPERATION_CLEANUP_WAIT_MS = 4000;
// GATT 整链(connect→服务→特征→订阅)的 JS 侧等待上限:真机 bridge 可悬空数秒到
// 永远,不设限会把 'connecting' 卡成永久假心率版面(看门狗只管 'connected')。
const BLE_CONNECT_TIMEOUT_MS = 10000;
const BLE_EXIT_CLEANUP_WAIT_MS = 800; // 退出前等 stopNotifications/disconnect，但不让宿主桥永久卡住关闭
const HUD_RECONNECT_DELAY_MS = 4000;  // 跑步中掉线:静默自动重连间隔
const HUD_RECONNECT_MAX = 5;
// 共享 GATT 上 RSC 仍在流动时，HRS 通知可能单独丢失。不拆 RSC/GATT，
// 只有界重新武装已有 2A37 notification；仅首个合法包才重置预算。
const HR_NOTIFY_RECOVERY_DELAY_MS = 1000;
const HR_NOTIFY_RECOVERY_RETRY_MS = 4000;
const HR_NOTIFY_RECOVERY_TIMEOUT_MS = 5000;
const HR_NOTIFY_RECOVERY_MAX = 5;
// 跑中总结检查点间隔:进程被系统杀掉时,下次前台代次仍能凭最近检查点后台归档。
const SUMMARY_CHECKPOINT_MS = 15000;
// 总结页可见期间的有界补传；无网或慢网仍保留 durable FIFO，
// 不会为了等 ACK 阻塞 800ms 快速退出。
const SUMMARY_HERMES_RETRY_DELAYS_MS = Object.freeze([3000, 8000, 15000]);
// HUD 结束必须由 3 次独立确认完成；3s 内相邻确认至少相隔 600ms，既覆盖
// GlobalHook/Enter/NumpadEnter 尾包，也保证 90–420ms 的触摸板双击最多只算一次。
const END_CONFIRM_WINDOW_MS = 3000;
const CONFIRM_KEY_DEDUPE_MS = 400;
const HUD_CONFIRM_REQUIRED_COUNT = 3;
const HUD_CONFIRM_INDEPENDENT_GAP_MS = 600;
const SURFACE_CONFIRM_DEDUPE_MS = 400;
// keyup 与 bindtap/TouchEnd 是两条独立宿主通道；一次实体手势只能激活一个动作。
// 这里故意不按 actionId 区分：页面自管焦点与宿主原生焦点可能不同，同一手势
// 的两个通道有机会落到不同按钮，仍必须整体吞掉第二次激活。
const SURFACE_ACTION_DEDUPE_MS = 600;
// 一次物理前划/后划在不同 Rokid 宿主上可能连续派发同键重复，或两个同语义
// 方向别名（例如 ArrowDown→ArrowRight）。同键重复只收敛 220ms，避免吞掉
// 用户快速连续滑动；异键别名按完整 600ms 手势窗收敛，兼容新版宿主迟到派发。
const DIRECTION_REPEAT_DEDUPE_MS = 220;
const DIRECTION_ALIAS_DEDUPE_MS = 600;
// 固定五个入口；服务端有“今日训练”时在最前方临时增加一项。
const MENU_FOCUS_COUNT = 5;
const TRAINING_FOCUS_COUNT = 5;
const SETTINGS_FOCUS_COUNT = 7;
// GlobalHook 是镜腿触摸的提前信号，可能先于同一手势的 ArrowUp/ArrowDown。
// 新版宿主的方向码可能在 220ms 后才到；用完整 600ms 手势窗等待方向码。
// 稳定 Enter/bindtap 仍可即时接管确认，因此只有 GlobalHook-only 老宿主会稍慢。
const GLOBAL_HOOK_DISAMBIGUATE_MS = 600;
// 搜索页把镜腿轻触同时解释为“单击确认 / 双击退出”。必须先等双击窗口结束，
// 才能提交第一次单击；否则第一击已把“开始搜索”变成“下一步”，第二击会误开跑。
// 过近的重复 GlobalHook 视为同一实体按压的宿主抖动，不得误判成双击。
const SEARCH_DOUBLE_TAP_WINDOW_MS = 420;
const SEARCH_DOUBLE_TAP_MIN_GAP_MS = 90;
// 总结页的镜腿双击必须独立于“同一次确认键的多键码别名”去重。
// 否则第二次真实 GlobalHook 会被下方 400ms 窗口误认为 Enter 别名而吞掉。
const SUMMARY_DOUBLE_TAP_WINDOW_MS = 420;
const SUMMARY_DOUBLE_TAP_MIN_GAP_MS = 90;
// 触摸板方向手势可能在 ArrowUp/Down/Left/Right 后附带 GlobalHook/TouchEnd。
// 清除跨页长保护时改为武装短释放保护，避免“刚移动焦点就自动选中”。
const DIRECTION_RELEASE_GUARD_MS = 600;
// 菜单确认切换到下一状态后，短暂禁止尾包继续执行“开始搜索/开始跑步/切设置”。
const SURFACE_ENTRY_CONFIRM_GRACE_MS = 700;
// 首页确认的同一次物理按压可能跨路由尾随 Enter / GlobalHook。目标页入场后
// 短暂隔离确认键；方向键会解除长保护并换成短释放保护，不妨碍马上下滑选择。
const MENU_ENTRY_CONFIRM_GRACE_MS = 800;
// 进入 HUD 的那次确认手势可能带一个尾随 keyup:入场宽限期内不武装结束。
const HUD_CONFIRM_GRACE_MS = 1200;
// 切入总结页的结束确认可能附带第二个键码；短窗口只吞尾包，之后总结页支持
// 独立的双确认退出。400ms 去重仍负责合并同一次实体按压的键码别名。
const SUMMARY_CONFIRM_ENTRY_GRACE_MS = 600;
const SUMMARY_LLM_TIMEOUT_MS = 8000;          // 重连预算;成功一次即重置
const BLE_READY_FALLBACK_MS = 500;  // 某些真机内部导航不派发 onReady；onShow 后有界兜底
// 真机证据(2026-07-12,官方 heart_rate 样例):services filter 在 Rokid 宿主
// 能扫到 Garmin fenix 8 的 0x180D 广播。用户手势只启动一次连续过滤扫描；
// 重复广播保留在诊断日志中，不在 UI 中伪装成需要等待的扫描轮次。
const HR_STALE_MS = 8000;           // 心率 8s 无新 notify 视为断连 → 静默回眼镜
// 首包宽限:订阅桥往返 + 表端广播拾取本身就要几秒,首包没到之前用更长的窗口,
// 否则"连上一会儿就被 8s 看门狗误杀主动断链"——真机报告的典型症状。
const HR_FIRST_PACKET_GRACE_MS = 20000;
// 版面唯一依据:15s 内收到过有效心率包 = 心率版面,否则眼镜版面。单一时间戳 +
// 单一常量,不做任何连接状态推断——状态机的一切毛病都影响不到版面;15s 保持
// 窗口盖住"掉线→4s 重连→首包回流"的整个周期,短暂断流不横跳。
const HR_UI_HOLD_MS = 15000;
// 上一次会话/上一次跑步的 BLE 资源宿主拆除可能滞后:扫描失败按梯次退避自动重试,
// 累计覆盖约 30s——只要用户停在搜索页,扫描最终一定被拉起来,不需要再点。
const SCAN_RETRY_DELAYS_MS = [1200, 2500, 5000, 5000, 8000, 8000];
const SEARCH_VISIBLE_DEVICE_ROWS = 4;
const ACCEL_STALE_MS = 10000;       // 传感器构造成功但 10s 无回调 → 原位重建
const ACCEL_RESUME_STALE_MS = 3000; // 系统录屏/浮层返回时，旧实例超过 3s 未读即重建
const IMU_RECOVERY_BASE_DELAY_MS = 1500;
const IMU_RECOVERY_MAX_DELAY_MS = 10000;
const RSC_PROBE_TIMEOUT_MS = 8000;
const RSC_PROBE_RETRY_DELAY_MS = 5000;
// 没有历史首选时也不要让第一个广播包在同一事件循环抢占 GATT；给附近
// 候选一个很短的有界汇集窗。有首选稳定 ID 时则只等它，其他 HRS 仅上屏。
const BLE_AUTO_CONNECT_SETTLE_MS = 1000;
// Generic Sensor 的 frequency 是 best-effort。录屏时真机可能长期只给 8–12Hz：
// 普通 StepDetector 仍保留主链路，下面的低频检测器只从连续真实回调的三点
// 局部峰恢复“峰发生时刻”，不插值/补造加速度帧，也不放宽活动确认门。
const LOW_RATE_IMU_MIN_INTERVAL_MS = 70;  // 约 14Hz
const LOW_RATE_IMU_MAX_INTERVAL_MS = 170; // 约 6Hz
const LOW_RATE_IMU_MAX_GAP_MS = 450;
const LOW_RATE_IMU_MIN_PROMINENCE_MPS2 = 0.32;
const LOW_RATE_IMU_MIN_PEAK_MPS2 = 0.12;
const LOW_RATE_IMU_RHYTHM_RESET_MS = 1800;
const START_CUE = '开跑，呼吸放稳。';
const RUN_STABILIZE_HINT = '请稳定跑约 5 秒';
const RUN_STABILIZE_MIN_MS = 5000;
// Sound/TTS 共用宿主音频焦点，但当前 AIUI 没有 TTS completion 回调。
// Z5 安全提示先停住已有节拍实例，用保守、有界的语音窗后只恢复同一实例。
const SAFETY_TTS_RESUME_MIN_MS = 3600;
const SAFETY_TTS_RESUME_MAX_MS = 6000;
const SAFETY_TTS_RESUME_BASE_MS = 1200;
const SAFETY_TTS_RESUME_PER_CHAR_MS = 160;
const DEVICE_REQUEST_TIMEOUT_MS = 12000;
// AIUI Sound.play() 会从头重播本地文件，部分真机还会为每次调用重建
// AudioTrack。按 BPM 预合成四拍小节，把跨桥播放从每拍一次降到每四拍一次；
// 首拍重音已经烘焙进文件，避免运行时反复写 volume。
const METRONOME_AUDIO_SOURCES = Object.freeze({
  160: '../../assets/audio/metro_0468_bar_160.wav',
  170: '../../assets/audio/metro_0468_bar_170.wav',
  180: '../../assets/audio/metro_0468_bar_180.wav',
});
const METRONOME_BEATS_PER_PLAYBACK = 4;
const LOCAL_TRAINING_OWNER = Object.freeze({
  ownershipEpoch: 1,
  dataNamespace: 'local:manual-training',
  publicDeviceId: 'LOCAL-TRAINING',
});
const SUMMARY_EXIT_COPY = '按返回键结束并关闭智能体';

function lowRateMedian(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

class LowRateImuStepDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastSampleAtMs = null;
    this.sampleIntervalsMs = [];
    this.samples = [];
    this.segmentFloor = null;
    this.lastPeakAtMs = null;
    this.startupPeriodsMs = [];
    this.periodsMs = [];
    this.transitionPeriodsMs = [];
    this.rhythmEstablished = false;
    this.lastCadenceSpm = 0;
    this.lastCadenceAtMs = null;
    this.acceptedPeaks = 0;
    this.active = false;
  }

  pause() {
    this.reset();
  }

  observe(dynamicMps2, timestampMs, quality = {}) {
    const idle = (reason) => ({
      stepped: false,
      cadenceReady: this._cadenceFresh(timestampMs),
      cadenceSpm: this._cadenceFresh(timestampMs)
        ? this.lastCadenceSpm : 0,
      candidateCadenceSpm: this.lastCadenceSpm,
      peakAtMs: null,
      strictEvidence: false,
      lowRateActive: this.active,
      channel: 'low_rate_magnitude',
      reason,
    });
    if (!Number.isFinite(dynamicMps2) || !Number.isFinite(timestampMs)) {
      return idle('low_rate_invalid');
    }
    if (this.lastSampleAtMs != null && timestampMs <= this.lastSampleAtMs) {
      this.reset();
    }
    if (this.lastSampleAtMs != null) {
      const intervalMs = timestampMs - this.lastSampleAtMs;
      if (intervalMs > LOW_RATE_IMU_MAX_GAP_MS) {
        this.reset();
      } else {
        this.sampleIntervalsMs.push(intervalMs);
        if (this.sampleIntervalsMs.length > 12) this.sampleIntervalsMs.shift();
      }
    }
    this.lastSampleAtMs = timestampMs;

    const effectiveIntervalMs = lowRateMedian(this.sampleIntervalsMs);
    const nextActive = this.sampleIntervalsMs.length >= 6
      && Number.isFinite(effectiveIntervalMs)
      && effectiveIntervalMs >= LOW_RATE_IMU_MIN_INTERVAL_MS
      && effectiveIntervalMs <= LOW_RATE_IMU_MAX_INTERVAL_MS;
    if (!nextActive) {
      if (this.active) {
        this.samples = [];
        this.segmentFloor = null;
        this._resetRhythm();
      }
      this.active = false;
      return idle('low_rate_inactive');
    }
    this.active = true;

    const stationaryConfidence = Number(quality.stationaryConfidence) || 0;
    const artifactConfidence = Number(quality.artifactConfidence) || 0;
    const gyroRms = Number(quality.gyroRms);
    const unsafeMotion = quality.state === MOTION_QUALITY_STATE.STATIONARY
      || quality.state === MOTION_QUALITY_STATE.HEAD_MOTION
      || stationaryConfidence >= 0.68
      || artifactConfidence >= 0.55
      || (quality.gyroFresh === true
        && Number.isFinite(gyroRms)
        && gyroRms >= 0.28);
    if (unsafeMotion) {
      this.samples = [];
      this.segmentFloor = null;
      this._resetRhythm();
      return idle('low_rate_quality_rejected');
    }

    if (this.lastPeakAtMs != null
        && timestampMs - this.lastPeakAtMs > LOW_RATE_IMU_RHYTHM_RESET_MS) {
      this._resetRhythm();
    }
    this.samples.push({ timestampMs, value: dynamicMps2 });
    if (this.samples.length > 3) this.samples.shift();
    this.segmentFloor = this.segmentFloor == null
      ? dynamicMps2 : Math.min(this.segmentFloor, dynamicMps2);
    if (this.samples.length < 3) return idle('low_rate_collecting');

    const [left, middle, right] = this.samples;
    const isLocalPeak = middle.value > left.value
      && middle.value >= right.value;
    if (!isLocalPeak) return idle('low_rate_no_peak');

    // 三点抛物线只修正峰时刻，绝不生成比真实相邻样本更多的检测帧。
    // 这能去掉 100/125ms 量化导致的 150/160/180spm 台阶，同时保持
    // MotionMetrics 仍只接收真正形成连续节奏的一个 accepted step。
    const denominator = left.value - 2 * middle.value + right.value;
    let sampleOffset = 0;
    if (denominator < -1e-6) {
      sampleOffset = 0.5 * (left.value - right.value) / denominator;
      sampleOffset = Math.max(-0.5, Math.min(0.5, sampleOffset));
    }
    const localIntervalMs = Math.max(
      1,
      (right.timestampMs - left.timestampMs) / 2,
    );
    const peakAtMs = middle.timestampMs + sampleOffset * localIntervalMs;
    const peakValue = middle.value
      - 0.25 * (left.value - right.value) * sampleOffset;
    const prominence = peakValue - Math.min(
      left.value,
      right.value,
      this.segmentFloor == null ? peakValue : this.segmentFloor,
    );
    this.segmentFloor = right.value;
    if (peakValue < LOW_RATE_IMU_MIN_PEAK_MPS2
        || prominence < LOW_RATE_IMU_MIN_PROMINENCE_MPS2) {
      return idle('low_rate_weak_peak');
    }

    const cadence = this._observePeak(peakAtMs);
    if (!(cadence > 0)) return idle('low_rate_rhythm_pending');
    this.lastCadenceSpm = cadence;
    this.lastCadenceAtMs = peakAtMs;
    this.acceptedPeaks += 1;
    return {
      stepped: true,
      cadenceReady: true,
      cadenceSpm: cadence,
      candidateCadenceSpm: cadence,
      peakAtMs,
      strictEvidence: true,
      lowRateActive: true,
      channel: 'low_rate_magnitude',
      reason: 'low_rate_rhythm',
    };
  }

  _observePeak(peakAtMs) {
    if (this.lastPeakAtMs == null) {
      this.lastPeakAtMs = peakAtMs;
      return 0;
    }
    const intervalMs = peakAtMs - this.lastPeakAtMs;
    if (intervalMs < 240) return 0;
    this.lastPeakAtMs = peakAtMs;
    if (intervalMs > 1250) {
      this._resetRhythm(peakAtMs);
      return 0;
    }
    if (!this.rhythmEstablished) {
      this.startupPeriodsMs.push(intervalMs);
      if (this.startupPeriodsMs.length > 2) this.startupPeriodsMs.shift();
      if (this.startupPeriodsMs.length < 2) return 0;
      if (!this._periodsConsistent(
        this.startupPeriodsMs[0],
        this.startupPeriodsMs[1],
      )) {
        this.startupPeriodsMs = [this.startupPeriodsMs[1]];
        return 0;
      }
      this.rhythmEstablished = true;
      this.periodsMs = this.startupPeriodsMs.slice();
      this.startupPeriodsMs = [];
      return this._cadenceFromPeriods();
    }

    const expectedMs = lowRateMedian(this.periodsMs);
    if (this._periodsConsistent(intervalMs, expectedMs)) {
      this.transitionPeriodsMs = [];
      this.periodsMs.push(intervalMs);
      if (this.periodsMs.length > 8) this.periodsMs.shift();
      return this._cadenceFromPeriods();
    }

    const previousTransition = this.transitionPeriodsMs[
      this.transitionPeriodsMs.length - 1
    ];
    if (Number.isFinite(previousTransition)
        && this._periodsConsistent(intervalMs, previousTransition)) {
      this.transitionPeriodsMs.push(intervalMs);
    } else {
      this.transitionPeriodsMs = [intervalMs];
    }
    if (this.transitionPeriodsMs.length < 2) return 0;
    this.periodsMs = this.transitionPeriodsMs.slice(-2);
    this.transitionPeriodsMs = [];
    return this._cadenceFromPeriods();
  }

  _periodsConsistent(leftMs, rightMs) {
    if (!(Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs > 0)) {
      return false;
    }
    return Math.abs(leftMs - rightMs)
      <= Math.max(95, rightMs * 0.3);
  }

  _cadenceFromPeriods() {
    const periodMs = lowRateMedian(this.periodsMs);
    if (!(periodMs >= 240 && periodMs <= 1250)) return 0;
    const cadenceSpm = Math.round(60000 / periodMs);
    return cadenceSpm >= 48 && cadenceSpm <= 250 ? cadenceSpm : 0;
  }

  _cadenceFresh(timestampMs) {
    return this.lastCadenceAtMs != null
      && Number.isFinite(timestampMs)
      && timestampMs >= this.lastCadenceAtMs
      && timestampMs - this.lastCadenceAtMs <= 2600
      && this.lastCadenceSpm > 0;
  }

  _resetRhythm(nextPeakAtMs = null) {
    this.lastPeakAtMs = Number.isFinite(nextPeakAtMs) ? nextPeakAtMs : null;
    this.startupPeriodsMs = [];
    this.periodsMs = [];
    this.transitionPeriodsMs = [];
    this.rhythmEstablished = false;
    this.lastCadenceSpm = 0;
    this.lastCadenceAtMs = null;
  }
}

function isPlausibleHudPace(value) {
  return Number.isFinite(value) && value > 0 && value <= 1800;
}

function isHighRiskHeartRateCue(text) {
  return String(text || '').includes('Z5');
}

function safetyTtsResumeDelayMs(text) {
  const estimated = SAFETY_TTS_RESUME_BASE_MS
    + String(text || '').length * SAFETY_TTS_RESUME_PER_CHAR_MS;
  return Math.max(
    SAFETY_TTS_RESUME_MIN_MS,
    Math.min(SAFETY_TTS_RESUME_MAX_MS, estimated),
  );
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

function classifyDeviceRequestError(error) {
  const message = String(
    error && (error.errMsg || error.message) ? (error.errMsg || error.message) : '',
  ).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('domain') || message.includes('whitelist')
      || message.includes('not allowed')
      || message.includes('\u5408\u6cd5\u57df\u540d')) return 'domain';
  return 'network';
}

export default {
  data: {
    bpm: '',
    pace: INITIAL_PACE,
    cadence: CADENCE_PENDING,
    elapsed: '00:00',
    distVal: '0.00',
    modeLabel: '眼镜模式',
    modeChipClass: 'mode-chip',
    footerClass: 'coach-line',
    showHeartRate: false,
    sourceMain: '眼镜估算',
    heartDeviceName: '',
    coachLine: '准备开跑',
    paused: false,
    running: false,
    runMode: 'free',
    surfacePhase: 'ready',
    // 04 总结页(surfacePhase 'summary'):跑完统计 + AI 点评
    sumDist: '0.00',
    sumElapsed: '00:00',
    sumPace: '--',
    sumStat: '0',
    sumStatLabel: '平均步频',
    sumAiText: '',
    sumAiState: '总结中',
    summaryUploadText: '日志整理中',
    summaryExitText: SUMMARY_EXIT_COPY,
    sumMetricOneLabel: '公里',
    sumMetricTwoLabel: '用时',
    sumMetricThreeLabel: '配速',
    sumMetricFourLabel: '平均步频',
    summaryChartTitle: '每分钟配速',
    summaryChartUnit: '分/公里',
    summaryChartData: [],
    summaryChartSeries: [{ yName: 'value', xName: 'minute', color: '#40ff5e', width: 2, smooth: false }],
    summaryChartYAxis: { minimum: 0, maximum: 900 },
    summaryChartXAxis: { minimum: 1, maximum: 2 },
    hudHint: '',
    safetyHudHint: '',
    runWarmupHint: '',
    paceConnected: false,
    motionSourceHint: '眼镜估算',
    hudEnvironment: formatHudClock(Date.now()),
    todayWorkoutAvailable: false,
    todayWorkoutTitle: '今日训练',
    todayWorkoutDetail: '',
    menuTodayClass: '',
    menuFreeClass: 'feature-focused',
    menuSlowClass: '',
    menuVirtualClass: '',
    menuTrainingClass: '',
    menuSettingsClass: '',
    menuTodayTabIndex: -1,
    menuFreeTabIndex: 0,
    menuSlowTabIndex: 1,
    menuVirtualTabIndex: 2,
    menuTrainingTabIndex: 3,
    menuSettingsTabIndex: 4,
    menuLayoutClass: '',
    trainingEasyClass: 'training-option-focused',
    trainingLongClass: '',
    trainingFartlekClass: '',
    trainingIntervalClass: '',
    trainingBackClass: '',
    recoveryHeading: '放松',
    recoveryProgress: '1 / 4',
    recoveryOverview: '4项 · 每项15秒 · 共1分钟',
    recoveryTitle: '慢走放松',
    recoveryDuration: '15秒',
    recoveryInstruction: '慢走，手臂自然摆动',
    recoverySafety: '疼痛就停',
    recoveryImage: '../../assets/recovery/walk.gif',
    recoveryCountdown: '15',
    recoveryCountdownUnit: '秒',
    recoveryAutoHint: '15秒后自动切换',
    recoveryActionLabel: '下一步',
    guideQuickExitEnabled: false,
    recoveryChoiceVisible: false,
    recoverySummaryClass: 'recovery-choice-focused',
    recoveryExitClass: '',
    workoutActive: false,
    workoutStageLabel: '',
    workoutProgressText: '',
    slowStepCount: '0',
    slowHeartRate: '--',
    slowCoachLine: '原地小步 · 轻落地 · 保持轻松呼吸',
    settingStride: '0.85m',
    settingHeartRate: '开',
    settingVoiceCue: '开',
    settingMetronome: '关闭',
    settingGuideQuickExit: '关',
    settingBinding: '待联网',
    settingsSaveState: '已保存',
    settingStrideClass: 'setting-row-focused',
    settingHeartRateClass: '',
    settingVoiceCueClass: '',
    settingMetronomeClass: '',
    settingGuideQuickExitClass: '',
    settingBindingClass: '',
    settingBackClass: '',
    bindingAiuiId: '待分配',
    bindingState: '正在读取绑定状态',
    bindingDetail: '身份只保存在本机与 SmartRun 服务器',
    bindingChip: '未就绪',
    bindingActionLabel: '刷新状态',
    bindingExportLabel: '导出现场日志',
    bindingRefreshClass: 'binding-action-focused',
    bindingExportClass: '',
    keyBeacon: '',
    searchText: '单击开始搜索心率设备',
    searchChip: '未搜索',
    primaryLabel: '开始搜索',
    discoveredDevices: [],
    discoveredDeviceCount: 0,
    discoveredDeviceRange: '',
    hasDiscoveredDevices: false,
    scanDiagnostic: '还没有开始搜索',
    scanProgressText: '等待操作',
    scanKeyGuide: '前后划选择 · 单击执行',
    scanExitGuide: '返回键退出 · 双击退出智能体',
    menuNavigationHint: '前后划选择 · 单击确认 · 返回键退出',
    searchPrimaryClass: 'search-target-focused',
    // 长值防溢出:按字符数换小字号 class(WXSS 无 overflow/ellipsis 可用)
    paceMod: unifiedPaceMod(INITIAL_PACE),
    paceStateClass: '',
    distMod: '',
    elapsedMod: '',
    gDistMod: '',
    gElapsedMod: '',
    dot5: 'dot',
    dot4: 'dot',
    dot3: 'dot',
    dot2: 'dot',
    dot1: 'dot',
    // BLE 状态机：idle | scanning | connecting | connected。HUD 内不展示按钮。
    bleState: 'idle',
  },

  onLoad(query = {}) {
    // AIUI 0.16.1 明确提供 onLoad/onShow/onReady/onHide/onUnload。仍从
    // onLoad 默认可见，是为了让 0.15 旧宿主在漏派 onShow 时 fail-open；
    // 新宿主随后的 show/hide 会继续精确修正生命周期状态。
    if (this.safetyTtsResumeTimer) clearTimeout(this.safetyTtsResumeTimer);
    this.pageVisible = true;
    // 宿主焦点与页面可见性是两条独立门。0.16.1 可能在同一次
    // 物理滑动的 keydown/keyup 之间重建焦点；默认 true 保留旧宿主兼容。
    this.hostFocused = true;
    // 训练执行 checkpoint 与完成队列先用异步精确键读取建立 durable 镜像。
    // 只把明确的 Key not found 当首次空存储；超时、宿主无回调、损坏或冲突
    // 都保持 unknown，后续菜单/执行/ACK 一律 fail closed。
    this.workoutDurableStorageGeneration = 0;
    this.restartWorkoutDurableStorageInitialization('load');
    this.viewReady = false;
    this.bleLifecycleGeneration = 0;
    this.bleOperationGeneration = 0;
    this.bleTerminated = false;
    this.bleHostCalls = [];
    this.discoveredDeviceRefs = {};
    this.discoveredDeviceOrder = [];
    this.rawAdvertisementCount = 0;
    this.surfaceGeneration = 0;
    this.entrySequenceStarted = false;
    this.entrySequenceCompleted = false;
    // 只有从沉浸式训练菜单选中的模式才需要“搜索配置 → 跑前热身”。
    // 诊断/兼容深链仍可从 ready 直接入场，避免破坏既有外部调用。
    this.preRunRequiredAfterSearch = false;
    this.startCuePlayed = false;
    this.scanAttempted = false;
    this.autoConnectPending = false;
    // 搜索页的候选选择拥有独立代次：stopScan() 的原生收尾窗内，用户手动
    // 点选必须能取消尚未提交的自动首选；GATT 已经发起后仍由 connectAttemptId
    // 负责清理迟到链。不要复用页面生命周期代次，否则热身切相位会误杀连接。
    this.bleSelectionGeneration = 0;
    this.autoConnectSelectionGeneration = null;
    // 与 scanAttempted 分开：后者也用于“心率设备已关闭”的下一步门禁，不能据此
    // 向用户宣称真实扫描已经启动/停止。
    this.scanStartedSuccessfully = false;
    this.hudReconnectCount = 0;
    this.hudReconnectTimer = null;
    this.hrWatchdogTimer = null;
    this.hrDegradedByRsc = false;
    this.hrNotifyRecoveryGeneration = 0;
    this.hrNotifyRecoveryTimer = null;
    this.hrNotifyRecoveryFlight = null;
    this.hrNotifyRecoveryCount = 0;
    this.hrNotifyRecoveryExhaustedLogged = false;
    this.rscProbeGeneration = 0;
    this.rscProbePromise = null;
    this.rscProbeRetryAtMs = null;
    this.rscFeatureProbePromise = null;
    this.rscCharacteristic = null;
    this.rscListener = null;
    this.rscPacketCount = 0;
    this.rscInvalidPacketCount = 0;
    this.rscSubscribedAtMs = null;
    this.rscLive = false;
    this.rscSilentTimer = null;
    this.rscSilentDeferredByHostBlur = false;
    this.rscFeatureFlags = null;
    this.bleServer = null;
    this.lastRscAtMs = null;
    this.pendingRscMeasurement = null;
    this.motionMetrics = null;
    this.lastMotionSource = MOTION_SOURCE.NONE;
    this.paceEverReady = false;
    this.cadenceEverReady = false;
    this.lastCrediblePaceSec = null;
    this.lastCrediblePaceAtMs = null;
    this.lastDisplayedPaceSec = null;
    this.lastDisplayedCadenceSpm = null;
    this.lastDisplayedCadenceAtMs = null;
    this.runWarmupPending = false;
    this.runWarmupMotionAtMs = null;
    this.setData({ hudEnvironment: formatHudClock(Date.now()) });
    this.accelClock = null;
    this.accelGeneration = 0;
    this.accel = null;
    this.gyro = null;
    this.gyroClock = null;
    // orientationSensor 是 AIUI 0.16.1 World Awareness 可能由宿主注入的
    // 保留字段，不能在页面初始化或清理中覆盖。自建 0.15 回退实例
    // 单独放在 motionOrientationSensor。
    this.motionOrientationSensor = null;
    this.motionOrientationBoundSensor = null;
    this.motionOrientationRuntimeOwned = false;
    this.motionOrientationReadingListener = null;
    this.motionOrientationErrorListener = null;
    this.orientationClock = null;
    this.worldAwarenessEnableAttempted = false;
    this.worldAwarenessEnabled = false;
    this.worldAwarenessLifecycleGeneration = 0;
    this.worldAwarenessDiagnostics = {
      headGestureCount: 0,
      lastHeadGesture: '',
      orientationStabilityCount: 0,
      orientationStable: null,
      lastEventAtMs: null,
    };
    this.motionQuality = null;
    this.imuArmingGate = null;
    this.imuActivityGate = null;
    this.imuArmingLogged = false;
    this.sensorAlignment = null;
    this.magnitudeStepDet = null;
    this.dualStepArbiter = null;
    this.lowRateImuStepDetector = null;
    this.lastImuCandidateAcceptedAtMs = null;
    this.accelerationCalibrationLogged = false;
    this.accelerationScaleToMps2 = 1;
    this.speedFusion = null;
    this.adaptiveStrideModel = null;
    this.strideCalibration = null;
    this.activeStepLengthM = null;
    this.lastImuFusionAtMs = null;
    this.lastStationaryFusionAtMs = null;
    this.orientationProjectionLogged = false;
    this.motionDiagnostics = null;
    this.calibrationStream = null;
    this.calibrationCaptureBuffer = [];
    this.calibrationQueueSaturated = false;
    try {
      const calibrationQueueState = readPendingAiuiCalibrationEventsState(wx);
      this.calibrationQueueSaturated = !calibrationQueueState.ok
        || calibrationQueueState.events.length >= AIUI_CALIBRATION_MAX_EVENTS;
    } catch (_e) {}
    this.localFieldLogRunId = '';
    this.localFieldLogStartedAtMs = null;
    this.localFieldLogBuffer = [];
    this.localFieldLogLastCapturedAtMs = null;
    this.localFieldLogFinished = false;
    this.localFieldLogWriteFailures = 0;
    this.localFieldLogLastErrorStatus = '';
    this.localFieldLogLastNoisyEventAtMs = {};
    this.localFieldLogPendingNoisyEvents = {};
    this.localFieldLogReplayTimer = null;
    // 全马现场日志默认只在分块 storage 中保存；不在总结页自动向 logcat
    // 回放整场数据，避免与总结上传/退出抢占 JS 与原生桥。开发者可在绑定页
    // 显式选择“导出现场日志”，深链诊断仍可传 localLogReplay=1。
    this.localFieldLogReplayEnabled = String(query.localLogReplay || '') === '1';
    this.localFieldLogReplayForced = String(query.localLogReplay || '') === '1';
    this.localFieldLogReplayGeneration = 0;
    this.pageUnloaded = false;
    // 上传锁必须属于一次具体的 owner flight。旧 owner 的悬空请求结束时，
    // 只能释放自己的 token，不能误清新 owner 已经开始的上传。
    this.calibrationFlushFlight = null;
    this.summaryPersistRetryPromise = null;
    this.summaryPersistRetryTimer = null;
    this.summaryExitPersistenceConfirmed = false;
    this.calibrationOwnerGeneration = 0;
    this.summaryCalibrationStreamId = '';
    this.summaryClientRunId = '';
    this.summaryHermesFlight = null;
    this.summaryHermesRetryTimer = null;
    this.summaryHermesRetryAttempt = 0;
    // 每场跑步固定完整 owner 上下文。另一路由完成解绑/换绑后，旧页面即使仍
    // 收到 tick、onHide、总结 AI 或网络回包，也不能把 A 的数据写进 B 的空间。
    this.runOwnerContext = null;
    this.runOwnerGeneration = 0;
    this.runOwnerInvalidated = false;
    this.lastCalibrationDiagnostics = null;
    this.lastHudMotionReportMs = null;
    this.lastRunTickAtMs = null;
    this.lastSessionCadenceSampleAtMs = null;
    this.runTickInProgress = false;
    this.runUploadFlushFlight = null;
    this.lastAccelSensorAt = null;
    this.lastAccelAt = null;
    this.imuSensorStartedAtMs = null;
    this.imuAwaitingFirstReading = false;
    this.imuRecoveryAttempts = 0;
    this.imuRecoveryDueAtMs = null;
    this.imuRecoveryReason = '';
    this.accelDiagnosticStartedAtMs = null;
    this.accelDiagnosticSamples = 0;
    this.accelDiagnosticMaxGapMs = 0;
    this.lastSummaryCheckpointMs = null;
    this.resetHudEndConfirmation({ clearHint: false });
    this.lastSurfaceConfirmKeyMs = null;
    this.lastSurfaceActivationAtMs = null;
    this.lastSurfaceActivationId = null;
    this.lastSurfaceDirectionAtMs = null;
    this.lastSurfaceDirectionPhase = null;
    this.lastSurfaceDirectionDelta = null;
    this.lastSurfaceDirectionCode = null;
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.menuEntryConfirmGuardUntilMs = null;
    this.pendingSurfaceGlobalHookTimer = null;
    this.pendingSurfaceGlobalHookPhase = null;
    this.pendingSurfaceGlobalHookAtMs = null;
    this.pendingSurfaceGlobalHookToken = 0;
    this.hudEnteredAtMs = null;
    this.scanRetryCount = 0;
    this.scanRetryTimer = null;
    this.scanRetryDeferredByHostBlur = false;
    this.scanSession = null;
    this.connectAttemptId = 0;
    this.connectingDevice = null;
    this.connectingAttemptId = null;
    this.connectingSelectionGeneration = null;
    this.connectingSelectionSource = null;
    this.reconnectDevice = null;
    this.hrCharacteristic = null;
    this.hrListener = null;
    this.bleDevice = null;
    this.bleDropListener = null;
    // 宿主复用实例时这两个棘轮位若不复位,第二场跑步会被上一场毒化:
    // backspaceHandled 杀掉一切守卫,runUploadQueued 吞掉总结/上传。
    this.backspaceHandled = false;
    this.agentExitRequested = false;
    this.agentExitDispatched = false;
    this.agentExitDispatching = false;
    this.agentExitTimer = null;
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    this.summaryEnteredAtMs = null;
    this.summaryExitPromptTimer = null;
    this.summaryFinalizeTimer = null;
    this.summaryLlmStartTimer = null;
    this.summaryLlmGeneration = 0;
    this.summaryLlmFlightGeneration = null;
    this.summaryLlmAttempted = false;
    this.summaryLlmSession = null;
    this.bleCleanupPromise = null;
    this.terminalBleCleanupPromise = null;
    this.runFinalizationStarted = false;
    this.pendingSummarySnapshot = null;
    this.runUploadQueued = false;
    this.runUploadFlushFlight = null;
    this.lastHrUiAtMs = null;
    this.minuteSeries = [];
    this.lastMinuteSample = 0;
    this.minuteMetricAnchor = { elapsedMs: 0, distanceM: 0 };
    this.minuteCadenceSum = 0;
    this.minuteCadenceCount = 0;
    this.menuFocusIndex = 0;
    this.menuFocusTouched = false;
    this.trainingFocusIndex = 0;
    // 只有真正进入跑前/跑后指导时才设置 kind；默认页不能伪装成 recovery，
    // 否则总结页的向前划会被“正在恢复”保护误吞掉。
    this.timedGuideKind = null;
    this.recoveryIndex = 0;
    this.recoveryTtsGeneration = 0;
    this.recoveryTtsTimer = null;
    this.recoveryTtsActive = false;
    this.recoveryCountdownGeneration = 0;
    this.recoveryCountdownTimer = null;
    this.recoveryCountdownActive = false;
    this.recoveryCountdownRemainingSec = RECOVERY_STEP_DURATION_SEC;
    this.recoveryStepEndsAtMs = null;
    this.recoveryMidpointCueSent = false;
    this.recoveryFinalCountCueSent = false;
    this.recoveryGuideCompleted = false;
    this.recoveryCompletionFocusIndex = 0;
    this.activeLocalTrainingPresetId = '';
    this.todayWorkoutPlan = null;
    this.todayWorkoutLaunchGeneration = 0;
    this.todayWorkoutLaunchPromise = null;
    this.activeWorkoutPlan = null;
    this.currentHeartRatePolicy = null;
    this.currentHeartRatePolicyOwner = null;
    this.frozenHeartRatePolicy = null;
    this.workoutExecution = null;
    this.completedWorkoutExecution = null;
    this.workoutCompletionQueued = false;
    this.workoutCompletionFlushFlight = null;
    this.workoutCompletionMenuRefreshPending = false;
    this.workoutCompletionAckedWorkoutIds = {};
    this.lastWorkoutCheckpointAtMs = null;
    this.settingFocusIndex = 0;
    this.searchFocusIndex = 0;
    this.deviceIdentityRequestPromise = null;
    this.deviceIdentityCache = null;
    this.immersiveStartupMaintenanceFlight = null;
    this.immersiveStartupMaintenanceOwner = null;
    this.immersiveStartupSummaryArchiveSettled = false;
    this.immersiveStartupSummaryGuardActive = true;
    this.immersiveStartupSummaryArchiveStatus = 'pending';
    this.bindingActionPending = false;
    this.bindingExportPending = false;
    this.bindingEnteredAtMs = null;
    this.bindingFocusIndex = 0;
    this.metronome = null;
    this.metronomeAudioSrc = '';
    this.safetyTtsGeneration = 0;
    this.safetyTtsResumeTimer = null;
    this.safetyMetronomeResumePending = false;
    // v0.14+ 官方 wx storage 会跨重启持久化；写回一次同时完成旧设置补字段迁移。
    this.runSettings = writeRunSettings(wx, readRunSettings(wx));
    this.settingsStored = isRunSettingsPersisted(wx, this.runSettings);
    this.runStrideM = this.runSettings.strideM || DEFAULT_STRIDE_M;
    this.lastDisplayedPaceSec = null;
    this.lastDisplayedCadenceSpm = null;
    this.lastDisplayedCadenceAtMs = null;
    const initialPace = formatPace(null);
    this.setData({
      pace: initialPace,
      cadence: CADENCE_PENDING,
      safetyHudHint: '',
      paceMod: unifiedPaceMod(initialPace),
      paceStateClass: '',
      ...heartZoneDotFields(0),
    });
    this.syncSettingsData();
    // Pure immersive launch enters the 480x352 menu directly. The old compact
    // launcher remains an explicit compatibility route and marks its origin so
    // Back can accurately say "return to card" instead of "exit agent".
    this.launchedFromCompactHome = !!(query && String(query.fromHome || '') === '1');
    this.setData({
      menuNavigationHint: this.launchedFromCompactHome
        ? '前后划选择 · 单击确认 · 返回键回首页'
        : '前后划选择 · 单击确认 · 返回键退出',
      scanExitGuide: this.launchedFromCompactHome
        ? '返回键回首页 · 双击退出智能体'
        : '返回键退出 · 双击退出智能体',
    });
    const requestedMode = query && typeof query.mode === 'string' ? query.mode : 'menu';
    if (requestedMode === 'settings') {
      this.runMode = 'free';
      this.setData({ surfacePhase: 'settings', runMode: 'free' });
    } else if (requestedMode === 'menu') {
      this.runMode = 'free';
      // 只对首页物理确认进入的菜单开启跨页隔离；深链、页内返回与直接触摸
      // 不承担这段等待。query 值按字符串比较，兼容 AIUI 路由参数形态。
      if (query && String(query.inputGuard || '') === '1') {
        this.menuEntryConfirmGuardUntilMs = Date.now() + MENU_ENTRY_CONFIRM_GRACE_MS;
      }
      this.setData({ surfacePhase: 'menu', runMode: 'free' });
    } else if (requestedMode === 'slow') {
      this.runMode = 'slow';
      this.setData({
        surfacePhase: 'ready',
        runMode: 'slow',
        ...this.runEntryCopy('idle'),
        primaryLabel: '开始搜索',
        scanProgressText: '等待操作',
      });
      this.applyHeartRateSettingToEntry();
    } else if (requestedMode === 'garmin_virtual') {
      this.runMode = 'garmin_virtual';
      this.setData({
        surfacePhase: 'ready',
        runMode: 'garmin_virtual',
        searchText: 'Garmin 手表请选择 Virtual Run 并按 START',
        searchChip: '室内跑',
        primaryLabel: '开始搜索',
        scanDiagnostic: 'Garmin 数据优先 · 无设备时用眼镜估算',
        scanProgressText: '等待操作',
      });
      this.applyHeartRateSettingToEntry();
    } else {
      this.runMode = 'free';
      this.setData({ surfacePhase: 'ready', runMode: 'free' });
      this.applyHeartRateSettingToEntry();
    }
    // The compact launcher used to archive the previous run before it could
    // open this page. Immersive-first launch must perform that local,
    // write-verified transaction synchronously during onLoad. Network
    // bootstrap may take seconds; it must never leave the single pending slot
    // available for a new run checkpoint to overwrite in the meantime.
    this.settleImmersiveStartupSummaryArchive();
    // 身份 bootstrap 在后台建立匿名上传与 owner 隔离；“智能体绑定”
    // 只展示服务器分配的当前 AIUI ID，确认键仅刷新服务器绑定状态。
    if (requestedMode === 'settings' || requestedMode === 'menu') {
      // 纯沉浸首屏也承担旧 448x150 启动器的后台职责：先建立准确 owner，
      // 再归档上一场总结并补传 durable 队列。维护不阻塞菜单交互，也不在
      // 跑步中新增实时网络请求。
      Promise.all([
        Promise.resolve(this.refreshDeviceIdentity()),
        this.workoutDurableStoragePromise,
      ]).then(([identity]) => {
        this.runImmersiveStartupMaintenance(identity);
        if (requestedMode === 'menu' && this.data.surfacePhase === 'menu') {
          return this.refreshWorkoutMenuState(identity);
        }
        // 用户可能在 identity/current-workout 返回前已离开菜单。
        // 心率策略不是菜单 UI 状态：继续同 owner 请求并持久化，
        // 让 1 分钟热身后开跑仍能冻结可信 Zone。
        if (requestedMode === 'menu') return this.loadTodayWorkoutForMenu(identity);
        return null;
      }).catch(() => {});
    }
    const recoveredLocalLogs = this.recoverStaleRunningLocalFieldLogs(Date.now());
    this.scheduleRunningLocalFieldLogDiagnostics(query, recoveredLocalLogs);
    this.markBeacon('L');
  },

  noteRunningLocalFieldLogResult(result, operation = 'write') {
    if (result && result.ok === true) return true;
    this.localFieldLogWriteFailures =
      (Number(this.localFieldLogWriteFailures) || 0) + 1;
    const status = String(result && result.status || 'exception');
    const shouldLog = this.localFieldLogLastErrorStatus !== status
      || this.localFieldLogWriteFailures === 1
      || this.localFieldLogWriteFailures % 10 === 0;
    this.localFieldLogLastErrorStatus = status;
    if (shouldLog) {
      try {
        console.log('[SmartRun LocalLog] WRITE_FAILED operation='
          + String(operation) + ' status=' + status
          + ' count=' + String(this.localFieldLogWriteFailures));
      } catch (_e) {}
    }
    return false;
  },

  runRunningLocalFieldLogMutation(operation, mutate) {
    try {
      return this.noteRunningLocalFieldLogResult(mutate(), operation);
    } catch (_e) {
      return this.noteRunningLocalFieldLogResult(null, operation);
    }
  },

  cancelRunningLocalFieldLogReplay() {
    this.localFieldLogReplayGeneration =
      (Number(this.localFieldLogReplayGeneration) || 0) + 1;
    // Some AIUI hosts (and deterministic test clocks) may return 0 as a valid
    // timer handle. Nullness, rather than truthiness, is the lifecycle guard.
    if (this.localFieldLogReplayTimer != null) {
      clearTimeout(this.localFieldLogReplayTimer);
    }
    this.localFieldLogReplayTimer = null;
  },

  latestRunningLocalFieldLogDigest(run = null) {
    let latest = run;
    try {
      if (!latest) latest = readLatestRunningLocalFieldLog(wx);
    } catch (_e) { latest = null; }
    if (!latest) return null;
    let digest = null;
    try { digest = buildLatestRunningLocalFieldLogDigest(latest); } catch (_e) {}
    if (digest) {
      try {
        console.log('[SmartRun LocalLog] DIGEST ' + JSON.stringify(digest));
      } catch (_e) {}
    }
    return digest;
  },

  recoverStaleRunningLocalFieldLogs(now = Date.now()) {
    let indexResult = null;
    try { indexResult = readRunningLocalFieldLogIndexResult(wx); } catch (_e) {}
    if (!indexResult || indexResult.ok !== true
        || !indexResult.index || !Array.isArray(indexResult.index.runs)) {
      if (indexResult && indexResult.ok === false) {
        this.noteRunningLocalFieldLogResult(indexResult, 'recover-read');
      }
      return 0;
    }
    const active = indexResult.index.runs.filter(
      (run) => run && run.status === 'active',
    );
    if (!active.length) return 0;
    let recovered = null;
    try {
      recovered = recoverActiveRunningLocalFieldLogs(wx, { endedAtMs: now });
    } catch (_e) {}
    if (!this.noteRunningLocalFieldLogResult(recovered, 'recover-active')) return 0;
    if (Number(recovered.recovered) > 0) {
      this.latestRunningLocalFieldLogDigest();
    }
    return Number(recovered.recovered) || 0;
  },

  scheduleRunningLocalFieldLogDiagnostics(query = {}, recovered = 0, options = {}) {
    this.cancelRunningLocalFieldLogReplay();
    if (this.localFieldLogReplayEnabled !== true) return false;
    const forced = String(query && query.localLogReplay || '') === '1';
    const generation = this.localFieldLogReplayGeneration;
    this.localFieldLogReplayTimer = setTimeout(() => {
      this.localFieldLogReplayTimer = null;
      if (generation !== this.localFieldLogReplayGeneration
          || this.pageUnloaded === true || this.data.running === true) return;
      let latest = null;
      try { latest = readLatestRunningLocalFieldLog(wx); } catch (_e) {}
      if (!latest) return;
      if (!(Number(recovered) > 0)) this.latestRunningLocalFieldLogDigest(latest);
      const autoMenuReplay = this.data.surfacePhase === 'menu'
        && latest.status === 'completed' && !(Number(recovered) > 0);
      const autoSummaryReplay = options.afterCompleted === true
        && latest.status === 'completed';
      if (!forced && !autoMenuReplay && !autoSummaryReplay) return;
      this.replayRunningLocalFieldLog(latest);
    }, 0);
    return true;
  },

  replayRunningLocalFieldLog(run, options = {}) {
    if (!run || this.data.running === true || this.pageUnloaded === true) return false;
    let lines = [];
    try { lines = buildRunningLocalFieldLogReplayLines(run); } catch (_e) {}
    if (!lines.length) return false;
    this.cancelRunningLocalFieldLogReplay();
    const generation = this.localFieldLogReplayGeneration;
    let offset = 0;
    const emitBatch = () => {
      this.localFieldLogReplayTimer = null;
      if (generation !== this.localFieldLogReplayGeneration
          || this.pageUnloaded === true || this.data.running === true) return;
      const end = Math.min(
        lines.length,
        offset + LOCAL_FIELD_LOG_REPLAY_BATCH_LINES,
      );
      for (; offset < end; offset += 1) {
        try { console.log('[SmartRun LocalLog] ' + lines[offset]); } catch (_e) {}
      }
      if (offset < lines.length) {
        this.localFieldLogReplayTimer = setTimeout(
          emitBatch,
          LOCAL_FIELD_LOG_REPLAY_YIELD_MS,
        );
      } else if (typeof options.onComplete === 'function') {
        try { options.onComplete(); } catch (_e) {}
      }
    };
    this.localFieldLogReplayTimer = setTimeout(emitBatch, 0);
    return true;
  },

  clearRunningLocalFieldLogMemory() {
    this.cancelRunningLocalFieldLogReplay();
    this.localFieldLogRunId = '';
    this.localFieldLogStartedAtMs = null;
    this.localFieldLogBuffer = [];
    this.localFieldLogLastCapturedAtMs = null;
    this.localFieldLogFinished = false;
    this.localFieldLogLastNoisyEventAtMs = {};
    this.localFieldLogPendingNoisyEvents = {};
  },

  beginRunningLocalFieldCapture(startedAtMs) {
    const runId = createRunningLocalFieldLogId(startedAtMs);
    if (!runId) return false;
    this.cancelRunningLocalFieldLogReplay();
    this.localFieldLogRunId = runId;
    this.localFieldLogStartedAtMs = startedAtMs;
    this.localFieldLogBuffer = [];
    this.localFieldLogLastCapturedAtMs = null;
    this.localFieldLogFinished = false;
    this.localFieldLogLastNoisyEventAtMs = {};
    this.localFieldLogPendingNoisyEvents = {};
    return this.runRunningLocalFieldLogMutation('begin', () => (
      beginRunningLocalFieldLog(wx, { runId, startedAtMs })
    ));
  },

  ensureRunningLocalFieldCaptureStarted() {
    if (!this.localFieldLogRunId
        || !Number.isFinite(Number(this.localFieldLogStartedAtMs))) return false;
    return this.runRunningLocalFieldLogMutation('ensure-begin', () => (
      beginRunningLocalFieldLog(wx, {
        runId: this.localFieldLogRunId,
        startedAtMs: this.localFieldLogStartedAtMs,
      })
    ));
  },

  runningLocalFieldBleState() {
    const state = String(this.data.bleState || 'idle');
    if (state === 'scanning' || state === 'connecting'
        || state === 'connected') return state;
    if (this.reconnectDevice || this.hudReconnectTimer) return 'reconnecting';
    return 'idle';
  },

  runningLocalFieldTrigger(value) {
    const trigger = String(value || 'unknown');
    return ['ticker', 'finish', 'hide', 'show', 'hrs', 'rsc', 'imu']
      .includes(trigger) ? trigger : 'unknown';
  },

  buildRunningLocalFieldSample(now = Date.now(), motionSnapshot = null,
    trigger = 'ticker') {
    if (!this.session || !this.motionMetrics) return null;
    const motion = motionSnapshot || this.motionMetrics.snapshot(now);
    if (!motion) return null;
    const snap = this.session.snapshot(now);
    const diagnostic = this.lastCalibrationDiagnostics
      && now - this.lastCalibrationDiagnostics.atMs >= 0
      && now - this.lastCalibrationDiagnostics.atMs
        <= CALIBRATION_DIAGNOSTIC_FRESH_MS
      ? this.lastCalibrationDiagnostics : null;
    const rscLive = !!(motion.rscFresh === true
      && motion.rscPaceLive === true
      && Number(motion.rscSpeedMps) > 0);
    const stationary = !!(diagnostic && diagnostic.stationary === true
      && !rscLive);
    let speedMps = stationary ? 0 : Number(motion.speedMps);
    if (!(speedMps >= 0 && speedMps <= 20)) speedMps = stationary ? 0 : null;
    let paceSecPerKm = speedMps > 0 ? 1000 / speedMps : null;
    if (Number.isFinite(Number(motion.avgPaceSecPerKm))
        && Number(motion.avgPaceSecPerKm) >= 60
        && Number(motion.avgPaceSecPerKm) <= 3600) {
      paceSecPerKm = Number(motion.avgPaceSecPerKm);
    }
    if (stationary) paceSecPerKm = null;
    const hrLive = this.lastHrAtMs != null
      && now - this.lastHrAtMs <= HR_STALE_MS
      && this.data.bleState === 'connected';
    const accelAgeMs = this.lastAccelAt == null
      ? null : Math.max(0, now - this.lastAccelAt);
    return {
      captured_at_ms: now,
      elapsed_ms: Math.max(0, Math.round(Number(motion.elapsedMs)
        || Number(snap.elapsedMs) || 0)),
      bpm: hrLive ? Number(snap.bpm) : null,
      cadence_spm: motion.cadenceReady === true
        ? Number(motion.cadenceSpm) : null,
      candidate_cadence_spm: diagnostic
        ? Number(diagnostic.candidateCadenceSpm) : null,
      speed_mps: speedMps,
      pace_sec_per_km: paceSecPerKm,
      distance_m: Math.max(0, Number(motion.distanceM) || 0),
      steps_total: Math.max(
        0,
        Math.round(Number(this.motionMetrics.acceptedSteps) || 0),
      ),
      motion_quality: diagnostic ? Number(diagnostic.motionQuality) : null,
      artifact_confidence: diagnostic
        ? Number(diagnostic.artifactConfidence) : null,
      gyro_rms: diagnostic ? Number(diagnostic.gyroRms) : null,
      stationary: diagnostic ? stationary : null,
      distance_source: this.calibrationDistanceSource(
        motion.activeMotionSource || motion.distanceSource,
      ),
      cadence_source: this.calibrationCadenceSource(motion.cadenceSource),
      rsc_live: rscLive,
      hr_live: hrLive,
      ble_state: this.runningLocalFieldBleState(),
      page_visible: this.pageVisible === true,
      paused: snap.paused === true,
      accel_age_ms: accelAgeMs,
      sensor_generation: Number(this.accelGeneration) || 0,
      trigger: this.runningLocalFieldTrigger(trigger),
    };
  },

  flushRunningLocalFieldLogBuffer() {
    const buffer = Array.isArray(this.localFieldLogBuffer)
      ? this.localFieldLogBuffer.slice() : [];
    if (!buffer.length) return true;
    if (!this.ensureRunningLocalFieldCaptureStarted()) return false;
    let result = null;
    try {
      result = appendRunningLocalFieldSamples(
        wx,
        this.localFieldLogRunId,
        buffer,
      );
    } catch (_e) {}
    if (!this.noteRunningLocalFieldLogResult(result, 'append-samples')) return false;
    this.localFieldLogBuffer = [];
    return true;
  },

  captureRunningLocalFieldSample(now = Date.now(), motionSnapshot = null,
    trigger = 'ticker', force = false) {
    if (!this.localFieldLogRunId || this.localFieldLogFinished === true
        || !this.session || !this.motionMetrics) return false;
    if (force !== true && this.localFieldLogLastCapturedAtMs != null
        && now - this.localFieldLogLastCapturedAtMs
          < RUNNING_LOCAL_FIELD_LOG_CAPTURE_INTERVAL_MS) return false;
    const sample = this.buildRunningLocalFieldSample(now, motionSnapshot, trigger);
    if (!sample) return false;
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.flushRunningLocalFieldLogBuffer();
    }
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.localFieldLogBuffer.shift();
    }
    this.localFieldLogBuffer.push(sample);
    this.localFieldLogLastCapturedAtMs = now;
    if (this.localFieldLogBuffer.length >= LOCAL_FIELD_LOG_BUFFER_SAMPLES) {
      this.flushRunningLocalFieldLogBuffer();
    }
    return true;
  },

  recordRunningLocalFieldEvent(kind, name, options = {}) {
    if (!this.localFieldLogRunId) return false;
    const eventName = String(name || '').toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
    if (!/^[A-Z]/.test(eventName)) return false;
    // 总结首帧会先把本场标记 completed，保证随后被系统杀进程也有完整摘要；
    // 但原生 BLE 清理与真正退出发生在其后。底层日志允许给 completed 元数据
    // 追加事件，这里只放行固定终端白名单，避免 HUD tick 在封存后继续写入。
    if (this.localFieldLogFinished === true && [
      'BLE_TEARDOWN',
      'BLE_TEARDOWN_FAILED',
      'AGENT_EXIT_REQUEST',
      'AGENT_EXIT_DEFERRED',
      'AGENT_EXIT_DISPATCH',
      'AGENT_EXIT_FAILED',
      'PAGE_UNLOADED',
    ].indexOf(eventName) < 0) return false;
    const now = Number.isFinite(Number(options.atMs))
      ? Number(options.atMs) : Date.now();
    const isNoisy = LOCAL_FIELD_LOG_NOISY_EVENTS.indexOf(eventName) >= 0;
    if (isNoisy && options.force !== true) {
      const lastAtMs = Number(
        this.localFieldLogLastNoisyEventAtMs
          && this.localFieldLogLastNoisyEventAtMs[eventName],
      );
      if (Number.isFinite(lastAtMs)
          && now - lastAtMs >= 0
          && now - lastAtMs < LOCAL_FIELD_LOG_NOISY_EVENT_INTERVAL_MS) {
        if (!this.localFieldLogPendingNoisyEvents) {
          this.localFieldLogPendingNoisyEvents = {};
        }
        this.localFieldLogPendingNoisyEvents[eventName] = {
          kind,
          name: eventName,
          options: { ...options, atMs: now, force: true },
        };
        return true;
      }
    }
    let elapsedMs = Number(options.elapsedMs);
    if (!Number.isFinite(elapsedMs) && this.session) {
      elapsedMs = Number(this.session.snapshot(now).elapsedMs) || 0;
    }
    const persisted = this.runRunningLocalFieldLogMutation('event-' + eventName, () => (
      appendRunningLocalFieldEvent(wx, this.localFieldLogRunId, {
        at_ms: now,
        elapsed_ms: Math.max(0, Math.round(Number(elapsedMs) || 0)),
        kind,
        name: eventName,
        ...(options.reason ? { reason: String(options.reason) } : {}),
        generation: Number.isFinite(Number(options.generation))
          ? Number(options.generation) : Number(this.accelGeneration) || 0,
      })
    ));
    if (persisted && isNoisy) {
      if (!this.localFieldLogLastNoisyEventAtMs) {
        this.localFieldLogLastNoisyEventAtMs = {};
      }
      this.localFieldLogLastNoisyEventAtMs[eventName] = now;
      if (this.localFieldLogPendingNoisyEvents) {
        delete this.localFieldLogPendingNoisyEvents[eventName];
      }
    }
    return persisted;
  },

  flushRunningLocalFieldNoisyEvents() {
    const pending = this.localFieldLogPendingNoisyEvents || {};
    const names = Object.keys(pending);
    let stored = true;
    for (let index = 0; index < names.length; index += 1) {
      const item = pending[names[index]];
      if (!item || !this.recordRunningLocalFieldEvent(
        item.kind,
        item.name,
        item.options,
      )) stored = false;
    }
    return stored;
  },

  finishRunningLocalFieldCapture(summary, motionSnapshot, endedAtMs,
    options = {}) {
    if (!this.localFieldLogRunId || this.localFieldLogFinished === true) return true;
    if (this.session && this.motionMetrics) {
      this.captureRunningLocalFieldSample(
        endedAtMs,
        motionSnapshot,
        'finish',
        true,
      );
    }
    if (!this.flushRunningLocalFieldLogBuffer()) return false;
    this.flushRunningLocalFieldNoisyEvents();
    if (options.aborted !== true) {
      this.recordRunningLocalFieldEvent('lifecycle', 'SUMMARY_ENTERED', {
        atMs: endedAtMs,
        elapsedMs: summary && summary.elapsedMs,
        reason: 'summary',
      });
    }
    const localSummary = summary ? {
      elapsed_ms: summary.elapsedMs,
      distance_m: summary.distanceM,
      avg_pace_sec_per_km: summary.avgPaceSecPerKm,
      avg_cadence_spm: summary.avgCadenceSpm,
      avg_bpm: summary.avgBpm,
      max_bpm: summary.maxBpm,
      steps: summary.steps,
    } : null;
    const completed = this.runRunningLocalFieldLogMutation('finish', () => (
      finishRunningLocalFieldLog(wx, this.localFieldLogRunId, {
        endedAtMs,
        aborted: options.aborted === true,
        summary: localSummary,
      })
    ));
    if (completed) {
      this.localFieldLogFinished = true;
      if (options.aborted !== true) {
        this.scheduleRunningLocalFieldLogDiagnostics({}, 0, {
          afterCompleted: true,
        });
      }
    }
    return completed;
  },

  isSearchPhase() {
    return this.data.surfacePhase === 'ready' || this.data.surfacePhase === 'connecting';
  },

  isEntryGattPhase() {
    return this.isSearchPhase() || this.data.surfacePhase === 'pre_run';
  },

  restartWorkoutDurableStorageInitialization(reason = 'owner-storage-refresh') {
    const generation = (this.workoutDurableStorageGeneration || 0) + 1;
    this.workoutDurableStorageGeneration = generation;
    this.workoutDurableStorageReady = false;
    const promise = initializeWorkoutOwnerStorage(wx).then((ready) => {
      if (generation !== this.workoutDurableStorageGeneration) return false;
      this.workoutDurableStorageReady = ready === true;
      if (this.workoutDurableStorageReady && reason !== 'load') {
        // Owner cleanup can replace the promise after onLoad captured an older
        // generation. Re-evaluate the menu from the newly verified stores in
        // the next microtask; refreshWorkoutMenuState also rechecks generation.
        Promise.resolve().then(() => {
          if (generation === this.workoutDurableStorageGeneration
              && this.workoutDurableStorageReady
              && this.pageVisible === true
              && this.data.surfacePhase === 'menu') {
            return this.refreshWorkoutMenuState(this.deviceIdentityCache);
          }
          return null;
        }).catch(() => {});
      }
      return this.workoutDurableStorageReady;
    }).catch(() => {
      if (generation === this.workoutDurableStorageGeneration) {
        this.workoutDurableStorageReady = false;
      }
      return false;
    });
    this.workoutDurableStoragePromise = promise;
    console.log('[SmartRun Workout] STORAGE_INIT reason=' + reason);
    return promise;
  },

  isSummaryPhase() {
    // finishRunToSummary() 在提交 setData 之前同步写入 summaryEnteredAtMs。
    // 真机可能延迟把 surfacePhase 镜像回 this.data；输入路由与资源终止门必须
    // 立即以内部相位为准，否则总结尚未绘出时的 Back/双击会误走 HUD 分支。
    return this.summaryEnteredAtMs != null || this.data.surfacePhase === 'summary';
  },

  syncSettingsData() {
    const settings = this.runSettings || DEFAULT_RUN_SETTINGS;
    this.setData({
      settingStride: formatStrideM(settings.strideM),
      settingHeartRate: formatSwitch(settings.autoHeartRate),
      settingVoiceCue: formatSwitch(settings.voiceCue),
      settingMetronome: formatMetronomeBpm(settings.metronomeBpm),
      settingGuideQuickExit: formatSwitch(settings.guideQuickExit),
      settingsSaveState: this.settingsStored ? '已保存' : '仅本次',
    });
  },

  deviceWxRequest(request) {
    this.lastDeviceRequestDiagnostic = null;
    const requestUrl = String(request && request.url || '').trim();
    if (!/^https:\/\//i.test(requestUrl)) {
      this.lastDeviceRequestDiagnostic = { kind: 'offline-default' };
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let done = false;
      let requestTask = null;
      let timer = null;
      const requestedTimeout = Number(request && request.timeout);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout : DEVICE_REQUEST_TIMEOUT_MS;
      const finish = (value, diagnostic = null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.lastDeviceRequestDiagnostic = diagnostic;
        resolve(value);
      };
      timer = setTimeout(() => {
        try {
          if (requestTask && typeof requestTask.abort === 'function') requestTask.abort();
        } catch (_e) {}
        finish(null, { kind: 'timeout' });
      }, timeoutMs + 250);
      try {
        requestTask = wx.request({
          ...request,
          dataType: 'json',
          responseType: 'text',
          timeout: timeoutMs,
          success: (rawResponse) => {
            const response = normalizeWxJsonResponse(rawResponse);
            const statusCode = Number(response && response.statusCode);
            let diagnostic = null;
            if (Number.isFinite(statusCode) && statusCode >= 400) {
              diagnostic = { kind: 'http', statusCode };
            } else if (Number.isFinite(statusCode) && statusCode >= 200
                && statusCode < 300 && !isJsonObjectResponse(response)) {
              diagnostic = { kind: 'response' };
            }
            finish(response, diagnostic);
          },
          fail: (error) => finish(null, { kind: classifyDeviceRequestError(error) }),
        });
      } catch (_e) {
        finish(null, { kind: 'network' });
      }
    });
  },

  async refreshDeviceIdentity() {
    if (this.deviceIdentityRequestPromise) return this.deviceIdentityRequestPromise;
    const config = resolveCoachBackendConfig(wx);
    this.lastDeviceRequestDiagnostic = null;
    const promise = bootstrapDeviceIdentity({
      storage: wx,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      appKey: config.appKey,
      navigatorObject: typeof navigator === 'undefined' ? null : navigator,
      cryptoObject: typeof crypto === 'undefined' ? null : crypto,
      TextEncoderCtor: typeof TextEncoder === 'undefined' ? null : TextEncoder,
      coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY,
      onOwnerDataCleared: () => this.handleCalibrationOwnerDataCleared(),
      request: (request) => this.deviceWxRequest(request),
    }).then((identity) => {
      let resolvedIdentity = identity;
      if (identity && identity.network !== true) {
        let diagnostic = this.lastDeviceRequestDiagnostic;
        if (!diagnostic && identity.statusCode === 200) diagnostic = { kind: 'response' };
        else if (!diagnostic && Number.isFinite(Number(identity.statusCode))) {
          diagnostic = { kind: 'http', statusCode: Number(identity.statusCode) };
        }
        if (diagnostic) {
          resolvedIdentity = {
            ...identity,
            networkDiagnostic: diagnostic.kind,
            networkStatusCode: diagnostic.statusCode || null,
          };
        }
      }
      this.deviceIdentityCache = resolvedIdentity;
      // bootstrap 的正常首次 claim 会让同一 public id 从 unbound epoch N
      // 前进到 bound epoch N+1；这是唯一可在本场内更新 pin 的连续迁移。
      this.reconcileRunOwnerContext(
        'identity-refresh',
        resolvedIdentity && resolvedIdentity.ownershipTransition,
      );
      if (this.runOwnerContext
          && !this.identityMatchesRunOwner(
            this.deviceIdentityCache,
            this.runOwnerContext,
          )) {
        this.deviceIdentityCache = null;
      }
      this.syncDeviceIdentityData(resolvedIdentity);
      return resolvedIdentity;
    });
    this.deviceIdentityRequestPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.deviceIdentityRequestPromise === promise) this.deviceIdentityRequestPromise = null;
    }
  },

  settleImmersiveStartupSummaryArchive() {
    if (this.immersiveStartupSummaryArchiveSettled === true) {
      return { ok: true, status: 'already_settled' };
    }
    const pendingState = readPendingRunSummaryState(wx);
    if (!pendingState.ok) {
      this.immersiveStartupSummaryGuardActive = true;
      this.immersiveStartupSummaryArchiveStatus = pendingState.status;
      return { ok: false, status: pendingState.status };
    }
    // A verified empty slot is safe even before the first server identity is
    // available. This keeps a clean offline first run fully functional.
    if (!pendingState.summary) {
      this.immersiveStartupSummaryArchiveSettled = true;
      this.immersiveStartupSummaryGuardActive = false;
      this.immersiveStartupSummaryArchiveStatus = 'empty';
      return { ok: true, status: 'empty' };
    }
    if (this.pageUnloaded || !this.ownerScopedRunWriteAllowed(0)) {
      this.immersiveStartupSummaryGuardActive = true;
      this.immersiveStartupSummaryArchiveStatus = 'owner_unavailable';
      return { ok: false, status: 'owner_unavailable' };
    }
    const storedOwner = this.readStoredRunOwnerContext();
    if (storedOwner.status !== 'ok') {
      this.immersiveStartupSummaryGuardActive = true;
      this.immersiveStartupSummaryArchiveStatus = 'owner_' + storedOwner.status;
      return { ok: false, status: 'owner_' + storedOwner.status };
    }
    const archived = archivePendingRunSummary(wx, {
      ownerReady: true,
      nowMs: Date.now(),
    });
    this.immersiveStartupSummaryArchiveSettled = archived.ok === true;
    this.immersiveStartupSummaryGuardActive = archived.ok !== true;
    this.immersiveStartupSummaryArchiveStatus = String(
      archived.status || (archived.ok ? 'archived' : 'archive_failed'),
    );
    return archived;
  },

  runImmersiveStartupMaintenance(identity = this.deviceIdentityCache) {
    const localArchive = this.settleImmersiveStartupSummaryArchive();
    if (!localArchive.ok) return Promise.resolve(false);
    const currentOwner = this.readStoredRunOwnerContext();
    if (currentOwner.status !== 'ok') return Promise.resolve(false);
    if (this.immersiveStartupMaintenanceFlight) {
      if (this.sameRunOwnerContext(
        this.immersiveStartupMaintenanceOwner,
        currentOwner.context,
      )) return this.immersiveStartupMaintenanceFlight;
      // An A-owner flight must not suppress B-owner maintenance. Serialize the
      // bridge work, then re-read storage and start one exact-owner successor.
      return Promise.resolve(this.immersiveStartupMaintenanceFlight)
        .catch(() => false)
        .then(() => this.runImmersiveStartupMaintenance(
          this.deviceIdentityCache || identity,
        ));
    }
    const maintenanceOwner = { ...currentOwner.context };
    const flight = Promise.resolve().then(async () => {
      if (this.pageUnloaded || !this.ownerScopedRunWriteAllowed(0)) return false;
      const storedOwner = this.readStoredRunOwnerContext();
      if (storedOwner.status !== 'ok'
          || !this.sameRunOwnerContext(maintenanceOwner, storedOwner.context)) return false;
      const expectedOwner = { ...storedOwner.context };

      const activeIdentity = this.identityMatchesRunOwner(identity, expectedOwner)
        ? identity : this.deviceIdentityCache;
      const token = activeIdentity && activeIdentity.deviceToken;
      const tokenMatchesOwner = !!(token
        && this.identityMatchesRunOwner(activeIdentity, expectedOwner));
      const config = resolveCoachBackendConfig(wx);
      const tokenStillCurrent = () => {
        if (this.pageUnloaded || this.pageVisible !== true) return false;
        const latestOwner = this.readStoredRunOwnerContext();
        return latestOwner.status === 'ok'
          && this.sameRunOwnerContext(expectedOwner, latestOwner.context)
          && this.deviceIdentityCache
          && this.deviceIdentityCache.deviceToken === token
          && this.identityMatchesRunOwner(this.deviceIdentityCache, expectedOwner);
      };
      const recordFlight = tokenMatchesOwner
        ? flushPendingAiuiRecords({
          storage: wx,
          baseUrl: config.baseUrl,
          token,
          request: (request) => this.deviceWxRequest(request),
          stillCurrent: tokenStillCurrent,
          onUnauthorized: (rejectedToken) => {
            let storedToken = '';
            try { storedToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY) || ''; } catch (_e) {}
            if (storedToken !== rejectedToken) return;
            clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY });
            this.deviceIdentityCache = null;
          },
        })
        : Promise.resolve(false);
      return Promise.all([
        Promise.resolve(this.flushRunUploads()).catch(() => false),
        Promise.resolve(this.flushAiuiCalibrationUploads()).catch(() => false),
        Promise.resolve(this.flushWorkoutCompletions()).catch(() => false),
        Promise.resolve(recordFlight).catch(() => false),
      ]).then(() => true);
    }).catch(() => false).finally(() => {
      if (this.immersiveStartupMaintenanceFlight === flight) {
        this.immersiveStartupMaintenanceFlight = null;
        this.immersiveStartupMaintenanceOwner = null;
      }
    });
    this.immersiveStartupMaintenanceFlight = flight;
    this.immersiveStartupMaintenanceOwner = maintenanceOwner;
    return flight;
  },

  todayWorkoutDetail(plan) {
    if (!plan || !Array.isArray(plan.stages)) return '';
    const target = plan.target || {};
    let bound = '';
    if (Number(target.duration_sec) > 0) {
      bound = Math.round(Number(target.duration_sec) / 60) + '分钟';
    } else if (Number(target.distance_m) > 0) {
      bound = Number(target.distance_m) >= 1000
        ? (Number(target.distance_m) / 1000).toFixed(1) + '公里'
        : Math.round(Number(target.distance_m)) + '米';
    }
    return [bound, String(plan.stages.length) + '阶段'].filter(Boolean).join(' · ');
  },

  loadHeartRatePolicyForOwner(owner, nowMs = Date.now()) {
    const policy = readHeartRatePolicy(wx, owner, { nowMs });
    this.currentHeartRatePolicy = policy;
    this.currentHeartRatePolicyOwner = policy && owner ? { ...owner } : null;
    return policy;
  },

  applyHeartRatePolicy(policy, owner, nowMs = Date.now()) {
    const normalized = normalizeHeartRatePolicy(policy, { nowMs });
    if (!normalized || !owner) return null;
    this.currentHeartRatePolicy = normalized;
    this.currentHeartRatePolicyOwner = { ...owner };
    if (isPersistableHeartRatePolicy(normalized)) {
      // A healthy current response remains usable in this page even if the
      // host storage bridge is temporarily unavailable. It becomes durable
      // only after the exact owner-scoped value is read back successfully.
      if (!writeHeartRatePolicy(wx, normalized, owner, { nowMs })) {
        console.log('[SmartRun HR Policy] CACHE_WRITE_FAILED');
      }
    } else {
      // conservative_default is intentionally session-only. Remove an older
      // cached personal/estimated value so the next offline run cannot revive
      // a policy Hermes has replaced with a generic default.
      if (!clearHeartRatePolicyStorage(wx)) {
        // The current page still uses only the session fallback set above.
        // Explicitly surface a host-storage failure instead of pretending the
        // previous durable policy was replaced successfully.
        console.log('[SmartRun HR Policy] CACHE_CLEAR_FAILED source=conservative_default');
      }
    }
    return normalized;
  },

  heartRatePolicyForOwner(owner, nowMs = Date.now()) {
    if (this.currentHeartRatePolicy
        && this.currentHeartRatePolicyOwner
        && sameHeartRatePolicyOwner(this.currentHeartRatePolicyOwner, owner)) {
      const current = normalizeHeartRatePolicy(this.currentHeartRatePolicy, { nowMs });
      if (current) return current;
      this.currentHeartRatePolicy = null;
      this.currentHeartRatePolicyOwner = null;
    }
    return this.loadHeartRatePolicyForOwner(owner, nowMs);
  },

  freezeHeartRatePolicyForRun(nowMs = Date.now()) {
    const owner = this.runOwnerContext;
    this.frozenHeartRatePolicy = owner && owner.kind !== 'preidentity'
      ? this.heartRatePolicyForOwner(owner, nowMs)
      : null;
    return this.frozenHeartRatePolicy;
  },

  runHeartRatePolicyFields() {
    const policy = this.frozenHeartRatePolicy;
    return policy ? {
      heartRateMaxHrBpm: policy.max_hr_bpm,
      heartRatePolicySource: policy.source,
    } : {};
  },

  runHeartRateZone(bpm) {
    return heartRateZoneFromPolicy(Number(bpm), this.frozenHeartRatePolicy);
  },

  runHeartRateHigh(bpm) {
    return isConservativeHighHeartRate(Number(bpm), this.frozenHeartRatePolicy);
  },

  applyTodayWorkoutPlan(plan) {
    const previousItems = this.todayWorkoutPlan
      ? ['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings']
      : ['free', 'slow', 'garmin_virtual', 'training', 'settings'];
    const previousSelected = previousItems[this.menuFocusIndex] || 'free';
    const pendingConfirmCancelled = this.clearPendingSurfaceGlobalHook({ keepGuard: true });
    if (pendingConfirmCancelled) {
      this.surfaceEntryConfirmGuardUntilMs = Date.now() + DIRECTION_RELEASE_GUARD_MS;
    }
    this.todayWorkoutPlan = plan || null;
    const available = !!plan;
    const nextItems = available
      ? ['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings']
      : ['free', 'slow', 'garmin_virtual', 'training', 'settings'];
    let nextFocus = 0;
    if (this.menuFocusTouched === true) {
      nextFocus = nextItems.indexOf(previousSelected);
      if (nextFocus < 0) nextFocus = nextItems.indexOf('free');
    }
    this.setMenuFocus(nextFocus, {
      todayWorkoutAvailable: available,
      // 服务端 title 最长可达 80 字；菜单卡固定短标题，完整训练名在 HUD 展示。
      todayWorkoutTitle: '今日训练',
      todayWorkoutDetail: available ? this.todayWorkoutDetail(plan) : '',
    });
    return available;
  },

  workoutPlanVisibilityState(workoutId, owner) {
    const id = String(workoutId || '');
    if (!id || !owner) return { hidden: false, readable: true };
    if (this.workoutCompletionAckedWorkoutIds
        && this.workoutCompletionAckedWorkoutIds[id] === true) {
      return { hidden: true, readable: true };
    }
    const pending = readPendingWorkoutCompletionsState(wx, owner);
    const quarantined = readQuarantinedWorkoutCompletionsState(wx, owner);
    if (!pending.ok || !quarantined.ok) return { hidden: true, readable: false };
    const hidden = pending.items.some(
      (item) => item.payload && item.payload.workout_id === id,
    ) || quarantined.entries.some(
      (entry) => entry.item && entry.item.payload
        && entry.item.payload.workout_id === id,
    );
    return { hidden, readable: true };
  },

  workoutPlanMustStayHidden(workoutId, owner) {
    return this.workoutPlanVisibilityState(workoutId, owner).hidden;
  },

  async refreshWorkoutMenuState(identity = this.deviceIdentityCache) {
    if (this.data.surfacePhase !== 'menu') return null;
    // Always wait for the newest owner-storage generation. An owner transition
    // may replace the promise while an older onLoad/onShow continuation is
    // already queued; that stale continuation must not hide Today indefinitely.
    let storageReady = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = this.workoutDurableStorageGeneration;
      const promise = this.workoutDurableStoragePromise;
      storageReady = !!promise && await promise === true;
      if (generation === this.workoutDurableStorageGeneration) break;
      storageReady = false;
    }
    if (!storageReady || this.workoutDurableStorageReady !== true) {
      this.applyTodayWorkoutPlan(null);
      return null;
    }
    if (this.data.surfacePhase !== 'menu') return null;
    // 完成 ACK 与 current-workout 必须串行。否则旧 planned 回包可能晚于 ACK，
    // 把刚完成的训练重新插回菜单。即便补传暂时失败，本地 pending completion
    // 也会让同 workout 保持不可执行，避免离线重复训练。
    await this.flushWorkoutCompletions();
    if (this.data.surfacePhase !== 'menu') return null;
    if (this.workoutCompletionMenuRefreshPending) {
      this.workoutCompletionMenuRefreshPending = false;
      clearCachedWorkout(wx);
      this.applyTodayWorkoutPlan(null);
    }
    // An older onLoad continuation may have captured null/old identity while a
    // later bootstrap already published the current owner. Never let that
    // stale continuation clear a plan loaded for the newer authoritative cache.
    return this.loadTodayWorkoutForMenu(this.deviceIdentityCache || identity);
  },

  loadTodayWorkoutForMenu(identity = this.deviceIdentityCache) {
    const owner = this.ownerContextFromIdentity(identity);
    if (!owner || owner.kind === 'preidentity' || !(owner.ownershipEpoch >= 1)) {
      this.currentHeartRatePolicy = null;
      this.currentHeartRatePolicyOwner = null;
      if (this.data.surfacePhase === 'menu') this.applyTodayWorkoutPlan(null);
      return Promise.resolve(null);
    }
    this.heartRatePolicyForOwner(owner, Date.now());
    let cached = null;
    if (this.data.surfacePhase === 'menu') {
      cached = readCachedWorkout(wx, owner, { nowMs: Date.now() });
      const cachedVisibility = cached
        ? this.workoutPlanVisibilityState(cached.workout_id, owner)
        : { hidden: false, readable: true };
      if (cached && cachedVisibility.hidden) {
        // 可验证的 pending/quarantine/ACK 才清缓存；unknown 只临时隐藏，保留
        // 唯一可恢复处方证据，待 storage 恢复后重新判断。
        if (cachedVisibility.readable) clearCachedWorkout(wx);
        cached = null;
      }
      this.applyTodayWorkoutPlan(cached);
    }
    const token = identity && identity.deviceToken;
    if (!token || this.pageVisible !== true) return Promise.resolve(cached);
    if (this.todayWorkoutRequestPromise) return this.todayWorkoutRequestPromise;
    const expectedOwner = { ...owner };
    const request = buildCurrentWorkoutRequest({
      token,
      baseUrl: resolveCoachBackendConfig(wx).baseUrl,
    });
    if (!request) return Promise.resolve(cached);
    const flight = this.deviceWxRequest(request).then((response) => {
      if (!this.identityMatchesRunOwner(this.deviceIdentityCache, expectedOwner)) return null;
      const stored = this.readStoredRunOwnerContext();
      if (stored.status !== 'ok'
          || !this.sameRunOwnerContext(stored.context, expectedOwner)) return null;
      const parsed = parseCurrentWorkoutResponse(response, expectedOwner, {
        nowMs: Date.now(),
      });
      // 网络错误或 owner 不匹配不破坏仍有效的离线缓存；只有同 owner 的明确
      // “无可执行计划/legacy suggestion”才清掉旧按钮。
      if (!parsed) return cached;
      if (parsed.heartRatePolicy) {
        this.applyHeartRatePolicy(parsed.heartRatePolicy, expectedOwner, Date.now());
      }
      // 心率策略先于菜单 UI 守卫落地。就算用户已进入搜索/热身，
      // 仍供本场开跑时冻结；若 HUD 已开始，frozen policy 不会热切。
      if (this.data.surfacePhase !== 'menu') {
        return parsed.available && parsed.executable ? parsed.plan : null;
      }
      if (!parsed.available || !parsed.executable || !parsed.plan) {
        clearCachedWorkout(wx);
        this.applyTodayWorkoutPlan(null);
        return null;
      }
      const parsedVisibility = this.workoutPlanVisibilityState(
        parsed.plan.workout_id,
        expectedOwner,
      );
      if (parsedVisibility.hidden) {
        if (parsedVisibility.readable) clearCachedWorkout(wx);
        this.applyTodayWorkoutPlan(null);
        return null;
      }
      if (!writeCachedWorkout(wx, parsed.plan, expectedOwner, { nowMs: Date.now() })) {
        return cached;
      }
      this.applyTodayWorkoutPlan(parsed.plan);
      return parsed.plan;
    }).catch(() => cached).finally(() => {
      if (this.todayWorkoutRequestPromise === flight) {
        this.todayWorkoutRequestPromise = null;
      }
    });
    this.todayWorkoutRequestPromise = flight;
    return flight;
  },

  readStoredRunOwnerContext(options = {}) {
    let replayed = false;
    let available = false;
    try {
      available = ownerScopedDataAvailable(wx, {
        onReplayed: () => { replayed = true; },
      });
    } catch (_e) {
      return { status: 'unknown', context: null };
    }
    if (replayed) return { status: 'destructive', context: null };
    if (!available) return { status: 'unknown', context: null };
    try {
      const publicDeviceIdRaw = wx.getStorageSync(PUBLIC_DEVICE_ID_STORAGE_KEY);
      const binding = wx.getStorageSync(DEVICE_BINDING_STORAGE_KEY);
      const publicDeviceId = typeof publicDeviceIdRaw === 'string'
        ? publicDeviceIdRaw.trim() : '';
      const ownershipEpoch = Number(binding && (
        binding.ownershipEpoch !== undefined
          ? binding.ownershipEpoch : binding.ownership_epoch
      ));
      const dataNamespaceRaw = binding && (
        binding.dataNamespace !== undefined
          ? binding.dataNamespace : binding.data_namespace
      );
      const dataNamespace = typeof dataNamespaceRaw === 'string'
        ? dataNamespaceRaw.trim() : '';
      if (!publicDeviceId || publicDeviceId.length > 160
          || !binding || typeof binding !== 'object'
          || !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 0
          || !dataNamespace || dataNamespace.length > 220) {
        // 只有真正干净、从未激活过服务器身份的安装才能建立本地待归属域。
        // 任何 public/binding/token/legacy/AIUI 残留都可能来自旧 owner，必须
        // fail closed；待归属标记永远不上传，也不是 installation ID。
        const legacyDeviceId = wx.getStorageSync(LEGACY_DEVICE_ID_STORAGE_KEY);
        const deviceToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY);
        const coachToken = wx.getStorageSync(COACH_TOKEN_STORAGE_KEY);
        const aiuiAlias = wx.getStorageSync(AIUI_ID_STORAGE_KEY);
        const installationId = wx.getStorageSync(INSTALLATION_ID_STORAGE_KEY);
        const deviceCredential = wx.getStorageSync(DEVICE_CREDENTIAL_STORAGE_KEY);
        const deviceSecret = wx.getStorageSync(DEVICE_SECRET_STORAGE_KEY);
        const secretBootstrapState = wx.getStorageSync(
          DEVICE_SECRET_BOOTSTRAP_STATE_STORAGE_KEY,
        );
        const recoveryState = wx.getStorageSync(DEVICE_RECOVERY_STATE_STORAGE_KEY);
        const recoveryCandidate = wx.getStorageSync(
          DEVICE_RECOVERY_CANDIDATE_STORAGE_KEY,
        );
        const fingerprintSuppression = wx.getStorageSync(
          HARDWARE_FINGERPRINT_SUPPRESSED_STORAGE_KEY,
        );
        const legacyCoachToken = wx.getStorageSync(
          LEGACY_COACH_TOKEN_STORAGE_KEY,
        );
        const legacyMigrationState = wx.getStorageSync(
          LEGACY_MIGRATION_STATE_STORAGE_KEY,
        );
        const marker = wx.getStorageSync(PREIDENTITY_OWNER_STORAGE_KEY);
        const activationTombstone = wx.getStorageSync(
          IDENTITY_EVER_ACTIVATED_STORAGE_KEY,
        );
        const hasIdentityResidue = !!publicDeviceId
          || !!binding
          || !!legacyDeviceId
          || !!deviceToken
          || !!coachToken
          || !!aiuiAlias
          || !!installationId
          || !!deviceCredential
          || !!deviceSecret
          || !!secretBootstrapState
          || !!recoveryState
          || !!recoveryCandidate
          || !!fingerprintSuppression
          || !!legacyCoachToken
          || !!legacyMigrationState;
        const hasActivationTombstone = activationTombstone !== undefined
          && activationTombstone !== null
          && activationTombstone !== '';
        if (!hasIdentityResidue
            && !hasActivationTombstone
            && marker === PREIDENTITY_OWNER_VALUE) {
          return {
            status: 'ok',
            context: { kind: 'preidentity' },
          };
        }
        const markerMissing = marker === undefined || marker === null || marker === '';
        if (!hasIdentityResidue
            && !hasActivationTombstone
            && markerMissing
            && !hasOwnerScopedPrivateData(wx)
            && options.allowCreatePreidentity === true) {
          wx.setStorageSync(
            PREIDENTITY_OWNER_STORAGE_KEY,
            PREIDENTITY_OWNER_VALUE,
          );
          if (wx.getStorageSync(PREIDENTITY_OWNER_STORAGE_KEY)
              === PREIDENTITY_OWNER_VALUE) {
            return {
              status: 'ok',
              context: { kind: 'preidentity' },
            };
          }
        }
        return { status: 'unknown', context: null };
      }
      return {
        status: 'ok',
        context: {
          publicDeviceId,
          bound: binding.bound === true,
          ownershipEpoch,
          dataNamespace,
        },
      };
    } catch (_e) {
      return { status: 'unknown', context: null };
    }
  },

  sameRunOwnerContext(previous, next) {
    if (previous && next
        && (previous.kind === 'preidentity' || next.kind === 'preidentity')) {
      return previous.kind === 'preidentity' && next.kind === 'preidentity';
    }
    return !!(previous && next
      && previous.publicDeviceId === next.publicDeviceId
      && previous.bound === next.bound
      && previous.ownershipEpoch === next.ownershipEpoch
      && previous.dataNamespace === next.dataNamespace);
  },

  ownerContextFromIdentity(identity) {
    if (!identity || typeof identity !== 'object') return null;
    const publicDeviceId = typeof identity.publicDeviceId === 'string'
      ? identity.publicDeviceId.trim() : '';
    const ownershipEpoch = Number(identity.ownershipEpoch);
    const dataNamespace = typeof identity.dataNamespace === 'string'
      ? identity.dataNamespace.trim() : '';
    if (!publicDeviceId || publicDeviceId.length > 160
        || !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 0
        || !dataNamespace || dataNamespace.length > 220) return null;
    return {
      publicDeviceId,
      bound: identity.bound === true,
      ownershipEpoch,
      dataNamespace,
    };
  },

  identityMatchesRunOwner(identity, ownerContext) {
    return this.sameRunOwnerContext(
      this.ownerContextFromIdentity(identity),
      ownerContext,
    );
  },

  exactOwnerOperationStillCurrent(expectedOwner, expectedGeneration, reason) {
    if (!expectedOwner
        || expectedGeneration !== (this.runOwnerGeneration || 0)) return false;
    const stored = this.readStoredRunOwnerContext();
    if (stored.status === 'unknown') return false;
    if (stored.status === 'ok'
        && this.sameRunOwnerContext(expectedOwner, stored.context)) return true;

    // 异步操作固定的是发起时 owner。正常首次 claim 可以保留本场数据并推进
    // 页面 pin，但旧匿名 token 的操作也必须在这里终止，由下一轮取得新 token。
    if (expectedGeneration > 0) {
      this.reconcileRunOwnerContext(reason || 'async-owner-check');
    } else {
      this.handleRunOwnerDataCleared(reason || 'background-owner-check');
    }
    return false;
  },

  isContinuousFirstClaim(previous, next, proof = null) {
    if (previous && previous.kind === 'preidentity') {
      return !!(next && next.kind !== 'preidentity'
        && next.publicDeviceId
        && Number.isSafeInteger(next.ownershipEpoch)
        && next.dataNamespace);
    }
    return !!(previous && next
      && previous.bound !== true
      && next.bound === true
      && proof && proof.kind === 'anonymous_claim'
      && previous.publicDeviceId
      && previous.publicDeviceId === next.publicDeviceId
      && proof.previousOwnershipEpoch === previous.ownershipEpoch
      && proof.previousDataNamespace === previous.dataNamespace
      && proof.currentOwnershipEpoch === next.ownershipEpoch
      && proof.currentDataNamespace === next.dataNamespace);
  },

  updateRunOwnerPin(next, reason = 'claim') {
    this.runOwnerContext = { ...next };
    // The current run keeps the already-frozen policy. Future runs must fetch
    // or read a policy for the new exact marker; never reinterpret the former
    // owner's cache under the claimed owner.
    this.currentHeartRatePolicy = null;
    this.currentHeartRatePolicyOwner = null;
    // 首次 claim 保留本场数据，但 scoped token 已跨 ownership epoch 失效。
    // 递增网络代次，让所有已发出的匿名 owner 上传在 await 后立即停下。
    this.calibrationOwnerGeneration = (this.calibrationOwnerGeneration || 0) + 1;
    const cached = this.deviceIdentityCache;
    if (cached && !this.identityMatchesRunOwner(cached, next)) {
      // 外部页面完成 claim 时，本页可能仍缓存匿名 scoped token；先停上传，
      // 下一次 bootstrap 再取得同一用户的新 token，不能拿旧 token 猜权限。
      this.deviceIdentityCache = null;
      this.todayWorkoutPlan = null;
      if (!this.activeLocalTrainingPresetId) {
        this.activeWorkoutPlan = null;
        this.workoutExecution = null;
        this.completedWorkoutExecution = null;
      }
    }
    if (this.adaptiveStrideModel) {
      this.adaptiveStrideModel.ownerMarker =
        String(next.ownershipEpoch) + ':' + next.dataNamespace;
    }
    console.log(
      '[SmartRun Owner] PIN_ADVANCED reason=' + reason
        + ' epoch=' + String(next.ownershipEpoch),
    );
  },

  reconcileRunOwnerContext(reason = 'write', ownershipTransition = null) {
    if (!(this.runOwnerGeneration > 0) || this.runOwnerInvalidated) return false;
    const pinned = this.runOwnerContext;
    if (!pinned) return false;
    const stored = this.readStoredRunOwnerContext();
    if (stored.status === 'unknown') return false;
    if (stored.status === 'destructive') {
      this.handleRunOwnerDataCleared(reason + '-journal');
      return false;
    }
    if (this.sameRunOwnerContext(pinned, stored.context)) return true;
    if (this.isContinuousFirstClaim(pinned, stored.context, ownershipTransition)) {
      this.updateRunOwnerPin(stored.context, reason);
      return true;
    }
    this.handleRunOwnerDataCleared(reason + '-mismatch');
    return false;
  },

  ownerScopedRunWriteAllowed(expectedGeneration = this.runOwnerGeneration || 0) {
    if (expectedGeneration !== (this.runOwnerGeneration || 0)) return false;
    // 菜单启动期的历史队列补传不属于当前跑步；仍使用 durable journal 门。
    if (!(expectedGeneration > 0)) {
      let replayed = false;
      let available = false;
      try {
        available = ownerScopedDataAvailable(wx, {
          onReplayed: () => { replayed = true; },
        });
      } catch (_e) {
        return false;
      }
      if (replayed) this.handleRunOwnerDataCleared('background-journal');
      return available && !replayed;
    }
    return this.reconcileRunOwnerContext('owner-write');
  },

  pinRunOwnerContextForStart() {
    const stored = this.readStoredRunOwnerContext({
      allowCreatePreidentity: true,
    });
    if (stored.status === 'destructive') {
      this.handleRunOwnerDataCleared('start-journal');
    }
    this.runOwnerGeneration = (this.runOwnerGeneration || 0) + 1;
    this.runOwnerInvalidated = false;
    this.runOwnerContext = stored.status === 'ok' ? { ...stored.context } : null;
    if (!this.runOwnerContext
        || !this.identityMatchesRunOwner(
          this.deviceIdentityCache,
          this.runOwnerContext,
        )) {
      // 首页或设置页可能刚完成 owner 轮换；开跑只能复用属于新 pin 的 token。
      this.deviceIdentityCache = null;
    }
    return !!this.runOwnerContext;
  },

  handleRunOwnerDataCleared(reason = 'owner-transition') {
    this.calibrationQueueSaturated = false;
    this.clearRunningLocalFieldLogMemory();
    if (this.runOwnerInvalidated) {
      // A second owner event can arrive before this page instance is rebuilt.
      // Keep the already-stopped session invalid, but start a fresh exact-key
      // initialization generation so the next authoritative identity can make
      // Today visible without forcing the user to reopen the page.
      this.deviceIdentityCache = null;
      this.todayWorkoutPlan = null;
      this.activeWorkoutPlan = null;
      this.workoutExecution = null;
      this.completedWorkoutExecution = null;
      this.currentHeartRatePolicy = null;
      this.currentHeartRatePolicyOwner = null;
      this.frozenHeartRatePolicy = null;
      this.restartWorkoutDurableStorageInitialization(reason + '-owner-cleared-again');
      if (this.data.surfacePhase === 'menu') this.applyTodayWorkoutPlan(null);
      return;
    }
    const hadRunState = this.runOwnerGeneration > 0
      || !!this.session
      || !!this.calibrationStream
      || !!this.pendingSummarySnapshot
      || this.isSummaryPhase();
    if (!hadRunState) {
      // 菜单启动期的 journal 重放只清空可能残留的内存队列，不制造一场虚假的
      // “已失效运行”；否则同页后续拿到新身份也会永久停用后台补传。
      this.calibrationOwnerGeneration = (this.calibrationOwnerGeneration || 0) + 1;
      this.calibrationCaptureBuffer = [];
      this.calibrationStream = null;
      this.lastCalibrationDiagnostics = null;
      this.deviceIdentityCache = null;
      // Owner clear must synchronously remove every executable in-memory
      // snapshot before the async exact-key initializer starts. Otherwise the
      // old owner's Today card can remain actionable for one storage roundtrip.
      this.todayWorkoutPlan = null;
      this.activeWorkoutPlan = null;
      this.workoutExecution = null;
      this.completedWorkoutExecution = null;
      this.currentHeartRatePolicy = null;
      this.currentHeartRatePolicyOwner = null;
      this.frozenHeartRatePolicy = null;
      this.workoutCompletionQueued = false;
      this.workoutCompletionMenuRefreshPending = false;
      if (this.data.surfacePhase === 'menu') this.applyTodayWorkoutPlan(null);
      this.restartWorkoutDurableStorageInitialization(reason + '-owner-cleared');
      console.log('[SmartRun Owner] MEMORY_RESET reason=' + reason);
      return;
    }
    this.runOwnerInvalidated = true;
    this.runOwnerGeneration = (this.runOwnerGeneration || 0) + 1;
    this.calibrationOwnerGeneration = (this.calibrationOwnerGeneration || 0) + 1;
    this.calibrationCaptureBuffer = [];
    this.calibrationStream = null;
    this.lastCalibrationDiagnostics = null;
    this.pendingSummarySnapshot = null;
    this.todayWorkoutPlan = null;
    this.activeWorkoutPlan = null;
    this.workoutExecution = null;
    this.completedWorkoutExecution = null;
    this.currentHeartRatePolicy = null;
    this.currentHeartRatePolicyOwner = null;
    this.frozenHeartRatePolicy = null;
    this.workoutCompletionQueued = false;
    this.runUploadQueued = false;
    this.runFinalizationStarted = false;
    this.lastSummaryCheckpointMs = null;
    this.runOwnerContext = null;
    this.deviceIdentityCache = null;
    if (this.summaryFinalizeTimer != null) clearTimeout(this.summaryFinalizeTimer);
    this.summaryFinalizeTimer = null;
    this.cancelSummaryLlm();
    this.clearSummaryExitPrompt();
    this.clearSurfaceTimers();
    this.clearHudReconnectTimer();
    this.clearHrWatchdogTimer();
    this.reconnectDevice = null;
    this.stopTicker();
    try { this.stopAccel(); } catch (_e) {}
    try { this.stopMetronomePlayback({ destroy: true }); } catch (_e) {}
    let cleanup = null;
    try { cleanup = this.teardownBle(); } catch (_e) {}
    this.session = null;
    this.motionMetrics = null;
    this.speedFusion = null;
    this.adaptiveStrideModel = null;
    this.strideCalibration = null;
    this.motionDiagnostics = null;
    this.pendingRscMeasurement = null;
    this.minuteSeries = [];
    this.summaryEnteredAtMs = null;
    this.autoPausedByHide = false;
    this.restartWorkoutDurableStorageInitialization(reason + '-owner-cleared');
    if (hadRunState && !this.agentExitRequested) {
      this.menuFocusIndex = 0;
      this.setData({
        surfacePhase: 'menu',
        running: false,
        paused: false,
        bleState: 'idle',
        hudHint: '',
        hudEnvironment: formatHudClock(Date.now()),
        todayWorkoutAvailable: false,
        workoutActive: false,
        workoutStageLabel: '',
        workoutProgressText: '',
      });
      const invalidatedGeneration = this.runOwnerGeneration;
      Promise.resolve(cleanup).catch(() => {}).then(() => {
        if (invalidatedGeneration === this.runOwnerGeneration
            && !this.agentExitRequested) {
          this.bleTerminated = false;
          this.terminalBleCleanupPromise = null;
        }
      });
    }
    console.log('[SmartRun Owner] SESSION_INVALIDATED reason=' + reason);
  },

  // 保留旧入口给现有诊断与测试；owner 清理必须统一销毁整场状态。
  handleCalibrationOwnerDataCleared() {
    this.handleRunOwnerDataCleared('calibration-owner-reset');
  },

  calibrationDistanceSource(source) {
    if (source === MOTION_SOURCE.RSC_TOTAL_DISTANCE) return 'rsc_distance';
    if (source === MOTION_SOURCE.RSC_SPEED) return 'rsc_speed';
    if (source === MOTION_SOURCE.IMU_STEP) return 'imu';
    return 'none';
  },

  calibrationCadenceSource(source) {
    return source === 'rsc' || source === 'imu' ? source : 'none';
  },

  persistAiuiCalibrationBuffer() {
    const buffered = Array.isArray(this.calibrationCaptureBuffer)
      ? this.calibrationCaptureBuffer : [];
    if (!buffered.length) return true;
    if (!this.ownerScopedRunWriteAllowed()) return false;
    const written = appendPendingAiuiCalibrationEvents(wx, buffered);
    if (!written) return false;
    if (written.length >= AIUI_CALIBRATION_MAX_EVENTS) {
      this.calibrationQueueSaturated = true;
    }
    this.calibrationCaptureBuffer = [];
    return true;
  },

  persistSummaryQueues() {
    const frozen = this.pendingSummarySnapshot
      && typeof this.pendingSummarySnapshot === 'object'
      ? this.pendingSummarySnapshot : null;
    const runNeedsStorage = !!(
      frozen && Number(frozen.elapsedMs) > 0
    );
    const buffered = Array.isArray(this.calibrationCaptureBuffer)
      ? this.calibrationCaptureBuffer : [];
    const calibrationHasElapsedData = buffered.some(
      (event) => Number(event && event.elapsed_ms) > 0,
    );
    // 0ms 误触会生成一个生命周期终点，但它既不是跑步记录也不是校准样本。
    // 不让这类空记录因 run summary 正确拒收而卡住退出。
    if (!runNeedsStorage && buffered.length && !calibrationHasElapsedData) {
      this.calibrationCaptureBuffer = [];
    }
    let runStored = !runNeedsStorage;
    let calibrationStored = false;
    let workoutStored = !this.completedWorkoutExecution;
    if (runNeedsStorage) {
      try {
        runStored = this.queueRunForUpload(this.pendingSummarySnapshot);
      } catch (_e) {}
    }
    try {
      calibrationStored = this.persistAiuiCalibrationBuffer();
    } catch (_e) {}
    if (this.completedWorkoutExecution) {
      try {
        workoutStored = this.queueWorkoutCompletion(this.pendingSummarySnapshot);
      } catch (_e) {}
    }
    if (calibrationStored) this.calibrationStream = null;
    return runStored && calibrationStored && workoutStored;
  },

  retrySummaryPersistence(maxAttempts = 4, delayMs = 120) {
    if (this.summaryPersistRetryPromise) {
      return this.summaryPersistRetryPromise;
    }
    const attemptsLimit = Math.max(1, Math.round(Number(maxAttempts) || 1));
    const retryDelayMs = Math.max(20, Math.round(Number(delayMs) || 120));
    let attempts = 0;
    let resolveFlight = null;
    const flight = new Promise((resolve) => { resolveFlight = resolve; });
    this.summaryPersistRetryPromise = flight;

    const complete = (stored) => {
      if (this.summaryPersistRetryTimer) {
        clearTimeout(this.summaryPersistRetryTimer);
      }
      this.summaryPersistRetryTimer = null;
      if (this.summaryPersistRetryPromise === flight) {
        this.summaryPersistRetryPromise = null;
      }
      resolveFlight(stored === true);
    };
    const attempt = () => {
      this.summaryPersistRetryTimer = null;
      attempts += 1;
      if (this.persistSummaryQueues()) {
        complete(true);
        return;
      }
      if (attempts >= attemptsLimit) {
        complete(false);
        return;
      }
      this.summaryPersistRetryTimer = setTimeout(attempt, retryDelayMs);
    };
    attempt();
    return flight;
  },

  captureAiuiCalibrationSnapshot(now = Date.now(), motionSnapshot = null, options = {}) {
    if (!this.calibrationStream || !this.session || !this.motionMetrics) return null;
    if ((this.runOwnerGeneration || 0) > 0
        && !this.ownerScopedRunWriteAllowed()) return null;
    // 首 30 分钟维持 1Hz 细粒度；durable 队列达到 1800 条后，后续长跑只
    // 每 30 秒补一帧，避免 6–8 小时马拉松反复序列化整个满队列。总结强制帧
    // 始终绕过降频，确保终点状态仍可落盘。
    if (options.force !== true && this.calibrationQueueSaturated === true
        && this.calibrationStream.lastCapturedAtMs != null
        && now - this.calibrationStream.lastCapturedAtMs
          < CALIBRATION_SATURATED_CAPTURE_INTERVAL_MS) return null;
    const motion = motionSnapshot || this.motionMetrics.snapshot(now);
    if (!motion) return null;
    const diagnostic = this.lastCalibrationDiagnostics
      && now - this.lastCalibrationDiagnostics.atMs >= 0
      && now - this.lastCalibrationDiagnostics.atMs <= CALIBRATION_DIAGNOSTIC_FRESH_MS
      ? this.lastCalibrationDiagnostics : null;
    // IMU 静止只描述眼镜本体；同一时刻若标准 RSC 正在提供有效速度和步频，
    // 外部运动证据优先，不能把真实跑动样本记成 stationary。反之，真正的
    // 静止样本必须同时清空 pace/cadence，避免形成 speed=0 + 正配速的矛盾帧。
    const externalRscMotion = !!(
      motion.rscFresh === true
      && motion.rscPaceLive === true
      && Number(motion.rscSpeedMps) > 0
      && motion.cadenceReady === true
      && Number(motion.cadenceSpm) > 0
    );
    const stationary = !!(
      diagnostic
      && diagnostic.stationary === true
      && !externalRscMotion
    );
    const hasSpeedOverride = Object.prototype.hasOwnProperty.call(
      options,
      'algorithmSpeedMps',
    );
    const hasPaceOverride = Object.prototype.hasOwnProperty.call(
      options,
      'algorithmPaceSecPerKm',
    );
    let speedMps = hasSpeedOverride && options.algorithmSpeedMps != null
      ? Number(options.algorithmSpeedMps) : (hasSpeedOverride
        ? null : Number(motion.speedMps));
    if (stationary) speedMps = 0;
    if (!(speedMps >= 0 && speedMps <= 20)) speedMps = stationary ? 0 : null;
    let paceSecPerKm = hasPaceOverride && options.algorithmPaceSecPerKm != null
      ? Number(options.algorithmPaceSecPerKm)
      : (speedMps > 0 ? 1000 / speedMps : null);
    if (!(paceSecPerKm >= 60 && paceSecPerKm <= 3600)) paceSecPerKm = null;
    if (stationary) paceSecPerKm = null;
    const acceptedSteps = Math.max(
      0,
      Math.round(Number(this.motionMetrics.acceptedSteps) || 0),
    );
    const candidateSteps = Math.max(
      acceptedSteps,
      Math.round(Number(this.motionDiagnostics
        && this.motionDiagnostics.candidateSteps) || 0),
    );
    const event = captureAiuiCalibrationEvent(this.calibrationStream, {
      elapsed_ms: Math.max(0, Math.round(Number(motion.elapsedMs) || 0)),
      cadence_spm: stationary
        ? 0
        : (motion.cadenceReady === true ? Number(motion.cadenceSpm) : null),
      candidate_cadence_spm: diagnostic
        ? diagnostic.candidateCadenceSpm : null,
      speed_mps: speedMps,
      pace_sec_per_km: paceSecPerKm,
      distance_m: Math.max(0, Number(motion.distanceM) || 0),
      steps_total: acceptedSteps,
      accepted_steps: acceptedSteps,
      candidate_steps: candidateSteps,
      rejected_steps: Math.max(0, candidateSteps - acceptedSteps),
      motion_quality: diagnostic ? diagnostic.motionQuality : null,
      artifact_confidence: diagnostic ? diagnostic.artifactConfidence : null,
      gyro_rms: diagnostic ? diagnostic.gyroRms : null,
      stationary: diagnostic ? stationary : null,
      distance_source: this.calibrationDistanceSource(
        motion.activeMotionSource || motion.distanceSource,
      ),
      cadence_source: this.calibrationCadenceSource(motion.cadenceSource),
      rejection_reason: diagnostic ? diagnostic.rejectionReason : '',
    }, {
      capturedAtMs: now,
      force: options.force === true,
    });
    if (!event) return null;
    if (!Array.isArray(this.calibrationCaptureBuffer)) {
      this.calibrationCaptureBuffer = [];
    }
    this.calibrationCaptureBuffer.push(event);
    if (options.deferPersist !== true
        && this.calibrationCaptureBuffer.length >= CALIBRATION_PERSIST_EVERY) {
      // 跑中仅把 1Hz 派生样本写入本地 durable 队列，不触发网络。总结页会
      // 一次性按后端上限分批发送；断网或快速退出后由首页继续补传。
      this.persistAiuiCalibrationBuffer();
    }
    return event;
  },

  async flushAiuiCalibrationUploads() {
    const runOwnerGeneration = this.runOwnerGeneration || 0;
    let expectedOwner = null;
    if (runOwnerGeneration > 0) {
      if (!this.ownerScopedRunWriteAllowed(runOwnerGeneration)) return;
      expectedOwner = this.runOwnerContext
        ? { ...this.runOwnerContext } : null;
    } else {
      const stored = this.readStoredRunOwnerContext();
      if (stored.status === 'destructive') {
        this.handleRunOwnerDataCleared('calibration-background-journal');
      }
      if (stored.status !== 'ok') return;
      expectedOwner = { ...stored.context };
    }
    if (!this.exactOwnerOperationStillCurrent(
      expectedOwner,
      runOwnerGeneration,
      'calibration-start',
    )) return;
    const existingFlight = this.calibrationFlushFlight;
    if (existingFlight
        && existingFlight.runOwnerGeneration === runOwnerGeneration
        && this.sameRunOwnerContext(existingFlight.expectedOwner, expectedOwner)) {
      return;
    }
    if (!this.persistAiuiCalibrationBuffer()) return;
    const initialQueueState = readPendingAiuiCalibrationEventsState(wx);
    if (!this.exactOwnerOperationStillCurrent(
      expectedOwner,
      runOwnerGeneration,
      'calibration-after-persist',
    )
        || !initialQueueState.ok
        || !initialQueueState.events.length) return;
    let identity = this.deviceIdentityCache;
    let token = identity && identity.deviceToken;
    // 此方法只由总结收场或首页兜底显式调用。尚未拿到 token 时只保留
    // durable 队列，绝不为了实验上传阻塞总结 UI 或延迟退出。
    if (!token || !this.identityMatchesRunOwner(identity, expectedOwner)) return;
    const flight = {
      expectedOwner: { ...expectedOwner },
      runOwnerGeneration,
      calibrationOwnerGeneration: this.calibrationOwnerGeneration || 0,
    };
    this.calibrationFlushFlight = flight;
    try {
      const config = resolveCoachBackendConfig(wx);
      let authRetried = false;
      let batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
      let completedBatches = 0;
      const ownerGeneration = this.calibrationOwnerGeneration || 0;
      // 总结阶段正常最多提交四个 500 条批次（覆盖本地 1800 条上限）；
      // 出现永久冲突时用前缀二分定位单条毒丸，避免连带丢弃同批有效数据。
      for (let attempt = 0;
        attempt < 20 && completedBatches < 4;
        attempt += 1) {
        if (ownerGeneration !== (this.calibrationOwnerGeneration || 0)
            || !this.exactOwnerOperationStillCurrent(
              expectedOwner,
              runOwnerGeneration,
              'calibration-before-read',
            )) return;
        const pendingState = readPendingAiuiCalibrationEventsState(wx);
        if (!pendingState.ok || !pendingState.events.length) return;
        const pending = pendingState.events;
        // 单批固定一个 stream，使 ACK/matched 能形成可复核的逐场回执；协议
        // 仍然是原有 events 批量端点和 500 条上限。
        const activeStreamId = pending[0].stream_id;
        const batch = pending.filter(
          (event) => event.stream_id === activeStreamId,
        ).slice(0, batchLimit);
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'calibration-before-send',
        )) return;
        const response = await this.deviceWxRequest(buildAiuiCalibrationRequest({
          baseUrl: config.baseUrl,
          token,
          events: batch,
        }));
        if (ownerGeneration !== (this.calibrationOwnerGeneration || 0)
            || !this.exactOwnerOperationStillCurrent(
              expectedOwner,
              runOwnerGeneration,
              'calibration-after-send',
            )) return;
        if (response && response.statusCode === 401) {
          if (authRetried) return;
          if (!this.exactOwnerOperationStillCurrent(
            expectedOwner,
            runOwnerGeneration,
            'calibration-before-auth-clear',
          )) return;
          let storedToken = '';
          try { storedToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY) || ''; } catch (_e) {
            return;
          }
          // 同一 owner 也可能已由另一页刷新出较新的 token；旧 401 不能清它。
          if (storedToken !== token) return;
          clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY });
          this.deviceIdentityCache = null;
          identity = await this.refreshDeviceIdentity();
          if (!identity || identity.network !== true || !identity.deviceToken
              || !this.identityMatchesRunOwner(identity, expectedOwner)
              || ownerGeneration !== (this.calibrationOwnerGeneration || 0)
              || !this.exactOwnerOperationStillCurrent(
                expectedOwner,
                runOwnerGeneration,
                'calibration-after-auth-refresh',
              )) return;
          token = identity.deviceToken;
          const latestIds = {};
          if (!this.exactOwnerOperationStillCurrent(
            expectedOwner,
            runOwnerGeneration,
            'calibration-before-auth-reread',
          )) return;
          const latestState = readPendingAiuiCalibrationEventsState(wx);
          if (!latestState.ok) return;
          for (let i = 0; i < latestState.events.length; i += 1) {
            latestIds[latestState.events[i].event_id] = true;
          }
          if (!batch.every((event) => latestIds[event.event_id])) {
            authRetried = false;
            continue;
          }
          authRetried = true;
          attempt -= 1;
          continue;
        }
        authRetried = false;
        if (ownerGeneration !== (this.calibrationOwnerGeneration || 0)) return;
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'calibration-before-result',
        )) return;
        if (response
            && isPermanentAiuiCalibrationRejection(response.statusCode)) {
          if (batch.length > 1) {
            batchLimit = Math.max(1, Math.floor(batch.length / 2));
            continue;
          }
          console.warn(
            '[SmartRun Calibration] quarantine invalid event status='
              + response.statusCode + ' event=' + batch[0].event_id,
          );
          if (!this.exactOwnerOperationStillCurrent(
            expectedOwner,
            runOwnerGeneration,
            'calibration-before-quarantine',
          )) return;
          if (!quarantineAiuiCalibrationEvent(
            wx,
            batch[0],
            response.statusCode,
          )) return;
          if (removePendingAiuiCalibrationEvents(
            wx,
            batch.map((event) => event.event_id),
          ) === null) return;
          batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
          continue;
        }
        const parsed = parseAiuiCalibrationResponse(response, batch);
        if (!parsed) return;
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'calibration-before-ack',
        )) return;
        const acked = {};
        for (let i = 0; i < parsed.ackedEventIds.length; i += 1) {
          acked[parsed.ackedEventIds[i]] = true;
        }
        const latestBeforeReceiptState = readPendingAiuiCalibrationEventsState(wx);
        if (!latestBeforeReceiptState.ok) return;
        const projectedRemaining = latestBeforeReceiptState.events.filter(
          (event) => !acked[event.event_id],
        ).length;
        const receipt = createCalibrationUploadReceipt(
          batch,
          parsed.ackedEventIds,
          {
            matchedCount: parsed.matched,
            completedAtMs: Date.now(),
            remainingCount: projectedRemaining,
          },
        );
        if (!receipt || !appendRunUploadReceipt(wx, receipt)) return;
        if (removePendingAiuiCalibrationEvents(wx, parsed.ackedEventIds) === null) return;
        this.refreshSummaryHermesState(true);
        completedBatches += 1;
        batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
        console.log(
          '[SmartRun Calibration] uploaded=' + parsed.ackedEventIds.length
            + ' matched=' + parsed.matched,
        );
      }
    } finally {
      if (this.calibrationFlushFlight === flight) {
        this.calibrationFlushFlight = null;
      }
    }
  },

  syncDeviceIdentityData(identity) {
    const current = identity || {};
    const aiuiId = formatAiuiId(current.aiuiId);
    const idReady = aiuiId !== '待分配';
    const bound = current.bound === true;
    const recoveryRequired = current.credentialRecoveryRequired === true;
    let bindingState = bound ? '智能体已绑定' : '尚未绑定智能体';
    let bindingDetail = bound
      ? ((current.agentAlias || 'SmartRun') + ' · 本地身份已保存')
      : '可在已登录 APK 输入此 ID 绑定';
    let bindingChip = bound ? '已绑定' : (idReady ? '未绑定' : '待联网');
    let bindingActionLabel = '刷新状态';
    if (current.credentialStorageUnavailable === true) {
      // 存储不可用时，即使后端同时要求恢复，也不能诱导用户执行会轮换身份的
      // 操作；先恢复可靠持久化能力，再允许显式重建。
      bindingState = '本地存储暂不可用';
      bindingDetail = '无法安全保存设备身份，请稍后重试';
      bindingChip = '存储异常';
      bindingActionLabel = '重试';
    } else if (recoveryRequired) {
      bindingState = '本地身份凭据已失效';
      bindingDetail = '确认后创建新的匿名身份；旧身份不会被接管';
      bindingChip = '需恢复';
      bindingActionLabel = '确认重建本地身份';
    } else if (current.credentialPersistenceFailed === true) {
      const missingSecret = current.persistenceFailureReason === 'secret_missing';
      const registrationCommit = current.persistenceFailureReason === 'registration_commit_failed';
      bindingState = missingSecret
        ? '安全身份尚未建立'
        : (registrationCommit ? '服务器身份缓存未完成' : '身份保存尚未完成');
      bindingDetail = missingSecret
        ? '服务器长期凭据尚未就绪，请联网后重试'
        : (registrationCommit
          ? 'ID 与安全凭据未完整写入，请重新同步'
          : '设备身份未完整提交，请重新同步');
      bindingChip = '待重试';
      bindingActionLabel = '重试';
    } else if (current.networkDiagnostic === 'timeout') {
      bindingState = '服务器连接超时';
      bindingDetail = '请确认手机联网且眼镜已连接 Rokid App';
      bindingChip = '连接超时';
      bindingActionLabel = '重试';
    } else if (current.networkDiagnostic === 'domain') {
      bindingState = '请求域名未放行';
      bindingDetail = '请检查 AIUI 开发后台的请求域名配置';
      bindingChip = '域名配置';
      bindingActionLabel = '重试';
    } else if (current.networkDiagnostic === 'network') {
      bindingState = '无法连接 SmartRun 服务器';
      bindingDetail = '请检查手机网络与 Rokid App 连接';
      bindingChip = '网络异常';
      bindingActionLabel = '重试';
    } else if (current.networkDiagnostic === 'http') {
      bindingState = '服务器暂时拒绝请求';
      bindingDetail = '本地记录安全保留，请稍后重试';
      bindingChip = '服务异常';
      bindingActionLabel = '重试';
    } else if (current.networkDiagnostic === 'response') {
      bindingState = '服务器响应无法识别';
      bindingDetail = '请更新 AIX 或稍后重试';
      bindingChip = '响应异常';
      bindingActionLabel = '重试';
    } else if (current.registrationPending === true) {
      bindingState = current.registrationCredentialFailed === true
        ? '长期设备凭据获取失败' : '正在建立设备身份';
      bindingDetail = '服务器长期凭据会安全缓存并持续复用';
      bindingChip = '注册重试';
      bindingActionLabel = '重试';
    } else if (!bound && current.network !== true && !idReady) {
      bindingState = '正在等待服务器分配';
      bindingDetail = '本地身份已准备，联网后会自动继续';
    }
    const patch = {
      settingBinding: bound ? '已绑定' : (idReady ? '未绑定' : '待联网'),
      bindingAiuiId: aiuiId,
      bindingState,
      bindingDetail,
      bindingChip,
      bindingActionLabel,
    };
    // 导出可能持续数秒；迟到的 bootstrap 仍可刷新 ID 和刷新按钮，但不得覆盖
    // 当前导出进度/END 完成提示。
    if (this.bindingExportPending === true) {
      delete patch.bindingState;
      delete patch.bindingDetail;
      delete patch.bindingChip;
    }
    this.setData(patch);
  },

  setBindingFocus(index, extraPatch = {}) {
    const raw = Number(index) || 0;
    const next = ((raw % 2) + 2) % 2;
    this.bindingFocusIndex = next;
    this.setData({
      ...extraPatch,
      bindingRefreshClass: next === 0 ? 'binding-action-focused' : '',
      bindingExportClass: next === 1 ? 'binding-action-focused' : '',
    });
    return next;
  },

  onBindingFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.shouldAcceptHostFocus('binding', index, this.bindingFocusIndex)) return false;
    this.setBindingFocus(index);
    return true;
  },

  onBindingTap(event) {
    if (this.data.surfacePhase !== 'binding') return false;
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    const action = dataset && dataset.action ? String(dataset.action) : 'refresh';
    this.setBindingFocus(index);
    return action === 'export'
      ? this.onBindingExportTap() : this.onBindingActionTap();
  },

  openDevicePairing() {
    // 某些宿主会把同一次物理确认同时派成 button tap 与尾随 keyup。记录入场时刻，
    // 防止“进入绑定页”的同一手势顺带触发服务器刷新。
    this.stopMetronomePlayback();
    const now = Date.now();
    this.bindingEnteredAtMs = now;
    this.bindingExportPending = false;
    this.armSurfaceEntryInputGuard(now);
    this.setData({
      surfacePhase: 'binding',
      bindingState: '正在读取绑定状态',
      bindingDetail: '身份只保存在本机与 SmartRun 服务器',
      bindingChip: '读取中',
      bindingActionLabel: '正在刷新',
      bindingExportLabel: '导出现场日志',
    });
    this.setBindingFocus(0);
    this.refreshDeviceIdentity().catch(() => {
      if (this.bindingExportPending === true) return;
      this.setData({
        bindingState: '服务器暂不可用',
        bindingDetail: '本地设置与跑步记录仍可正常使用',
        bindingChip: '离线',
        bindingActionLabel: '重试',
      });
    });
    return true;
  },

  showSettingsFromBinding() {
    this.bindingActionPending = false;
    this.bindingExportPending = false;
    this.bindingEnteredAtMs = null;
    this.cancelRunningLocalFieldLogReplay();
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearSurfaceActivationGate();
    this.setData({ surfacePhase: 'settings' });
    this.syncSettingsData();
    this.setSettingFocus(4);
    this.refreshDeviceIdentity();
    return true;
  },

  async recoverDeviceIdentityFromBinding(config) {
    const recovered = await recoverFreshAnonymousDeviceIdentity({
      storage: wx,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      appKey: config.appKey,
      cryptoObject: typeof crypto === 'undefined' ? null : crypto,
      coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY,
      onOwnerDataCleared: () => this.handleCalibrationOwnerDataCleared(),
      request: (request) => this.deviceWxRequest(request),
      userConfirmed: true,
    });
    this.deviceIdentityCache = recovered;
    this.syncDeviceIdentityData(recovered);
    return recovered && recovered.network === true;
  },

  async onBindingActionTap() {
    if (this.data.surfacePhase !== 'binding') return false;
    if (this.bindingEnteredAtMs != null
        && Date.now() - this.bindingEnteredAtMs < SURFACE_CONFIRM_DEDUPE_MS) return false;
    if (this.bindingActionPending || this.bindingExportPending) return false;
    if (!this.claimSurfaceActivation('binding-refresh')) return false;
    // “重试存储/刷新状态”与“确认重建身份”必须是两次独立、可见的用户动作。
    // 若本次刷新才首次发现 credentialRecoveryRequired，只更新 UI；不能把原本
    // 的“重试”点击升级成会轮换 installation/secret 的授权。
    const recoveryWasExplicitlyOffered = this.data.bindingChip === '需恢复'
      && this.data.bindingActionLabel === '确认重建本地身份';
    this.bindingActionPending = true;
    const config = resolveCoachBackendConfig(wx);
    try {
      let identity = await this.refreshDeviceIdentity();
      if (identity && identity.credentialRecoveryRequired === true) {
        this.syncDeviceIdentityData(identity);
        if (identity.credentialStorageUnavailable === true
            || !recoveryWasExplicitlyOffered) return false;
        return await this.recoverDeviceIdentityFromBinding(config);
      }
      this.syncDeviceIdentityData(identity);
      return !!(identity && identity.network === true);
    } catch (_e) {
      this.setData({
        bindingState: '服务器暂不可用',
        bindingDetail: '本地设置与跑步记录不会丢失',
        bindingChip: '离线',
        bindingActionLabel: '重试',
      });
      return false;
    } finally {
      this.bindingActionPending = false;
    }
  },

  onBindingExportTap() {
    if (this.data.surfacePhase !== 'binding') return false;
    if (this.bindingEnteredAtMs != null
        && Date.now() - this.bindingEnteredAtMs < SURFACE_CONFIRM_DEDUPE_MS) return false;
    if (this.bindingActionPending || this.bindingExportPending) return false;
    if (!this.claimSurfaceActivation('binding-export')) return false;
    let indexResult = null;
    try { indexResult = readRunningLocalFieldLogIndexResult(wx); } catch (_e) {}
    if (!indexResult || indexResult.ok !== true) {
      this.setData({
        bindingState: '现场日志暂时无法导出',
        bindingDetail: '本地记录仍保留，请稍后重试',
        bindingChip: '导出失败',
        bindingExportLabel: '重试导出',
      });
      return false;
    }
    let latest = null;
    try { latest = readLatestRunningLocalFieldLog(wx); } catch (_e) {}
    if (!latest && indexResult.index && indexResult.index.runs.length === 0) {
      this.setData({
        bindingState: '暂无可导出的跑步日志',
        bindingDetail: '完成一次跑步并保存总结后再导出',
        bindingChip: '无日志',
        bindingExportLabel: '暂无现场日志',
      });
      return false;
    }
    if (!latest) {
      this.setData({
        bindingState: '现场日志暂时无法导出',
        bindingDetail: '本地记录仍保留，请稍后重试',
        bindingChip: '导出失败',
        bindingExportLabel: '重试导出',
      });
      return false;
    }
    this.bindingExportPending = true;
    this.setData({
      bindingState: '正在导出现场日志',
      bindingDetail: '请保持电脑 ADB 实时抓取，看到 END 即完成',
      bindingChip: '导出中',
      bindingExportLabel: '正在导出',
    });
    this.latestRunningLocalFieldLogDigest(latest);
    const started = this.replayRunningLocalFieldLog(latest, {
      onComplete: () => {
        this.bindingExportPending = false;
        if (this.data.surfacePhase !== 'binding' || this.pageUnloaded === true) return;
        this.setData({
          bindingState: '现场日志导出完成',
          bindingDetail: '电脑看到 END 后即可停止抓取并运行提取命令',
          bindingChip: '已导出',
          bindingExportLabel: '再次导出',
        });
      },
    });
    if (started) return true;
    this.bindingExportPending = false;
    this.setData({
      bindingState: '现场日志暂时无法导出',
      bindingDetail: '本地记录仍保留，请稍后重试',
      bindingChip: '导出失败',
      bindingExportLabel: '重试导出',
    });
    return false;
  },

  applyHeartRateSettingToEntry() {
    if (!this.runSettings || this.runSettings.autoHeartRate !== false) return;
    this.scanAttempted = true;
    this.setData({
      searchText: this.isGarminVirtualMode()
        ? '心率搜索已关闭，无法接收手表数据'
        : '心率设备已关闭',
      searchChip: '纯眼镜模式',
      primaryLabel: '下一步',
      scanDiagnostic: this.isGarminVirtualMode()
        ? '可继续使用眼镜估算，或先在设置中开启心率搜索'
        : '可在设置中重新开启心率设备',
      scanProgressText: '已关闭',
    });
  },

  isGarminVirtualMode() {
    return this.runMode === 'garmin_virtual';
  },

  isSlowJogMode() {
    return this.runMode === 'slow';
  },

  persistedRunMode() {
    if (this.isGarminVirtualMode()) return 'garmin_virtual';
    return this.isSlowJogMode() ? 'slow' : 'free';
  },

  runEntryCopy(state = 'idle') {
    const virtual = this.isGarminVirtualMode();
    const slow = this.isSlowJogMode();
    if (state === 'scanning') {
      return virtual ? {
        searchText: '正在搜索室内跑设备...',
        scanDiagnostic: 'Garmin 数据优先 · 无设备时用眼镜估算',
      } : slow ? {
        searchText: '正在搜索心率设备...',
        scanDiagnostic: '超慢跑将由眼镜估算步频与步数',
      } : {
        searchText: '正在搜索心率设备...',
        scanDiagnostic: '等待附近设备广播',
      };
    }
    if (state === 'connecting') {
      return {
        searchText: virtual ? '正在连接室内跑设备' : '正在连接心率设备',
      };
    }
    if (state === 'connected') {
      return {
        searchText: virtual
          ? '心率已连接 · 等待室内跑数据'
          : (slow ? '心率已连接 · 超慢跑准备就绪' : '已连接心率设备'),
      };
    }
    return virtual ? {
      searchText: 'Garmin 手表请选择 Virtual Run 并按 START',
      searchChip: '室内跑',
      scanDiagnostic: 'Garmin 数据优先 · 无设备时用眼镜估算',
    } : slow ? {
      searchText: '原地小步 · 轻落地 · 保持轻松呼吸',
      searchChip: '超慢跑',
      scanDiagnostic: '可连接心率设备，也可直接下一步',
    } : {
      searchText: '单击开始搜索心率设备',
      searchChip: '未搜索',
      scanDiagnostic: '还没有开始搜索',
    };
  },

  setMenuFocus(index, extraPatch = {}) {
    const items = this.todayWorkoutPlan
      ? ['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings']
      : ['free', 'slow', 'garmin_virtual', 'training', 'settings'];
    const raw = Number(index) || 0;
    const count = this.todayWorkoutPlan ? MENU_FOCUS_COUNT + 1 : MENU_FOCUS_COUNT;
    const next = ((raw % count) + count) % count;
    const selected = items[next];
    if (selected !== 'today' && this.todayWorkoutLaunchPromise) {
      this.invalidateTodayWorkoutLaunch('menu-focus');
    }
    const todayOffset = this.todayWorkoutPlan ? 1 : 0;
    this.menuFocusIndex = next;
    this.setData({
      ...extraPatch,
      menuTodayClass: selected === 'today' ? 'feature-focused' : '',
      menuFreeClass: selected === 'free' ? 'feature-focused' : '',
      menuSlowClass: selected === 'slow' ? 'feature-focused' : '',
      menuVirtualClass: selected === 'garmin_virtual' ? 'feature-focused' : '',
      menuTrainingClass: selected === 'training' ? 'feature-focused' : '',
      menuSettingsClass: selected === 'settings' ? 'feature-focused' : '',
      menuTodayTabIndex: this.todayWorkoutPlan ? 0 : -1,
      menuFreeTabIndex: todayOffset,
      menuSlowTabIndex: todayOffset + 1,
      menuVirtualTabIndex: todayOffset + 2,
      menuTrainingTabIndex: todayOffset + 3,
      menuSettingsTabIndex: todayOffset + 4,
      menuLayoutClass: this.todayWorkoutPlan ? 'feature-menu-has-plan' : '',
    });
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
      || this.data.surfacePhase === 'training'
      || this.data.surfacePhase === 'settings'
      || this.data.surfacePhase === 'binding'
      || this.isRecoveryChoicePhase()
      || this.isSearchPhase();
  },

  handleSurfaceDirection(code, now = Date.now(), source = 'keyup') {
    if (!this.isSurfaceDirectionCode(code) || !this.canHandleSurfaceDirection()) return false;
    // 前划(ArrowDown/Right)进入下一项，后划(ArrowUp/Left)回到上一项。
    // GlobalHook 在部分 Rokid 宿主上会先于方向码到达：方向码先取消待定轻拍，
    // 再用整手势 600ms 保护吞掉 TouchEnd/bindtap 尾包，绝不激活旧焦点。
    this.clearPendingSurfaceGlobalHook();
    this.menuEntryConfirmGuardUntilMs = null;
    this.surfaceEntryConfirmGuardUntilMs = now + DIRECTION_RELEASE_GUARD_MS;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearSurfaceActivationGate();
    const delta = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;
    const shouldMove = this.claimSurfaceDirection(code, delta, now);
    if (!shouldMove) {
      this.bleDebug('DIRECTION_DUPLICATE', String(source) + ':' + String(code));
      return true;
    }
    if (this.data.surfacePhase === 'menu') {
      this.menuFocusTouched = true;
      this.setMenuFocus(this.menuFocusIndex + delta);
    } else if (this.data.surfacePhase === 'training') {
      this.setTrainingFocus(this.trainingFocusIndex + delta);
    } else if (this.data.surfacePhase === 'settings') {
      this.setSettingFocus(this.settingFocusIndex + delta);
    } else if (this.data.surfacePhase === 'binding') {
      this.setBindingFocus(this.bindingFocusIndex + delta);
    } else if (this.isRecoveryChoicePhase()) {
      this.setRecoveryCompletionFocus(this.recoveryCompletionFocusIndex + delta);
    } else {
      this.setSearchFocus(this.searchFocusIndex + delta);
    }
    this.bleDebug('DIRECTION_MOVE', String(source) + ':' + String(code));
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
    if (directionStillReleasing && Number(index) !== Number(currentIndex)) {
      this.bleDebug('HOST_FOCUS_STALE',
        String(phase) + ':' + String(index) + '!=' + String(currentIndex));
      return false;
    }
    return true;
  },

  onMenuFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.shouldAcceptHostFocus('menu', index, this.menuFocusIndex)) return false;
    if (index !== this.menuFocusIndex) this.menuFocusTouched = true;
    this.setMenuFocus(index);
    return true;
  },

  setTrainingFocus(index) {
    const raw = Number(index) || 0;
    const next = ((raw % TRAINING_FOCUS_COUNT) + TRAINING_FOCUS_COUNT)
      % TRAINING_FOCUS_COUNT;
    const keys = ['Easy', 'Long', 'Fartlek', 'Interval', 'Back'];
    const patch = {};
    for (let i = 0; i < keys.length; i += 1) {
      patch['training' + keys[i] + 'Class'] = i === next
        ? 'training-option-focused' : '';
    }
    this.trainingFocusIndex = next;
    this.setData(patch);
  },

  onTrainingFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.shouldAcceptHostFocus('training', index, this.trainingFocusIndex)) return false;
    this.setTrainingFocus(index);
    return true;
  },

  onTrainingTap(event) {
    if (this.data.surfacePhase !== 'training') return false;
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const presetId = dataset && dataset.preset ? String(dataset.preset) : '';
    const index = dataset && dataset.index != null ? Number(dataset.index) : 0;
    if (!this.claimSurfaceActivation('training-' + (presetId || 'back'))) return false;
    this.setTrainingFocus(index);
    if (presetId === 'back') {
      const returned = this.showFeatureMenu();
      if (returned) {
        this.menuEntryConfirmGuardUntilMs = Date.now() + SURFACE_ENTRY_CONFIRM_GRACE_MS;
      }
      return returned;
    }
    if (!TRAINING_PRESET_IDS.includes(presetId)) return false;
    const plan = buildTrainingPreset(presetId, LOCAL_TRAINING_OWNER, Date.now());
    if (!plan) return false;
    return this.openRunMode('free', {
      workoutPlan: plan,
      localPresetId: presetId,
      activationClaimed: true,
    });
  },

  activateTrainingFocused() {
    const ids = [...TRAINING_PRESET_IDS, 'back'];
    const presetId = ids[this.trainingFocusIndex] || ids[0];
    return this.onTrainingTap({
      currentTarget: {
        dataset: { preset: presetId, index: this.trainingFocusIndex },
      },
    });
  },

  isMultiTargetSurface() {
    return this.data.surfacePhase === 'menu'
      || this.data.surfacePhase === 'training'
      || this.data.surfacePhase === 'settings'
      || this.data.surfacePhase === 'binding'
      || this.isRecoveryChoicePhase()
      || this.isSearchPhase();
  },

  clearPendingSurfaceGlobalHook(options = {}) {
    const hadPending = !!this.pendingSurfaceGlobalHookTimer
      || !!this.pendingSurfaceGlobalHookPhase;
    if (this.pendingSurfaceGlobalHookTimer) {
      clearTimeout(this.pendingSurfaceGlobalHookTimer);
    }
    this.pendingSurfaceGlobalHookTimer = null;
    this.pendingSurfaceGlobalHookPhase = null;
    this.pendingSurfaceGlobalHookAtMs = null;
    this.pendingSurfaceGlobalHookToken = (this.pendingSurfaceGlobalHookToken || 0) + 1;
    // 只清掉由 pending GlobalHook 自己建立的临时门；方向手势随后会重新武装
    // 更长的 DIRECTION_RELEASE_GUARD_MS，不能被迟到的清理覆盖。
    if (hadPending && options.keepGuard !== true) {
      this.surfaceEntryConfirmGuardUntilMs = null;
    }
    return hadPending;
  },

  activateMultiTargetFocused() {
    if (this.data.surfacePhase === 'menu') {
      const items = this.todayWorkoutPlan
        ? ['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings']
        : ['free', 'slow', 'garmin_virtual', 'training', 'settings'];
      const selected = items[this.menuFocusIndex] || items[0];
      if (selected === 'today') return this.openTodayWorkout();
      if (selected === 'slow') return this.openSlowMode();
      if (selected === 'garmin_virtual') return this.openGarminVirtualMode();
      if (selected === 'training') return this.openTrainingMode();
      if (selected === 'settings') return this.openSettingsMode();
      return this.openFreeMode();
    }
    if (this.data.surfacePhase === 'training') {
      return this.activateTrainingFocused();
    }
    if (this.data.surfacePhase === 'settings') {
      const keys = [
        'stride', 'voice', 'metronome', 'guide', 'binding', 'heart', 'back',
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
    if (this.data.surfacePhase === 'binding') {
      return this.bindingFocusIndex === 1
        ? this.onBindingExportTap() : this.onBindingActionTap();
    }
    if (this.isRecoveryChoicePhase()) {
      return this.activateRecoveryCompletionFocused();
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
        this.bleDebug('SEARCH_DOUBLE_TAP_EXIT', 'gap=' + String(gapMs));
        return this.closeAgentFromSummary('search-double-tap');
      }
      if (gapMs >= 0 && gapMs < SEARCH_DOUBLE_TAP_MIN_GAP_MS) {
        this.bleDebug('GLOBAL_HOOK_DUPLICATE', 'gap=' + String(gapMs));
        return true;
      }
    }
    if ((this.data.surfacePhase === 'menu' && this.isMenuEntryInputGuarded(now))
        || this.isSurfaceEntryInputGuarded(now)) {
      this.bleDebug('GLOBAL_HOOK_GUARDED', this.data.surfacePhase);
      return false;
    }
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceDirectionBurst();
    const generation = this.surfaceGeneration;
    const disambiguateMs = this.isSearchPhase()
      ? Math.max(SEARCH_DOUBLE_TAP_WINDOW_MS, GLOBAL_HOOK_DISAMBIGUATE_MS)
      : GLOBAL_HOOK_DISAMBIGUATE_MS;
    const token = (this.pendingSurfaceGlobalHookToken || 0) + 1;
    this.pendingSurfaceGlobalHookToken = token;
    this.pendingSurfaceGlobalHookPhase = phase;
    this.pendingSurfaceGlobalHookAtMs = now;
    // pending 期间任何宿主 TouchEnd/bindtap 都必须失败，避免仍停在 tabindex=0
    // 的原生焦点抢先进入自由跑。
    this.surfaceEntryConfirmGuardUntilMs = now + disambiguateMs + 40;
    this.pendingSurfaceGlobalHookTimer = setTimeout(() => {
      if (token !== this.pendingSurfaceGlobalHookToken
          || generation !== this.surfaceGeneration
          || phase !== this.pendingSurfaceGlobalHookPhase
          || phase !== this.data.surfacePhase
          || !this.pageVisible) {
        if (token === this.pendingSurfaceGlobalHookToken) {
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
    }, disambiguateMs);
    return true;
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

  clearSurfaceActivationGate() {
    this.invalidateTodayWorkoutLaunch('surface-activation-cleared');
    this.lastSurfaceActivationAtMs = null;
    this.lastSurfaceActivationId = null;
  },

  claimSurfaceActivation(actionId, now = Date.now()) {
    if (this.isSurfaceEntryInputGuarded(now)) {
      this.bleDebug('INPUT_ENTRY_IGNORED', String(actionId));
      return false;
    }
    if (this.lastSurfaceActivationAtMs != null
        && now - this.lastSurfaceActivationAtMs < SURFACE_ACTION_DEDUPE_MS) {
      this.bleDebug('INPUT_DUPLICATE_IGNORED',
        String(this.lastSurfaceActivationId || 'unknown') + '→' + String(actionId));
      return false;
    }
    this.lastSurfaceActivationAtMs = now;
    this.lastSurfaceActivationId = actionId;
    return true;
  },

  claimMenuActivation(actionId, now = Date.now()) {
    if (this.isMenuEntryInputGuarded(now)) {
      this.bleDebug('KEY_HANDOFF_IGNORED', String(actionId));
      return false;
    }
    return this.claimSurfaceActivation(actionId, now);
  },

  showFeatureMenu() {
    // 这是沉浸页内部返回，不存在首页确认键的跨页尾包。
    this.stopMetronomePlayback();
    this.clearSurfaceDirectionBurst();
    this.menuEntryConfirmGuardUntilMs = null;
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceActivationGate();
    this.activeWorkoutPlan = null;
    this.activeLocalTrainingPresetId = '';
    this.workoutExecution = null;
    this.completedWorkoutExecution = null;
    this.frozenHeartRatePolicy = null;
    this.preRunRequiredAfterSearch = false;
    this.entrySequenceStarted = false;
    this.entrySequenceCompleted = false;
    this.menuFocusTouched = false;
    this.setMenuFocus(0);
    this.setData({
      surfacePhase: 'menu',
      runMode: this.runMode || 'free',
      workoutActive: false,
      workoutStageLabel: '',
      workoutProgressText: '',
    });
    Promise.resolve(this.refreshWorkoutMenuState()).catch(() => {});
    return true;
  },

  openFreeMode() {
    return this.openRunMode('free', { workoutPlan: null });
  },

  openSlowMode() {
    return this.openRunMode('slow');
  },

  openGarminVirtualMode() {
    return this.openRunMode('garmin_virtual', { workoutPlan: null });
  },

  openTrainingMode() {
    if (this.data.surfacePhase !== 'menu') return false;
    if (!this.claimMenuActivation('menu-training')) return false;
    this.stopMetronomePlayback();
    this.armSurfaceEntryInputGuard();
    this.clearSurfaceDirectionBurst();
    this.setTrainingFocus(0);
    this.setData({ surfacePhase: 'training' });
    return true;
  },

  invalidateTodayWorkoutLaunch(reason = 'cancelled') {
    if (!this.todayWorkoutLaunchPromise) return false;
    this.todayWorkoutLaunchGeneration = (this.todayWorkoutLaunchGeneration || 0) + 1;
    this.todayWorkoutLaunchPromise = null;
    if (this.data.surfacePhase === 'menu' && this.todayWorkoutPlan) {
      this.setData({ todayWorkoutDetail: this.todayWorkoutDetail(this.todayWorkoutPlan) });
    }
    console.log('[SmartRun Workout] LAUNCH_AUTH_CANCELLED reason=' + String(reason));
    return true;
  },

  todayWorkoutLaunchStillCurrent(generation, displayedPlan, expectedOwner) {
    if (generation !== (this.todayWorkoutLaunchGeneration || 0)
        || this.pageVisible !== true
        || this.data.surfacePhase !== 'menu'
        || this.lastSurfaceActivationId !== 'menu-today'
        || !this.todayWorkoutPlan
        || !sameWorkoutPrescription(this.todayWorkoutPlan, displayedPlan)
        || !this.identityMatchesRunOwner(this.deviceIdentityCache, expectedOwner)) return false;
    const items = ['today', 'free', 'slow', 'garmin_virtual', 'training', 'settings'];
    return items[this.menuFocusIndex] === 'today';
  },

  showTodayWorkoutLaunchMessage(generation, displayedPlan, expectedOwner, message) {
    if (!this.todayWorkoutLaunchStillCurrent(
      generation,
      displayedPlan,
      expectedOwner,
    )) return false;
    this.setData({ todayWorkoutDetail: message });
    return true;
  },

  openAuthorizedTodayWorkout(plan) {
    const type = String(plan && plan.type || '');
    // Hermes keeps slow_jog distinct because its motion policy is IMU-only:
    // HRS remains available, while RSC/distance/pace must stay disabled.
    // Every other admitted staged running type uses the normal outdoor policy.
    const outdoorTypes = [
      'free', 'easy', 'recovery', 'steady', 'tempo', 'interval', 'long',
    ];
    if (type === 'slow_jog') {
      return this.openRunMode('slow', { workoutPlan: plan, activationClaimed: true });
    }
    if (!outdoorTypes.includes(type)) return false;
    return this.openRunMode('free', { workoutPlan: plan, activationClaimed: true });
  },

  openTodayWorkout() {
    if (this.data.surfacePhase !== 'menu' || !this.todayWorkoutPlan
        || this.todayWorkoutLaunchPromise) return false;
    if (!this.claimMenuActivation('menu-today')) return false;
    const displayedPlan = this.todayWorkoutPlan;
    const identity = this.deviceIdentityCache;
    const expectedOwner = this.ownerContextFromIdentity(identity);
    const stored = this.readStoredRunOwnerContext();
    const token = identity && identity.deviceToken;
    if (!expectedOwner || expectedOwner.kind === 'preidentity'
        || !(expectedOwner.ownershipEpoch >= 1)
        || stored.status !== 'ok'
        || !this.sameRunOwnerContext(stored.context, expectedOwner)
        || !token) {
      this.setData({ todayWorkoutDetail: '需要联网确认，请重试' });
      return false;
    }
    const visibility = this.workoutPlanVisibilityState(
      displayedPlan.workout_id,
      expectedOwner,
    );
    if (visibility.hidden) {
      this.setData({ todayWorkoutDetail: '训练状态待确认，请重试' });
      return false;
    }
    const request = buildCurrentWorkoutRequest({
      token,
      baseUrl: resolveCoachBackendConfig(wx).baseUrl,
    });
    if (!request) {
      this.setData({ todayWorkoutDetail: '需要联网确认，请重试' });
      return false;
    }
    const generation = (this.todayWorkoutLaunchGeneration || 0) + 1;
    this.todayWorkoutLaunchGeneration = generation;
    this.setData({ todayWorkoutDetail: '正在确认训练安全…' });
    const flight = this.deviceWxRequest(request).then((response) => {
      if (!this.todayWorkoutLaunchStillCurrent(
        generation,
        displayedPlan,
        expectedOwner,
      )) return false;
      const storedAfter = this.readStoredRunOwnerContext();
      if (storedAfter.status !== 'ok'
          || !this.sameRunOwnerContext(storedAfter.context, expectedOwner)) {
        this.showTodayWorkoutLaunchMessage(
          generation,
          displayedPlan,
          expectedOwner,
          '身份状态已变化，请重试',
        );
        return false;
      }
      const parsed = parseCurrentWorkoutResponse(response, expectedOwner, {
        nowMs: Date.now(),
      });
      if (!parsed) {
        const message = response ? '训练校验失败，请重试' : '需要联网确认，请重试';
        this.showTodayWorkoutLaunchMessage(
          generation,
          displayedPlan,
          expectedOwner,
          message,
        );
        return false;
      }
      if (parsed.heartRatePolicy) {
        this.applyHeartRatePolicy(parsed.heartRatePolicy, expectedOwner, Date.now());
      }
      if (!parsed.available || !parsed.executable || !parsed.plan) {
        clearCachedWorkout(wx);
        this.showTodayWorkoutLaunchMessage(
          generation,
          displayedPlan,
          expectedOwner,
          '今日训练暂不可开始',
        );
        return false;
      }
      const latestVisibility = this.workoutPlanVisibilityState(
        parsed.plan.workout_id,
        expectedOwner,
      );
      if (latestVisibility.hidden) {
        if (latestVisibility.readable) clearCachedWorkout(wx);
        this.showTodayWorkoutLaunchMessage(
          generation,
          displayedPlan,
          expectedOwner,
          '训练状态已更新，请重试',
        );
        return false;
      }
      if (!sameWorkoutPrescription(displayedPlan, parsed.plan)) {
        writeCachedWorkout(wx, parsed.plan, expectedOwner, { nowMs: Date.now() });
        this.applyTodayWorkoutPlan(parsed.plan);
        this.setData({ todayWorkoutDetail: '训练已更新，请再次确认' });
        return false;
      }
      writeCachedWorkout(wx, parsed.plan, expectedOwner, { nowMs: Date.now() });
      this.todayWorkoutPlan = parsed.plan;
      return this.openAuthorizedTodayWorkout(parsed.plan);
    }).catch(() => {
      this.showTodayWorkoutLaunchMessage(
        generation,
        displayedPlan,
        expectedOwner,
        '需要联网确认，请重试',
      );
      return false;
    }).finally(() => {
      if (this.todayWorkoutLaunchPromise === flight) {
        this.todayWorkoutLaunchPromise = null;
      }
    });
    this.todayWorkoutLaunchPromise = flight;
    return true;
  },

  enterSearchReady(options = {}) {
    const fromModeSelection = options.fromModeSelection === true
      && (this.data.surfacePhase === 'menu' || this.data.surfacePhase === 'training');
    const fromWarmupBack = options.fromWarmupBack === true
      && this.data.surfacePhase === 'pre_run';
    if ((!fromModeSelection && !fromWarmupBack) || this.agentExitRequested) return false;
    if (fromWarmupBack) {
      this.cancelRecoveryTts();
      this.cancelRecoveryCountdown({ reset: true });
      this.timedGuideKind = null;
      this.entrySequenceStarted = false;
      const connected = this.data.bleState === 'connected';
      const connecting = this.data.bleState === 'connecting';
      const entryCopy = this.runEntryCopy(connected ? 'connected' : 'idle');
      this.setData({
        surfacePhase: connecting ? 'connecting' : 'ready',
        runMode: this.runMode,
        searchText: entryCopy.searchText,
        searchChip: connected ? '已连接' : entryCopy.searchChip,
        primaryLabel: '下一步',
        scanDiagnostic: connected
          ? entryCopy.scanDiagnostic
          : '设备配置已保留 · 再按下一步进入热身',
        scanProgressText: this.data.hasDiscoveredDevices
          ? '已发现 ' + String(this.data.discoveredDeviceCount || 0) + ' 台'
          : '配置已保留',
      });
      this.applyHeartRateSettingToEntry();
      this.armSurfaceEntryInputGuard();
      return true;
    }
    this.preRunRequiredAfterSearch = true;
    this.entrySequenceStarted = false;
    this.entrySequenceCompleted = false;
    const entryCopy = this.runEntryCopy('idle');
    this.setData({
      surfacePhase: 'ready',
      runMode: this.runMode,
      bleState: 'idle',
      searchText: entryCopy.searchText,
      searchChip: entryCopy.searchChip,
      primaryLabel: '开始搜索',
      scanDiagnostic: entryCopy.scanDiagnostic,
      scanProgressText: '等待操作',
      recoveryCountdown: '15',
      recoveryCountdownUnit: '秒',
      recoveryAutoHint: '15秒后自动切换',
    });
    this.applyHeartRateSettingToEntry();
    // 菜单确认的尾包不能直接触发“开始搜索”。
    this.armSurfaceEntryInputGuard();
    return true;
  },

  openRunMode(mode = 'free', options = {}) {
    const fromTraining = this.data.surfacePhase === 'training';
    if (this.data.surfacePhase !== 'menu' && !fromTraining) return false;
    const nextMode = mode === 'garmin_virtual'
      ? 'garmin_virtual' : (mode === 'slow' ? 'slow' : 'free');
    const workoutPlan = options.workoutPlan || null;
    if (options.activationClaimed !== true) {
      const actionId = workoutPlan ? 'menu-today' : 'menu-' + nextMode;
      if (!this.claimMenuActivation(actionId)) return false;
    }
    this.stopMetronomePlayback();
    this.armSurfaceEntryInputGuard();
    this.clearSurfaceDirectionBurst();
    this.runMode = nextMode;
    this.activeWorkoutPlan = workoutPlan;
    this.activeLocalTrainingPresetId = options.localPresetId || '';
    this.workoutExecution = null;
    this.completedWorkoutExecution = null;
    this.frozenHeartRatePolicy = null;
    this.workoutCompletionQueued = false;
    this.entrySequenceStarted = false;
    this.entrySequenceCompleted = false;
    this.preRunRequiredAfterSearch = true;
    this.scanAttempted = false;
    this.scanStartedSuccessfully = false;
    if (nextMode === 'slow') {
      this.pendingRscMeasurement = null;
      this.rscLive = false;
      this.lastRscAtMs = null;
    }
    this.resetDiscoveredDevices();
    this.setData({
      runMode: nextMode,
      workoutActive: !!workoutPlan,
      workoutStageLabel: workoutPlan ? String(workoutPlan.title || '今日训练') : '',
      workoutProgressText: workoutPlan ? this.todayWorkoutDetail(workoutPlan) : '',
    });
    return this.enterSearchReady({ fromModeSelection: true });
  },

  openSettingsMode() {
    if (this.data.surfacePhase !== 'menu') return false;
    if (!this.claimMenuActivation('menu-settings')) return false;
    this.armSurfaceEntryInputGuard();
    this.syncSettingsData();
    this.setSettingFocus(0);
    this.setData({ surfacePhase: 'settings' });
    this.refreshDeviceIdentity();
    return true;
  },

  setSettingFocus(index) {
    const raw = Number(index) || 0;
    const next = ((raw % SETTINGS_FOCUS_COUNT) + SETTINGS_FOCUS_COUNT)
      % SETTINGS_FOCUS_COUNT;
    // 设置页的声音仅用于当前“节拍器”项试听。档位会继续持久化给开跑使用，
    // 但焦点一旦移到任何其他设置，必须立即静音；重新聚焦也不自动重播，
    // 只有再次确认切换档位才会调用 startMetronomePreview()。
    const previewWasRunning = next !== 2
      && this.metronome && this.metronome.running === true;
    if (next !== 2) this.stopMetronomePlayback();
    const names = [
      'Stride', 'VoiceCue', 'Metronome', 'GuideQuickExit',
      'Binding', 'HeartRate', 'Back',
    ];
    const patch = {};
    for (let i = 0; i < names.length; i += 1) {
      patch['setting' + names[i] + 'Class'] = i === next ? 'setting-row-focused' : '';
    }
    if (previewWasRunning) {
      patch.settingsSaveState = this.settingsStored ? '已保存' : '仅本次';
    }
    this.settingFocusIndex = next;
    this.setData(patch);
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
    if (key === 'binding') return this.openDevicePairing();
    if (key === 'back') {
      const returned = this.showFeatureMenu();
      // 返回按钮的同一次物理确认可能继续派发 Enter/GlobalHook/bindtap 尾包。
      // 回到菜单后保留一段入场保护，避免尾包马上误开“自由跑”。
      if (returned) {
        this.menuEntryConfirmGuardUntilMs = Date.now() + SURFACE_ENTRY_CONFIRM_GRACE_MS;
      }
      return returned;
    }
    const next = { ...(this.runSettings || DEFAULT_RUN_SETTINGS) };
    if (key === 'stride') next.strideM = nextStrideM(next.strideM);
    else if (key === 'heart') next.autoHeartRate = !next.autoHeartRate;
    else if (key === 'voice') next.voiceCue = !next.voiceCue;
    else if (key === 'metronome') next.metronomeBpm = nextMetronomeBpm(next.metronomeBpm);
    else if (key === 'guide') next.guideQuickExit = !next.guideQuickExit;
    else return false;
    this.runSettings = writeRunSettings(wx, next);
    this.settingsStored = isRunSettingsPersisted(wx, this.runSettings);
    this.runStrideM = this.runSettings.strideM || DEFAULT_STRIDE_M;
    if (!this.data.running) {
      this.lastDisplayedPaceSec = null;
      this.lastDisplayedCadenceSpm = null;
      this.lastDisplayedCadenceAtMs = null;
      const estimatedPace = formatPace(null);
      this.setData({
        pace: estimatedPace,
        cadence: CADENCE_PENDING,
        paceMod: unifiedPaceMod(estimatedPace),
        paceStateClass: '',
      });
    }
    this.syncSettingsData();
    if (key === 'metronome') {
      const bpm = Number(this.runSettings.metronomeBpm) || 0;
      if (bpm > 0) this.startMetronomePreview(bpm);
      else {
        this.stopMetronomePlayback();
        this.setData({ settingsSaveState: '节拍器已关闭' });
      }
    } else if (key === 'guide' && this.runSettings.guideQuickExit === true) {
      this.setData({ settingsSaveState: '快速结束已开启 · 指导静音' });
    }
    return true;
  },

  onUnload() {
    this.resetHudEndConfirmation({ clearHint: false });
    this.pageVisible = false;
    this.pageUnloaded = true;
    this.cancelRunningLocalFieldLogReplay();
    if (this.localFieldLogRunId && this.localFieldLogFinished !== true) {
      const unloadedAtMs = Date.now();
      let localMotion = null;
      try {
        localMotion = this.motionMetrics
          ? this.motionMetrics.snapshot(unloadedAtMs) : null;
      } catch (_e) {}
      this.captureRunningLocalFieldSample(
        unloadedAtMs,
        localMotion,
        'finish',
        true,
      );
      this.flushRunningLocalFieldLogBuffer();
      this.flushRunningLocalFieldNoisyEvents();
      this.recordRunningLocalFieldEvent('lifecycle', 'PAGE_UNLOADED', {
        atMs: unloadedAtMs,
        reason: 'unload',
      });
      this.finishRunningLocalFieldCapture(
        null,
        localMotion,
        unloadedAtMs,
        { aborted: true },
      );
    } else if (this.localFieldLogRunId && this.localFieldLogFinished === true) {
      this.recordRunningLocalFieldEvent('lifecycle', 'PAGE_UNLOADED', {
        atMs: Date.now(),
        reason: 'unload_after_summary',
      });
    }
    if (this.workoutExecution && this.workoutExecution.status !== 'finished') {
      this.pauseWorkoutExecution('hide', Date.now());
    }
    this.imuRecoveryDueAtMs = null;
    this.imuRecoveryReason = '';
    if ((this.runOwnerGeneration || 0) > 0) {
      this.ownerScopedRunWriteAllowed();
    }
    if (this.calibrationStream && this.motionMetrics) {
      const now = Date.now();
      this.captureAiuiCalibrationSnapshot(
        now,
        this.motionMetrics.snapshot(now),
        { force: true, deferPersist: true },
      );
    }
    let unloadCalibrationStored = false;
    try {
      unloadCalibrationStored = this.persistAiuiCalibrationBuffer();
    } catch (_e) {}
    if (unloadCalibrationStored) this.calibrationStream = null;
    this.clearSurfaceDirectionBurst();
    this.clearSummaryExitPrompt();
    this.cancelSummaryLlm();
    if (this.summaryFinalizeTimer != null) clearTimeout(this.summaryFinalizeTimer);
    this.summaryFinalizeTimer = null;
    // 总结页已经请求关闭时，onUnload 不能把唯一的 800ms 兜底清掉。部分宿主会
    // 先卸载页面再兑现 exitMiniProgram；此时立即补派发一次，dispatch 自身幂等。
    if (this.agentExitRequested && !this.agentExitDispatched) {
      if (this.isSummaryPhase()
          && this.summaryExitPersistenceConfirmed !== true) {
        this.summaryExitPersistenceConfirmed = this.persistSummaryQueues();
      }
      if (!this.isSummaryPhase() || this.summaryExitPersistenceConfirmed === true) {
        this.dispatchAgentExit();
      } else {
        this.clearAgentExitTimer();
      }
    } else {
      this.clearAgentExitTimer();
    }
    this.clearSurfaceTimers();
    this.clearHudReconnectTimer();
    if (!this.agentExitRequested) {
      this.queueRunForUpload();   // 系统级卸载(被杀/被导航)也不丢跑步摘要
    }
    this.stopTicker();
    this.persistAiuiCalibrationBuffer();
    this.stopAccel();
    this.stopMetronomePlayback({ destroy: true });
    this.beginTerminalBleCleanup();
    if (this.ownerScopedRunWriteAllowed()) clearLiveSnapshot(wx);
  },

  // 跑步摘要入待传队列(只传汇总指标,无轨迹):总结页立即尝试上传，首页
  // onLoad/onShow 继续静默补传。眼镜用户由此复用 APK 生态的跑后管线；
  // 幂等键稳定且一次会话只入队一次。
  queueRunForUpload(frozenSummary = null) {
    if (this.runUploadQueued || !this.session) return this.runUploadQueued === true;
    // Never overwrite an unreadable or unarchived previous-run recovery
    // marker. Entry normally settles this synchronously; this second gate
    // covers explicit deep links and storage that recovered during the run.
    const startupArchive = this.settleImmersiveStartupSummaryArchive();
    if (!startupArchive.ok) return false;
    // 未完成的 owner journal 代表当前归属不可证明；本场数据宁可不入队，
    // 也不能落入随后可能被另一身份读取的 owner-scoped storage。
    if (!this.ownerScopedRunWriteAllowed()) return false;
    const storedSummary = frozenSummary && typeof frozenSummary === 'object'
      ? frozenSummary
      : (this.pendingSummarySnapshot && typeof this.pendingSummarySnapshot === 'object'
        ? this.pendingSummarySnapshot : null);
    const now = storedSummary && Number.isFinite(Number(storedSummary.endedAtMs))
      ? Number(storedSummary.endedAtMs) : Date.now();
    const startedAtMs = storedSummary && Number.isFinite(Number(storedSummary.startedAtMs))
      && Number(storedSummary.startedAtMs) > 0
      ? Number(storedSummary.startedAtMs) : this.session.startMs;
    let snap;
    let avgBpm;
    let maxBpm;
    let avgCadenceSpm;
    let steps;
    let minuteSeries;
    if (storedSummary) {
      snap = {
        elapsedMs: Number(storedSummary.elapsedMs) || 0,
        distanceM: Number(storedSummary.distanceM) || 0,
        avgPaceSecPerKm: isPlausibleHudPace(storedSummary.avgPaceSecPerKm)
          ? Number(storedSummary.avgPaceSecPerKm) : null,
      };
      avgBpm = Number(storedSummary.avgBpm) || 0;
      maxBpm = Number(storedSummary.maxBpm) || 0;
      avgCadenceSpm = Number(storedSummary.avgCadenceSpm) || 0;
      steps = Number(storedSummary.steps) || 0;
      minuteSeries = Array.isArray(storedSummary.minuteSeries)
        ? storedSummary.minuteSeries : [];
    } else {
      const motion = this.motionMetrics ? this.motionMetrics.snapshot(now) : null;
      const summaryMotion = this.resolveSummaryMotion(now, motion);
      if (motion) this.session.distanceM = motion.distanceM;
      snap = this.session.snapshot(now);
      snap.avgPaceSecPerKm = summaryMotion.avgPaceSecPerKm;
      avgBpm = this.session.avgBpm();
      maxBpm = this.session.maxBpm();
      avgCadenceSpm = summaryMotion.avgCadenceSpm;
      steps = this.motionMetrics ? this.motionMetrics.acceptedSteps : 0;
      minuteSeries = Array.isArray(this.minuteSeries) ? this.minuteSeries : [];
    }
    // 跑后 AI 总结待办不受上传门槛限制:任何真实结束的跑步都值得一句反馈。
    const storedPendingSummary = writePendingRunSummary(wx, {
      mode: this.persistedRunMode(),
      startedAtMs,
      elapsedMs: snap.elapsedMs,
      distanceM: snap.distanceM,
      avgPaceSecPerKm: snap.avgPaceSecPerKm,
      avgBpm,
      maxBpm,
      avgCadenceSpm,
      steps,
      minuteSeries,
      endedAtMs: now,
      heartRatePolicy: storedSummary && storedSummary.heartRatePolicy
        ? storedSummary.heartRatePolicy : this.frozenHeartRatePolicy,
    });
    if (!storedPendingSummary) return false;
    const payload = buildRunUploadPayload({
      startMs: startedAtMs,
      mode: this.persistedRunMode(),
      endMs: now,
      elapsedMs: snap.elapsedMs,
      distanceM: snap.distanceM,
      avgPaceSecPerKm: snap.avgPaceSecPerKm,
      avgBpm,
      maxBpm,
      avgCadenceSpm,
    });
    if (!payload) {
      this.summaryClientRunId = '';
      this.runUploadQueued = true;
      return true;   // 不够门槛(误进误出)不制造垃圾上传记录
    }
    const normalizedPayload = normalizeRunUploadPayload(payload);
    if (!normalizedPayload) return false;
    const queued = enqueueRunUpload(wx, payload);
    if (!queued) return false;
    this.summaryClientRunId = normalizedPayload.client_run_id;
    this.runUploadQueued = true;
    return true;
  },

  queueWorkoutCompletion(frozenSummary = null) {
    if (this.workoutCompletionQueued) return true;
    // 本地训练模板沿用同一阶段执行器，但不是服务器签发的 workout。
    // 普通跑步汇总照常上传；completion 队列只保留真实服务端计划。
    if (this.activeLocalTrainingPresetId) {
      this.workoutCompletionQueued = true;
      return true;
    }
    const execution = this.completedWorkoutExecution;
    if (!execution) return true;
    if (!this.ownerScopedRunWriteAllowed()) return false;
    const summary = frozenSummary && typeof frozenSummary === 'object'
      ? frozenSummary : {};
    const payload = buildWorkoutCompletion({
      execution,
      clientRunId: this.summaryClientRunId || undefined,
      summary: {
        duration_s: Math.max(0, Math.round(Number(summary.elapsedMs) / 1000 || 0)),
        distance_m: Math.max(0, Math.round(Number(summary.distanceM) || 0)),
        avg_pace_s: Number(summary.avgPaceSecPerKm) || undefined,
        avg_hr: Number(summary.avgBpm) || undefined,
        max_hr: Number(summary.maxBpm) || undefined,
        cadence_avg: Number(summary.avgCadenceSpm) || undefined,
      },
    });
    if (!payload) return false;
    const queued = enqueueWorkoutCompletion(wx, payload, execution.owner, {
      allowedStageIds: execution.plan.stages.map((stage) => stage.stage_id),
    });
    if (!queued || !queued.some(
      (item) => item.client_execution_id === payload.client_execution_id,
    )) return false;
    if (!this.summaryClientRunId) this.summaryClientRunId = payload.client_run_id;
    this.workoutCompletionQueued = true;
    clearWorkoutExecutionCheckpoint(wx);
    return true;
  },

  summaryHermesPending() {
    const clientRunId = String(this.summaryClientRunId || '');
    const streamId = String(this.summaryCalibrationStreamId || '');
    const runQueueState = readPendingRunUploadsState(wx);
    const runPending = !runQueueState.ok || (clientRunId
      && runQueueState.items.some(
        (item) => item.client_run_id === clientRunId,
      ));
    const calibrationQueueState = readPendingAiuiCalibrationEventsState(wx);
    const calibrationPending = !calibrationQueueState.ok || !!(streamId
      && calibrationQueueState.events.some(
        (event) => event.stream_id === streamId,
      ));
    const workoutExecutionId = this.completedWorkoutExecution
      ? String(this.completedWorkoutExecution.client_execution_id || '') : '';
    const workoutOwner = this.completedWorkoutExecution
      ? this.completedWorkoutExecution.owner : null;
    let workoutPending = false;
    if (workoutExecutionId) {
      const pendingState = readPendingWorkoutCompletionsState(wx, workoutOwner);
      const quarantineState = readQuarantinedWorkoutCompletionsState(wx, workoutOwner);
      // 总结页退出门必须把 unknown 当“尚未安全落盘/ACK”，绝不把损坏或宿主
      // 静默读取误解成空队列。
      workoutPending = !pendingState.ok || !quarantineState.ok || pendingState.items.some(
        (item) => item.client_execution_id === workoutExecutionId,
      );
    }
    return !!(runPending || calibrationPending || workoutPending);
  },

  summaryHermesNeedsDiagnostic() {
    const clientRunId = String(this.summaryClientRunId || '');
    const streamId = String(this.summaryCalibrationStreamId || '');
    const workoutExecutionId = this.completedWorkoutExecution
      ? String(this.completedWorkoutExecution.client_execution_id || '') : '';
    const workoutOwner = this.completedWorkoutExecution
      ? this.completedWorkoutExecution.owner : null;
    try {
      const runQuarantineState = readQuarantinedRunUploadsState(wx);
      const calibrationQuarantineState =
        readQuarantinedAiuiCalibrationEventsState(wx);
      const runQuarantined = !runQuarantineState.ok || !!(clientRunId
        && runQuarantineState.entries.some(
          (entry) => entry.run.client_run_id === clientRunId,
        ));
      const calibrationQuarantined = !calibrationQuarantineState.ok || !!(streamId
        && calibrationQuarantineState.entries.some(
          (entry) => entry.event.stream_id === streamId,
        ));
      let workoutQuarantined = false;
      if (workoutExecutionId) {
        const state = readQuarantinedWorkoutCompletionsState(wx, workoutOwner);
        workoutQuarantined = !state.ok || state.entries.some(
          (entry) => entry.item.client_execution_id === workoutExecutionId,
        );
      }
      return runQuarantined || calibrationQuarantined || workoutQuarantined;
    } catch (_e) {
      return true;
    }
  },

  refreshSummaryHermesState(uploading = false) {
    if (!this.isSummaryPhase() || this.agentExitRequested) return;
    const pending = this.summaryHermesPending();
    const needsDiagnostic = this.summaryHermesNeedsDiagnostic();
    const receipt = summarizeRunUploadReceipts(wx, {
      clientRunId: this.summaryClientRunId,
      streamId: this.summaryCalibrationStreamId,
    });
    let summaryUploadText = '日志已保存 · 待补传';
    if (uploading && pending) {
      summaryUploadText = '日志已保存 · 上传中';
    } else if (!pending && needsDiagnostic) {
      summaryUploadText = '日志已保存 · 部分需诊断';
    } else if (!pending && receipt.ackedCount > 0) {
      summaryUploadText = 'Hermes 已上传 · ' + String(receipt.ackedCount) + '条';
    } else if (!pending) {
      summaryUploadText = 'Hermes 已同步';
    }
    if (this.data.summaryUploadText !== summaryUploadText) {
      this.setData({ summaryUploadText });
    }
  },

  startSummaryHermesUploads(localSaved, options = {}) {
    const allowDuringExit = options.allowDuringExit === true;
    if (!this.isSummaryPhase()
        || (this.agentExitRequested && !allowDuringExit)) {
      return Promise.resolve(false);
    }
    if (!localSaved) {
      if (!this.agentExitRequested) {
        this.setData({ summaryUploadText: '日志保存失败 · 请重试' });
      }
      return Promise.resolve(false);
    }
    if (this.summaryHermesFlight) return this.summaryHermesFlight;
    this.clearSummaryHermesRetry();
    if (!this.agentExitRequested) this.refreshSummaryHermesState(true);
    const expectedOwner = this.runOwnerContext;
    const identity = this.deviceIdentityCache;
    const tokenReady = identity && identity.deviceToken
      && (!expectedOwner || this.identityMatchesRunOwner(identity, expectedOwner));
    const launchUploads = () => {
      let runFlight = null;
      let calibrationFlight = null;
      let workoutFlight = null;
      try { runFlight = this.flushRunUploads(); } catch (_e) {}
      try { calibrationFlight = this.flushAiuiCalibrationUploads(); } catch (_e) {}
      try { workoutFlight = this.flushWorkoutCompletions(); } catch (_e) {}
      return Promise.all([
        Promise.resolve(runFlight).catch(() => false),
        Promise.resolve(calibrationFlight).catch(() => false),
        Promise.resolve(workoutFlight).catch(() => false),
      ]);
    };
    // 已有同 owner token 时同步启动三条补传，保证总结首帧后立即退出
    // 也至少把请求交给宿主；只有缺 token 才先走一次长期凭据 bootstrap。
    const uploads = tokenReady
      ? launchUploads()
      : Promise.resolve(this.refreshDeviceIdentity()).catch(() => null).then(launchUploads);
    const flight = Promise.resolve(uploads).then(() => {
      if (!this.agentExitRequested) this.refreshSummaryHermesState(false);
      const complete = !this.summaryHermesPending();
      if (!complete && !this.agentExitRequested) this.scheduleSummaryHermesRetry();
      return complete;
    });
    this.summaryHermesFlight = flight;
    flight.finally(() => {
      if (this.summaryHermesFlight === flight) this.summaryHermesFlight = null;
    });
    return flight;
  },

  clearSummaryHermesRetry() {
    if (this.summaryHermesRetryTimer != null) {
      clearTimeout(this.summaryHermesRetryTimer);
    }
    this.summaryHermesRetryTimer = null;
  },

  scheduleSummaryHermesRetry() {
    this.clearSummaryHermesRetry();
    if (!this.isSummaryPhase() || this.agentExitRequested
        || !this.summaryHermesPending()) return false;
    const attempt = Number(this.summaryHermesRetryAttempt) || 0;
    if (attempt >= SUMMARY_HERMES_RETRY_DELAYS_MS.length) return false;
    const delayMs = SUMMARY_HERMES_RETRY_DELAYS_MS[attempt];
    this.summaryHermesRetryAttempt = attempt + 1;
    this.summaryHermesRetryTimer = setTimeout(() => {
      this.summaryHermesRetryTimer = null;
      if (!this.isSummaryPhase() || this.agentExitRequested
          || this.pageVisible !== true) return;
      this.startSummaryHermesUploads(true);
    }, delayMs);
    return true;
  },

  // 总结页直接尝试上传本场汇总；首页 onLoad/onShow 仍作为 durable 队列的
  // 后续补传器。这样用户跑完后直接关闭智能体时，不必再打开一次才能落 runs 表。
  // 所有网络回包都固定到发起时 owner；失败、超时、401 刷新失败与退出抢占均保留 FIFO。
  flushRunUploads() {
    const runOwnerGeneration = this.runOwnerGeneration || 0;
    let expectedOwner = null;
    if (runOwnerGeneration > 0) {
      if (!this.ownerScopedRunWriteAllowed(runOwnerGeneration)) {
        return Promise.resolve(false);
      }
      expectedOwner = this.runOwnerContext
        ? { ...this.runOwnerContext } : null;
    } else {
      const stored = this.readStoredRunOwnerContext();
      if (stored.status === 'destructive') {
        this.handleRunOwnerDataCleared('run-upload-background-journal');
      }
      if (stored.status !== 'ok') return Promise.resolve(false);
      expectedOwner = { ...stored.context };
    }
    if (!this.exactOwnerOperationStillCurrent(
      expectedOwner,
      runOwnerGeneration,
      'run-upload-start',
    )) return Promise.resolve(false);

    const existingFlight = this.runUploadFlushFlight;
    if (existingFlight
        && existingFlight.runOwnerGeneration === runOwnerGeneration
        && this.sameRunOwnerContext(existingFlight.expectedOwner, expectedOwner)) {
      return existingFlight.promise || Promise.resolve(false);
    }
    const initialQueueState = readPendingRunUploadsState(wx);
    if (!initialQueueState.ok) return Promise.resolve(false);
    if (!initialQueueState.items.length) return Promise.resolve(true);

    const flight = {
      expectedOwner: { ...expectedOwner },
      runOwnerGeneration,
      promise: null,
    };
    this.runUploadFlushFlight = flight;
    // wx.request 当前适配器会把网络失败收敛为普通响应，但未来身份刷新或宿主
    // Promise 仍可能拒绝。flight 在唯一入口统一吞成 false，避免总结 finalizer
    // 产生未处理 rejection；durable FIFO 只有明确 ACK 才会变化。
    flight.promise = Promise.resolve(this.performRunUploadFlight(flight))
      .catch(() => false)
      .finally(() => {
        if (this.runUploadFlushFlight === flight) {
          this.runUploadFlushFlight = null;
        }
      });
    return flight.promise;
  },

  async performRunUploadFlight(flight) {
    const expectedOwner = flight.expectedOwner;
    const runOwnerGeneration = flight.runOwnerGeneration;
    if (!this.exactOwnerOperationStillCurrent(
      expectedOwner,
      runOwnerGeneration,
      'run-upload-before-token',
    )) return false;
    let identity = this.deviceIdentityCache;
    let token = identity && identity.deviceToken;
    // 跑后首帧和退出均不能等待冷 bootstrap；菜单/设置已拿到的 scoped token
    // 可直接发送。尚无 token 时保留 durable 队列，由首页或下一次生命周期补传。
    if (!token || !this.identityMatchesRunOwner(identity, expectedOwner)) return false;

    const config = resolveCoachBackendConfig(wx);
    const pendingState = readPendingRunUploadsState(wx);
    if (!pendingState.ok) return false;
    const pending = pendingState.items;
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      let authRetried = false;
      while (true) {
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'run-upload-before-send',
        )) return false;
        const response = await this.deviceWxRequest(buildRunUploadRequest({
          baseUrl: config.baseUrl,
          token,
          payload: item,
          deviceToken: true,
        }));
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'run-upload-after-send',
        )) return false;

        if (response && response.statusCode === 401) {
          if (authRetried) return false;
          let storedToken = '';
          try {
            storedToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY) || '';
          } catch (_e) {
            return false;
          }
          // 另一页面若已刷新出新 token，旧 401 不能清它；留队给下一轮读取。
          if (storedToken !== token) return false;
          clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY });
          this.deviceIdentityCache = null;
          identity = await this.refreshDeviceIdentity();
          if (!identity || identity.network !== true || !identity.deviceToken
              || !this.identityMatchesRunOwner(identity, expectedOwner)
              || !this.exactOwnerOperationStillCurrent(
                expectedOwner,
                runOwnerGeneration,
                'run-upload-after-auth-refresh',
              )) return false;
          token = identity.deviceToken;
          const retryQueueState = readPendingRunUploadsState(wx);
          if (!retryQueueState.ok) return false;
          const stillQueued = retryQueueState.items.some(
            (queued) => queued.client_run_id === item.client_run_id,
          );
          if (!stillQueued) break;
          authRetried = true;
          continue;
        }

        if (response && isPermanentRunUploadRejection(response.statusCode)) {
          console.warn(
            '[SmartRun Upload] quarantine invalid run status='
              + response.statusCode + ' client_run_id=' + item.client_run_id,
          );
          // 永久拒绝也先进入 owner-scoped 有界隔离区并完成写后读回；隔离失败
          // 继续留在主 FIFO，绝不把唯一科学记录直接丢掉。
          if (!quarantineRunUpload(wx, item, response.statusCode)) return false;
          if (removePendingRunUpload(wx, item) === null) return false;
          break;
        }
        // 429/5xx/网络失败保留 FIFO；409 与 400/422 一样已在上方先隔离。
        // 200 只有读到后端 run id 才算 ACK。
        const runId = parseRunUploadResponse(response);
        if (!runId) return false;
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          runOwnerGeneration,
          'run-upload-before-ack',
        )) return false;
        const latestQueueState = readPendingRunUploadsState(wx);
        if (!latestQueueState.ok) return false;
        const latestBeforeAck = latestQueueState.items;
        const projectedRemaining = latestBeforeAck.filter(
          (queued) => queued.client_run_id !== item.client_run_id,
        ).length;
        const receipt = createRunSummaryUploadReceipt(item, {
          completedAtMs: Date.now(),
          remainingCount: projectedRemaining,
        });
        // 回执先写后读回，再 ACK 主队列。若主队列清理失败，稳定 receipt_id
        // 会让下一次后端幂等 ACK 覆盖同一条回执，不重复累计。
        if (!receipt || !appendRunUploadReceipt(wx, receipt)) return false;
        if (removePendingRunUpload(wx, item) === null) return false;
        this.refreshSummaryHermesState(true);
        console.log(
          '[SmartRun Upload] uploaded run=' + String(runId)
            + ' client_run_id=' + item.client_run_id,
        );
        break;
      }
    }
    const finalQueueState = readPendingRunUploadsState(wx);
    return finalQueueState.ok && finalQueueState.items.length === 0;
  },

  flushWorkoutCompletions() {
    const runOwnerGeneration = this.runOwnerGeneration || 0;
    let expectedOwner = null;
    if (runOwnerGeneration > 0) {
      if (!this.ownerScopedRunWriteAllowed(runOwnerGeneration)) {
        return Promise.resolve(false);
      }
      expectedOwner = this.runOwnerContext ? { ...this.runOwnerContext } : null;
    } else {
      const stored = this.readStoredRunOwnerContext();
      if (stored.status !== 'ok' || stored.context.kind === 'preidentity') {
        return Promise.resolve(false);
      }
      expectedOwner = { ...stored.context };
    }
    if (!expectedOwner || !this.exactOwnerOperationStillCurrent(
      expectedOwner,
      runOwnerGeneration,
      'workout-upload-start',
    )) return Promise.resolve(false);
    const initialPending = readPendingWorkoutCompletionsState(wx, expectedOwner);
    if (!initialPending.ok) return Promise.resolve(false);
    if (!initialPending.items.length) {
      return Promise.resolve(true);
    }
    const existing = this.workoutCompletionFlushFlight;
    if (existing
        && existing.runOwnerGeneration === runOwnerGeneration
        && this.sameRunOwnerContext(existing.expectedOwner, expectedOwner)) {
      return existing.promise;
    }
    const flight = {
      expectedOwner: { ...expectedOwner },
      runOwnerGeneration,
      promise: null,
    };
    this.workoutCompletionFlushFlight = flight;
    flight.promise = Promise.resolve(this.performWorkoutCompletionFlight(flight))
      .catch(() => false)
      .finally(() => {
        if (this.workoutCompletionFlushFlight === flight) {
          this.workoutCompletionFlushFlight = null;
        }
      });
    return flight.promise;
  },

  async performWorkoutCompletionFlight(flight) {
    const expectedOwner = flight.expectedOwner;
    const generation = flight.runOwnerGeneration;
    if (!this.exactOwnerOperationStillCurrent(
      expectedOwner,
      generation,
      'workout-upload-token',
    )) return false;
    let identity = this.deviceIdentityCache;
    let token = identity && identity.deviceToken;
    if (!token || !this.identityMatchesRunOwner(identity, expectedOwner)) return false;
    const config = resolveCoachBackendConfig(wx);
    const pendingState = readPendingWorkoutCompletionsState(wx, expectedOwner);
    if (!pendingState.ok) return false;
    const pending = pendingState.items;
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      let authRetried = false;
      while (true) {
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          generation,
          'workout-upload-send',
        )) return false;
        const request = buildWorkoutCompletionRequest({
          token,
          payload: item.payload,
          baseUrl: config.baseUrl,
        });
        if (!request) return false;
        const response = await this.deviceWxRequest(request);
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          generation,
          'workout-upload-response',
        )) return false;

        if (response && response.statusCode === 401) {
          if (authRetried) return false;
          let storedToken = '';
          try {
            storedToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY) || '';
          } catch (_e) {
            return false;
          }
          // A newer page may already have rotated the token. Never erase it in
          // response to this flight's stale 401; the next flush will reuse it.
          if (storedToken !== token) return false;
          clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY });
          this.deviceIdentityCache = null;
          identity = await this.refreshDeviceIdentity();
          if (!identity || identity.network !== true || !identity.deviceToken
              || !this.identityMatchesRunOwner(identity, expectedOwner)
              || !this.exactOwnerOperationStillCurrent(
                expectedOwner,
                generation,
                'workout-upload-auth-refresh',
              )) return false;
          token = identity.deviceToken;
          const refreshedPending = readPendingWorkoutCompletionsState(wx, expectedOwner);
          if (!refreshedPending.ok) return false;
          const stillQueued = refreshedPending.items.some(
            (queued) => queued.client_execution_id === item.client_execution_id,
          );
          if (!stillQueued) break;
          authRetried = true;
          continue;
        }

        if (response && isPermanentWorkoutCompletionRejection(response.statusCode)) {
          console.warn(
            '[SmartRun Workout] COMPLETION_QUARANTINE status='
              + String(response.statusCode)
              + ' execution=' + item.client_execution_id,
          );
          if (!quarantineWorkoutCompletion(wx, item, response.statusCode)) return false;
          if (removePendingWorkoutCompletion(wx, item, expectedOwner) === null) return false;
          this.refreshSummaryHermesState(true);
          break;
        }

        // 429/5xx/network failures remain in the durable FIFO. Only an explicit
        // accepted receipt may ACK a completion.
        const receipt = parseWorkoutCompletionResponse(response);
        if (!receipt) return false;
        if (!this.exactOwnerOperationStillCurrent(
          expectedOwner,
          generation,
          'workout-upload-ack',
        )) return false;
        if (removePendingWorkoutCompletion(wx, item, expectedOwner) === null) return false;
        this.workoutCompletionMenuRefreshPending = true;
        if (!this.workoutCompletionAckedWorkoutIds) {
          this.workoutCompletionAckedWorkoutIds = {};
        }
        this.workoutCompletionAckedWorkoutIds[item.payload.workout_id] = true;
        console.log(
          '[SmartRun Workout] COMPLETION_ACK execution='
            + item.client_execution_id
            + ' duplicate=' + String(receipt.duplicate),
        );
        break;
      }
    }
    const finalPending = readPendingWorkoutCompletionsState(wx, expectedOwner);
    return finalPending.ok && finalPending.items.length === 0;
  },

  // 息屏/浮层/切页:停传感器的同时暂停记录 —— 加速度计停了距离就不会涨,
  // 时长若照走会得到"时长+10分钟、距离+0"的坏数据;自动暂停保证两者口径一致。
  onHide() {
    console.log(
      '[SmartRun Lifecycle] PAGE_HIDE phase='
        + String(this.data.surfacePhase || '')
        + ' running=' + String(this.data.running === true)
        + ' accelGeneration=' + String(this.accelGeneration || 0),
    );
    this.pageVisible = false;
    this.resetHudEndConfirmation();
    const bindingExportWasPending = this.bindingExportPending === true;
    this.cancelRunningLocalFieldLogReplay();
    this.bindingExportPending = false;
    if (bindingExportWasPending && this.data.surfacePhase === 'binding') {
      this.setData({
        bindingState: '现场日志导出已暂停',
        bindingDetail: '回到页面后请重新导出，本地记录不会丢失',
        bindingChip: '已暂停',
        bindingExportLabel: '重新导出',
      });
    }
    if (this.localFieldLogRunId && this.localFieldLogFinished !== true) {
      const hiddenAtMs = Date.now();
      let localMotion = null;
      try {
        localMotion = this.motionMetrics
          ? this.motionMetrics.snapshot(hiddenAtMs) : null;
      } catch (_e) {}
      this.captureRunningLocalFieldSample(
        hiddenAtMs,
        localMotion,
        'hide',
        true,
      );
      this.flushRunningLocalFieldLogBuffer();
      this.flushRunningLocalFieldNoisyEvents();
      this.recordRunningLocalFieldEvent('lifecycle', 'PAGE_HIDDEN', {
        atMs: hiddenAtMs,
        reason: 'host_hidden',
      });
    }
    this.imuRecoveryDueAtMs = null;
    this.imuRecoveryReason = '';
    if ((this.runOwnerGeneration || 0) > 0) {
      this.ownerScopedRunWriteAllowed();
    }
    // 隐藏可能紧接着被系统卸载；先把本刻算法快照与尚在内存的 1Hz 样本
    // 同步写入 owner-scoped storage。保持同一 stream，回来后继续递增 seq。
    if (this.calibrationStream && this.motionMetrics && this.data.running
        && !this.isSummaryPhase()) {
      const calibrationNow = Date.now();
      this.captureAiuiCalibrationSnapshot(
        calibrationNow,
        this.motionMetrics.snapshot(calibrationNow),
      );
    }
    this.persistAiuiCalibrationBuffer();
    this.clearSurfaceDirectionBurst();
    this.stopMetronomePlayback();
    // 息屏/切页后下一次按键一定是新手势，不沿用隐藏前的跨通道防重窗口。
    this.surfaceEntryConfirmGuardUntilMs = null;
    this.lastSurfaceConfirmKeyMs = null;
    this.clearSurfaceActivationGate();
    this.bleLifecycleGeneration = (this.bleLifecycleGeneration || 0) + 1;
    this.clearSurfaceTimers();
    if (this.rscProbePromise && !this.rscCharacteristic) {
      // getPrimaryService/getCharacteristic/startNotifications 可能跨过隐藏再兑现。
      // 仅靠 pageVisible 检查不够：恢复可见后旧 Promise 会重新满足条件并被
      // 错当成本代提交。隐藏时显式失效该代，等旧桥真正收尾后只在当前可见、
      // 同一活 HRS/GATT 上启动一条新探测，避免 listener 叠加。
      const staleProbe = this.rscProbePromise;
      this.rscProbeGeneration = (this.rscProbeGeneration || 0) + 1;
      this.rscProbeRetryAtMs = Date.now();
      Promise.resolve(staleProbe).catch(() => false).finally(() => {
        if (this.pageVisible === true
            && this.data.bleState === 'connected'
            && this.bleDevice
            && !this.rscCharacteristic
            && !this.rscProbePromise
            && !this.isSlowJogMode()
            && !this.isSummaryPhase()
            && this.bleTerminated !== true
            && this.backspaceHandled !== true) {
          this.probeOptionalRsc(this.bleDevice);
        }
      });
    }
    if (this.isSearchPhase()) {
      this.entrySequenceStarted = false;
      this.entrySequenceCompleted = false;
      this.scanAttempted = false;
      this.scanStartedSuccessfully = false;
      this.hudReconnectCount = 0;
      this.reconnectDevice = null;
      this.lastHrUiAtMs = null;
      this.discoveredDeviceRefs = {};
      this.discoveredDeviceOrder = [];
      this.rawAdvertisementCount = 0;
      this.selectedDeviceKey = null;
      this.searchFocusIndex = 0;
      this.teardownBle();
      const entryCopy = this.runEntryCopy('idle');
      this.setData({
        surfacePhase: 'ready',
        searchText: entryCopy.searchText,
        searchChip: entryCopy.searchChip,
        primaryLabel: '开始搜索',
        discoveredDevices: [],
        discoveredDeviceCount: 0,
        discoveredDeviceRange: '',
        hasDiscoveredDevices: false,
        scanDiagnostic: entryCopy.scanDiagnostic,
        scanProgressText: '等待操作',
        searchPrimaryClass: 'search-target-focused',
        bleState: 'idle',
        hudHint: '',
      });
    }
    // 隐藏后的 InkView 不再拥有交互式 BLE 权限；未完成的扫描/连接不能继续推进。
    if (this.data.bleState === 'scanning') this.stopScan();
    if (this.data.bleState === 'connecting') {
      // HUD 入场后的 GATT 链仍可在后台进行。InkView 短暂失去交互性会使
      // 当前尝试失效；保留目标，亮屏后才能重排，否则这个小窗口会永久丢心率。
      if (((this.data.surfacePhase === 'hud' && this.data.running)
          || this.data.surfacePhase === 'pre_run') && this.connectingDevice) {
        this.reconnectDevice = this.connectingDevice;
      }
      this.setData({ bleState: 'idle' });
    }
    // 隐藏期本页丢弃所有 notify(lastHrAtMs 冻结)，看门狗若继续跑，>8s 的息屏
    // 必然把健康的活连接误判断连并从后台 disconnect——先停表，恢复时重置基线。
    this.clearHrWatchdogTimer();
    // HRS 单路恢复也必须服从 InkView 交互门：隐藏后不再发起新的
    // startNotifications，迟到 Promise 仅做所有权校验，不能改页面状态。
    this.cancelHrNotificationRecovery('hide');
    this.clearHudReconnectTimer();
    this.stopTicker();
    this.stopAccel();
    if (this.session && this.data.running && !this.session.paused
        && !this.isSummaryPhase()) {
      const now = Date.now();
      this.session.pause(now);
      if (this.motionMetrics) this.motionMetrics.pause(now);
      if (this.speedFusion) this.speedFusion.pause(now);
      this.pauseWorkoutExecution('hide', now);
      this.resetStrideCalibration();
      this.autoPausedByHide = true;
      const snap = this.session.snapshot(now);
      // 息屏路径同样做心率新鲜度门控:不许用冻结心率算出 Z5 触发安全提醒
      const hrFresh = this.lastHrAtMs != null && (now - this.lastHrAtMs) <= HR_STALE_MS;
      const hasHeartRate = this.data.bleState === 'connected' && hrFresh && Number.isFinite(snap.bpm);
      if (this.ownerScopedRunWriteAllowed()) writeLiveSnapshot(wx, {
        bpm: hasHeartRate ? snap.bpm : null,
        heartDeviceName: this.data.bleState === 'connected' ? this.connectedHeartName : null,
        zone: this.runHeartRateZone(hasHeartRate ? snap.bpm : 0), paceSecPerKm: null,
        ...this.runHeartRatePolicyFields(),
        cadenceSpm: snap.cadenceSpm, distanceM: snap.distanceM,
        elapsedMs: snap.elapsedMs, paused: true,
      }, now);
      this.setData({ paused: true, coachLine: '已暂停' });
    }
  },

  // 回来后:恢复记录 + ticker + 加速度计,否则步数/步频/距离永久冻结。
  // startAccel 内部先 stopAccel、回调有 session.paused 守卫,恢复是幂等安全的。
  onShow() {
    const wasVisible = this.pageVisible === true;
    // 只有"从隐藏回到可见"才换代次。宿主可能在页面已可见时重复派发 onShow
    // (音量条/系统浮层),若无脑 +1 会把进行中的扫描会话判为过期代次,
    // devicefound 事件全部被丢弃——真机上表现为"扫描中但永远 0 台"。
    if (!this.pageVisible) {
      this.bleLifecycleGeneration = (this.bleLifecycleGeneration || 0) + 1;
    }
    this.pageVisible = true;
    console.log(
      '[SmartRun Lifecycle] PAGE_SHOW phase='
        + String(this.data.surfacePhase || '')
        + ' running=' + String(this.data.running === true)
        + ' wasVisible=' + String(wasVisible)
        + ' accelGeneration=' + String(this.accelGeneration || 0),
    );
    if (this.data.surfacePhase === 'settings' || this.data.surfacePhase === 'binding') {
      this.refreshDeviceIdentity();
    }
    if (this.data.surfacePhase === 'menu') {
      Promise.resolve(this.refreshDeviceIdentity()).then((identity) => {
        this.runImmersiveStartupMaintenance(identity);
        if (this.data.surfacePhase === 'menu') {
          return this.refreshWorkoutMenuState(identity);
        }
        return this.loadTodayWorkoutForMenu(identity);
      }).catch(() => {});
    }
    if (this.summaryEnteredAtMs != null && !this.agentExitRequested
        && (this.runUploadQueued || this.summaryClientRunId
          || this.summaryCalibrationStreamId)) {
      this.startSummaryHermesUploads(true);
    }
    this.markBeacon('S');
    if (this.session && this.session.paused && this.autoPausedByHide
        && !this.isSummaryPhase()) {
      const now = Date.now();
      this.session.resume(now);
      if (this.motionMetrics) this.motionMetrics.resume(now);
      if (this.speedFusion) this.speedFusion.resume(now);
      this.resumeWorkoutExecution('show', now);
      this.resetStrideCalibration();
      this.autoPausedByHide = false;
      this.setData({ paused: false, coachLine: '' });
    }
    if (this.data.running && !this.isSummaryPhase() && !this.timer) this.startTicker();
    if (this.data.running && !this.isSummaryPhase()) {
      const now = Date.now();
      const accelStale = !!(this.accel && this.lastAccelAt != null
        && now - this.lastAccelAt > ACCEL_RESUME_STALE_MS);
      if (!this.accel || this.imuOk !== true || accelStale) {
        this.startAccel(accelStale ? 'show-stale' : 'show-resume');
      }
    }
    if (this.data.surfacePhase === 'hud' && this.data.running
        && !this.isSummaryPhase()) this.startRunMetronome();
    if (this.isTimedGuidePhase()
        && this.recoveryGuideCompleted !== true
        && this.recoveryCountdownActive !== true) {
      this.resumeRecoveryCountdown();
    }
    // 页面隐藏期间宿主可能静默断开 GATT 而没有派发事件；以官方 connected
    // 属性复核一次，避免状态仍停在 connected 而永远不重连。
    if (this.data.bleState === 'connected' && this.bleDevice
        && this.bleDevice.gatt && this.bleDevice.gatt.connected === false) {
      // 下面统一排一次延迟连接，避免断连处理和 onShow 各排一份。
      this.onBleDropped('', 'show');
    } else if (this.data.bleState === 'connected') {
      const resumeSilentHrRecovery = this.hrDegradedByRsc === true
        && this.isRscDataFresh();
      // 活连接跨隐藏保留：隐藏期 notify 被丢弃，恢复时重置新鲜度基线，
      // 给连接完整的首包宽限(20s)重新自证；绝不用隐藏前的旧时间戳立刻误判断连。
      this.lastHrAtMs = null;
      this.hrSubscribedAtMs = Date.now();
      this.invalidHrPackets = 0;
      this.hrDegradedByRsc = resumeSilentHrRecovery;
      this.scheduleHrWatchdog();
      if (resumeSilentHrRecovery) this.scheduleHrNotificationRecovery();
      if (!this.isSlowJogMode()) {
        if (this.rscCharacteristic) {
          // 隐藏期不消费 2A53 notify；原静默 timer 到点后会因 pageVisible=false
          // 安全退出。恢复时必须重新以最后合法包（或订阅时刻）武装诊断，
          // 否则旧 characteristic 会永久占位，HRS 正常却再也不重探跑速。
          this.scheduleRscSilentDiagnostic(
            this.lastRscAtMs != null ? this.lastRscAtMs : this.rscSubscribedAtMs,
          );
        } else if (!this.rscProbePromise && this.bleDevice
            && (this.rscProbeRetryAtMs == null
              || Date.now() >= this.rscProbeRetryAtMs)) {
          this.probeOptionalRsc(this.bleDevice);
        }
      }
    }
    // 掉线重连跨隐藏恢复:onHide 清定时器/隐藏期定时器哑火后,这里重排接续。
    if (this.reconnectDevice && this.data.bleState === 'idle'
        && (this.hudReconnectCount || 0) < HUD_RECONNECT_MAX
        && ((this.data.surfacePhase === 'hud' && this.data.running)
          || this.isEntryGattPhase())) {
      this.scheduleHudReconnect(this.reconnectDevice);
    }
    // 扫描只由"开始搜索"手势启动;生命周期回调只维护可见性与信标。
    if (!this.viewReady && this.isSearchPhase()) this.scheduleBleReadyFallback();
    if (this.localFieldLogRunId && this.localFieldLogFinished !== true) {
      const shownAtMs = Date.now();
      let localMotion = null;
      try {
        localMotion = this.motionMetrics
          ? this.motionMetrics.snapshot(shownAtMs) : null;
      } catch (_e) {}
      this.recordRunningLocalFieldEvent('lifecycle', 'PAGE_SHOWN', {
        atMs: shownAtMs,
        reason: wasVisible ? 'duplicate_show' : 'host_visible',
      });
      this.captureRunningLocalFieldSample(
        shownAtMs,
        localMotion,
        'show',
        true,
      );
      this.flushRunningLocalFieldLogBuffer();
    }
  },

  onReady() {
    this.clearBleReadyFallback();
    this.viewReady = true;
    this.markBeacon('R');
    this.bleDebug('PAGE_READY', 'generation=' + String(this.bleLifecycleGeneration));
  },

  scheduleBleReadyFallback() {
    this.clearBleReadyFallback();
    const generation = this.bleLifecycleGeneration;
    this.bleReadyFallbackTimer = setTimeout(() => {
      this.bleReadyFallbackTimer = null;
      if (!this.pageVisible || generation !== this.bleLifecycleGeneration
          || !this.isSearchPhase()) return;
      this.viewReady = true;
      this.markBeacon('F');
      this.bleDebug('PAGE_READY_FALLBACK', 'generation=' + String(generation));
    }, BLE_READY_FALLBACK_MS);
  },

  clearBleReadyFallback() {
    if (this.bleReadyFallbackTimer) clearTimeout(this.bleReadyFallbackTimer);
    this.bleReadyFallbackTimer = null;
  },


  clearSurfaceTimers() {
    this.surfaceGeneration = (this.surfaceGeneration || 0) + 1;
    this.clearPendingSurfaceGlobalHook();
    this.clearBleReadyFallback();
    this.clearSummaryHermesRetry();
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown({ preserveRemaining: true });
  },

  resetHudEndConfirmation(options = {}) {
    this.endArmedAtMs = null;
    this.hudEndConfirmCount = 0;
    this.lastConfirmKeyMs = null;
    if (options.clearHint === false || !this.data) return true;
    const hint = String(this.data.hudHint || '');
    if (hint === '再按2次结束'
        || hint === '再按1次结束'
        || hint === '请按确认键3次结束') {
      this.setData({ hudHint: '' });
    }
    return true;
  },

  clearScanRetryTimer() {
    if (this.scanRetryTimer) clearTimeout(this.scanRetryTimer);
    this.scanRetryTimer = null;
  },

  isBleHostInteractive() {
    return this.hostFocused !== false
      && this.pageVisible === true
      && this.bleTerminated !== true
      && this.backspaceHandled !== true
      && !this.isSummaryPhase();
  },

  isBleOperationCurrent(operation, lifecycleGeneration) {
    return this.isBleHostInteractive()
      && operation === this.bleOperationGeneration
      && lifecycleGeneration === this.bleLifecycleGeneration;
  },

  isBleAttemptCurrent(attempt, operation, lifecycleGeneration) {
    return this.connectAttemptId === attempt
      && this.isBleOperationCurrent(operation, lifecycleGeneration);
  },

  isBleSelectionCurrent(selectionGeneration) {
    return selectionGeneration == null
      || selectionGeneration === this.bleSelectionGeneration;
  },

  beginBleSelection(source = 'unknown') {
    this.bleSelectionGeneration = (this.bleSelectionGeneration || 0) + 1;
    const generation = this.bleSelectionGeneration;
    this.bleDebug(
      'SELECTION_GENERATION',
      'generation=' + String(generation) + ' source=' + String(source),
    );
    return generation;
  },

  isBleConnectAttemptCurrent(attempt, operation, lifecycleGeneration, selectionGeneration) {
    return this.isBleAttemptCurrent(attempt, operation, lifecycleGeneration)
      && this.isBleSelectionCurrent(selectionGeneration);
  },

  staleBleAttemptMustDisconnect(attempt, device) {
    if (this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false
        || this.isSummaryPhase()) return true;
    const replacementActive = this.connectAttemptId !== attempt
      && (this.data.bleState === 'connecting' || this.data.bleState === 'connected');
    if (!replacementActive) return true;
    // 同一原生 device 对象可能被新尝试复用；此时旧尝试只摘自己的 listener，
    // 不能 disconnect 新链。不同设备的旧 GATT 则必须归还，避免双 HRS 泄漏。
    return this.connectingDevice !== device && this.bleDevice !== device;
  },

  isDiscoveryOperationCurrent(operation, lifecycleGeneration) {
    return this.isBleOperationCurrent(operation, lifecycleGeneration)
      && (this.data.surfacePhase === 'ready' || this.data.surfacePhase === 'connecting');
  },

  async waitForBleBridgeStep(result, timeoutMs = BLE_CLEANUP_STEP_WAIT_MS) {
    if (!result || typeof result.then !== 'function') return;
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve(result).catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async waitForPendingBleCleanup() {
    const cleanup = this.bleCleanupPromise;
    if (!cleanup) return true;
    let timer = null;
    let outcome = 'timeout';
    this.bleDebug('BLE_CLEANUP_WAIT', 'before-operation');
    try {
      outcome = await Promise.race([
        Promise.resolve(cleanup).then(() => 'settled', () => 'settled'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), BLE_OPERATION_CLEANUP_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome !== 'settled') {
      this.bleDebug('BLE_CLEANUP_BUSY', 'operation-deferred');
      return false;
    }
    if (this.bleCleanupPromise === cleanup) this.bleCleanupPromise = null;
    // 生命周期切换可能在等待期间又排入一条更新的清理；本次操作继续让位。
    return this.bleCleanupPromise == null;
  },

  async releaseBleResources(resources, device, disconnect = true) {
    const seen = [];
    for (const resource of resources || []) {
      const characteristic = resource && resource.characteristic;
      const listener = resource && resource.listener;
      if (!characteristic || seen.includes(characteristic)) continue;
      seen.push(characteristic);
      if (listener) {
        try {
          characteristic.removeEventListener('characteristicvaluechanged', listener);
        } catch (_e) {}
      }
      if (disconnect) {
        try {
          const stopping = characteristic.stopNotifications();
          // 原生 GATT 桥串行化：先停每个 notify，再 disconnect。单步悬空按上限放行。
          await this.waitForBleBridgeStep(stopping);
        } catch (_e) {}
      }
    }
    if (disconnect && device && device.gatt) {
      try {
        const dropping = device.gatt.disconnect();
        await this.waitForBleBridgeStep(dropping);
      } catch (_e) {}
    }
  },

  releaseBleAttempt(characteristic, listener, device, disconnect = true) {
    return this.releaseBleResources([{ characteristic, listener }], device, disconnect);
  },

  isRscDataFresh(now = Date.now()) {
    return this.lastRscAtMs != null
      && now - this.lastRscAtMs >= 0
      && now - this.lastRscAtMs <= RSC_FRESH_MS;
  },

  clearRscSilentTimer() {
    if (this.rscSilentTimer == null) return;
    clearTimeout(this.rscSilentTimer);
    this.rscSilentTimer = null;
  },

  // RSC 与 HRS 共用一个 GATT，但拥有独立 characteristic/listener。2A53 静默
  // 只退役本代 RSC 订阅并让 MotionMetrics 释放外部距离源；2A37、共享 GATT
  // 与正在工作的心率必须原样保留。随后自由跑/室内跑在 5 秒后独立重探。
  retireSilentRsc(generation, now = Date.now()) {
    const characteristic = this.rscCharacteristic;
    const listener = this.rscListener;
    if (generation !== this.rscProbeGeneration
        || !characteristic || !listener || !this.bleDevice
        || this.data.bleState !== 'connected'
        || this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false
        || this.isSummaryPhase() || this.isSlowJogMode()) return false;

    this.rscProbeGeneration = generation + 1;
    this.rscCharacteristic = null;
    this.rscListener = null;
    this.rscSubscribedAtMs = null;
    this.rscLive = false;
    this.rscFeatureFlags = null;
    this.rscFeatureProbePromise = null;
    this.lastRscAtMs = null;
    this.pendingRscMeasurement = null;
    if (this.motionMetrics) this.motionMetrics.onRscDisconnected(now);
    this.resetRscStrideCalibration();
    this.rscProbeRetryAtMs = now + RSC_PROBE_RETRY_DELAY_MS;
    this.bleDebug(
      'RSC_RETRY_SCHEDULED',
      'afterMs=' + String(RSC_PROBE_RETRY_DELAY_MS) + ' reason=silent',
    );

    // cleanup 本身占用 rscProbePromise，确保旧 2A53 stopNotifications 尚未完成
    // 时 tick/onShow 不会在同一原生 characteristic 上叠加新的 startNotifications。
    const cleanup = Promise.resolve(
      this.releaseBleAttempt(characteristic, listener, null, true),
    ).catch((error) => {
      this.bleDebug('RSC_RELEASE_FAILED', 'reason=' + this.bleErrorText(error));
      return false;
    });
    this.rscProbePromise = cleanup;
    cleanup.finally(() => {
      if (this.rscProbePromise === cleanup) this.rscProbePromise = null;
    });
    this.requestRunTick('rsc-silent', now);
    return true;
  },

  // 订阅成功只代表 CCCD 已开启，不能代表 Garmin/脚豆真的在发送 0x2A53。
  // 以最后一条合法包（尚无包时以订阅时刻）为锚点。超过 freshness 后
  // 独立退役 2A53，并由 MotionMetrics/5 秒重探接管恢复；HRS/GATT 不动。
  scheduleRscSilentDiagnostic(referenceAtMs = null) {
    this.clearRscSilentTimer();
    const reference = referenceAtMs != null
      ? Number(referenceAtMs)
      : (this.lastRscAtMs != null
        ? Number(this.lastRscAtMs) : Number(this.rscSubscribedAtMs));
    if (!Number.isFinite(reference)) return false;
    if (this.hostFocused === false) {
      this.rscSilentDeferredByHostBlur = true;
      return false;
    }
    this.rscSilentDeferredByHostBlur = false;
    const generation = this.rscProbeGeneration;
    const dueAtMs = reference + RSC_FRESH_MS + 1;
    this.rscSilentTimer = setTimeout(() => {
      this.rscSilentTimer = null;
      if (this.hostFocused === false) {
        this.rscSilentDeferredByHostBlur = true;
        return;
      }
      if (generation !== this.rscProbeGeneration
          || !this.rscCharacteristic
          || this.data.bleState !== 'connected'
          || this.bleTerminated === true
          || this.backspaceHandled === true
          || !this.pageVisible
          || this.isSummaryPhase()) return;
      const latest = this.lastRscAtMs != null
        ? Number(this.lastRscAtMs) : Number(this.rscSubscribedAtMs);
      if (!Number.isFinite(latest)) return;
      if (latest !== reference || Date.now() - latest <= RSC_FRESH_MS) {
        this.scheduleRscSilentDiagnostic(latest);
        return;
      }
      this.rscLive = false;
      this.bleDebug(
        'RSC_SILENT',
        'since=' + (this.lastRscAtMs == null ? 'subscription' : 'last-packet')
          + ' ageMs=' + Math.max(0, Math.round(Date.now() - latest))
          + ' validPackets=' + String(this.rscPacketCount || 0)
          + ' invalidPackets=' + String(this.rscInvalidPacketCount || 0),
      );
      this.retireSilentRsc(generation, Date.now());
    }, Math.max(1, dueAtMs - Date.now()));
    return true;
  },

  // 2A54 只用于诊断设备声明的可选能力位。必须在 2A53 主订阅已经提交后
  // best-effort 读取；失败、悬空或迟到完成都不能影响 HRS/RSC 主链。
  probeRscFeatureCapabilities(service, generation, device) {
    if (!service || typeof service.getCharacteristic !== 'function') return false;
    const isCurrent = () => generation === this.rscProbeGeneration
      && this.bleDevice === device
      && !!this.rscCharacteristic
      && this.bleTerminated !== true
      && this.backspaceHandled !== true
      && this.pageVisible === true
      && this.hostFocused !== false
      && !this.isSummaryPhase();
    const run = async () => {
      try {
        const feature = await service.getCharacteristic(RSC_FEATURE_UUID);
        if (!isCurrent()) return false;
        if (!feature || typeof feature.readValue !== 'function') {
          throw new Error('2a54 read unavailable');
        }
        const raw = await feature.readValue();
        if (!isCurrent()) return false;
        const bytes = Array.isArray(raw) ? raw : Array.from(raw || []);
        if (bytes.length < 2) {
          this.bleDebug('RSC_FEATURE_INVALID', 'length=' + String(bytes.length));
          return false;
        }
        const flags = (Number(bytes[0]) & 0xff) | ((Number(bytes[1]) & 0xff) << 8);
        this.rscFeatureFlags = flags;
        this.bleDebug(
          'RSC_FEATURE',
          'flags=0x' + flags.toString(16).padStart(4, '0')
            + ' stride=' + String((flags & 0x01) !== 0)
            + ' totalDistance=' + String((flags & 0x02) !== 0)
            + ' walkingOrRunning=' + String((flags & 0x04) !== 0),
        );
        return true;
      } catch (error) {
        if (isCurrent()) {
          this.bleDebug('RSC_FEATURE_UNAVAILABLE', 'reason=' + this.bleErrorText(error));
        }
        return false;
      } finally {
        if (generation === this.rscProbeGeneration) {
          this.rscFeatureProbePromise = null;
        }
      }
    };
    this.rscFeatureProbePromise = run();
    return true;
  },

  // HR 是兼容性成功门槛；RSC 是同一 GATT 上的可选增强能力。普通心率带没有
  // 0x1814 时只能记一条诊断，绝不能反向拆掉已经工作的 HR 连接。
  probeOptionalRsc(device, server = null) {
    const gattServer = server || this.bleServer || (device && device.gatt);
    if (this.isSlowJogMode()
        || !device || !gattServer || typeof gattServer.getPrimaryService !== 'function'
        || this.rscCharacteristic || this.rscProbePromise
        || this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false
        || this.isSummaryPhase()) return false;

    const generation = (this.rscProbeGeneration || 0) + 1;
    this.rscProbeGeneration = generation;
    this.rscProbeRetryAtMs = null;
    this.clearRscSilentTimer();
    this.rscFeatureProbePromise = null;
    this.rscPacketCount = 0;
    this.rscInvalidPacketCount = 0;
    this.rscSubscribedAtMs = null;
    this.lastRscAtMs = null;
    this.rscLive = false;
    this.rscFeatureFlags = null;
    let characteristic = null;
    let listener = null;
    let timedOut = false;
    let guardedPromise = null;
    const isCurrent = () => generation === this.rscProbeGeneration
      && this.bleDevice === device
      && this.data.bleState === 'connected'
      && this.bleTerminated !== true
      && this.backspaceHandled !== true
      && this.pageVisible === true
      && this.hostFocused !== false
      && !this.isSummaryPhase()
      && !this.isSlowJogMode();

    // 旧探测只能摘掉自己挂上的 listener。只有它仍独占 rscProbePromise
    // 槽位时才允许 stopNotifications；teardown 已清空槽位、或新一代已经
    // 复用同一 2A53 时，旧 Promise 迟到绝不能把新代通知一起停掉。
    const releaseOwnedProbeAttempt = async () => {
      if (!characteristic) return;
      if (listener && typeof characteristic.removeEventListener === 'function') {
        try {
          characteristic.removeEventListener('characteristicvaluechanged', listener);
        } catch (_e) {}
      }
      if (timedOut || this.rscProbePromise !== guardedPromise
          || typeof characteristic.stopNotifications !== 'function') return;
      try {
        await this.waitForBleBridgeStep(characteristic.stopNotifications());
      } catch (_e) {}
    };

    const run = async () => {
      try {
        const service = await gattServer.getPrimaryService(RSC_SERVICE_UUID);
        if (!isCurrent()) throw new Error('stale RSC service');
        this.bleDebug('RSC_SERVICE_FOUND', 'service=1814');
        characteristic = await service.getCharacteristic(RSC_MEASUREMENT_UUID);
        if (!isCurrent()) throw new Error('stale RSC characteristic');
        listener = () => {
          const committedOwner = this.rscCharacteristic === characteristic
            && this.rscListener === listener && this.bleDevice === device;
          if (this.isSlowJogMode()) return;
          if (committedOwner) {
            if (this.bleTerminated === true || this.backspaceHandled === true
                || !this.pageVisible || this.isSummaryPhase()) return;
          } else if (!isCurrent()) return;
          const measurement = parseRscMeasurement(characteristic.value);
          if (!measurement) {
            this.rscInvalidPacketCount = (this.rscInvalidPacketCount || 0) + 1;
            if (this.rscInvalidPacketCount <= 3
                || this.rscInvalidPacketCount % 25 === 0) {
              const rawLength = characteristic.value
                && Number.isFinite(Number(characteristic.value.length))
                ? Number(characteristic.value.length) : 0;
              this.bleDebug(
                'RSC_PACKET_INVALID',
                'length=' + String(rawLength)
                  + ' count=' + String(this.rscInvalidPacketCount),
              );
            }
            return;
          }
          const now = Date.now();
          this.rscPacketCount = (this.rscPacketCount || 0) + 1;
          if (this.rscPacketCount === 1) {
            const rawFlags = characteristic.value
              && Number.isFinite(Number(characteristic.value[0]))
              ? (Number(characteristic.value[0]) & 0xff) : 0;
            this.bleDebug(
              'RSC_FIRST_PACKET',
              'afterMs=' + String(this.rscSubscribedAtMs == null
                ? 0 : Math.max(0, Math.round(now - this.rscSubscribedAtMs)))
                + ' flags=0x' + rawFlags.toString(16).padStart(2, '0'),
            );
          }
          if (this.rscPacketCount <= 3) {
            this.bleDebug(
              'RSC_DATA',
              'rawCadence=' + measurement.cadenceFootfallsPerMin
                + ' cadenceSpm=' + measurement.cadenceSpm
                + ' speedMps=' + measurement.speedMps.toFixed(3),
            );
          }
          this.rscLive = true;
          this.lastRscAtMs = now;
          if (this.isSearchPhase() && this.isGarminVirtualMode()) {
            const motionLive = Number(measurement.speedMps) > 0
              && Number(measurement.cadenceSpm) > 0;
            this.setData({
              searchText: motionLive
                ? '室内跑配速与步频已接入'
                : '室内跑数据在线 · 等待起跑',
              searchChip: motionLive ? '配速接入' : '数据在线',
            });
          }
          this.scheduleRscSilentDiagnostic(now);
          this.pendingRscMeasurement = measurement;
          if (this.motionMetrics) {
            const metricResult = this.motionMetrics.onRscMeasurement(measurement, now);
            const motion = this.motionMetrics.snapshot(now);
            if (Number(measurement.speedMps) > 0
                && Number(measurement.cadenceSpm) > 0) {
              const activity = this.imuActivityGate
                ? this.imuActivityGate.confirmExternal(now, 'rsc_motion')
                : null;
              if (activity && activity.justActivated) {
                console.log('[SmartRun Motion] ACTIVITY_CONFIRMED reason=rsc_motion');
                this.startRunMetronome();
              }
            }
            this.advanceWorkoutDistance(now, this.motionMetrics.snapshot(now));
            if (metricResult.incoherentSpeed === true) {
              // 已有合法 RSC 速度后，设备在模式切换边沿可能给出
              // “正速度 + 0 步频”。MotionMetrics 会拒绝该包，融合器也必须
              // 同帧清空，不能继续把上一条 3–4 分配速留在静止 HUD。
              this.clearLivePaceState(now);
            }
            if (this.speedFusion && metricResult.speedAccepted
                && Number.isFinite(motion.rscSpeedMps)) {
              if (motion.rscSpeedMps > 0) {
                this.speedFusion.observe('rsc', motion.rscSpeedMps, now, {
                  quality: metricResult.outlierRejected ? 0.25 : 1,
                });
              } else if (!(motion.cadenceReady && motion.cadenceSpm > 0)) {
                // 标准 RSC 的 0/0 是明确停止边沿；但某些 Garmin 状态会持续
                // 发送 0，同时眼镜 IMU 仍在形成正步频。前者应清旧速度，
                // 后者必须继续由 IMU 接管，不能每秒被设备的无数据零值打断。
                this.speedFusion.observeStationary(now, 1);
              }
            }
            // RSC 个性化步长必须使用 2A53 自己的双脚总步频积分步数。即使
            // MotionMetrics 的首包只建立累计距离/速度锚点，也要把本包作为
            // cadence 锚点；后续只有同一段 RSC 距离达到阈值才会真正学习。
            this.observeRscStrideCalibration(measurement, metricResult, now);
          }
          // 录屏时系统可能饿死 1Hz interval，但 RSC notify 仍持续到达。
          // 直接从真实数据事件请求一次限频 HUD 刷新，避免配速/步频长期为占位。
          this.requestRunTick('rsc', now);
        };
        characteristic.addEventListener('characteristicvaluechanged', listener);
        await characteristic.startNotifications();
        if (!isCurrent()) {
          await releaseOwnedProbeAttempt();
          return false;
        }
        this.rscCharacteristic = characteristic;
        this.rscListener = listener;
        this.rscSubscribedAtMs = Date.now();
        this.rscLive = false;
        this.bleDebug(
          'RSC_SUBSCRIBED',
          'service=1814 characteristic=2a53 subscribedAtMs='
            + String(this.rscSubscribedAtMs),
        );
        this.scheduleRscSilentDiagnostic(this.rscSubscribedAtMs);
        this.probeRscFeatureCapabilities(service, generation, device);
        return true;
      } catch (error) {
        await releaseOwnedProbeAttempt();
        if (generation === this.rscProbeGeneration && this.bleDevice === device) {
          const reason = this.bleErrorText(error);
          if (!this.isSlowJogMode()
              && this.pageVisible === true
              && !this.isSummaryPhase()) {
            this.rscProbeRetryAtMs = Date.now() + RSC_PROBE_RETRY_DELAY_MS;
            this.bleDebug(
              'RSC_UNAVAILABLE',
              'reason=' + reason
                + ' retryInMs=' + String(RSC_PROBE_RETRY_DELAY_MS),
            );
          } else {
            this.bleDebug('RSC_UNAVAILABLE', 'reason=' + reason);
          }
        }
        return false;
      }
    };
    const chainPromise = run();
    let timeoutTimer = null;
    guardedPromise = Promise.race([
      chainPromise.then((value) => ({ type: 'settled', value })),
      new Promise((resolve) => {
        timeoutTimer = setTimeout(
          () => resolve({ type: 'timeout', value: false }),
          RSC_PROBE_TIMEOUT_MS,
        );
      }),
    ]).then((outcome) => {
      if (outcome.type !== 'timeout') return outcome.value;
      timedOut = true;
      // listener 在 startNotifications 前已挂上；超时当刻先摘掉，避免旧桥
      // 迟到时把同一数据包交给旧 owner。通知本身不能安全“取消”，所以仅
      // 让 generation 失效，并允许稍后用新 listener 重试，HRS/GATT 不动。
      if (characteristic && listener
          && typeof characteristic.removeEventListener === 'function') {
        try {
          characteristic.removeEventListener(
            'characteristicvaluechanged',
            listener,
          );
        } catch (_e) {}
      }
      if (generation === this.rscProbeGeneration && this.bleDevice === device) {
        this.rscProbeGeneration = generation + 1;
        this.rscProbeRetryAtMs = Date.now() + RSC_PROBE_RETRY_DELAY_MS;
        this.bleDebug(
          'RSC_PROBE_TIMEOUT',
          'afterMs=' + String(RSC_PROBE_TIMEOUT_MS)
            + ' retryInMs=' + String(RSC_PROBE_RETRY_DELAY_MS),
        );
      }
      return false;
    }).finally(() => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (this.rscProbePromise === guardedPromise) this.rscProbePromise = null;
    });
    this.rscProbePromise = guardedPromise;
    return true;
  },







  bleDebug(event, details = '') {
    const suffix = details ? ' ' + String(details) : '';
    console.log('[SmartRun BLE] ' + event + suffix);
    // details 只接受调用方已经分类/限界的诊断值；不得传设备名、稳定 ID、
    // 原生错误原文或原始包。durable archive 进一步只保留事件 token。
    this.recordRunningLocalFieldEvent('ble', event);
  },

  bleErrorText(error) {
    if (!error) return 'unknown';
    const parts = [];
    if (typeof error === 'object') {
      if (error.name != null) parts.push(String(error.name));
      if (error.code != null) parts.push(String(error.code));
      if (error.message != null) parts.push(String(error.message));
    } else {
      parts.push(String(error));
    }
    const raw = parts.join(' ').toLowerCase();
    if (!raw) return 'unknown';
    if (/not.?allowed|permission|denied|unauthori[sz]ed|security/.test(raw)) {
      return 'permission';
    }
    if (/timeout|timed.?out/.test(raw)) return 'timeout';
    if (/disconnect|connection.?lost|not.?connected/.test(raw)) return 'disconnected';
    if (/not.?found|missing|unavailable|unsupported|not.?supported/.test(raw)) {
      return 'unavailable';
    }
    if (/abort|cancel/.test(raw)) return 'cancelled';
    if (/invalid|type|range|syntax/.test(raw)) return 'invalid';
    if (/network|transport|\bio\b|i\/o/.test(raw)) return 'transport';
    if (/busy|in.?progress/.test(raw)) return 'busy';
    return 'other';
  },

  logBleDevice(event, _device, count = null, rawCount = null) {
    const boundedCount = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return Math.max(0, Math.min(9999, Math.trunc(numeric)));
    };
    const safeCount = count == null ? null : boundedCount(count);
    const safeRawCount = rawCount == null ? null : boundedCount(rawCount);
    const countText = safeCount == null ? '' : ' count=' + safeCount;
    const rawText = safeRawCount == null ? '' : ' raw=' + safeRawCount;
    this.bleDebug(event, 'candidate=redacted' + countText + rawText);
  },

  discoveredDeviceKey(device) {
    const stableId = String(device && (device.id || device.deviceId) || '').trim();
    if (stableId) return stableId;
    const name = deviceDisplayName(device);
    return 'anonymous-' + name;
  },

  syncDiscoveredDevices() {
    // HUD/总结相位不渲染设备列表:内部结构照更新,跳过逐包 setData 重绘。
    if (this.data.surfacePhase === 'hud' || this.isSummaryPhase()) return;
    const refs = this.discoveredDeviceRefs || {};
    const order = this.discoveredDeviceOrder || [];
    const focusCount = order.length + 1;
    const rawFocus = Number(this.searchFocusIndex) || 0;
    const focusIndex = ((rawFocus % focusCount) + focusCount) % focusCount;
    this.searchFocusIndex = focusIndex;
    // 480x352 搜索页最多稳定容纳四行。完整候选仍保留在 refs/order，
    // 只把当前焦点所在的四行窗口交给 Ink 渲染，避免焦点走到裁剪区之外。
    const focusedOrderIndex = focusIndex > 0 ? focusIndex - 1 : 0;
    const windowStart = focusIndex > 0
      ? Math.floor(focusedOrderIndex / SEARCH_VISIBLE_DEVICE_ROWS)
        * SEARCH_VISIBLE_DEVICE_ROWS
      : 0;
    const visibleKeys = order.slice(
      windowStart,
      windowStart + SEARCH_VISIBLE_DEVICE_ROWS,
    );
    const devices = visibleKeys.map((key, visibleIndex) => {
      const orderIndex = windowStart + visibleIndex;
      const record = refs[key];
      const selected = key === this.selectedDeviceKey;
      const focused = focusIndex === orderIndex + 1;
      return {
        deviceId: key,
        deviceName: record.deviceName,
        deviceMeta: record.deviceMeta,
        status: record.status,
        focusIndex: orderIndex + 1,
        deviceSelectedClass: selected ? 'device-row-selected' : '',
        deviceFocusClass: focused ? 'device-row-focused' : '',
      };
    });
    const rangeEnd = Math.min(
      order.length,
      windowStart + SEARCH_VISIBLE_DEVICE_ROWS,
    );
    this.setData({
      searchPrimaryClass: focusIndex === 0 ? 'search-target-focused' : '',
      discoveredDevices: devices,
      discoveredDeviceCount: order.length,
      discoveredDeviceRange: order.length > SEARCH_VISIBLE_DEVICE_ROWS
        ? String(windowStart + 1) + '–' + String(rangeEnd)
          + ' / ' + String(order.length)
        : '',
      hasDiscoveredDevices: order.length > 0,
    });
    return devices;
  },

  setSearchFocus(index) {
    const count = (this.discoveredDeviceOrder || []).length + 1;
    const next = ((Number(index) || 0) % count + count) % count;
    this.searchFocusIndex = next;
    this.syncDiscoveredDevices();
    return next;
  },

  onSearchFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : {};
    const index = dataset && dataset.focusIndex != null ? Number(dataset.focusIndex) : 0;
    if (!this.shouldAcceptHostFocus(
      this.data.surfacePhase, index, this.searchFocusIndex,
    )) return false;
    this.setSearchFocus(index);
    return true;
  },

  activateSearchFocused() {
    const index = this.setSearchFocus(this.searchFocusIndex);
    if (index === 0) return this.onScanTap();
    const deviceId = (this.discoveredDeviceOrder || [])[index - 1];
    if (!deviceId) return false;
    return this.selectDevice({
      currentTarget: {
        dataset: { id: deviceId, focusIndex: index },
        attributes: { 'data-id': deviceId },
      },
    });
  },

  recordDiscoveredDevice(device, preferred = null, status = '') {
    if (!device) return null;
    const key = this.discoveredDeviceKey(device);
    const stableId = String(device.id || device.deviceId || '').trim();
    const refs = this.discoveredDeviceRefs || (this.discoveredDeviceRefs = {});
    let changed = false;
    if (!refs[key]) {
      refs[key] = {
        device,
        deviceName: deviceDisplayName(device),
        deviceMeta: stableId ? stableId.slice(-6) : 'NO-ID',
        // 手动流程:状态即操作提示——点按设备行发起连接;首选=之前记住的设备。
        status: status || (preferred && matchesHeartRateDevice(device, preferred) ? '首选' : '点按连接'),
      };
      (this.discoveredDeviceOrder || (this.discoveredDeviceOrder = [])).push(key);
      changed = true;
    } else {
      refs[key].device = device;
      const nextName = deviceDisplayName(device);
      if (refs[key].deviceName !== nextName) {
        refs[key].deviceName = nextName;
        changed = true;
      }
      if (status && refs[key].status !== '已连接' && refs[key].status !== status) {
        refs[key].status = status;
        changed = true;
      }
    }
    // 同一设备的密集重复广播只累计 raw 次数；列表字段没变时不重复 setData。
    if (changed) this.syncDiscoveredDevices();
    return refs[key];
  },

  setDiscoveredDeviceStatus(device, status) {
    if (!device) return false;
    const key = this.discoveredDeviceKey(device);
    const record = this.discoveredDeviceRefs && this.discoveredDeviceRefs[key];
    if (!record || record.status === status) return false;
    record.status = status;
    this.syncDiscoveredDevices();
    return true;
  },

  // ── 官方 bluetooth 样例 heart_rate 页的逐行移植 ─────────────────────
  // 点"开始搜索"→ 一次连续扫描(hr filter,新鲜字面量,裸 await,无包装无轮次);
  // 设备行上屏 → 点设备行 → stopScan → gatt.connect → 180D → 2A37 → notify。
  // 这是本机唯一被完整验证过的链路;我们只保留 UI 文案/信标/跑步会话对接。
  ensureBleAvailable() {
    if (typeof navigator === 'undefined' || !navigator.bluetooth
        || typeof navigator.bluetooth.scanDevices !== 'function') {
      this.bleDebug('AVAILABILITY_FAILED', 'reason=api-missing');
      this.setData({
        bleState: 'idle',
        searchChip: '未搜索',
        searchText: '当前无法搜索蓝牙设备',
        // Craft 模拟器没有真机 Web Bluetooth。第一次确认只完成能力探测，
        // 随即开放“下一步”；第二次确认仍可按产品约定进入纯眼镜 HUD。
        primaryLabel: '下一步',
        scanDiagnostic: '单击“下一步”使用眼镜估算',
        scanProgressText: '未搜索',
      });
      return false;
    }
    this.bleDebug('AVAILABILITY_OK', 'api-present');
    this.markBeacon('V');
    return true;
  },

  resetDiscoveredDevices() {
    this.beginBleSelection('reset-discovery');
    this.discoveredDeviceRefs = {};
    this.discoveredDeviceOrder = [];
    this.rawAdvertisementCount = 0;
    this.selectedDeviceKey = null;
    this.autoConnectPending = false;
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    this.searchFocusIndex = 0;
    this.setData({
      discoveredDevices: [],
      discoveredDeviceCount: 0,
      discoveredDeviceRange: '',
      hasDiscoveredDevices: false,
      primaryLabel: '开始搜索',
      scanDiagnostic: '还没有开始搜索',
      scanProgressText: '等待操作',
      searchPrimaryClass: 'search-target-focused',
    });
  },

  onScanTap() {
    if (!this.isSearchPhase()) return false;
    if (this.agentExitRequested || this.backspaceHandled
        || !this.pageVisible || this.hostFocused === false) return false;
    // 必须在任何 await 之前占用语义动作。否则 GlobalHook keyup 已把
    // scanAttempted 置 true 后，同次 TouchEnd/bindtap 会被误判成“下一步”。
    if (!this.claimSurfaceActivation('search-primary')) return false;
    this.setSearchFocus(0);
    this.markBeacon('T');
    this.pageVisible = true;
    this.viewReady = true;
    this.clearBleReadyFallback();
    if (this.data.surfacePhase === 'hud'
        || this.isSummaryPhase()) return false;
    if (this.runSettings && this.runSettings.autoHeartRate === false) {
      return this.onConnectTap();
    }
    // 扫描已启动/已有设备/已连接:主按钮即"下一步"——智能入场(有设备自动连,
    // 没有就眼镜模式开跑)。只有完全未开扫时才发起扫描。
    if (this.data.hasDiscoveredDevices
        || this.scanAttempted === true
        || this.data.bleState === 'scanning'
        || this.data.bleState === 'connecting'
        || this.data.bleState === 'connected') {
      return this.onConnectTap();
    }
    this.scanRetryCount = 0;
    return this.startDiscovery();
  },

  async startDiscovery() {
    if (this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false
        || this.data.surfacePhase === 'hud'
        || this.isSummaryPhase()) return false;
    this.scanRetryDeferredByHostBlur = false;
    // 用户已经完成了“开始搜索”这次语义动作。即使 Craft 没有扫描接口，
    // 下一次独立确认也必须被解释为“下一步”，不能永久重试能力检查。
    this.scanAttempted = true;
    if (this.bleCleanupPromise) {
      const cleanupReady = await this.waitForPendingBleCleanup();
      if (!cleanupReady) {
        this.scanAttempted = false;
        return false;
      }
      if (this.bleTerminated === true || this.backspaceHandled === true
          || !this.pageVisible || this.data.surfacePhase === 'hud'
          || this.isSummaryPhase()) return false;
    }
    if (!this.ensureBleAvailable()) return false;
    this.clearScanRetryTimer();
    const operation = this.bleOperationGeneration || 0;
    const lifecycleGeneration = this.bleLifecycleGeneration || 0;
    await this.stopScan();
    if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) return false;
    this.resetDiscoveredDevices();
    const scanningCopy = this.runEntryCopy('scanning');
    this.setData({
      surfacePhase: 'connecting',
      bleState: 'scanning',
      searchChip: '搜索中',
      searchText: scanningCopy.searchText,
      scanDiagnostic: scanningCopy.scanDiagnostic,
      scanProgressText: '已发现 0 台',
      coachLine: '匹配心率设备',
    });
    this.markBeacon('C');
    this.bleDebug('SCAN_REQUEST', 'options=hr-filter');
    try {
      const scan = await navigator.bluetooth.scanDevices({
        filters: [{ services: ['heart_rate'] }],
      });
      // scanDevices 是原生桥 Promise：页面可能已总结/返回/销毁后它才兑现。
      // 过期会话立即 stop，不挂载事件、不改 UI，从根上阻止退出后蓝牙复活。
      if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) {
        try { scan.stop(); } catch (_e) {}
        this.bleDebug('SCAN_DISCARDED', 'reason=stale-operation');
        return false;
      }
      this.scanSession = scan;
      this.scanStartedSuccessfully = true;
      this.bleDebug('SCAN_ACTIVE', 'hr-filter');
      // 扫描已启动:主按钮即变"下一步"——找到设备则自动连接入场,找不到也能
      // 直接开跑(眼镜模式)。单按钮完成全流程,不再需要第二个下一步。
      this.setData({ primaryLabel: '下一步' });
      scan.onDeviceFound((event) => {
        if (this.scanSession !== scan
            || !this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) return;
        const device = event && event.device;
        if (!device) return;
        this.rawAdvertisementCount = (this.rawAdvertisementCount || 0) + 1;
        const preferredHeartRateDevice = readHeartRateDevice(wx);
        this.recordDiscoveredDevice(device, preferredHeartRateDevice);
        this.logBleDevice(
          'DEVICE_FOUND', device,
          this.data.discoveredDeviceCount, this.rawAdvertisementCount,
        );
        // 进入跑步页/总结页后扫描已停(scanSession 置空,迟到广播在上方已被丢弃);
        // 这里只服务 02 搜索页的可见诊断。
        if (this.isSearchPhase()) {
          this.setData({
            scanDiagnostic: '已发现 ' + this.data.discoveredDeviceCount + ' 台设备',
            // 重复广播次数只留在 [SmartRun BLE] 日志中；用户只需要知道候选数，
            // 避免把广告包次数误解成还要等待的“扫描轮次”。
            scanProgressText: '已发现 ' + this.data.discoveredDeviceCount + ' 台',
          });
        }
        // 有已记住的稳定 ID 时，邻近其他 HRS 只进入列表，绝不能抢占 GATT；
        // 首选设备到达后立即自动连接。没有首选时给候选一个短汇集窗，再连接
        // 第一台。下一步仍由用户确认进入热身，扫描结果不替用户开始跑步。
        const preferredDeviceId = String(
          preferredHeartRateDevice && preferredHeartRateDevice.deviceId || '',
        ).trim();
        const candidateMayAutoConnect = !preferredDeviceId
          || matchesHeartRateDevice(device, preferredHeartRateDevice);
        if (this.data.surfacePhase === 'connecting'
            && this.data.bleState === 'scanning'
            && this.hostFocused !== false
            && candidateMayAutoConnect
            && this.autoConnectPending !== true
            && !this.autoConnectTimer) {
          const autoConnectDelayMs = preferredDeviceId
            ? 0 : BLE_AUTO_CONNECT_SETTLE_MS;
          this.autoConnectTimer = setTimeout(() => {
            this.autoConnectTimer = null;
            if (this.data.surfacePhase !== 'connecting'
                || this.data.bleState !== 'scanning'
                || this.autoConnectPending === true
                || !this.pageVisible || this.hostFocused === false) return;
            this.autoConnectBestCandidate({ autoFromDiscovery: true });
          }, autoConnectDelayMs);
        }
      });
      return true;
    } catch (e) {
      if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)) return false;
      const reason = this.bleErrorText(e);
      this.bleDebug('SCAN_START_FAILED', 'reason=' + reason);
      this.markBeacon('E:' + String(reason).slice(0, 40));
      // 扫描失败不堵路:按钮保持"下一步",点击即无心率开跑;后台仍自动补一次重试。
      this.setData({
        bleState: 'idle',
        searchChip: '搜索失败',
        searchText: '搜索失败，可使用眼镜估算',
        primaryLabel: '下一步',
        scanDiagnostic: '单击“下一步”继续',
      });
      // 上次连接/扫描的宿主侧拆除可能尚未完成(跑完立刻重进的典型场景),
      // 按梯次退避自动重试约 30s;期间按钮始终是"下一步",不堵路。
      const retryDelayMs = SCAN_RETRY_DELAYS_MS[this.scanRetryCount || 0];
      if (retryDelayMs != null) {
        const retryAttempt = (this.scanRetryCount || 0) + 1;
        this.clearScanRetryTimer();
        this.scanRetryTimer = setTimeout(() => {
          this.scanRetryTimer = null;
          if (this.hostFocused === false) {
            this.scanRetryDeferredByHostBlur = true;
            return;
          }
          // 宿主返回后的僵尸实例绝不许复活扫描(backspaceHandled 在 keyup 同步置位)。
          if (!this.isDiscoveryOperationCurrent(operation, lifecycleGeneration)
              || this.data.bleState !== 'idle') return;
          this.scanRetryCount = retryAttempt;
          this.markBeacon('RT' + this.scanRetryCount);
          this.startDiscovery();
        }, retryDelayMs);
      }
      return false;
    }
  },

  async stopScan() {
    const session = this.scanSession;
    this.scanSession = null;
    if (this.data.bleState === 'scanning') {
      this.setData({ bleState: 'idle' });
    }
    if (!session) return;
    try {
      const stopping = session.stop();
      if (stopping && typeof stopping.then === 'function') {
        await this.waitForBleBridgeStep(stopping, BLE_STOP_WAIT_MS);
      } else {
        // AIUI v0.14 的 stop() 是这种形态：JS 已停派发，原生扫描尚在异步退出。
        await new Promise((resolve) => { setTimeout(resolve, BLE_NATIVE_SCAN_SETTLE_MS); });
      }
    } catch (_) {}
    this.bleDebug('SCAN_STOPPED', 'found=' + this.data.discoveredDeviceCount);
  },

  async selectDevice(e) {
    if (!this.isSearchPhase()) return false;
    if (this.agentExitRequested || this.backspaceHandled
        || !this.pageVisible || this.hostFocused === false) return false;
    const target = e && e.currentTarget ? e.currentTarget : {};
    const dataset = target.dataset || {};
    const attributes = target.attributes || {};
    const deviceId = dataset.id || attributes['data-id'] || null;
    if (!this.claimSurfaceActivation('search-device-' + String(deviceId || 'missing'))) return false;
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    this.markBeacon('P');
    const record = deviceId && this.discoveredDeviceRefs
      ? this.discoveredDeviceRefs[deviceId] : null;
    const device = record && record.device;
    if (!device) {
      this.setData({ scanDiagnostic: '设备已不在附近' });
      return false;
    }
    // 自动首选已经越过 stopScan 并进入 GATT 时，明确的用户点选仍然优先。
    // 其他手动/重连链保持 single-flight，已连接状态也不被误拆。
    const replacingAuto = this.data.bleState === 'connecting'
      && this.autoConnectPending === true
      && this.autoConnectSelectionGeneration != null;
    if (this.data.bleState === 'connected'
        || (this.data.bleState === 'connecting' && !replacingAuto)) return false;
    const selectionGeneration = this.beginBleSelection('manual');
    this.autoConnectPending = false;
    this.autoConnectSelectionGeneration = null;
    const focusIndex = (this.discoveredDeviceOrder || []).indexOf(deviceId) + 1;
    if (focusIndex > 0) this.searchFocusIndex = focusIndex;
    this.selectedDeviceKey = deviceId;
    this.reconnectDevice = device;
    this.syncDiscoveredDevices();
    await this.stopScan();
    if (!this.isBleSelectionCurrent(selectionGeneration)) return false;
    return this.connectSelected(device, {
      selectionGeneration,
      selectionSource: 'manual',
    });
  },

  async connectSelected(device, options = {}) {
    const selectionGeneration = options.selectionGeneration == null
      ? null : Number(options.selectionGeneration);
    if (!device || this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false || this.isSummaryPhase()
        || !this.isBleSelectionCurrent(selectionGeneration)) return false;
    if (this.bleCleanupPromise) {
      const cleanupReady = await this.waitForPendingBleCleanup();
      if (!cleanupReady
          || !device || this.bleTerminated === true || this.backspaceHandled === true
          || !this.pageVisible || this.hostFocused === false || this.isSummaryPhase()
          || !this.isBleSelectionCurrent(selectionGeneration)) return false;
    }
    const operation = this.bleOperationGeneration || 0;
    const lifecycleGeneration = this.bleLifecycleGeneration || 0;
    // 尝试代次:超时后才迟到 settle 的旧尝试,不得拆新链路、不得改 UI、不得提交状态。
    const attempt = (this.connectAttemptId || 0) + 1;
    this.connectAttemptId = attempt;
    this.connectingAttemptId = attempt;
    this.connectingDevice = device;
    this.connectingSelectionGeneration = selectionGeneration;
    this.connectingSelectionSource = String(options.selectionSource || 'direct');
    this.setDiscoveredDeviceStatus(device, '连接中');
    const connectingCopy = this.runEntryCopy('connecting');
    this.setData({
      bleState: 'connecting',
      coachLine: '正在连接心率设备',
      searchChip: '连接中',
      searchText: connectingCopy.searchText,
    });
    let server = null;
    let characteristic = null;
    let listener = null;
    try {
      // 与官方样例逐行同序的 GATT 链;外层只加 JS 侧等待上限(不取消宿主调用、
      // 不新增任何桥请求):bridge 悬空不再把 'connecting' 卡成永久假心率版面。
      const chain = async () => {
        server = await device.gatt.connect();
        if (!this.isBleConnectAttemptCurrent(
          attempt, operation, lifecycleGeneration, selectionGeneration,
        )) {
          throw new Error('stale BLE connect');
        }
        const service = await server.getPrimaryService('heart_rate');
        if (!this.isBleConnectAttemptCurrent(
          attempt, operation, lifecycleGeneration, selectionGeneration,
        )) {
          throw new Error('stale BLE service');
        }
        characteristic = await service.getCharacteristic(HR_MEASUREMENT_UUID);
        if (!this.isBleConnectAttemptCurrent(
          attempt, operation, lifecycleGeneration, selectionGeneration,
        )) {
          throw new Error('stale BLE characteristic');
        }
        // 必须在开启通知前重置:宿主可能在 startNotifications resolve 前派发首包。
        this.lastHrAtMs = null;
        this.hrSubscribedAtMs = Date.now();
        this.invalidHrPackets = 0;
        listener = () => {
          // 提交前跟尝试代次;提交后跟资源所有权。HUD 息屏会换
          // lifecycle generation 但刻意保留 GATT，回来后同一监听必须继续收包。
          const committedOwner = this.hrCharacteristic === characteristic
            && this.hrListener === listener && this.bleDevice === device;
          if (committedOwner) {
            if (this.bleTerminated === true || this.backspaceHandled === true
                || !this.pageVisible || this.isSummaryPhase()) return;
          } else if (!this.isBleConnectAttemptCurrent(
            attempt, operation, lifecycleGeneration, selectionGeneration,
          )) return;
          const m = parseHeartRateMeasurement(characteristic.value);
          if (!m || !Number.isFinite(m.bpm) || m.bpm <= 0 || m.bpm >= 255) {
            this.invalidHrPackets = (this.invalidHrPackets || 0) + 1;
            return;
          }
          this.invalidHrPackets = 0;
          const recoveredSilentHeartRate = this.hrDegradedByRsc === true
            || (this.hrNotifyRecoveryCount || 0) > 0
            || !!this.hrNotifyRecoveryTimer
            || !!this.hrNotifyRecoveryFlight;
          this.cancelHrNotificationRecovery('first-packet', { resetAttempts: true });
          this.hrDegradedByRsc = false;
          // 只有真正收到有效 2A37 首包才算链路恢复；仅 notify 订阅成功
          // 不清重试预算，否则“订阅成功但永远无数据”会每 20s 无限重连。
          this.hudReconnectCount = 0;
          this.lastHrAtMs = Date.now();
          this.lastHrUiAtMs = this.lastHrAtMs;  // 版面时间戳:teardown 不清,15s 保持
          if (recoveredSilentHeartRate) {
            this.bleDebug('HR_NOTIFY_RECOVERY_FIRST_PACKET', 'action=restore-bpm');
          }
          this.showConnectedResult(m.bpm, deviceDisplayName(device));
          this.scheduleHrWatchdog();
          if (this.session) this.session.onHeartRate(m.bpm);
          this.requestRunTick('hr', this.lastHrAtMs);
        };
        characteristic.addEventListener('characteristicvaluechanged', listener);
        await characteristic.startNotifications();
        if (!this.isBleConnectAttemptCurrent(
          attempt, operation, lifecycleGeneration, selectionGeneration,
        )) {
          throw new Error('stale BLE notifications');
        }
      };
      let connectTimer = null;
      const chainPromise = chain();
      let raced = null;
      try {
        raced = await Promise.race([
          chainPromise.then(() => 'ok'),
          new Promise((resolve) => {
            connectTimer = setTimeout(() => resolve('timeout'), BLE_CONNECT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        // 原生链提前 reject 时 await 会直接抛进外层 catch；finally 保证 10s
        // 业务超时器不会留在已卸载/已结束的页面实例里继续占用生命周期。
        if (connectTimer) clearTimeout(connectTimer);
      }
      if (raced === 'timeout') {
        // 悬空链若日后兑现:只摘自己的监听;仅当此刻无人用连接(idle)才断链,
        // 绝不踩后续尝试用同一设备建立的新链路。
        const cleanupLateChain = () => {
          const mustDisconnect = this.staleBleAttemptMustDisconnect(attempt, device);
          return this.releaseBleAttempt(characteristic, listener, device, mustDisconnect);
        };
        chainPromise.then(cleanupLateChain, cleanupLateChain).catch(() => {});
        throw new Error('connect timeout ' + BLE_CONNECT_TIMEOUT_MS + 'ms');
      }
      // 统一提交门:尝试换代、页面隐藏、总结/退出任一发生都放弃提交。
      if (!this.isBleConnectAttemptCurrent(
        attempt, operation, lifecycleGeneration, selectionGeneration,
      )) {
        const mustDisconnect = this.staleBleAttemptMustDisconnect(attempt, device);
        await this.releaseBleAttempt(characteristic, listener, device, mustDisconnect);
        if (this.connectingAttemptId === attempt) {
          this.connectingAttemptId = null;
          this.connectingDevice = null;
          this.connectingSelectionGeneration = null;
          this.connectingSelectionSource = null;
        }
        return false;
      }
      // 订阅桥往返可能耗秒级:首包等待基线改从订阅完成时刻起算(首包已到则不动),
      // 否则宽限窗口被握手时间白白吃掉。
      if (this.lastHrAtMs == null) this.hrSubscribedAtMs = Date.now();
      this.hrCharacteristic = characteristic;
      this.hrListener = listener;
      this.bleDevice = device;
      this.bleServer = server;
      this.connectedHeartName = deviceDisplayName(device);
      this.setDiscoveredDeviceStatus(device, '已连接');
      // 手动点选即显式配对语义:成功订阅后记住该设备。
      if (device.id) writeHeartRateDevice(wx, device);
      if (typeof device.addEventListener === 'function') {
        this.bleDropListener = () => this.onBleDropped();
        device.addEventListener('gattserverdisconnected', this.bleDropListener);
      }
      this.setData({
        bleState: 'connected',
        heartDeviceName: this.connectedHeartName,
        ...this.hudModeFields({
          connected: this.isHrUiEngaged(),
          deviceName: this.connectedHeartName,
        }),
        coachLine: this.lastHrAtMs != null ? '心率数据已接入' : '等待心率数据',
        ...(this.isSearchPhase()
          ? { ...this.runEntryCopy('connected'), searchChip: '已连接' }
          : {}),
      });
      this.scheduleHrWatchdog();
      this.reconnectDevice = null;  // 链路到手:重连目标清空
      if (this.connectingAttemptId === attempt) {
        this.connectingAttemptId = null;
        this.connectingDevice = null;
        this.connectingSelectionGeneration = null;
        this.connectingSelectionSource = null;
      }
      this.markBeacon('OK');
      // 不等待可选 RSC，避免缺少该服务或宿主桥悬空拖垮所有标准 HR-only 设备。
      if (!this.isSlowJogMode()) this.probeOptionalRsc(device, server);
      return true;
    } catch (e) {
      if (!this.isBleConnectAttemptCurrent(
        attempt, operation, lifecycleGeneration, selectionGeneration,
      )) {
        // 旧尝试迟到失败:退出/隐藏时强制归还链路;若已有新尝试接管,只摘自己的监听。
        const mustDisconnect = this.staleBleAttemptMustDisconnect(attempt, device);
        await this.releaseBleAttempt(characteristic, listener, device, mustDisconnect);
        if (this.connectingAttemptId === attempt) {
          this.connectingAttemptId = null;
          this.connectingDevice = null;
          this.connectingSelectionGeneration = null;
          this.connectingSelectionSource = null;
        }
        return false;
      }
      const reason = this.bleErrorText(e);
      this.bleDebug('GATT_ERROR', 'reason=' + reason);
      this.markBeacon('EC:' + String(reason).slice(0, 40));
      await this.releaseBleAttempt(characteristic, listener, device, true);
      if (this.connectingAttemptId === attempt) {
        this.connectingAttemptId = null;
        this.connectingDevice = null;
        this.connectingSelectionGeneration = null;
        this.connectingSelectionSource = null;
      }
      this.teardownBle();
      this.setDiscoveredDeviceStatus(device, '可重试');
      // 失败不死等用户:目标已知就走与掉线同一条自动重连通道(共享 5 次预算);
      // 预算还在时版面继续按心率渲染,避免"失败→眼镜→重试→心率"反复横跳。
      const willRetry = this.backspaceHandled !== true
        && this.bleTerminated !== true
        && this.pageVisible === true
        && (this.isEntryGattPhase() || this.data.surfacePhase === 'hud')
        && (this.hudReconnectCount || 0) < HUD_RECONNECT_MAX;
      this.setData({
        bleState: 'idle',
        heartDeviceName: '',
        coachLine: '心率连接失败',
        ...(this.isSearchPhase()
          ? { searchChip: '可重试', searchText: willRetry ? '自动重连中' : '点按设备重试' }
          : {}),
        ...this.hudModeFields({ connected: this.isHrUiEngaged() }),
      });
      if (willRetry) {
        this.reconnectDevice = device;
        this.scheduleHudReconnect(device);
      } else {
        this.reconnectDevice = null;
      }
      return false;
    }
  },

  // 心率源没了(GATT 断连事件 / 无数据超时):静默回眼镜,跑步不中断。
  // HUD 跑步中与 02 搜索页都自动对同一设备重连,成功即恢复——用户全程无感。
  // sourceTag 上信标(DP:evt/wd0/wd/show):真机排查"到底是谁判的断"。
  onBleDropped(reason = '', sourceTag = 'evt') {
    if (this.bleTerminated === true || this.backspaceHandled === true
        || this.isSummaryPhase()) return;
    if (this.data.bleState !== 'connected' && this.data.bleState !== 'connecting') return;
    this.bleDebug('BLE_DROPPED', 'src=' + sourceTag + (reason ? ' reason=' + reason : ''));
    this.markBeacon('DP:' + sourceTag);
    // 宿主可能在 connect/startNotifications 中途派发掉线。此时 bleDevice
    // 尚未提交，仍必须保留 connecting/reconnect 目标以便后续自动恢复。
    const droppedDevice = this.bleDevice || this.connectingDevice || this.reconnectDevice;
    this.teardownBle();
    const hudRunning = this.data.surfacePhase === 'hud' && this.data.running;
    const searching = this.isEntryGattPhase();
    // 会自动重连时版面保持心率态(bpm 置空):掉线-重试周期不在眼镜/心率两种版面间横跳,
    // 预算耗尽才真正落回眼镜。
    const willReconnect = (hudRunning || searching) && droppedDevice != null
      && (this.hudReconnectCount || 0) < HUD_RECONNECT_MAX;
    this.reconnectDevice = willReconnect ? droppedDevice : null;
    this.setData({
      bleState: 'idle',
      bpm: '',
      heartDeviceName: '',
      ...heartZoneDotFields(0),
      ...(hudRunning ? { coachLine: '心率重连中' } : (reason ? { coachLine: reason } : {})),
      ...(searching ? { searchChip: '已断开', searchText: '自动重连中' } : {}),
      ...this.hudModeFields({ connected: this.isHrUiEngaged() }),
    });
    this.setDiscoveredDeviceStatus(droppedDevice, '已断开');
    if (willReconnect) this.scheduleHudReconnect(droppedDevice);
  },

  clearHudReconnectTimer() {
    if (this.hudReconnectTimer) clearTimeout(this.hudReconnectTimer);
    this.hudReconnectTimer = null;
  },

  scheduleHudReconnect(device) {
    if (this.bleTerminated === true || this.backspaceHandled === true) return;
    const target = device || this.reconnectDevice;
    if (!target) return;
    this.reconnectDevice = target;
    // blur 只暂停新的原生桥调用，不消耗重连预算，也不丢目标。
    // onHostFocus 会在 HUD/入场相位精确重排一次。
    if (this.hostFocused === false || !this.pageVisible) return false;
    if ((this.hudReconnectCount || 0) >= HUD_RECONNECT_MAX) {
      // 预算耗尽:此刻才真正放弃心率版面,落回眼镜。
      this.bleDebug('HUD_RECONNECT', 'budget-exhausted');
      this.reconnectDevice = null;
      this.setData({
        coachLine: '',
        ...this.hudModeFields({ connected: this.isHrUiEngaged() }),
        ...(this.isSearchPhase()
          ? { searchText: '单击开始搜索心率设备' }
          : {}),
      });
      return;
    }
    this.clearHudReconnectTimer();
    this.hudReconnectTimer = setTimeout(() => {
      this.hudReconnectTimer = null;
      if (this.bleTerminated === true || this.backspaceHandled === true) {
        this.reconnectDevice = null;
        return;
      }
      // 息屏期定时器不消费也不放弃:onShow 会重排。
      if (!this.pageVisible || this.hostFocused === false) return;
      const phase = this.data.surfacePhase;
      const hudRunning = phase === 'hud' && this.data.running;
      const searching = this.isEntryGattPhase();
      if (!hudRunning && !searching) { this.reconnectDevice = null; return; }
      if (this.data.bleState === 'connected') { this.reconnectDevice = null; return; }
      // 用户手动开扫/开连时让位重排(不耗预算),绝不吞掉仅有的一枚定时器。
      if (this.data.bleState !== 'idle') { this.scheduleHudReconnect(target); return; }
      this.hudReconnectCount = (this.hudReconnectCount || 0) + 1;
      this.bleDebug('HUD_RECONNECT', 'attempt=' + this.hudReconnectCount);
      this.connectSelected(target)
        .then((ok) => { if (!ok) this.scheduleHudReconnect(target); })
        .catch(() => { this.scheduleHudReconnect(target); });
    }, HUD_RECONNECT_DELAY_MS);
  },





  // 02 在 onReady（或真机 onShow 兼容兜底）后只标记可交互；真实搜索始终由用户
  // 点“开始搜索”发起，也永远不因结果自动推进。

  // “开始搜索”：与官方 bluetooth 样例一致的手动启动路径——用户手势本身
  // 就是真机验证过的扫描前提，也顺带证明视图已可交互。

  // “下一步”：菜单流程先完成设备配置并停扫，再进入跑前热身；诊断深链保持
  // 既有直接入场能力。找到与否都不阻塞，扫描只属于“开始搜索”。
  onConnectTap() {
    if (this.hostFocused === false || !this.pageVisible) return false;
    // Next 是扫描生命周期的终点。失败退避即使有相位守卫也要同步取消，避免
    // HUD 已开始后仍残留一枚无意义的重试定时器。
    this.clearScanRetryTimer();
    if (this.preRunRequiredAfterSearch === true) {
      if (this.entrySequenceStarted || !this.isSearchPhase()) return false;
      this.entrySequenceStarted = true;
      const generation = this.surfaceGeneration;
      const lifecycleGeneration = this.bleLifecycleGeneration;
      const beginWarmup = () => {
        if (generation !== this.surfaceGeneration
            || lifecycleGeneration !== this.bleLifecycleGeneration
            || this.entrySequenceStarted !== true
            || !this.isSearchPhase()
            || this.agentExitRequested
            || this.backspaceHandled
            || !this.pageVisible
            || this.hostFocused === false) return false;
        this.autoConnectBestCandidate({ scanAlreadyStopped: true });
        return this.startPreRunGuide();
      };
      if (this.scanSession || this.data.bleState === 'scanning') {
        Promise.resolve(this.stopScan()).then(beginWarmup).catch(() => {
          if (generation === this.surfaceGeneration) this.entrySequenceStarted = false;
        });
        return true;
      }
      return beginWarmup();
    }
    this.autoConnectBestCandidate();
    return this.proceedToHud();
  },

  autoConnectBestCandidate(options = {}) {
    if (!this.isBleHostInteractive()) return false;
    if (this.data.bleState === 'connecting' || this.data.bleState === 'connected') return false;
    if (this.autoConnectPending === true) return false;
    const order = this.discoveredDeviceOrder || [];
    if (!order.length) return false;
    const refs = this.discoveredDeviceRefs || {};
    const preferred = readHeartRateDevice(wx);
    let pick = null;
    for (const key of order) {
      const record = refs[key];
      if (record && record.device && matchesHeartRateDevice(record.device, preferred)) {
        pick = record.device;
        break;
      }
    }
    // 自动连接和“下一步”的隐式选择都只认已经记住的稳定 ID。首选不在场时
    // 继续纯眼镜流程；用户仍可明确点另一台设备行来改选并在成功后记住它。
    if (!pick && preferred && preferred.deviceId) return false;
    if (!pick) {
      const first = refs[order[0]];
      pick = first && first.device;
    }
    if (!pick) return false;
    const selectionGeneration = this.beginBleSelection('auto');
    this.markBeacon('AC');
    // 先记住目标再等原生停扫：若 stop 收尾的 250ms 内 InkView 被短暂隐藏，
    // connectSelected 会因不可交互而拒绝；亮屏后仍能凭该目标重排，不丢掉智能入场。
    this.reconnectDevice = pick;
    this.selectedDeviceKey = this.discoveredDeviceKey(pick);
    this.syncDiscoveredDevices();
    this.autoConnectPending = true;
    this.autoConnectSelectionGeneration = selectionGeneration;
    const run = async () => {
      if (options.scanAlreadyStopped !== true) await this.stopScan();
      if (!this.isBleHostInteractive()
          || !this.isBleSelectionCurrent(selectionGeneration)) return false;
      return this.connectSelected(pick, {
        selectionGeneration,
        selectionSource: 'auto',
      });
    };
    run().catch(() => false).then(() => {
      if (this.autoConnectSelectionGeneration === selectionGeneration) {
        this.autoConnectPending = false;
        this.autoConnectSelectionGeneration = null;
      }
    });
    return true;
  },

  proceedToHud(options = {}) {
    if (this.entrySequenceCompleted || this.data.surfacePhase === 'hud') return false;
    return this.finishEntry(this.surfaceGeneration, options);
  },



  showConnectedResult(bpm, deviceName = '') {
    const value = Number(bpm);
    if (!Number.isFinite(value) || value <= 0 || value >= 255) return;
    this.connectedHeartName = deviceName || this.connectedHeartName || '心率设备';
    if (!this.session) this.pendingEntryBpm = value;
    if (this.isSearchPhase()) {
      this.setData({
        ...this.runEntryCopy('connected'),
        searchChip: '已连接',
      });
    }
  },

  // 连接是否"活着"(结构性检查,不含数据新鲜度):活连接必须直接进心率版面,
  // 数字随首包/新包到位——绝不先渲染无心率版面再跳变。
  isHrLinkLive() {
    return this.data.bleState === 'connected'
      && !!this.hrCharacteristic
      && !!this.hrListener
      && !!this.bleDevice
      && !!this.bleDevice.gatt
      && this.bleDevice.gatt.connected !== false;
  },

  // 版面判定(最简数据驱动):只看"最近 15s 是否收到过有效心率包"。
  // 有数据就是心率版面,没数据就是眼镜版面;连接/重连机制只负责恢复数据流,不碰 UI。
  isHrUiFresh(now = Date.now()) {
    return this.lastHrUiAtMs != null && now - this.lastHrUiAtMs <= HR_UI_HOLD_MS;
  },

  // 单向棘轮:跟着入场状态起步;跑步中心率数据一旦到过就永久心率版面,
  // 中间断了只置空数字,绝不中途降级回眼镜——整场最多一次向上切换,零横跳。
  isHrUiEngaged(now = Date.now()) {
    return this.data.showHeartRate === true || this.isHrUiFresh(now);
  },

  hasFreshConnectedEntryBpm(bpm, now = Date.now()) {
    const value = Number(bpm);
    return this.data.bleState === 'connected'
      && !!this.hrCharacteristic
      && !!this.hrListener
      && !!this.bleDevice
      && !!this.bleDevice.gatt
      // 真机宿主的 gatt 对象可能不暴露 connected 属性(undefined)——严格 ===true
      // 会把活连接误判为未连接,导致"先无心率入场再跳成有心率"的割裂。
      && this.bleDevice.gatt.connected !== false
      && Number.isFinite(value) && value > 0 && value < 255
      && this.lastHrAtMs != null
      && now - this.lastHrAtMs >= 0
      && now - this.lastHrAtMs <= HR_STALE_MS;
  },

  finishEntry(generation, options = {}) {
    const fromSearch = this.data.surfacePhase === 'ready'
      || this.data.surfacePhase === 'connecting';
    const fromWarmup = this.data.surfacePhase === 'pre_run'
      && this.entrySequenceStarted === true;
    if (generation !== this.surfaceGeneration || (!fromSearch && !fromWarmup)) return false;
    if (fromWarmup) {
      this.cancelRecoveryTts();
      this.cancelRecoveryCountdown({ reset: true });
    }
    this.clearScanRetryTimer();
    const entryBpm = Number(this.pendingEntryBpm);
    // 数据驱动:02 已有心率数据在流(已连接再按下一步的典型场景)就直接心率版面;
    // 首包未到则先眼镜版面,数据到达后 tick 原位换上。
    const entryLinkLive = this.isHrUiFresh();
    const entryHeartRateLive = this.hasFreshConnectedEntryBpm(entryBpm);
    const entryZone = this.runHeartRateZone(entryHeartRateLive ? entryBpm : 0);
    if (!entryHeartRateLive) this.pendingEntryBpm = null;
    this.setData({
      surfacePhase: 'hud',
      runMode: this.persistedRunMode(),
      hudHint: '',
      safetyHudHint: '',
      paceConnected: false,
      ...heartZoneDotFields(entryZone),
      // 版面跟随活连接:连接在手就直接心率版面(数字随首包到位),
      // 绝不先渲染眼镜版面再在 1s 后跳成心率版面。
      ...(entryLinkLive ? {
        bpm: entryHeartRateLive ? formatBpm(entryBpm) : '',
        showHeartRate: true,
        ...this.hudModeFields({ connected: true }),
      } : { showHeartRate: false }),
    });
    this.hudEnteredAtMs = Date.now();
    // 进入跑步页立即停扫省电:持续 BLE 扫描是眼镜第一耗电大户,原实现会跟着
    // 跑完一整场。心率入口从此只剩已建立的连接与已知设备的自动重连。
    if (this.scanSession || this.data.bleState === 'scanning') this.stopScan();
    // 相变已提交后才落棘轮；此前任何一步抛错都必须让下一次点击仍可推进,
    // 否则设备端一次异常就把"下一步"永久变哑(02 可见但完成位已置真)。
    this.entrySequenceCompleted = true;
    try {
      if (!this.data.running) this.startRun();
    } catch (error) {
      this.bleDebug('ENTRY_RUN_ERROR', 'reason=' + this.bleErrorText(error));
      // 计划断点、owner 或本地存储读取失败时绝不能悄悄降级成一场自由跑，
      // 也不能把已经存在的 execution 覆盖掉。保留 BLE 连接和当前计划，
      // 搜索后的热身已经完成时停在原页重试；兼容深链仍回同一个“下一步”入口。
      this.stopTicker();
      this.stopAccel();
      this.stopMetronomePlayback();
      this.entrySequenceCompleted = false;
      this.hudEnteredAtMs = null;
      this.session = null;
      this.calibrationStream = null;
      this.calibrationCaptureBuffer = [];
      this.motionMetrics = null;
      this.workoutExecution = null;
      this.completedWorkoutExecution = null;
      if (fromWarmup) this.recoveryGuideCompleted = true;
      this.setData({
        surfacePhase: fromWarmup ? 'pre_run' : 'ready',
        running: false,
        paused: false,
        ...(fromWarmup ? {
          recoveryCountdown: '完成',
          recoveryCountdownUnit: '',
          recoveryAutoHint: '训练记录读取失败 · 请再次确认',
          recoveryActionLabel: '重试开跑',
        } : {
          primaryLabel: '下一步',
          searchText: '训练记录读取失败',
          searchChip: '请重试',
          scanDiagnostic: '本地存储暂不可用 · 再按下一步重试',
          scanProgressText: '未开始',
        }),
        workoutActive: !!this.activeWorkoutPlan,
        workoutStageLabel: this.activeWorkoutPlan
          ? String(this.activeWorkoutPlan.title || '今日训练') : '',
        workoutProgressText: this.activeWorkoutPlan
          ? this.todayWorkoutDetail(this.activeWorkoutPlan) : '',
      });
      return false;
    }
    if (fromWarmup) {
      this.timedGuideKind = null;
      this.preRunRequiredAfterSearch = false;
    }
    // startRun freezes the exact owner policy. Re-apply the entry dots in the
    // same user action so a BPM already flowing on 02 never shows the old
    // generic 190-based zone or waits one ticker before becoming consistent.
    this.setData({
      ...heartZoneDotFields(this.runHeartRateZone(
        entryHeartRateLive ? entryBpm : 0,
      )),
    });
    if (options.suppressStartCue === true) {
      // 自动归零前已在播较慢的“三、二、一”；不要立刻用另一条 TTS
      // 抢占最后一个数字。HUD 与跑步计时照常同步启动。
      this.startCuePlayed = true;
    } else if (!this.startCuePlayed
        && (!this.runSettings || this.runSettings.voiceCue !== false)) {
      this.startCuePlayed = true;
      try {
        this.playCueTts(this.isSlowJogMode()
          ? '超慢跑开始。原地小步，轻落地，保持轻松呼吸。'
          : START_CUE);
      } catch (_e) {}
    }
    return true;
  },

  // ── 跑步会话 ────────────────────────────────────────────────
  clearLivePaceState(now = Date.now()) {
    if (this.speedFusion) this.speedFusion.reset(now);
    this.lastCrediblePaceSec = null;
    this.lastCrediblePaceAtMs = null;
  },

  adaptiveStrideOwnerMarker() {
    const marker = (this.runOwnerGeneration || 0) > 0
      ? this.runOwnerContext : this.deviceIdentityCache;
    const ownershipEpoch = Number(marker && marker.ownershipEpoch);
    const dataNamespace = marker && typeof marker.dataNamespace === 'string'
      ? marker.dataNamespace.trim() : '';
    if (!Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 0
        || !dataNamespace || dataNamespace.length > 220) return null;
    // 只保存服务端给出的不透明 owner marker，不保存数据库用户主键或原始轨迹。
    return String(ownershipEpoch) + ':' + dataNamespace;
  },

  createAdaptiveStrideModel() {
    const options = {
      manualStepLengthM: this.runStrideM || DEFAULT_STRIDE_M,
      ownerMarker: this.adaptiveStrideOwnerMarker(),
    };
    let stored = null;
    if (this.ownerScopedRunWriteAllowed()) {
      try { stored = wx.getStorageSync(ADAPTIVE_STRIDE_STORAGE_KEY); } catch (_e) {}
    }
    if (stored && typeof stored === 'object') {
      return AdaptiveStrideModel.restore(stored, options);
    }
    return new AdaptiveStrideModel(options);
  },

  persistAdaptiveStrideModel() {
    const model = this.adaptiveStrideModel;
    // 服务器 owner marker 尚未落盘时只允许本场内存学习；不能把匿名、待绑定
    // 或归属不明的派生模型写成跨会话共享数据。
    if (!model || !model.ownerMarker || !this.ownerScopedRunWriteAllowed()) return false;
    if (model.ownerMarker !== this.adaptiveStrideOwnerMarker()) return false;
    try {
      const serialized = model.serialize();
      wx.setStorageSync(ADAPTIVE_STRIDE_STORAGE_KEY, serialized);
      const roundTrip = wx.getStorageSync(ADAPTIVE_STRIDE_STORAGE_KEY);
      const persisted = !!(roundTrip
        && roundTrip.version === serialized.version
        && roundTrip.ownerMarker === serialized.ownerMarker);
      if (!persisted) return false;
      for (const legacyKey of ADAPTIVE_STRIDE_LEGACY_STORAGE_KEYS) {
        wx.removeStorageSync(legacyKey);
        let legacyValue = wx.getStorageSync(legacyKey);
        if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
          // 兼容 removeStorageSync 被旧宿主静默吞掉的情况；类型安全空值可
          // 阻止回滚包把已经判定有污染风险的 v1 模型重新载入。
          wx.setStorageSync(legacyKey, '');
          legacyValue = wx.getStorageSync(legacyKey);
        }
        if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
          return false;
        }
      }
      return true;
    } catch (_e) {
      return false;
    }
  },

  resetStrideCalibration() {
    this.strideCalibration = {
      rsc: null,
    };
  },

  resetRscStrideCalibration() {
    const state = this.strideCalibration || { rsc: null };
    state.rsc = null;
    this.strideCalibration = state;
  },

  observeRscStrideCalibration(measurement, metricResult, nowMs) {
    const metrics = this.motionMetrics;
    const model = this.adaptiveStrideModel;
    if (!metrics || !model || metrics.paused || !Number.isFinite(nowMs)) {
      this.resetRscStrideCalibration();
      return false;
    }
    if (!metricResult || metricResult.accepted !== true) return false;

    const cadenceSpm = Number(measurement && measurement.cadenceSpm);
    const speedMps = Number(measurement && measurement.speedMps);
    // 仅正速度 + 正双脚总步频构成 RSC 步长学习证据。0/0 是停止边沿，
    // 正速度 + 0 步频是矛盾尾包；两者都必须切断旧学习窗口。
    if (!(Number.isFinite(cadenceSpm) && cadenceSpm >= 60 && cadenceSpm <= 260)
        || !(Number.isFinite(speedMps) && speedMps > 0)
        || metricResult.incoherentSpeed === true) {
      this.resetRscStrideCalibration();
      return false;
    }

    const state = this.strideCalibration || { rsc: null };
    let slot = state.rsc;
    const createAnchor = () => ({
      lastMs: nowMs,
      lastCadenceSpm: cadenceSpm,
      steps: 0,
      distanceM: 0,
      durationMs: 0,
      trusted: true,
      qualityScore: 1,
      lastDistanceSource: null,
    });
    if (!slot || !Number.isFinite(slot.lastMs)
        || nowMs <= slot.lastMs
        || nowMs - slot.lastMs > RSC_FRESH_MS) {
      // 首包、乱序或断流后的首包只建 cadence 锚点；同包即使携带累计
      // 距离也不能把断流前后两段拼成一个学习窗口。
      state.rsc = createAnchor();
      this.strideCalibration = state;
      return false;
    }

    const dtMs = nowMs - slot.lastMs;
    slot.steps += (slot.lastCadenceSpm + cadenceSpm) * 0.5 * dtMs / 60000;
    slot.durationMs += dtMs;
    slot.lastMs = nowMs;
    slot.lastCadenceSpm = cadenceSpm;

    const distanceAddedM = Number(metricResult.distanceAddedM);
    const distanceSource = metricResult.distanceSource;
    if (Number.isFinite(distanceAddedM) && distanceAddedM > 0
        && (distanceSource === MOTION_SOURCE.RSC_SPEED
          || distanceSource === MOTION_SOURCE.RSC_TOTAL_DISTANCE)) {
      slot.distanceM += distanceAddedM;
      slot.lastDistanceSource = distanceSource;
      const trustedPacket = distanceSource === MOTION_SOURCE.RSC_TOTAL_DISTANCE
        || (metricResult.speedAccepted === true
          && metricResult.outlierRejected !== true);
      slot.trusted = slot.trusted && trustedPacket;
      slot.qualityScore = Math.min(
        slot.qualityScore,
        trustedPacket ? 0.95 : 0,
      );
    }

    state.rsc = slot;
    this.strideCalibration = state;
    if (!(slot.durationMs >= 8000
        && slot.steps >= 20
        && slot.distanceM >= 12)) return false;

    const learnedCadenceSpm = slot.steps * 60000 / slot.durationMs;
    const result = model.observeWindow({
      cadenceSpm: learnedCadenceSpm,
      steps: slot.steps,
      distanceM: slot.distanceM,
      durationMs: slot.durationMs,
      source: slot.lastDistanceSource || MOTION_SOURCE.RSC_SPEED,
      trusted: slot.trusted === true,
      qualityScore: slot.qualityScore,
    });
    // 不论模型接受还是拒绝，当前包都成为下一学习窗的 cadence 锚点，
    // 不重复使用已经提交过的步数或距离。
    state.rsc = createAnchor();
    this.strideCalibration = state;
    if (!result || result.accepted !== true) return false;
    this.applyAdaptiveStride(learnedCadenceSpm);
    this.persistAdaptiveStrideModel();
    console.log(
      '[SmartRun Motion] STRIDE_LEARNED source=rsc cadence='
        + Math.round(learnedCadenceSpm)
        + ' step=' + this.activeStepLengthM.toFixed(3),
    );
    return true;
  },

  applyAdaptiveStride(cadenceSpm) {
    const model = this.adaptiveStrideModel;
    const configuredStepLengthM = this.runStrideM || DEFAULT_STRIDE_M;
    const estimate = model
      ? model.estimate(Number(cadenceSpm))
      : {
          stepLengthM: configuredStepLengthM,
          confidence: 0,
          learned: false,
          source: 'manual',
        };
    const stepLengthM = effectiveImuStepLengthM(
      configuredStepLengthM,
      cadenceSpm,
      estimate,
    );
    if (Number.isFinite(stepLengthM) && stepLengthM > 0) {
      this.activeStepLengthM = stepLengthM;
      if (this.motionMetrics) this.motionMetrics.setStepLengthM(stepLengthM);
      if (this.stepDet) this.stepDet.strideM = stepLengthM;
      if (this.magnitudeStepDet) this.magnitudeStepDet.strideM = stepLengthM;
    }
    return {
      ...estimate,
      stepLengthM,
      imuCapped: stepLengthM + 0.0001
        < Number(estimate && estimate.stepLengthM),
    };
  },

  startRun() {
    if (this.data.running) return;
    const startupArchive = this.settleImmersiveStartupSummaryArchive();
    if (!startupArchive.ok) {
      this.setData({ hudHint: '正在恢复上次记录 · 请重试' });
      throw new Error('startup-summary-archive-' + String(startupArchive.status));
    }
    this.resetHudEndConfirmation();
    this.pinRunOwnerContextForStart();
    const startMs = Date.now();
    this.freezeHeartRatePolicyForRun(startMs);
    this.calibrationStream = createAiuiCalibrationStream(startMs);
    this.calibrationCaptureBuffer = [];
    this.lastCalibrationDiagnostics = null;
    this.session = new RunSession(startMs);
    // 页面实例理论上只承载一场跑步，但 owner 迁移/开发宿主可能复用同一路由。
    // 新会话必须重新建立约 1Hz 的等时步频采样锚点，不能继承上一场的时钟。
    this.lastSessionCadenceSampleAtMs = null;
    const entryBpm = Number(this.pendingEntryBpm);
    if (this.hasFreshConnectedEntryBpm(entryBpm)) this.session.onHeartRate(entryBpm);
    this.pendingEntryBpm = null;
    this.stepDet = new StepDetector({
      strideM: this.runStrideM || DEFAULT_STRIDE_M,
      ...PROJECTED_STEP_OPTIONS,
    });
    this.magnitudeStepDet = new StepDetector({
      strideM: this.runStrideM || DEFAULT_STRIDE_M,
    });
    this.dualStepArbiter = new DualStepArbiter();
    this.lowRateImuStepDetector = new LowRateImuStepDetector();
    this.lastImuCandidateAcceptedAtMs = null;
    this.sensorAlignment = new SensorAlignment({
      // 1g 与 9.80665m/s² 相差近十倍。真机用户可能确认后立即起跑，
      // 因此页面允许带跑动波形的稳健中值完成单位识别，而不是强迫静止校准。
      acceleration: {
        // 录屏/系统浮层可能把请求的 50Hz best-effort 降到约 8–12Hz。
        // 用更长的时间窗收足真实样本，避免 1.2s 窗内永远凑不齐默认 16 帧；
        // 仍要求至少 10 个互不重复样本和 800ms 覆盖，5Hz 以下不会借此
        // 绕过后续运动质量/活动确认门。
        windowMs: 2400,
        minWindowMs: 800,
        minSamples: 10,
        maxRelativeDeviation: 0.28,
        maxRelativeRange: 0.9,
      },
    });
    this.motionQuality = new MotionQualityGate();
    this.imuActivityGate = new ImuActivityGate();
    this.accelerationCalibrationLogged = false;
    this.accelerationScaleToMps2 = 1;
    this.speedFusion = new MotionSpeedFusion();
    this.adaptiveStrideModel = this.createAdaptiveStrideModel();
    // v2 即使尚未学到样本也立即落盘并清理 v1，避免回滚旧包复活已经可能
    // 被定位漂移污染的个人化步长。
    this.persistAdaptiveStrideModel();
    this.activeStepLengthM = effectiveImuStepLengthM(
      this.runStrideM || DEFAULT_STRIDE_M,
      0,
    );
    this.lastImuFusionAtMs = null;
    this.lastStationaryFusionAtMs = null;
    this.orientationProjectionLogged = false;
    this.motionDiagnostics = {
      samples: 0,
      projectedSteps: 0,
      magnitudeSteps: 0,
      lowRateSteps: 0,
      candidateSteps: 0,
      acceptedSteps: 0,
      lastReason: 'start',
      lastReportMs: startMs,
      cadenceLogged: false,
    };
    this.lastHudMotionReportMs = startMs;
    this.resetStrideCalibration();
    this.motionMetrics = new MotionMetrics({
      startMs,
      stepLengthM: this.runStrideM || DEFAULT_STRIDE_M,
      // 超慢跑是原地训练：只统计真实 IMU 落步、步频与心率，不把原地
      // 震动换算成不存在的位移。自由跑和室内跑仍使用统一距离账本。
      trackDistance: !this.isSlowJogMode(),
      rscFreshMs: RSC_FRESH_MS,
    });
    const workoutExecutionRequired = !!this.activeWorkoutPlan;
    const preparedWorkoutExecution = this.prepareWorkoutExecution(
      startMs,
      this.motionMetrics.snapshot(startMs).distanceM,
    );
    if (workoutExecutionRequired && !preparedWorkoutExecution) {
      const error = new Error('Workout execution could not be prepared');
      error.code = 'WORKOUT_EXECUTION_PREPARE_FAILED';
      throw error;
    }
    const localFieldStarted = this.beginRunningLocalFieldCapture(startMs);
    // 搜索/热身发生在现场日志正式开场之前。开跑当刻补一组不含设备 ID/名称
    // 的连接基线，确保 12 小时档案能判断“从 HRS-only、已订阅 RSC，还是
    // 已收到真实 2A53 数据起跑”，而不需要回放任何隐私字段。
    if (localFieldStarted && this.data.bleState === 'connected'
        && this.hrCharacteristic) {
      this.recordRunningLocalFieldEvent('ble', 'HRS_CONNECTED_AT_START', {
        atMs: startMs,
        reason: 'run_start',
      });
    }
    if (localFieldStarted && !this.isSlowJogMode() && this.rscCharacteristic) {
      this.recordRunningLocalFieldEvent('ble', 'RSC_SUBSCRIBED_AT_START', {
        atMs: startMs,
        reason: 'run_start',
      });
      if (this.isRscDataFresh(startMs)) {
        this.recordRunningLocalFieldEvent('ble', 'RSC_LIVE_AT_START', {
          atMs: startMs,
          reason: 'run_start',
        });
      }
    }
    this.applyAdaptiveStride(0);
    if (!this.isSlowJogMode()
        && this.pendingRscMeasurement && this.isRscDataFresh(startMs)) {
      // 搜索页刚收到的最后一包只用于建立 RSC 基线，不补记开跑前的距离。
      // 必须仍处在真实通知的新鲜期内；订阅成功或历史正速度都不能在开跑时
      // 被重新包装成“刚收到”，否则会短暂压住本应立即接管的眼镜 IMU。
      this.motionMetrics.onRscMeasurement(this.pendingRscMeasurement, startMs);
    } else if (this.pendingRscMeasurement) {
      this.pendingRscMeasurement = null;
      this.rscLive = false;
      this.bleDebug('RSC_SILENT', 'since=pre-run action=imu-fallback');
    }
    this.prevCue = null;
    this.paceEverReady = false;
    this.cadenceEverReady = false;
    this.lastCrediblePaceSec = null;
    this.lastCrediblePaceAtMs = null;
    this.lastDisplayedPaceSec = null;
    this.lastDisplayedCadenceSpm = null;
    this.lastDisplayedCadenceAtMs = null;
    this.runWarmupPending = true;
    this.runWarmupMotionAtMs = null;
    this.minuteSeries = [];
    this.lastMinuteSample = 0;
    this.minuteMetricAnchor = { elapsedMs: 0, distanceM: 0 };
    this.minuteCadenceSum = 0;
    this.minuteCadenceCount = 0;
    this.autoPausedByHide = false;
    const initialPace = formatPace(null);
    this.setData({
      running: true,
      paused: false,
      paceConnected: false,
      pace: initialPace,
      cadence: CADENCE_PENDING,
      runWarmupHint: this.isSlowJogMode()
        ? '原地小步，稳定约 5 秒' : RUN_STABILIZE_HINT,
      slowStepCount: '0',
      slowHeartRate: '--',
      slowCoachLine: '原地小步 · 轻落地 · 保持轻松呼吸',
      paceMod: unifiedPaceMod(initialPace),
      paceStateClass: '',
      ...this.workoutHudFields(),
    });
    // 先提交 running 状态再启动传感器。这样构造/首帧失败时有界恢复器能
    // 立即确认当前确实是可见 HUD，而不会因 setData 尚未提交误判成后台。
    this.startAccel();
    // 保留开跑即播放的产品行为；候选振动由独立活动确认门隔离，不能用
    // 关闭音频来掩盖计步误判。
    this.startRunMetronome();
    if (this.imuOk === false) {
      this.setData({
        coachLine: '眼镜计时中',
        // IMU 降级只影响步频/距离,不得改写棘轮化的心率版面判定。
        ...this.hudModeFields({ connected: this.isHrUiEngaged() }),
      });
    }
    this.startTicker();
  },

  prepareWorkoutExecution(startMs, initialDistanceM = 0) {
    const plan = this.activeWorkoutPlan;
    const localPreset = !!this.activeLocalTrainingPresetId;
    const owner = localPreset ? LOCAL_TRAINING_OWNER : this.runOwnerContext;
    if (!plan || !owner || (!localPreset && owner.kind === 'preidentity')) {
      this.workoutExecution = null;
      return null;
    }
    let execution = localPreset ? null : readWorkoutExecutionCheckpoint(
      wx,
      owner,
      normalizeWorkoutExecution,
    );
    const samePlan = !!(execution
      && execution.plan
      && execution.plan.plan_id === plan.plan_id
      && execution.plan.plan_session_id === plan.plan_session_id
      && execution.plan.workout_id === plan.workout_id
      && execution.plan.revision === plan.revision
      && execution.status !== 'finished');
    if (samePlan) {
      execution = restoreWorkoutExecution(execution, owner, startMs);
      if (execution.status === 'paused') {
        execution = advanceWorkoutExecution(execution, {
          type: 'resume',
          nowMs: startMs,
        });
      }
    } else {
      execution = createWorkoutExecution(plan, owner, {
        nowMs: startMs,
        initialDistanceM,
      });
    }
    if (!execution) {
      this.activeWorkoutPlan = null;
      this.workoutExecution = null;
      this.setData({
        workoutActive: false,
        workoutStageLabel: '',
        workoutProgressText: '',
      });
      return null;
    }
    this.workoutExecution = execution;
    this.completedWorkoutExecution = null;
    this.lastWorkoutCheckpointAtMs = startMs;
    if (!localPreset
        && writeWorkoutExecutionCheckpoint(wx, execution, owner) !== true) {
      // 服务器计划的阶段进度必须先形成可读回的 durable checkpoint，才允许
      // 真正进入 HUD。部分 AIUI storage bridge 会静默吞掉写入；把这种情况
      // 当成功会让用户开跑后无法恢复阶段，甚至在重启后重复执行同一训练。
      // 保留 activeWorkoutPlan 和既有持久化证据，只撤销本次内存执行，让
      // startRun/finishEntry 回到同一个“下一步”入口重试，绝不降级自由跑。
      this.workoutExecution = null;
      this.completedWorkoutExecution = null;
      return null;
    }
    return execution;
  },

  workoutIntensityHint(metrics = {}) {
    const execution = this.workoutExecution;
    const stage = execution && execution.plan && execution.plan.stages
      ? execution.plan.stages[execution.stage_index] : null;
    if (!stage || execution.status !== 'running') return '';
    // 安全优先：心率超区间（尤其 Z5）不得被“配速合适”或步频提示遮住。
    // 只有心率在区间内时，才继续给出配速/步频反馈。
    const heartZone = Number(metrics.heartZone);
    const zoneMin = Number(stage.heart_zone_min);
    const zoneMax = Number(stage.heart_zone_max);
    const policyConfidence = heartRatePolicyConfidence(this.frozenHeartRatePolicy);
    if (policyConfidence === 'trusted') {
      if (heartZone >= 5) return '心率过高 · 请降速';
      if (heartZone > 0 && zoneMax > 0 && heartZone > zoneMax) return '心率偏高';
      if (heartZone > 0 && zoneMin > 0 && heartZone < zoneMin) return '心率偏低';
    }
    if (this.runHeartRateHigh(metrics.bpm)) return '心率偏高 · 请降速';
    const paceSec = Number(metrics.paceSec);
    const paceMin = Number(stage.pace_min_sec_per_km);
    const paceMax = Number(stage.pace_max_sec_per_km);
    if (paceSec > 0 && paceMin > 0 && paceSec < paceMin) return '配速偏快';
    if (paceSec > 0 && paceMax > 0 && paceSec > paceMax) return '配速偏慢';
    if (paceSec > 0 && (paceMin > 0 || paceMax > 0)) return '配速合适';
    const cadence = Number(metrics.cadenceSpm);
    const cadenceMin = Number(stage.cadence_min_spm);
    const cadenceMax = Number(stage.cadence_max_spm);
    if (cadence > 0 && cadenceMin > 0 && cadence < cadenceMin) return '步频偏低';
    if (cadence > 0 && cadenceMax > 0 && cadence > cadenceMax) return '步频偏高';
    if (cadence > 0 && (cadenceMin > 0 || cadenceMax > 0)) return '节奏合适';
    if (policyConfidence === 'trusted'
        && heartZone > 0 && (zoneMin > 0 || zoneMax > 0)) return '强度合适';
    return '';
  },

  workoutHudFields(metrics = {}) {
    const progress = workoutProgressView(this.workoutExecution);
    if (!progress) {
      return {
        workoutActive: false,
        workoutStageLabel: '',
        workoutProgressText: '',
      };
    }
    const shortTitle = String(progress.stageTitle || '训练').slice(0, 6);
    const stageLabel = String(progress.stageNumber) + '/'
      + String(progress.stageCount) + ' ' + shortTitle;
    const intensityHint = this.workoutIntensityHint(metrics);
    const progressText = progress.planComplete
      ? '已完成'
      : [progress.detail, intensityHint].filter(Boolean).join(' · ');
    const fields = {
      workoutActive: true,
      workoutStageLabel: stageLabel,
      workoutProgressText: progressText,
    };
    if (progress.finalPromptPending
        && this.endArmedAtMs == null
        && this.data.hudHint !== '再按2次结束'
        && this.data.hudHint !== '再按1次结束') {
      fields.hudHint = '训练完成 · 三按确认结束';
    }
    return fields;
  },

  persistWorkoutCheckpoint(force = false, now = Date.now()) {
    if (this.activeLocalTrainingPresetId) return true;
    if (!this.workoutExecution || !this.runOwnerContext
        || this.runOwnerContext.kind === 'preidentity') return true;
    if (!force && this.lastWorkoutCheckpointAtMs != null
        && now - this.lastWorkoutCheckpointAtMs < 5000) return true;
    const stored = writeWorkoutExecutionCheckpoint(
      wx,
      this.workoutExecution,
      this.runOwnerContext,
    );
    if (stored) this.lastWorkoutCheckpointAtMs = now;
    return stored;
  },

  advanceWorkoutClock(now, metrics = {}) {
    if (!this.workoutExecution || this.workoutExecution.status === 'finished') {
      return this.workoutHudFields();
    }
    const previousStage = this.workoutExecution.stage_index;
    const previousStatus = this.workoutExecution.status;
    this.workoutExecution = advanceWorkoutExecution(this.workoutExecution, {
      type: 'tick',
      nowMs: now,
      bpm: metrics.bpm,
      cadenceSpm: metrics.cadenceSpm,
    });
    const changed = previousStage !== this.workoutExecution.stage_index
      || previousStatus !== this.workoutExecution.status;
    this.persistWorkoutCheckpoint(changed, now);
    if (changed && this.workoutExecution.status === 'running') {
      const next = workoutProgressView(this.workoutExecution);
      if (next && next.stageTitle) this.playCueTts('进入' + String(next.stageTitle));
    }
    return this.workoutHudFields(metrics);
  },

  advanceWorkoutDistance(now, motion) {
    if (!this.workoutExecution || !motion
        || this.workoutExecution.status !== 'running') return false;
    const distanceM = Number(motion.distanceM);
    if (!Number.isFinite(distanceM) || distanceM < 0) return false;
    const previousStage = this.workoutExecution.stage_index;
    const previousStatus = this.workoutExecution.status;
    this.workoutExecution = advanceWorkoutExecution(this.workoutExecution, {
      type: 'distance',
      nowMs: now,
      distanceM,
      // MotionMetrics is already the single source-independent ledger.
      ledgerId: 'motion-ledger-v1',
    });
    const changed = previousStage !== this.workoutExecution.stage_index
      || previousStatus !== this.workoutExecution.status;
    if (changed) {
      this.persistWorkoutCheckpoint(true, now);
      this.setData(this.workoutHudFields());
    }
    return true;
  },

  pauseWorkoutExecution(reason, now = Date.now()) {
    if (!this.workoutExecution || this.workoutExecution.status === 'finished') return;
    this.workoutExecution = advanceWorkoutExecution(this.workoutExecution, {
      type: reason === 'hide' ? 'hide' : 'pause',
      nowMs: now,
    });
    this.persistWorkoutCheckpoint(true, now);
  },

  resumeWorkoutExecution(reason, now = Date.now()) {
    if (!this.workoutExecution || this.workoutExecution.status === 'finished') return;
    this.workoutExecution = advanceWorkoutExecution(this.workoutExecution, {
      type: reason === 'show' ? 'show' : 'resume',
      nowMs: now,
    });
    this.persistWorkoutCheckpoint(true, now);
  },

  hudModeFields(opts = {}) {
    const connected = opts.connected === true;
    const linked = connected || opts.linked === true;
    const deviceName = opts.deviceName || this.connectedHeartName || '心率设备';
    if (linked) {
      const policySource = this.frozenHeartRatePolicy
        ? String(this.frozenHeartRatePolicy.source || '') : '';
      const policyConfidence = heartRatePolicyConfidence(this.frozenHeartRatePolicy);
      // Reuse the existing four-character status chip rather than adding a new
      // HUD row. Age-based policy is explicitly labelled as estimated; a
      // generic/default or missing policy only claims that BPM is recorded.
      const liveLabel = (policySource === 'age_estimate'
          || policySource === 'conservative_default')
        ? '估算区间'
        : (policyConfidence === 'trusted' ? '心率接入' : '心率记录');
      return {
        modeLabel: connected ? liveLabel : '心率已连',
        modeChipClass: 'mode-chip',
        footerClass: 'coach-line',
        showHeartRate: connected,
        sourceMain: deviceName,
      };
    }
    if (this.imuOk === false) {
      return {
        modeLabel: '眼镜模式',
        modeChipClass: 'mode-chip mode-muted',
        footerClass: 'coach-line line-muted',
        showHeartRate: false,
        sourceMain: '仅计时',
      };
    }
    return {
      modeLabel: '眼镜模式',
      modeChipClass: 'mode-chip',
      footerClass: 'coach-line',
      showHeartRate: false,
      sourceMain: '眼镜估算',
    };
  },

  canRecoverImu() {
    return this.pageVisible === true
      && this.data.surfacePhase === 'hud'
      && this.data.running === true
      && this.data.paused !== true
      && !this.isSummaryPhase()
      && this.agentExitRequested !== true
      && this.backspaceHandled !== true
      && this.runFinalizationStarted !== true;
  },

  scheduleImuRecovery(reason, now = Date.now()) {
    if (!this.canRecoverImu()) {
      this.imuRecoveryDueAtMs = null;
      this.imuRecoveryReason = '';
      return false;
    }
    this.imuRecoveryAttempts = Math.max(
      1,
      Number(this.imuRecoveryAttempts || 0) + 1,
    );
    const exponent = Math.min(3, this.imuRecoveryAttempts - 1);
    const delayMs = Math.min(
      IMU_RECOVERY_MAX_DELAY_MS,
      IMU_RECOVERY_BASE_DELAY_MS * Math.pow(2, exponent),
    );
    this.imuRecoveryReason = String(reason || 'unavailable');
    this.imuRecoveryDueAtMs = now + delayMs;
    this.recordRunningLocalFieldEvent('imu', 'IMU_RECOVERY_SCHEDULED', {
      atMs: now,
      reason: this.imuRecoveryReason,
      generation: this.accelGeneration,
    });
    console.log(
      '[SmartRun Motion] ACCEL_RETRY_SCHEDULED reason='
        + this.imuRecoveryReason
        + ' attempt=' + String(this.imuRecoveryAttempts)
        + ' delayMs=' + String(delayMs),
    );
    return true;
  },

  attemptScheduledImuRecovery(now = Date.now()) {
    if (this.imuRecoveryDueAtMs == null || now < this.imuRecoveryDueAtMs) {
      return false;
    }
    if (!this.canRecoverImu()) {
      this.imuRecoveryDueAtMs = null;
      this.imuRecoveryReason = '';
      return false;
    }
    const reason = this.imuRecoveryReason || 'unavailable';
    this.imuRecoveryDueAtMs = null;
    this.imuRecoveryReason = '';
    this.startAccel('retry-' + reason);
    return true;
  },

  markImuUnavailable(reason = 'unavailable', options = {}) {
    this.stopAccel();
    this.imuOk = false;
    this.recordRunningLocalFieldEvent('imu', 'IMU_ERROR', {
      reason: String(reason || 'unavailable'),
      generation: this.accelGeneration,
    });
    console.log(
      '[SmartRun Motion] ACCEL_UNAVAILABLE reason=' + String(reason),
    );
    this.setData({
      coachLine: options.retryable === true && this.canRecoverImu()
        ? '眼镜传感器恢复中' : '眼镜计时中',
      ...this.hudModeFields({
        connected: this.data.showHeartRate,
        linked: this.data.bleState === 'connected',
      }),
    });
    if (options.retryable === true) {
      this.scheduleImuRecovery(reason);
    } else {
      this.imuRecoveryDueAtMs = null;
      this.imuRecoveryReason = '';
    }
  },

  // AIUI 0.16.1 World Awareness 只作影子诊断，不进入步频、距离或配速算法。
  // 页面通过官方 enable/disable API 管理能力生命周期；宿主注入的
  // orientationSensor 实例仍归宿主所有，SmartRun 只挂/摘自己的 listener。
  enableMotionWorldAwareness() {
    if (this.worldAwarenessEnableAttempted === true) {
      return this.worldAwarenessEnabled === true;
    }
    this.worldAwarenessEnableAttempted = true;
    if (typeof this.enableWorldAwareness !== 'function') {
      this.worldAwarenessEnableAttempted = false;
      this.worldAwarenessEnabled = false;
      return false;
    }
    const lifecycleGeneration =
      (Number(this.worldAwarenessLifecycleGeneration) || 0) + 1;
    this.worldAwarenessLifecycleGeneration = lifecycleGeneration;
    try {
      const result = this.enableWorldAwareness({ mode: 'normal' });
      this.worldAwarenessEnabled = true;
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          if (this.worldAwarenessLifecycleGeneration !== lifecycleGeneration) return;
          this.worldAwarenessEnabled = false;
          this.worldAwarenessEnableAttempted = false;
          console.log(
            '[SmartRun Motion] WORLD_AWARENESS_UNAVAILABLE reason='
              + String(error && error.message || error || 'rejected'),
          );
          const generation = this.accelGeneration;
          if (this.motionOrientationRuntimeOwned === true
              && this.motionOrientationBoundSensor) {
            this.detachMotionOrientationListeners();
            this.orientationClock = null;
            if (this.accel && this.motionQuality
                && this.accelGeneration === generation) {
              this.startManualMotionOrientationSensor(generation);
            }
          }
        });
      }
      console.log('[SmartRun Motion] WORLD_AWARENESS_ENABLED mode=normal');
      return true;
    } catch (error) {
      this.worldAwarenessEnabled = false;
      this.worldAwarenessEnableAttempted = false;
      console.log(
        '[SmartRun Motion] WORLD_AWARENESS_UNAVAILABLE reason='
          + String(error && error.message || error || 'threw'),
      );
      return false;
    }
  },

  disableMotionWorldAwareness(reason = 'motion-stop') {
    const wasEnabled = this.worldAwarenessEnabled === true;
    this.worldAwarenessLifecycleGeneration =
      (Number(this.worldAwarenessLifecycleGeneration) || 0) + 1;
    // 无论宿主 disable 是否抛错/拒绝，页面本地棘轮都必须先复位，
    // 下一次 onShow/startAccel 才能重新调用 enableWorldAwareness。
    this.worldAwarenessEnabled = false;
    this.worldAwarenessEnableAttempted = false;
    if (!wasEnabled || typeof this.disableWorldAwareness !== 'function') return false;
    try {
      const result = this.disableWorldAwareness();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          console.log(
            '[SmartRun Motion] WORLD_AWARENESS_DISABLE_FAILED reason='
              + String(error && error.message || error || 'rejected'),
          );
        });
      }
      console.log(
        '[SmartRun Motion] WORLD_AWARENESS_DISABLED reason=' + String(reason),
      );
      return true;
    } catch (error) {
      console.log(
        '[SmartRun Motion] WORLD_AWARENESS_DISABLE_FAILED reason='
          + String(error && error.message || error || 'threw'),
      );
      return false;
    }
  },

  recordWorldAwarenessDiagnostic(kind, value) {
    const previous = this.worldAwarenessDiagnostics || {};
    const atMs = Date.now();
    if (kind === 'head-gesture') {
      this.worldAwarenessDiagnostics = {
        ...previous,
        headGestureCount: Number(previous.headGestureCount || 0) + 1,
        lastHeadGesture: String(value || ''),
        lastEventAtMs: atMs,
      };
    } else if (kind === 'orientation-stability') {
      this.worldAwarenessDiagnostics = {
        ...previous,
        orientationStabilityCount:
          Number(previous.orientationStabilityCount || 0) + 1,
        orientationStable: value === true,
        lastEventAtMs: atMs,
      };
    }
    return this.worldAwarenessDiagnostics;
  },

  onHeadGesture(event = {}) {
    const gesture = String(event.gesture || event.type || 'unknown');
    this.recordWorldAwarenessDiagnostic('head-gesture', gesture);
    console.log('[SmartRun Motion] WORLD_AWARENESS_HEAD gesture=' + gesture);
  },

  onOrientationStabilityChange(event = {}) {
    const stable = event.stable === true;
    this.recordWorldAwarenessDiagnostic('orientation-stability', stable);
    console.log('[SmartRun Motion] WORLD_AWARENESS_STABLE stable=' + String(stable));
  },

  detachMotionOrientationListeners(sensor = this.motionOrientationBoundSensor) {
    if (!sensor) return false;
    const reading = this.motionOrientationReadingListener;
    const error = this.motionOrientationErrorListener;
    if (typeof sensor.removeEventListener === 'function') {
      if (reading) {
        try { sensor.removeEventListener('reading', reading); } catch (_e) {}
      }
      if (error) {
        try { sensor.removeEventListener('error', error); } catch (_e) {}
      }
    }
    if (this.motionOrientationBoundSensor === sensor) {
      this.motionOrientationBoundSensor = null;
      this.motionOrientationRuntimeOwned = false;
      this.motionOrientationReadingListener = null;
      this.motionOrientationErrorListener = null;
    }
    return true;
  },

  bindMotionOrientationSensor(orientation, generation, runtimeOwned = false) {
    if (!orientation || typeof orientation.addEventListener !== 'function'
        || typeof orientation.removeEventListener !== 'function') return false;
    this.detachMotionOrientationListeners();
    this.orientationClock = new SensorTimestampNormalizer({
      frequency: ORIENTATION_HZ,
    });
    const reading = () => {
      if (this.motionOrientationBoundSensor !== orientation
          || this.accelGeneration !== generation
          || !this.motionQuality) return;
      const now = Date.now();
      const sampleAt = this.orientationClock
        ? this.orientationClock.normalize(orientation.timestamp, now)
        : now;
      if (this.sensorAlignment) {
        this.sensorAlignment.pushOrientation(orientation.quaternion, sampleAt);
      } else {
        this.motionQuality.pushOrientation(orientation.quaternion, sampleAt);
      }
    };
    const error = () => {
      if (this.motionOrientationBoundSensor !== orientation
          || this.accelGeneration !== generation) return;
      const wasRuntimeOwned = this.motionOrientationRuntimeOwned === true;
      this.detachMotionOrientationListeners(orientation);
      this.orientationClock = null;
      if (!wasRuntimeOwned && this.motionOrientationSensor === orientation) {
        this.motionOrientationSensor = null;
        try { orientation.stop(); } catch (_e) {}
      }
      console.log(
        '[SmartRun Motion] ORIENTATION_UNAVAILABLE source='
          + (wasRuntimeOwned ? 'world-awareness' : 'manual'),
      );
      // 宿主姿态源报错时只摘 SmartRun listener，不停止或清空
      // this.orientationSensor。同一运动代次可立即回退 0.15 自建姿态源。
      if (wasRuntimeOwned && this.accel && this.motionQuality
          && this.accelGeneration === generation) {
        this.startManualMotionOrientationSensor(generation);
      }
    };
    this.motionOrientationBoundSensor = orientation;
    this.motionOrientationRuntimeOwned = runtimeOwned === true;
    this.motionOrientationReadingListener = reading;
    this.motionOrientationErrorListener = error;
    if (!runtimeOwned) this.motionOrientationSensor = orientation;
    try {
      orientation.addEventListener('reading', reading);
      orientation.addEventListener('error', error);
      return true;
    } catch (_e) {
      this.detachMotionOrientationListeners(orientation);
      if (!runtimeOwned && this.motionOrientationSensor === orientation) {
        this.motionOrientationSensor = null;
      }
      this.orientationClock = null;
      return false;
    }
  },

  startManualMotionOrientationSensor(generation) {
    if (this.motionOrientationBoundSensor || this.motionOrientationSensor
        || typeof AbsoluteOrientationSensor === 'undefined') return false;
    let orientation = null;
    try {
      orientation = new AbsoluteOrientationSensor({ frequency: ORIENTATION_HZ });
      if (!this.bindMotionOrientationSensor(orientation, generation, false)) {
        throw new Error('orientation listener unavailable');
      }
      orientation.start();
      console.log('[SmartRun Motion] ORIENTATION_STARTED source=manual');
      return true;
    } catch (_e) {
      this.detachMotionOrientationListeners(orientation);
      if (this.motionOrientationSensor === orientation) {
        this.motionOrientationSensor = null;
      }
      this.orientationClock = null;
      if (orientation) {
        try { orientation.stop(); } catch (_ignored) {}
      }
      console.log('[SmartRun Motion] ORIENTATION_UNAVAILABLE source=manual');
      return false;
    }
  },

  // ── IMU 计步(无蓝牙设备兜底:眼镜自带加速度计)──────────────
  startAuxMotionSensors(generation) {
    const gate = this.motionQuality;
    if (!gate) return false;

    this.enableMotionWorldAwareness();
    const runtimeOrientation = this.orientationSensor;
    const runtimeOrientationBound = this.bindMotionOrientationSensor(
      runtimeOrientation,
      generation,
      true,
    );
    if (runtimeOrientationBound) {
      console.log('[SmartRun Motion] ORIENTATION_STARTED source=world-awareness');
    } else {
      this.startManualMotionOrientationSensor(generation);
    }

    if (typeof Gyroscope !== 'undefined') {
      try {
        const gyro = new Gyroscope({ frequency: GYRO_HZ });
        this.gyroClock = new SensorTimestampNormalizer({ frequency: GYRO_HZ });
        gyro.addEventListener('reading', () => {
          if (this.gyro !== gyro
              || this.accelGeneration !== generation
              || !this.motionQuality) return;
          const now = Date.now();
          const sampleAt = this.gyroClock
            ? this.gyroClock.normalize(gyro.timestamp, now)
            : now;
          if (this.sensorAlignment) {
            this.sensorAlignment.pushGyroscope(gyro.x, gyro.y, gyro.z, sampleAt);
          } else {
            this.motionQuality.pushGyro(gyro.x, gyro.y, gyro.z, sampleAt);
          }
        });
        gyro.addEventListener('error', () => {
          if (this.gyro !== gyro || this.accelGeneration !== generation) return;
          this.gyro = null;
          this.gyroClock = null;
          try { gyro.stop(); } catch (_e) {}
          console.log('[SmartRun Motion] GYRO_UNAVAILABLE');
        });
        this.gyro = gyro;
        gyro.start();
        console.log('[SmartRun Motion] GYRO_STARTED');
      } catch (_e) {
        this.gyro = null;
        this.gyroClock = null;
        console.log('[SmartRun Motion] GYRO_UNAVAILABLE');
      }
    }
    return !!(this.motionOrientationBoundSensor || this.gyro);
  },

  recordAccelDiagnostics(wallNow, generation, previousReadingAtMs) {
    if (!Number.isFinite(wallNow)) return;
    if (this.accelDiagnosticStartedAtMs == null) {
      this.accelDiagnosticStartedAtMs = wallNow;
    }
    this.accelDiagnosticSamples = Number(this.accelDiagnosticSamples || 0) + 1;
    if (Number.isFinite(previousReadingAtMs)) {
      this.accelDiagnosticMaxGapMs = Math.max(
        Number(this.accelDiagnosticMaxGapMs || 0),
        Math.max(0, wallNow - previousReadingAtMs),
      );
    }
    const elapsedMs = wallNow - this.accelDiagnosticStartedAtMs;
    if (elapsedMs < IMU_DIAGNOSTIC_INTERVAL_MS) return;
    const effectiveHz = elapsedMs > 0
      ? this.accelDiagnosticSamples * 1000 / elapsedMs : 0;
    const calibration = this.sensorAlignment
      && this.sensorAlignment.accelerationCalibrator
      && typeof this.sensorAlignment.accelerationCalibrator.snapshot === 'function'
      ? this.sensorAlignment.accelerationCalibrator.snapshot() : null;
    console.log(
      '[SmartRun Motion] ACCEL_RATE generation=' + String(generation)
        + ' hz=' + effectiveHz.toFixed(1)
        + ' samples=' + String(this.accelDiagnosticSamples)
        + ' maxGapMs=' + String(Math.round(this.accelDiagnosticMaxGapMs || 0))
        + ' armed=' + String(this.imuArmingLogged === true)
        + ' unit=' + String(calibration && calibration.sourceUnit || 'unknown')
        + ' unitSamples=' + String(Number(calibration && calibration.sampleCount) || 0)
        + ' unitSpanMs=' + String(Math.round(
          Number(calibration && calibration.windowSpanMs) || 0,
        )),
    );
    this.accelDiagnosticStartedAtMs = wallNow;
    this.accelDiagnosticSamples = 0;
    this.accelDiagnosticMaxGapMs = 0;
  },

  startAccel(reason = 'start') {
    this.stopAccel();
    const generation = this.accelGeneration;
    const startedAtMs = Date.now();
    this.imuSensorStartedAtMs = startedAtMs;
    this.imuAwaitingFirstReading = true;
    this.accelDiagnosticStartedAtMs = startedAtMs;
    this.accelDiagnosticSamples = 0;
    this.accelDiagnosticMaxGapMs = 0;
    this.imuArmingGate = new ImuArmingGate({ startMs: startedAtMs });
    this.imuArmingLogged = false;
    if (this.stepDet && typeof this.stepDet.resetTiming === 'function') {
      this.stepDet.resetTiming();
    }
    if (this.magnitudeStepDet
        && typeof this.magnitudeStepDet.resetTiming === 'function') {
      this.magnitudeStepDet.resetTiming();
    }
    if (this.dualStepArbiter) this.dualStepArbiter.resume();
    if (this.lowRateImuStepDetector) this.lowRateImuStepDetector.reset();
    this.lastImuCandidateAcceptedAtMs = null;
    if (this.imuActivityGate) this.imuActivityGate.reset(Date.now());
    if (this.sensorAlignment) this.sensorAlignment.resume();
    if (this.motionQuality) this.motionQuality.resume();
    this.lastAccelSensorAt = null;
    if (typeof Accelerometer === 'undefined') {
      this.markImuUnavailable('api-missing');
      return;
    }
    try {
      const sensor = new Accelerometer({ frequency: IMU_HZ });
      this.accelClock = new SensorTimestampNormalizer({ frequency: IMU_HZ });
      sensor.addEventListener('reading', () => {
        // stop/onHide 后旧 Generic Sensor 仍可能迟到派发 reading。旧实例绝不能
        // 污染新实例的时钟、步频或新鲜度，否则恢复后会再次长期显示 0。
        if (this.accel !== sensor || this.accelGeneration !== generation) return;
        const wallNow = Date.now();
        const previousReadingAtMs = this.lastAccelAt;
        this.lastAccelAt = wallNow;
        this.recordAccelDiagnostics(
          wallNow,
          generation,
          previousReadingAtMs,
        );
        if (this.imuAwaitingFirstReading) {
          const recoveryAttempts = Number(this.imuRecoveryAttempts || 0);
          const delayMs = this.imuSensorStartedAtMs == null
            ? 0 : Math.max(0, wallNow - this.imuSensorStartedAtMs);
          this.imuAwaitingFirstReading = false;
          this.imuRecoveryDueAtMs = null;
          this.imuRecoveryReason = '';
          this.imuRecoveryAttempts = 0;
          console.log(
            '[SmartRun Motion] ACCEL_FIRST_READING generation='
              + String(generation)
              + ' delayMs=' + String(Math.round(delayMs)),
          );
          if (recoveryAttempts > 0) {
            console.log(
              '[SmartRun Motion] ACCEL_RECOVERED attempts='
                + String(recoveryAttempts),
            );
            this.recordRunningLocalFieldEvent('imu', 'IMU_RECOVERED', {
              atMs: wallNow,
              reason: 'first_reading',
              generation,
            });
            this.setData({
              coachLine: '',
              ...this.hudModeFields({
                connected: this.data.showHeartRate,
                linked: this.data.bleState === 'connected',
              }),
            });
          }
        }
        const sampleAt = this.accelClock
          ? this.accelClock.normalize(sensor.timestamp, wallNow)
          : wallNow;
        this.lastAccelSensorAt = sampleAt;
        if (this.stepDet && this.session && !this.session.paused) {
          const aligned = this.sensorAlignment
            ? this.sensorAlignment.alignAcceleration(
              sensor.x,
              sensor.y,
              sensor.z,
              sampleAt,
            )
            : null;
          const acceleration = aligned && aligned.accepted === true
            && Array.isArray(aligned.accelerationMps2)
            ? aligned.accelerationMps2
            : [sensor.x, sensor.y, sensor.z];
          const calibration = aligned && aligned.accelerationCalibration;
          const nextScale = Number(calibration && calibration.scaleToMps2) || 1;
          if (nextScale !== this.accelerationScaleToMps2) {
            this.accelerationScaleToMps2 = nextScale;
            if (this.stepDet) this.stepDet.resetTiming();
            if (this.magnitudeStepDet) this.magnitudeStepDet.resetTiming();
            if (this.dualStepArbiter) this.dualStepArbiter.resume();
            if (this.lowRateImuStepDetector) {
              this.lowRateImuStepDetector.reset();
            }
            this.lastImuCandidateAcceptedAtMs = null;
            if (this.imuActivityGate) this.imuActivityGate.reset(sampleAt);
            if (this.motionQuality) this.motionQuality.reset();
            if (this.imuArmingGate) this.imuArmingGate.reset(sampleAt);
            this.imuArmingLogged = false;
          }
          if (calibration && calibration.calibrated === true
              && !this.accelerationCalibrationLogged) {
            this.accelerationCalibrationLogged = true;
            console.log(
              '[SmartRun Motion] ACCEL_UNIT unit='
                + String(calibration.sourceUnit)
                + ' scale=' + nextScale.toFixed(5),
            );
          }
          if (this.motionQuality && aligned && aligned.accepted === true) {
            const orientation = aligned.orientation;
            if (orientation && Array.isArray(orientation.value)) {
              const orientationAt = Number.isFinite(orientation.sampleTimestampMs)
                ? orientation.sampleTimestampMs : sampleAt;
              this.motionQuality.pushOrientation(orientation.value, orientationAt);
            }
            const gyroscope = aligned.gyroscope;
            if (gyroscope && Array.isArray(gyroscope.value)) {
              const gyroAt = Number.isFinite(gyroscope.sampleTimestampMs)
                ? gyroscope.sampleTimestampMs : sampleAt;
              this.motionQuality.pushGyro(
                gyroscope.value[0],
                gyroscope.value[1],
                gyroscope.value[2],
                gyroAt,
              );
            }
          }
          const qualityResult = this.motionQuality
            ? this.motionQuality.pushAcceleration(
              acceleration[0],
              acceleration[1],
              acceleration[2],
              sampleAt,
            )
            : null;
          const quality = qualityResult && qualityResult.quality;
          const projection = qualityResult && qualityResult.projection;
          const arming = this.imuArmingGate
            ? this.imuArmingGate.observe(quality || {}, sampleAt)
            : { armed: true, reason: 'unavailable', elapsedMs: 0 };
          if (arming.armed !== true) {
            // 入场门内的峰值不进入运动账本，但静止/伪动作质量正是校准实验
            // 需要的负样本。候选步频尚未形成时保持缺席，不编造 0。
            this.lastCalibrationDiagnostics = {
              atMs: wallNow,
              candidateCadenceSpm: null,
              motionQuality:
                Number(quality && quality.runningConfidence) || 0,
              artifactConfidence:
                Number(quality && quality.artifactConfidence) || 0,
              gyroRms: Number(quality && quality.gyroRms) || 0,
              stationary: !!(quality
                && quality.state === MOTION_QUALITY_STATE.STATIONARY),
              rejectionReason: 'arming_' + String(arming.reason || 'pending'),
            };
            this.requestRunTick('imu-arming', wallNow);
            return;
          }
          if (!this.imuArmingLogged) {
            // 保护窗只建立单位、姿态和质量基线。开门时再次清掉检测器内部
            // 的候选峰与周期，确认键/扶镜余振绝不能延迟泄漏进距离账本。
            if (this.stepDet && typeof this.stepDet.resetTiming === 'function') {
              this.stepDet.resetTiming();
            }
            if (this.magnitudeStepDet
                && typeof this.magnitudeStepDet.resetTiming === 'function') {
              this.magnitudeStepDet.resetTiming();
            }
            if (this.dualStepArbiter) this.dualStepArbiter.resume();
            if (this.lowRateImuStepDetector) {
              this.lowRateImuStepDetector.reset();
            }
            this.lastImuCandidateAcceptedAtMs = null;
            if (this.imuActivityGate) this.imuActivityGate.reset(sampleAt);
            this.imuArmingLogged = true;
            console.log(
              '[SmartRun Motion] IMU_ARMED reason=' + String(arming.reason)
                + ' delay=' + Math.round(Number(arming.elapsedMs) || 0)
                + ' stride='
                  + Number(this.activeStepLengthM
                    || this.runStrideM
                  || DEFAULT_STRIDE_M).toFixed(2),
            );
            this.requestRunTick('imu-armed', wallNow);
            return;
          }

          const useProjected = !!(projection
            && projection.source === 'orientation_vertical'
            && projection.orientationFresh === true
            && Number.isFinite(projection.verticalDynamicMps2));
          if (useProjected && !this.orientationProjectionLogged) {
            this.orientationProjectionLogged = true;
            console.log(
              '[SmartRun Motion] ORIENTATION_VERTICAL direction='
                + String(projection.direction || 'undetermined'),
            );
          }
          const projectedResult = useProjected
            ? this.stepDet.pushProjectedDynamic(
              // Projector 已完成重力分离；StepDetector 自己还会做一次短时
              // EMA。喂 rawDynamic 可避免 55ms+25ms 双重平滑吞掉真机弱峰。
              projection.rawDynamicMps2,
              sampleAt,
            )
            : this.stepDet.push(
              acceleration[0],
              acceleration[1],
              acceleration[2],
              sampleAt,
            );
          const magnitudeResult = this.magnitudeStepDet
            ? this.magnitudeStepDet.push(
              acceleration[0],
              acceleration[1],
              acceleration[2],
              sampleAt,
            )
            : projectedResult;
          const primaryResult = this.dualStepArbiter
            ? this.dualStepArbiter.observe({
              timestampMs: sampleAt,
              projectedResult,
              magnitudeResult,
              projectedUsable: useProjected,
              quality,
            })
            : projectedResult;
          const lowRateResult = this.lowRateImuStepDetector
            ? this.lowRateImuStepDetector.observe(
              projection && Number.isFinite(projection.rawDynamicMps2)
                ? projection.rawDynamicMps2 : NaN,
              sampleAt,
              quality || {},
            )
            : null;
          // 主检测器与低频局部峰可能在相邻回调报告同一个物理落步。跨链统一
          // 使用 220ms 生理去重；低频链只在主链未提交时补证据，绝不形成第二
          // 份距离账本。低频抛物线 cadence 已就绪时优先拿它去掉 100/125ms
          // 量化台阶，但每个 accepted step 仍只由活动门提交一次。
          const primaryStepped = primaryResult && primaryResult.stepped === true;
          const lowRateStepped = lowRateResult && lowRateResult.stepped === true;
          let stepResult = null;
          let candidateAtMs = null;
          const lowRatePeakAtMs = lowRateStepped
            && Number.isFinite(Number(lowRateResult.peakAtMs))
            && Number(lowRateResult.peakAtMs) <= sampleAt
            && sampleAt - Number(lowRateResult.peakAtMs)
              <= LOW_RATE_IMU_MAX_INTERVAL_MS * 2
            ? Number(lowRateResult.peakAtMs) : null;
          const primaryStepAtMs = primaryStepped
            && Number.isFinite(Number(primaryResult.stepAtMs))
            && Number(primaryResult.stepAtMs) <= sampleAt
            && sampleAt - Number(primaryResult.stepAtMs)
              <= LOW_RATE_IMU_MAX_INTERVAL_MS * 2
            ? Number(primaryResult.stepAtMs) : null;
          if (primaryStepped) {
            stepResult = primaryResult;
            // 低频链会在同一 release callback 上给出三点抛物线峰时刻。
            // 两条链必须用同一种物理时间语义去重并提交，否则同一落步会被
            // callback 网格量化，甚至因相差超过 220ms 逃过去重。
            candidateAtMs = lowRatePeakAtMs == null
              ? (primaryStepAtMs == null ? sampleAt : primaryStepAtMs)
              : lowRatePeakAtMs;
          } else if (lowRateStepped) {
            stepResult = lowRateResult;
            candidateAtMs = lowRatePeakAtMs == null
              ? sampleAt : lowRatePeakAtMs;
          }
          const duplicateCandidate = stepResult
            && this.lastImuCandidateAcceptedAtMs != null
            && Number.isFinite(candidateAtMs)
            && Math.abs(candidateAtMs - this.lastImuCandidateAcceptedAtMs) < 220;
          if (duplicateCandidate) stepResult = null;
          if (stepResult && Number.isFinite(candidateAtMs)) {
            this.lastImuCandidateAcceptedAtMs = candidateAtMs;
          }
          const cadenceResult = lowRateResult
            && lowRateResult.cadenceReady === true
            && Number(lowRateResult.cadenceSpm) > 0
            ? lowRateResult : primaryResult;
          const result = {
            ...(primaryResult || {}),
            stepped: !!stepResult,
            channel: stepResult
              ? String(stepResult.channel || 'unknown')
              : String(primaryResult && primaryResult.channel || 'none'),
            reason: stepResult
              ? String(stepResult.reason || 'accepted')
              : (duplicateCandidate
                ? 'cross_detector_deduped'
                : String(primaryResult && primaryResult.reason || 'no_step')),
            strictEvidence: !!(stepResult
              && stepResult.strictEvidence === true),
            cadenceReady: !!(cadenceResult
              && cadenceResult.cadenceReady === true),
            cadenceSpm: Number(cadenceResult && cadenceResult.cadenceSpm) || 0,
            candidateCadenceSpm:
              Number(cadenceResult && cadenceResult.candidateCadenceSpm)
                || Number(cadenceResult && cadenceResult.cadenceSpm)
                || 0,
            lowRateActive: !!(lowRateResult && lowRateResult.lowRateActive),
          };
          const activity = this.imuActivityGate
            ? this.imuActivityGate.observe({
              timestampMs: sampleAt,
              result,
              quality,
            })
            : {
              active: true,
              justActivated: false,
              justDeactivated: false,
              submitStep: result && result.stepped === true,
              cadenceReady: result && result.cadenceReady === true,
              cadenceSpm: Number(result && result.cadenceSpm) || 0,
              reason: 'unavailable',
            };
          this.lastCalibrationDiagnostics = {
            atMs: wallNow,
            candidateCadenceSpm:
              Number(result && result.candidateCadenceSpm) || 0,
            motionQuality:
              Number(quality && quality.runningConfidence) || 0,
            artifactConfidence:
              Number(quality && quality.artifactConfidence) || 0,
            gyroRms: Number(quality && quality.gyroRms) || 0,
            stationary: !!(quality
              && quality.state === MOTION_QUALITY_STATE.STATIONARY),
            rejectionReason: activity && activity.active !== true
              ? String(activity.reason || 'probing')
              : (activity && activity.submitStep !== true
                && result && result.reason && result.reason !== 'none'
                  ? String(result.reason) : ''),
          };
          if (activity.justActivated) {
            console.log(
              '[SmartRun Motion] ACTIVITY_CONFIRMED reason='
                + String(activity.reason || 'unknown')
                + ' strict='
                + Number(activity.strictEvidenceCount || 0)
                + ' stable='
                + Number(activity.stableCadenceCount || 0),
            );
            this.startRunMetronome();
          } else if (activity.justDeactivated) {
            console.log('[SmartRun Motion] ACTIVITY_STOPPED reason=stationary_hold');
            // 节拍器属于整场跑步设置，不属于 IMU 活动门。活动门会在短暂停步、
            // 折返或质量窗波动时正常关闭；这里若停止 Sound，用户就会误以为
            // 播放器偶发断线。真正的暂停、隐藏、总结与退出仍统一清理音频。
            if (this.stepDet && typeof this.stepDet.resetTiming === 'function') {
              this.stepDet.resetTiming();
            }
            if (this.magnitudeStepDet
                && typeof this.magnitudeStepDet.resetTiming === 'function') {
              this.magnitudeStepDet.resetTiming();
            }
            if (this.dualStepArbiter) this.dualStepArbiter.resume();
          }
          const diagnostics = this.motionDiagnostics;
          if (diagnostics) {
            diagnostics.samples += 1;
            if (projectedResult && projectedResult.stepped) {
              diagnostics.projectedSteps += 1;
            }
            if (magnitudeResult && magnitudeResult.stepped) {
              diagnostics.magnitudeSteps += 1;
            }
            if (lowRateStepped) diagnostics.lowRateSteps += 1;
            if (result && result.stepped) diagnostics.candidateSteps += 1;
            if (activity && activity.submitStep) diagnostics.acceptedSteps += 1;
            diagnostics.lastReason = activity && activity.active !== true
              ? String(activity.reason || 'probing')
              : (result && result.reason ? result.reason : 'none');
            if (!diagnostics.cadenceLogged
                && activity && activity.cadenceReady === true
                && Number(activity.cadenceSpm) > 0) {
              diagnostics.cadenceLogged = true;
              console.log(
                '[SmartRun Motion] IMU_CADENCE_READY spm='
                  + Math.round(activity.cadenceSpm)
                  + ' channel=' + String(result.channel || 'unknown'),
              );
            }
            if (sampleAt - diagnostics.lastReportMs
                >= IMU_DIAGNOSTIC_INTERVAL_MS) {
              diagnostics.lastReportMs = sampleAt;
              console.log(
                '[SmartRun Motion] IMU_STATUS samples=' + diagnostics.samples
                  + ' projected=' + diagnostics.projectedSteps
                  + ' magnitude=' + diagnostics.magnitudeSteps
                  + ' lowRate=' + diagnostics.lowRateSteps
                  + ' candidates=' + diagnostics.candidateSteps
                  + ' accepted=' + diagnostics.acceptedSteps
                  + ' finalCadence='
                    + Math.round(Number(activity.cadenceSpm) || 0)
                  + ' candidateCadence='
                    + Math.round(Number(result.candidateCadenceSpm) || 0)
                  + ' reason=' + diagnostics.lastReason
                  + ' activity='
                    + String(activity.active === true ? 'active' : 'probing')
                  + ' quality=' + String(quality && quality.state || 'unknown')
                  + ' running='
                    + Number(quality && quality.runningConfidence || 0).toFixed(2)
                  + ' artifact='
                    + Number(quality && quality.artifactConfidence || 0).toFixed(2)
                  + ' stationary='
                    + Number(quality && quality.stationaryConfidence || 0).toFixed(2)
                  + ' accelRms='
                    + Number(quality && quality.accelRms || 0).toFixed(3)
                  + ' gyro='
                    + Number(quality && quality.gyroRms || 0).toFixed(3)
                  + ' gyroFresh='
                    + String(quality && quality.gyroFresh === true)
                  + ' gyroSamples='
                    + Math.round(Number(quality && quality.gyroSamples) || 0)
                  + ' strict='
                    + Number(activity && activity.strictEvidenceCount || 0)
                  + ' stable='
                    + Number(activity && activity.stableCadenceCount || 0)
                  + ' stepLength='
                    + Number(this.activeStepLengthM || 0).toFixed(2)
                  + ' scale=' + Number(this.accelerationScaleToMps2 || 1).toFixed(5),
              );
            }
          }
          if (this.motionMetrics) {
            if (activity && activity.submitStep) {
              const acceptedStepAtMs = Number.isFinite(candidateAtMs)
                ? Math.min(sampleAt, candidateAtMs) : sampleAt;
              const accepted = this.motionMetrics.onAcceptedStep(
                acceptedStepAtMs,
                Number(activity.cadenceSpm) || 0,
              );
              const motion = this.motionMetrics.snapshot(sampleAt);
              // HUD、步长和速度融合只认 accepted-step 间隔形成的终态步频。
              // activity.cadenceSpm 仍保留给活动确认门，但不得成为距离或配速。
              const finalCadenceSpm = this.motionMetrics.imuCadenceReady === true
                ? Number(this.motionMetrics.imuCadenceSpm) || 0 : 0;
              const stride = this.applyAdaptiveStride(finalCadenceSpm);
              if (accepted && this.runWarmupMotionAtMs == null) {
                this.runWarmupMotionAtMs = acceptedStepAtMs;
              }
              if (accepted && finalCadenceSpm > 0) {
                this.cadenceEverReady = true;
                this.lastDisplayedCadenceSpm = finalCadenceSpm;
                this.lastDisplayedCadenceAtMs = acceptedStepAtMs;
              }
              if (accepted && !this.isSlowJogMode()
                  && this.speedFusion && finalCadenceSpm > 0
                  && motion.rscFresh !== true) {
                const stepLengthM = Number(stride && stride.stepLengthM)
                  || this.activeStepLengthM
                  || this.runStrideM
                  || DEFAULT_STRIDE_M;
                this.speedFusion.observe(
                  'imu',
                  finalCadenceSpm * stepLengthM / 60,
                  acceptedStepAtMs,
                  {
                    quality: quality
                      ? Math.max(0.4, quality.runningConfidence)
                      : 0.5,
                    cadenceConfidence: quality
                      ? Math.max(0.5, quality.runningConfidence)
                      : 0.55,
                    strideConfidence: Number(stride && stride.confidence) || 0,
                  },
                );
                this.lastImuFusionAtMs = acceptedStepAtMs;
              }
            }
            const recentStep = this.motionMetrics.lastAcceptedStepMs;
            const currentMotion = this.motionMetrics.snapshot(sampleAt);
            this.advanceWorkoutDistance(sampleAt, currentMotion);
            if (!this.isSlowJogMode() && this.speedFusion && quality
                && quality.state === MOTION_QUALITY_STATE.STATIONARY
                && quality.stationaryConfidence >= 0.72
                && currentMotion.rscFresh !== true
                && (recentStep == null || sampleAt - recentStep > 1200)
                && (this.lastStationaryFusionAtMs == null
                  || sampleAt - this.lastStationaryFusionAtMs >= 250)) {
              this.speedFusion.observeStationary(
                sampleAt,
                quality.stationaryConfidence,
              );
              this.lastStationaryFusionAtMs = sampleAt;
            }
          }
          this.requestRunTick('imu', wallNow);
        }
      });
      sensor.addEventListener('error', () => {
        // 同理，旧实例的迟到 error 不得关闭息屏恢复后已经工作的当前实例。
        if (this.accel !== sensor || this.accelGeneration !== generation) return;
        this.markImuUnavailable('sensor-error', { retryable: true });
      });
      this.accel = sensor;
      this.imuOk = true;
      this.lastAccelAt = startedAtMs;
      this.startAuxMotionSensors(generation);
      sensor.start();
      console.log(
        '[SmartRun Motion] ACCEL_STARTED reason=' + String(reason)
          + ' generation=' + String(generation),
      );
      this.recordRunningLocalFieldEvent(
        'imu',
        reason === 'start' ? 'IMU_STARTED' : 'IMU_REBUILT',
        {
          atMs: startedAtMs,
          reason: String(reason || 'start'),
          generation,
        },
      );
    } catch (_e) {
      this.markImuUnavailable('start-failed', { retryable: true });
    }
  },

  stopAccel() {
    this.accelGeneration = (this.accelGeneration || 0) + 1;
    const sensor = this.accel;
    const gyro = this.gyro;
    const orientation = this.motionOrientationSensor;
    this.detachMotionOrientationListeners();
    this.accel = null;
    this.gyro = null;
    this.motionOrientationSensor = null;
    this.accelClock = null;
    this.gyroClock = null;
    this.orientationClock = null;
    this.imuSensorStartedAtMs = null;
    this.imuAwaitingFirstReading = false;
    if (this.sensorAlignment) this.sensorAlignment.pause();
    if (this.dualStepArbiter) this.dualStepArbiter.pause();
    if (this.lowRateImuStepDetector) this.lowRateImuStepDetector.pause();
    this.lastImuCandidateAcceptedAtMs = null;
    if (this.imuActivityGate) this.imuActivityGate.pause();
    if (this.motionQuality) this.motionQuality.pause();
    if (sensor) { try { sensor.stop(); } catch (_e) {} }
    if (gyro) { try { gyro.stop(); } catch (_e) {} }
    // 只停止 SmartRun 自建的 0.15 回退实例。AIUI 0.16.1 宿主注入的
    // this.orientationSensor 不直接停止；World Awareness 能力只通过官方
    // disableWorldAwareness 关闭，让 onShow/startAccel 可以干净重启。
    if (orientation) { try { orientation.stop(); } catch (_e) {} }
    this.disableMotionWorldAwareness('motion-stop');
  },

  clearSafetyTtsResume() {
    this.safetyTtsGeneration = (this.safetyTtsGeneration || 0) + 1;
    if (this.safetyTtsResumeTimer) clearTimeout(this.safetyTtsResumeTimer);
    this.safetyTtsResumeTimer = null;
    this.safetyMetronomeResumePending = false;
  },

  pauseMetronomeForSafetyCue() {
    const metronome = this.metronome;
    const shouldResume = this.safetyMetronomeResumePending === true
      || !!(metronome && metronome.running === true);
    if (!shouldResume) return null;
    if (this.safetyTtsResumeTimer) clearTimeout(this.safetyTtsResumeTimer);
    const generation = (this.safetyTtsGeneration || 0) + 1;
    this.safetyTtsGeneration = generation;
    this.safetyTtsResumeTimer = null;
    this.safetyMetronomeResumePending = true;
    if (metronome && metronome.running === true) {
      this.stopMetronomePlayback({ preserveSafetyResume: true });
    }
    console.log('[SmartRun Audio] SAFETY_TTS_PREEMPT generation=' + String(generation));
    return generation;
  },

  resumeMetronomeAfterSafetyCue(generation) {
    if (generation == null || generation !== this.safetyTtsGeneration
        || this.safetyMetronomeResumePending !== true) return false;
    this.safetyTtsResumeTimer = null;
    this.safetyMetronomeResumePending = false;
    const metronome = this.metronome;
    if (!metronome || metronome.destroyed === true
        || this.agentExitRequested || this.backspaceHandled
        || this.pageVisible !== true || this.data.surfacePhase !== 'hud'
        || !this.session || this.session.paused === true) return false;
    const bpm = Number(this.runSettings && this.runSettings.metronomeBpm) || 0;
    if (bpm <= 0) return false;
    try {
      // 严格复用被暂停的同一 Metronome/Sound，绝不在恢复定时器里重建播放器。
      const resumed = metronome.start(bpm);
      console.log('[SmartRun Audio] SAFETY_TTS_RESUME bpm=' + String(bpm)
        + ' resumed=' + String(resumed));
      return resumed;
    } catch (error) {
      console.log('[SmartRun Audio] SAFETY_TTS_RESUME_FAILED '
        + String(error && (error.message || error.errMsg) || 'unknown'));
      return false;
    }
  },

  finishSafetyTtsAudioWindow(generation, text, dispatched) {
    if (generation == null || generation !== this.safetyTtsGeneration) return;
    if (!dispatched) {
      this.resumeMetronomeAfterSafetyCue(generation);
      return;
    }
    const delayMs = safetyTtsResumeDelayMs(text);
    this.safetyTtsResumeTimer = setTimeout(() => {
      this.resumeMetronomeAfterSafetyCue(generation);
    }, delayMs);
  },

  // 主动语音教练：普通提示优先 wx TTS。跑前/跑后指导的末三秒只做
  // 视觉倒计时；开启“指导快速结束”时整段指导不派发 TTS，避免跨页追播。
  speakCue(text, options = {}) {
    this.setData({ coachLine: text });
    this.playCueTts(text, options);
  },

  playCueTts(text, options = {}) {
    if (this.runSettings && this.runSettings.voiceCue === false) return false;
    // AIUI Sound 与 TTS 共用眼镜的系统音频焦点，但当前 API 没有可靠的
    // completion/interruption 回调。非安全教练文案仍不抢占节拍器；Z5 提示
    // 则先暂停当前实例，播报后经有界保守窗只恢复同一实例。
    const safety = options.safety === true;
    const metronomeOwnsRunAudio = !!(
      (this.metronome && this.metronome.running === true)
      || this.safetyMetronomeResumePending === true
    ) && !!(
      this.session
      && this.session.paused !== true
      && !this.isSummaryPhase()
    );
    if (metronomeOwnsRunAudio && !safety) {
      console.log('[SmartRun Audio] TTS_SKIPPED reason=metronome-focus');
      return false;
    }
    const safetyResumeGeneration = safety
      ? this.pauseMetronomeForSafetyCue() : null;
    let dispatched = false;
    const preferWebSpeech = options.preferWebSpeech === true;
    const webSpeechRate = Math.max(
      0.5,
      Math.min(1.0, Number(options.speechRate) || 0.7),
    );
    const dispatchWebSpeech = () => {
      if (typeof speechSynthesis === 'undefined'
          || typeof SpeechSynthesisUtterance === 'undefined') return false;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = webSpeechRate;
      speechSynthesis.speak(utterance);
      return true;
    };
    try {
      if (preferWebSpeech && dispatchWebSpeech()) {
        dispatched = true;
      } else if (typeof wx !== 'undefined' && wx.speech && typeof wx.speech.playTTS === 'function') {
        const requestId = wx.speech.playTTS(text);
        dispatched = requestId !== '';
      } else {
        dispatched = dispatchWebSpeech();
      }
    } catch (_e) {
      // 部分宿主声明 Web Speech 但调用失败；倒数仍回退为一次 wx TTS，
      // 不拆成三次播放器请求，避免迟到语音跨步骤。
      try {
        if (preferWebSpeech && typeof wx !== 'undefined' && wx.speech
            && typeof wx.speech.playTTS === 'function') {
          const requestId = wx.speech.playTTS(text);
          dispatched = requestId !== '';
        }
      } catch (_ignored) { dispatched = false; }
    }
    this.finishSafetyTtsAudioWindow(
      safetyResumeGeneration,
      text,
      dispatched,
    );
    return dispatched;
  },

  ensureMetronome(bpmValue) {
    const bpm = Math.round(Number(bpmValue));
    const audioSrc = METRONOME_AUDIO_SOURCES[bpm];
    if (!audioSrc) return null;
    if (
      this.metronome
      && this.metronome.destroyed !== true
      && this.metronomeAudioSrc === audioSrc
    ) return this.metronome;

    // 每个 BPM 的四拍间隔已经烘焙在各自 WAV 中，切档时必须重建 Sound，
    // 不能只改调度间隔后继续播放旧 BPM 的音轨。
    if (this.metronome) {
      try { this.metronome.stop(); } catch (_e) {}
      try { this.metronome.destroy(); } catch (_e) {}
      this.metronome = null;
      this.metronomeAudioSrc = '';
    }
    try {
      this.metronome = new Metronome({
        SoundCtor: Sound,
        src: audioSrc,
        bpm: 0,
        beatsPerPlayback: METRONOME_BEATS_PER_PLAYBACK,
        onError: (error) => {
          console.log('[SmartRun Audio] PLAYBACK_ERROR '
            + String(error && (error.message || error.errMsg) || 'unknown'));
          if (this.data.surfacePhase === 'settings') {
            this.setData({ settingsSaveState: '暂时无法播放' });
          }
        },
      });
      this.metronomeAudioSrc = audioSrc;
      console.log('[SmartRun Audio] SOUND_READY bpm=' + String(bpm)
        + ' src=' + audioSrc);
      return this.metronome;
    } catch (error) {
      console.log('[SmartRun Audio] SOUND_INIT_FAILED '
        + String(error && (error.message || error.errMsg) || 'unknown'));
      this.metronome = null;
      this.metronomeAudioSrc = '';
      if (this.data.surfacePhase === 'settings') {
        this.setData({ settingsSaveState: '暂时无法播放' });
      }
      return null;
    }
  },

  stopMetronomePlayback(options = {}) {
    if (options.preserveSafetyResume !== true) this.clearSafetyTtsResume();
    const metronome = this.metronome;
    if (!metronome) {
      if (options.destroy === true) this.metronomeAudioSrc = '';
      return false;
    }
    try { metronome.stop(); } catch (_e) {}
    if (options.destroy === true) {
      try { metronome.destroy(); } catch (_e) {}
      if (this.metronome === metronome) {
        this.metronome = null;
        this.metronomeAudioSrc = '';
      }
    }
    return true;
  },

  startMetronomePreview(bpm) {
    if (this.data.surfacePhase !== 'settings') return false;
    const metronome = this.ensureMetronome(bpm);
    if (!metronome) return false;
    try {
      metronome.stop();
      const scheduled = metronome.start(bpm);
      console.log('[SmartRun Audio] PREVIEW_START bpm=' + String(bpm)
        + ' scheduled=' + String(scheduled));
      if (scheduled) this.setData({ settingsSaveState: '正在试听 ' + bpm + ' BPM' });
      return scheduled;
    } catch (_e) {
      this.stopMetronomePlayback();
      this.setData({ settingsSaveState: '暂时无法播放' });
      return false;
    }
  },

  startRunMetronome() {
    // finishEntry()/onShow() 都会先 setData 再紧接着启动音频。真机宿主可能尚未
    // 把 surfacePhase/running/paused 镜像回 this.data；若依赖这些 UI 字段，
    // 会在首帧把整场节拍器静默跳过。RunSession 是同步建立/恢复的真实运行态，
    // 因此用它作为唯一启动门，并只显式排除已经进入总结的终止相位。
    if (!this.session || this.session.paused || this.isSummaryPhase()) {
      return false;
    }
    const bpm = Number(this.runSettings && this.runSettings.metronomeBpm) || 0;
    if (bpm <= 0) {
      this.stopMetronomePlayback();
      return false;
    }
    const metronome = this.ensureMetronome(bpm);
    if (!metronome) return false;
    try {
      const scheduled = metronome.start(bpm);
      console.log('[SmartRun Audio] RUN_START bpm=' + String(bpm)
        + ' scheduled=' + String(scheduled));
      return scheduled;
    } catch (error) {
      console.log('[SmartRun Audio] RUN_START_FAILED '
        + String(error && (error.message || error.errMsg) || 'unknown'));
      return false;
    }
  },

  startTicker() {
    this.stopTicker();
    this.timer = setInterval(() => this.requestRunTick('timer'), TICK_MS);
  },

  stopTicker() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastRunTickAtMs = null;
    this.runTickInProgress = false;
  },

  requestRunTick(source = 'signal', requestedAtMs = Date.now()) {
    if (this.pageVisible !== true
        || this.data.surfacePhase !== 'hud'
        || this.data.running !== true
        || !this.session
        || this.session.paused
        || this.runOwnerInvalidated === true
        || this.backspaceHandled === true
        || this.agentExitRequested === true
        || this.isSummaryPhase()) return false;
    const now = Number.isFinite(Number(requestedAtMs))
      ? Number(requestedAtMs) : Date.now();
    const lastAt = this.lastRunTickAtMs == null
      ? null : Number(this.lastRunTickAtMs);
    if (Number.isFinite(lastAt) && now - lastAt < SIGNAL_TICK_MIN_MS) {
      return false;
    }
    if (this.runTickInProgress === true) return false;
    if (source !== 'timer'
        && Number.isFinite(lastAt)
        && now - lastAt >= SIGNAL_TICK_STALL_LOG_MS) {
      console.log(
        '[SmartRun Motion] HUD_SIGNAL_RECOVERY source=' + String(source)
          + ' gapMs=' + String(Math.round(now - lastAt)),
      );
    }
    this.runTickInProgress = true;
    const previousTickAtMs = this.lastRunTickAtMs;
    try {
      this.tick();
      return this.lastRunTickAtMs !== previousTickAtMs;
    } finally {
      this.runTickInProgress = false;
    }
  },





  // 给可能悬空的原生 bridge Promise 加“等待上限”。超时/隐藏只结束 JS 等待，
  // 不假装取消宿主调用；token 会保留到原生真正 settle，因此不会叠加第二次调用。



  clearHrWatchdogTimer() {
    if (this.hrWatchdogTimer) {
      clearTimeout(this.hrWatchdogTimer);
      this.hrWatchdogTimer = null;
    }
  },

  clearHrNotificationRecoveryTimer() {
    if (this.hrNotifyRecoveryTimer) clearTimeout(this.hrNotifyRecoveryTimer);
    this.hrNotifyRecoveryTimer = null;
  },

  cancelHrNotificationRecovery(reason = '', options = {}) {
    const hadPending = !!this.hrNotifyRecoveryTimer || !!this.hrNotifyRecoveryFlight;
    this.clearHrNotificationRecoveryTimer();
    this.hrNotifyRecoveryGeneration = (this.hrNotifyRecoveryGeneration || 0) + 1;
    // 原生 stop/start Promise 无法取消，必须把 single-flight 保留到它真实 settle；
    // 否则 hide→show 会在旧桥调用仍悬空时叠加第二次原生订阅。teardown 已接管
    // 同一 characteristic 的 stop/disconnect 时打标，迟到 settle 不再重复停订阅。
    if (this.hrNotifyRecoveryFlight && reason === 'teardown') {
      this.hrNotifyRecoveryFlight.cleanupOwnedByTeardown = true;
    }
    if (options.resetAttempts === true) {
      this.hrNotifyRecoveryCount = 0;
      this.hrNotifyRecoveryExhaustedLogged = false;
    }
    if (hadPending && reason) {
      this.bleDebug('HR_NOTIFY_RECOVERY_CANCELLED', 'reason=' + String(reason));
    }
  },

  isHrNotificationRecoveryCurrent(generation, characteristic, device) {
    return generation === this.hrNotifyRecoveryGeneration
      && this.pageVisible === true
      && this.hostFocused !== false
      && this.bleTerminated !== true
      && this.backspaceHandled !== true
      && !this.isSummaryPhase()
      && this.data.bleState === 'connected'
      && this.hrDegradedByRsc === true
      && this.isRscDataFresh()
      && this.hrCharacteristic === characteristic
      && !!this.hrListener
      && this.bleDevice === device
      && !!device && !!device.gatt
      && device.gatt.connected !== false;
  },

  scheduleHrNotificationRecovery(delayMs = HR_NOTIFY_RECOVERY_DELAY_MS) {
    if (this.hrNotifyRecoveryTimer || this.hrNotifyRecoveryFlight) return false;
    if (this.bleTerminated === true || this.backspaceHandled === true
        || !this.pageVisible || this.hostFocused === false || this.isSummaryPhase()
        || this.data.bleState !== 'connected'
        || this.hrDegradedByRsc !== true
        || !this.isRscDataFresh()
        || !this.hrCharacteristic || !this.hrListener || !this.bleDevice) return false;
    if ((this.hrNotifyRecoveryCount || 0) >= HR_NOTIFY_RECOVERY_MAX) {
      if (!this.hrNotifyRecoveryExhaustedLogged) {
        this.hrNotifyRecoveryExhaustedLogged = true;
        this.bleDebug(
          'HR_NOTIFY_RECOVERY_FAILED',
          'reason=budget-exhausted attempts=' + String(this.hrNotifyRecoveryCount || 0),
        );
      }
      return false;
    }
    const generation = this.hrNotifyRecoveryGeneration || 0;
    const characteristic = this.hrCharacteristic;
    const device = this.bleDevice;
    this.clearHrNotificationRecoveryTimer();
    this.hrNotifyRecoveryTimer = setTimeout(() => {
      this.hrNotifyRecoveryTimer = null;
      if (!this.isHrNotificationRecoveryCurrent(generation, characteristic, device)) return;
      this.recoverHeartRateNotifications(generation, characteristic, device);
    }, Math.max(1, Number(delayMs) || HR_NOTIFY_RECOVERY_DELAY_MS));
    return true;
  },

  async settleHrNotificationRecoveryFlight(flight, outcome, late = false) {
    if (!flight) return false;
    const characteristic = flight.characteristic;
    const device = flight.device;
    const current = this.isHrNotificationRecoveryCurrent(
      flight.generation,
      characteristic,
      device,
    );
    if (this.hrNotifyRecoveryFlight === flight) this.hrNotifyRecoveryFlight = null;
    if (!current) {
      // 总结/teardown 后迟到的 startNotifications 可能在原生层又开启 CCCD。
      // 只在没有新会话复用同一 characteristic 时补一次停订阅；否则
      // 绝不让旧代次拆掉新连接。
      const sameOwner = this.hrCharacteristic === characteristic
        && this.bleDevice === device && !!this.hrListener;
      const cleanupOwned = flight.cleanupOwnedByTeardown === true
        || !!this.bleCleanupPromise || !!this.terminalBleCleanupPromise;
      if (outcome && outcome.kind === 'subscribed' && !sameOwner && !cleanupOwned
          && characteristic && typeof characteristic.stopNotifications === 'function') {
        try {
          await this.waitForBleBridgeStep(characteristic.stopNotifications());
        } catch (_e) {}
      }
      // hide 只换页面代次、不拆共享 GATT。旧原生调用 settle 后若页面已经恢复、
      // HR 仍静默且 RSC 仍新鲜，再由新代次排一次；single-flight 期间不叠加。
      this.scheduleHrNotificationRecovery(HR_NOTIFY_RECOVERY_RETRY_MS);
      return false;
    }
    if (!outcome || outcome.kind !== 'subscribed') {
      this.bleDebug(
        'HR_NOTIFY_RECOVERY_FAILED',
        'attempt=' + String(flight.attempt)
          + ' reason=' + this.bleErrorText(outcome && outcome.error),
      );
      this.scheduleHrNotificationRecovery(HR_NOTIFY_RECOVERY_RETRY_MS);
      return false;
    }
    this.bleDebug(
      'HR_NOTIFY_RECOVERY_SUBSCRIBED',
      'attempt=' + String(flight.attempt) + ' late=' + String(late === true),
    );
    // 订阅 Promise resolve 不等于数据恢复。保留 stale 基线，继续等现有
    // listener 收到首个合法 2A37 包；若仍无包，有界进入下一次重新武装。
    this.scheduleHrNotificationRecovery(HR_NOTIFY_RECOVERY_RETRY_MS);
    return true;
  },

  async recoverHeartRateNotifications(generation, characteristic, device) {
    if (this.hrNotifyRecoveryFlight
        || !this.isHrNotificationRecoveryCurrent(generation, characteristic, device)) {
      return false;
    }
    const attempt = (this.hrNotifyRecoveryCount || 0) + 1;
    this.hrNotifyRecoveryCount = attempt;
    this.hrNotifyRecoveryExhaustedLogged = false;
    this.bleDebug('HR_NOTIFY_RECOVERY_ATTEMPT', 'attempt=' + String(attempt));
    const flight = {
      generation,
      characteristic,
      device,
      attempt,
      settledPromise: null,
      cleanupOwnedByTeardown: false,
    };
    this.hrNotifyRecoveryFlight = flight;
    // 某些 GATT 宿主在 CCCD 已开启时把 startNotifications 当作幂等 no-op，
    // 无法恢复已静默的通知通道。保留既有 listener/RSC/GATT，只对 2A37 做一次
    // best-effort、有界 stop→start；两步之间再次校验代次，避免隐藏/总结后复活。
    const settledPromise = Promise.resolve().then(async () => {
      if (!this.isHrNotificationRecoveryCurrent(generation, characteristic, device)) {
        return { kind: 'cancelled' };
      }
      if (typeof characteristic.stopNotifications === 'function') {
        try {
          await this.waitForBleBridgeStep(characteristic.stopNotifications());
        } catch (_e) {}
      }
      if (!this.isHrNotificationRecoveryCurrent(generation, characteristic, device)) {
        return { kind: 'cancelled' };
      }
      try {
        await characteristic.startNotifications();
        return { kind: 'subscribed' };
      } catch (error) {
        return { kind: 'failed', error };
      }
    });
    flight.settledPromise = settledPromise;
    let timeoutTimer = null;
    const outcome = await Promise.race([
      settledPromise,
      new Promise((resolve) => {
        timeoutTimer = setTimeout(
          () => resolve({ kind: 'timeout' }),
          HR_NOTIFY_RECOVERY_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (outcome.kind === 'timeout') {
      this.bleDebug(
        'HR_NOTIFY_RECOVERY_TIMEOUT',
        'attempt=' + String(attempt),
      );
      // 不叠加第二个原生 startNotifications：保留 flight 到原请求真正
      // settle，然后再按当前 generation/RSC freshness 决定是否继续。
      settledPromise.then((lateOutcome) => {
        this.settleHrNotificationRecoveryFlight(flight, lateOutcome, true).catch(() => {});
      }).catch(() => {});
      return false;
    }
    return this.settleHrNotificationRecoveryFlight(flight, outcome, false);
  },

  keepRscConnectionWhenHeartRateStale() {
    this.clearHrWatchdogTimer();
    if (!this.hrDegradedByRsc) {
      this.hrDegradedByRsc = true;
      if (this.session) this.session.lastBpm = null;
      this.setData({
        bpm: '',
        coachLine: '跑速已接入 · 等待心率',
        ...heartZoneDotFields(0),
      });
      this.bleDebug('HR_STALE_RSC_ALIVE', 'action=keep-gatt');
    }
    this.scheduleHrNotificationRecovery();
    // 02 尚未开跑时没有 1Hz ticker；若此处只清 watchdog，RSC 随后停止后便
    // 永远无人复核。仍复用唯一的 hrWatchdogTimer，下一拍改守 RSC freshness
    // 的绝对截止点；新 HR 包会通过原有 scheduleHrWatchdog() 清掉并重置它。
    this.scheduleHrWatchdog();
  },

  scheduleHrWatchdog() {
    this.clearHrWatchdogTimer();
    if (this.bleTerminated === true || this.backspaceHandled === true
        || this.hostFocused === false || !this.pageVisible
        || this.isSummaryPhase()) return false;
    const watchAtMs = this.lastHrAtMs != null ? this.lastHrAtMs : this.hrSubscribedAtMs;
    if (watchAtMs == null) return false;
    // 首包未到用 20s 宽限;有包之后按 8s 新鲜度。
    const staleMs = this.lastHrAtMs != null ? HR_STALE_MS : HR_FIRST_PACKET_GRACE_MS;
    const now = Date.now();
    const hrDeadlineMs = watchAtMs + staleMs + 1;
    const hrAlreadyStale = now > watchAtMs + staleMs;
    // HR 已过期但 RSC 仍活着时，下一次检查必须落在 RSC freshness 刚过期后；
    // 不能继续按已过去的 HR deadline 以 1ms 自旋，也不能彻底停表。
    const nextDeadlineMs = hrAlreadyStale && this.isRscDataFresh(now)
      && this.lastRscAtMs != null
      ? this.lastRscAtMs + RSC_FRESH_MS + 1
      : hrDeadlineMs;
    const delayMs = Math.max(1, nextDeadlineMs - now);
    this.hrWatchdogTimer = setTimeout(() => {
      this.hrWatchdogTimer = null;
      if (this.hostFocused === false || !this.pageVisible) return;
      if (this.data.bleState !== 'connected') return;
      const currentWatchAtMs = this.lastHrAtMs != null ? this.lastHrAtMs : this.hrSubscribedAtMs;
      if (currentWatchAtMs == null) return;
      const ageMs = Date.now() - currentWatchAtMs;
      const currentStaleMs = this.lastHrAtMs != null ? HR_STALE_MS : HR_FIRST_PACKET_GRACE_MS;
      if (ageMs <= currentStaleMs) {
        this.scheduleHrWatchdog();
        return;
      }
      const firstPacketFailure = this.lastHrAtMs == null;
      const reason = firstPacketFailure
        ? ((this.invalidHrPackets || 0) > 0 ? '心率数据异常' : '心率无数据')
        : '';
      if (this.isRscDataFresh()) {
        this.keepRscConnectionWhenHeartRateStale();
        return;
      }
      this.onBleDropped(reason, firstPacketFailure ? 'wd0' : 'wd');
    }, delayMs);
    return true;
  },

  recordMinuteMetric(snapshot, cadenceSpm) {
    if (!snapshot || !(snapshot.elapsedMs > 0)) return;
    if (Number.isFinite(Number(cadenceSpm)) && Number(cadenceSpm) > 0) {
      this.minuteCadenceSum = (this.minuteCadenceSum || 0) + Number(cadenceSpm);
      this.minuteCadenceCount = (this.minuteCadenceCount || 0) + 1;
    }
    const minute = Math.floor(snapshot.elapsedMs / 60000);
    if (minute <= 0 || minute <= (this.lastMinuteSample || 0)) return;
    const anchor = this.minuteMetricAnchor || { elapsedMs: 0, distanceM: 0 };
    const deltaElapsedMs = snapshot.elapsedMs - anchor.elapsedMs;
    const deltaDistanceM = snapshot.distanceM - anchor.distanceM;
    const cadenceValue = this.minuteCadenceCount > 0
      ? this.minuteCadenceSum / this.minuteCadenceCount : 0;
    const value = this.isSlowJogMode()
      ? cadenceValue
      : (deltaDistanceM >= 10 && deltaElapsedMs > 0
        ? (deltaElapsedMs / 1000) / (deltaDistanceM / 1000) : 0);
    this.lastMinuteSample = minute;
    this.minuteMetricAnchor = {
      elapsedMs: snapshot.elapsedMs,
      distanceM: snapshot.distanceM,
    };
    this.minuteCadenceSum = 0;
    this.minuteCadenceCount = 0;
    if (!(value > 0) || !Number.isFinite(value)) return;
    const series = Array.isArray(this.minuteSeries) ? this.minuteSeries.slice(-29) : [];
    series.push({ minute, value: Math.round(value) });
    this.minuteSeries = series;
  },

  // 跑后统计必须与真实运动账本共用证据。MotionMetrics 的 accepted-step
  // 间隔优先于 1Hz ticker 的偶然采样；短跑尚未满足 8 秒/10 米平均配速
  // 窗口时，只能用该真实平均步频和当前受限步长补出估算平均配速。
  // HUD 的 sticky 数字仅为停步后的显示棘轮，绝不反向写进总结。
  resolveSummaryMotion(now = Date.now(), motionSnapshot = null) {
    const motion = motionSnapshot
      || (this.motionMetrics ? this.motionMetrics.snapshot(now) : null);
    const motionCadence = Number(motion && motion.avgCadenceSpm);
    const sessionCadence = Number(
      this.session && this.session.avgCadenceSpm
        ? this.session.avgCadenceSpm() : 0,
    );
    // RunSession 每秒采样 MotionMetrics 当前选中的互斥步频源，能正确覆盖
    // RSC→IMU 与 IMU→RSC 的混合跑；MotionMetrics 全事件聚合只负责在
    // 下一次 1Hz tick 之前结束的短跑兜底。
    const avgCadenceSpm = Number.isFinite(sessionCadence) && sessionCadence > 0
      ? sessionCadence
      : (Number.isFinite(motionCadence) && motionCadence > 0
        ? motionCadence : null);
    let avgPaceSecPerKm = this.isSlowJogMode() ? null : (motion
      && isPlausibleHudPace(motion.avgPaceSecPerKm)
      ? Number(motion.avgPaceSecPerKm) : null);
    // 短 RSC 跑尚未达到严格 8s/10m 平均窗时，设备即时速度仍比
    // “RSC 步频 × 眼镜步长”更接近真实值。只有设备配速不可用时，
    // 才用真实平均步频与当前受限步长做纯眼镜估算。
    if (!this.isSlowJogMode() && avgPaceSecPerKm == null
        && motion
        && motion.rscPaceLive === true
        && isPlausibleHudPace(motion.rscInstantPaceSecPerKm)) {
      avgPaceSecPerKm = Number(motion.rscInstantPaceSecPerKm);
    }
    if (!this.isSlowJogMode() && avgPaceSecPerKm == null && avgCadenceSpm != null) {
      const estimated = estimatePaceSecPerKmFromCadence(
        avgCadenceSpm,
        this.activeStepLengthM || this.runStrideM || DEFAULT_STRIDE_M,
      );
      if (isPlausibleHudPace(estimated)) avgPaceSecPerKm = estimated;
    }
    return {
      motion,
      avgCadenceSpm,
      avgPaceSecPerKm,
    };
  },





  tick() {
    const s = this.session;
    if (!s) return;
    const runOwnerGeneration = this.runOwnerGeneration || 0;
    if (runOwnerGeneration > 0
        && !this.ownerScopedRunWriteAllowed(runOwnerGeneration)) {
      // owner 校验可能同步销毁 session 并切回菜单。必须在本拍最前面停下，
      // 不能再用已失效的 A 会话计算并提交一轮 HUD/TTS 状态。
      return;
    }
    if (this.runOwnerInvalidated || this.session !== s || !this.data.running) return;
    const now = Date.now();
    this.lastRunTickAtMs = now;

    if (!this.isSlowJogMode()
        && this.data.bleState === 'connected'
        && this.bleDevice
        && !this.rscCharacteristic
        && !this.rscProbePromise
        && this.rscProbeRetryAtMs != null
        && now >= this.rscProbeRetryAtMs
        && this.pageVisible
        && this.hostFocused !== false
        && !this.isSummaryPhase()) {
      this.rscProbeRetryAtMs = null;
      this.bleDebug('RSC_PROBE_RETRY', 'source=hud-tick');
      this.probeOptionalRsc(this.bleDevice, this.bleServer);
    }

    // 结束确认窗口过期:清掉完整三段进度，不把旧的一、二次确认带到下一组手势。
    if (this.endArmedAtMs != null && now - this.endArmedAtMs > END_CONFIRM_WINDOW_MS) {
      this.resetHudEndConfirmation();
    }

    // 心率新鲜度:GATT 断连事件 + 8s 无 notify 双保险。首包尚未到时也从
    // hrSubscribedAtMs 起算，避免订阅成功但永远无数据时永久假装“心率已连”。
    // 设备停止广播/走出范围时 characteristicvaluechanged 只是"不再来",必须超时兜底,
    // 否则 HUD 永久显示冻结的旧心率,还会把它当"此刻"喂给 AI 教练。
    const hrFresh = this.lastHrAtMs != null && (now - this.lastHrAtMs) <= HR_STALE_MS;
    const hrWatchAtMs = this.lastHrAtMs != null ? this.lastHrAtMs : this.hrSubscribedAtMs;
    const hrWatchStaleMs = this.lastHrAtMs != null ? HR_STALE_MS : HR_FIRST_PACKET_GRACE_MS;
    if (this.data.bleState === 'connected' && hrWatchAtMs != null
        && now - hrWatchAtMs > hrWatchStaleMs) {
      const firstPacketFailure = this.lastHrAtMs == null;
      const reason = firstPacketFailure
        ? ((this.invalidHrPackets || 0) > 0 ? '心率数据异常' : '心率无数据')
        : '';
      if (this.isRscDataFresh(now)) {
        this.keepRscConnectionWhenHeartRateStale();
      } else {
        this.onBleDropped(reason, firstPacketFailure ? 'wd0' : 'wd');
      }
    }
    const hrLive = this.data.bleState === 'connected' && hrFresh;

    // 录屏、系统浮层或 Generic Sensor bridge 短时抢占可能让 reading 停流。
    // 可见跑步页不得永久降级：先释放旧 generation，再按有界退避原位重建；
    // 隐藏、总结和退出阶段则绝不从后台复活传感器。
    if (this.imuOk === true && this.accel && this.lastAccelAt != null
        && now - this.lastAccelAt > ACCEL_STALE_MS) {
      console.log(
        '[SmartRun Motion] ACCEL_STALLED gapMs='
          + String(Math.round(now - this.lastAccelAt))
          + ' generation=' + String(this.accelGeneration || 0),
      );
      this.recordRunningLocalFieldEvent('imu', 'IMU_STALLED', {
        atMs: now,
        reason: 'stale',
        generation: this.accelGeneration,
      });
      this.markImuUnavailable('stalled', { retryable: true });
    }
    this.attemptScheduledImuRecovery(now);

    // 统一数据源：RSC 累计距离 > RSC 速度梯形积分 > IMU accepted step。
    // 距离只由真实事件推进；UI 的 1Hz ticker 不再参与积分，也不会在停步后补尾巴距离。
    const motion = this.motionMetrics ? this.motionMetrics.snapshot(now) : null;
    const motionSource = motion ? motion.activeMotionSource : MOTION_SOURCE.NONE;
    if (motionSource !== this.lastMotionSource) {
      const sourceEvent = motionSource === MOTION_SOURCE.RSC_TOTAL_DISTANCE
        ? 'SOURCE_RSC_DISTANCE'
        : (motionSource === MOTION_SOURCE.RSC_SPEED
          ? 'SOURCE_RSC_SPEED'
          : (motionSource === MOTION_SOURCE.IMU_STEP
            ? 'SOURCE_IMU' : 'SOURCE_NONE'));
      this.lastMotionSource = motionSource;
      console.log('[SmartRun Motion] source=' + motionSource);
      this.recordRunningLocalFieldEvent('source', sourceEvent, {
        atMs: now,
        reason: 'motion_ledger',
      });
    }
    const rawCadence = motion ? Number(motion.cadenceSpm || 0) : 0;
    const cadenceReady = !!(motion && motion.cadenceReady && rawCadence > 0);
    if (cadenceReady) this.cadenceEverReady = true;
    const instantPaceSec = motion && Number.isFinite(motion.instantPaceSecPerKm)
      ? motion.instantPaceSecPerKm : null;
    const rollingPaceSec = motion && Number.isFinite(motion.paceSecPerKm)
      ? motion.paceSecPerKm : null;
    const rscInstantPaceSec = motion
      && Number.isFinite(motion.rscInstantPaceSecPerKm)
      ? motion.rscInstantPaceSecPerKm : null;
    const fusedMotion = this.speedFusion ? this.speedFusion.snapshot(now) : null;
    const fusedPaceSec = fusedMotion
      && Number.isFinite(fusedMotion.paceSecPerKm)
      ? fusedMotion.paceSecPerKm : null;
    // 传感器即时值只用于起跑早期、总配速窗口尚未形成时尽快给出首个数字。
    // Garmin 等腕上 RSC 可能在手臂摆动变化时连续数秒把即时速度抬高一倍；
    // 它虽然不是单点坏包，却不能直接覆盖已经由唯一距离账本形成的本场配速。
    const sensorPaceSec = rscInstantPaceSec != null
      ? rscInstantPaceSec
      : (fusedPaceSec != null
        ? fusedPaceSec
        : (instantPaceSec != null ? instantPaceSec : rollingPaceSec));
    const overallPaceSec = motion && isPlausibleHudPace(motion.avgPaceSecPerKm)
      ? motion.avgPaceSecPerKm : null;
    // 跑够至少 8 秒且 10 米后，MotionMetrics 才会给出 overallPaceSec。
    // 此后 HUD、实时教练和校准记录统一采用“首次可信运动→最后运动证据”的
    // 本场总配速；既符合产品口径，也不会把 8:00/km 的跑步显示成短时 4–6 分。
    const rawPaceSec = overallPaceSec != null ? overallPaceSec : sensorPaceSec;
    if (motion) s.distanceM = motion.distanceM;
    // HUD 可由真实事件以最高 2Hz 救活，但跑后 RunSession 平均步频仍保持
    // 原先的约 1Hz 等时抽样口径，不能因某类 BLE/sensor 回调更频繁而被加权。
    if (!s.paused
        && (this.lastSessionCadenceSampleAtMs == null
          || now - this.lastSessionCadenceSampleAtMs >= TICK_MS)) {
      s.onCadence(rawCadence);
      this.lastSessionCadenceSampleAtMs = now;
    }

    const snap = s.snapshot(now);
    // 总配速使用 MotionMetrics 的“首次真实运动→最后运动证据”口径。
    // 停下后该值冻结，不让继续走动的 HUD 计时把配速拖成异常慢值。
    snap.avgPaceSecPerKm = overallPaceSec;
    const hasHeartRate = hrLive && Number.isFinite(snap.bpm);
    const zone = this.runHeartRateZone(hasHeartRate ? snap.bpm : 0);

    // 即时配速必须与“此刻确实在运动”的证据绑定：正步频或同包一致的
    // RSC 正速度。旧版允许速度尾值在步频仍为 -- 时单独显示，正是静坐
    // 仍出现 3–4 分配速的根因之一。
    const liveCadenceMotion = cadenceReady && rawCadence > 0;
    const liveRscMotion = !!(motion
      && motion.rscPaceLive === true
      && Number(motion.rscSpeedMps) > 0
      && rawCadence > 0);
    const livePaceSec = !snap.paused
      && (liveCadenceMotion || liveRscMotion)
      && isPlausibleHudPace(rawPaceSec)
      ? rawPaceSec : null;
    // 校准上传使用算法本刻真实采用的值：可信窗口形成前是传感器即时值，
    // 形成后与 HUD 一致改为本场累计配速；禁止上传粘性展示值。
    this.captureAiuiCalibrationSnapshot(now, motion, {
      algorithmSpeedMps: this.isSlowJogMode() || livePaceSec == null
        ? null : 1000 / livePaceSec,
      algorithmPaceSecPerKm: this.isSlowJogMode() ? null : livePaceSec,
    });
    this.captureRunningLocalFieldSample(now, motion, 'ticker');
    const dispCadence = snap.paused ? 0 : rawCadence;
    this.recordMinuteMetric(snap, dispCadence);

    let coachLine;
    let proactiveCue = '';
    if (hasHeartRate && this.data.coachLine === '等待心率数据') {
      coachLine = '心率数据已接入';
    }

    // 主动语音教练：里程碑 / 区间变化时不等提问就开口(并入本拍 setData,保持 1Hz 单次合并)
    if (!snap.paused) {
      const cur = {
        distanceM: snap.distanceM, elapsedMs: snap.elapsedMs,
        bpm: hasHeartRate ? snap.bpm : null,
        zone, cadenceSpm: rawCadence, paceSecPerKm: rawPaceSec,
        ...this.runHeartRatePolicyFields(),
      };
      const cue = nextProactiveCue(this.prevCue, cur);
      if (cue && (!this.isSlowJogMode() || isHighRiskHeartRateCue(cue))) {
        coachLine = cue;
        proactiveCue = cue;
      }
      this.prevCue = cur;
    }

    const distVal = formatDistanceKm(snap.distanceM);
    const cadenceEstimatedPaceSec = estimatePaceSecPerKmFromCadence(
      rawCadence,
      this.activeStepLengthM || this.runStrideM || DEFAULT_STRIDE_M,
    );
    if (dispCadence > 0) {
      this.lastDisplayedCadenceSpm = dispCadence;
      const sourceCadenceAtMs = motion && motion.cadenceSource === 'rsc'
        ? Number(this.motionMetrics && this.motionMetrics.lastRscCadenceMs)
        : Number(this.motionMetrics && this.motionMetrics.lastAcceptedStepMs);
      this.lastDisplayedCadenceAtMs = Number.isFinite(sourceCadenceAtMs)
        ? sourceCadenceAtMs : now;
    }
    const cadenceHoldLive = this.cadenceEverReady
      && Number.isFinite(Number(this.lastDisplayedCadenceAtMs))
      && now - Number(this.lastDisplayedCadenceAtMs) >= 0
      && now - Number(this.lastDisplayedCadenceAtMs) <= CADENCE_DISPLAY_HOLD_MS;
    const stickyCadenceSpm = dispCadence > 0
      ? dispCadence
      : (cadenceHoldLive ? this.lastDisplayedCadenceSpm : null);
    const stickyCadencePaceSec = estimatePaceSecPerKmFromCadence(
      stickyCadenceSpm,
      this.activeStepLengthM || this.runStrideM || DEFAULT_STRIDE_M,
    );
    if (livePaceSec != null) {
      this.paceEverReady = true;
      this.lastCrediblePaceSec = livePaceSec;
      this.lastCrediblePaceAtMs = now;
      this.lastDisplayedPaceSec = livePaceSec;
    } else if (liveCadenceMotion) {
      // 真实滚动窗口至少需要 8 秒/8 米；窗口成形前先把眼镜步频×用户步长
      // 转成可读数字。这里只影响 HUD，不写入 live snapshot、总结或上传。
      this.paceEverReady = true;
      this.lastDisplayedPaceSec = cadenceEstimatedPaceSec;
    }
    // 配速仍可保留本场累计值；实时步频则只允许上面的短窗口保持，不能把
    // 跑后平均步频长期粘到 HUD 上。失效 RSC 仍只撤销“接入”状态。
    const stickyPaceSec = isPlausibleHudPace(overallPaceSec)
      ? overallPaceSec
      : (isPlausibleHudPace(stickyCadencePaceSec)
          ? stickyCadencePaceSec : this.lastDisplayedPaceSec);
    const dispPaceSec = livePaceSec != null
      ? livePaceSec
      : (liveCadenceMotion
          ? cadenceEstimatedPaceSec
          : ((this.paceEverReady || this.cadenceEverReady)
              ? stickyPaceSec : null));
    if (isPlausibleHudPace(dispPaceSec)) {
      this.lastDisplayedPaceSec = dispPaceSec;
    }
    const paceVal = formatPace(
      isPlausibleHudPace(dispPaceSec) ? dispPaceSec : null,
    );
    const elapsedVal = formatElapsed(snap.elapsedMs);
    const cadenceVal = Number.isFinite(stickyCadenceSpm) && stickyCadenceSpm > 0
      ? formatCadence(stickyCadenceSpm)
      : CADENCE_PENDING;
    const warmupDataReady = cadenceReady
      && cadenceVal !== CADENCE_PENDING
      && (this.isSlowJogMode() || isPlausibleHudPace(dispPaceSec));
    if (this.runWarmupPending === true
        && this.runWarmupMotionAtMs == null
        && !snap.paused
        && (liveCadenceMotion || liveRscMotion)) {
      this.runWarmupMotionAtMs = now;
    }
    if (this.runWarmupPending === true
        && this.runWarmupMotionAtMs != null
        && now - this.runWarmupMotionAtMs >= RUN_STABILIZE_MIN_MS
        && warmupDataReady) {
      this.runWarmupPending = false;
    }
    const runWarmupHint = this.runWarmupPending === true
      ? (this.isSlowJogMode() ? '原地小步，稳定约 5 秒' : RUN_STABILIZE_HINT)
      : '';
    if (this.lastHudMotionReportMs == null
        || now - this.lastHudMotionReportMs >= IMU_DIAGNOSTIC_INTERVAL_MS) {
      this.lastHudMotionReportMs = now;
      console.log(
        '[SmartRun Motion] HUD_STATUS metricCadence=' + Math.round(rawCadence)
          + ' metricReady=' + String(cadenceReady)
          + ' displayCadence=' + String(cadenceVal)
          + ' displayEverReady=' + String(this.cadenceEverReady)
          + ' distance=' + Number(snap.distanceM || 0).toFixed(2)
          + ' source=' + String(motionSource),
      );
    }
    const hudEnvironment = formatHudClock(now);
    const paceConnected = !this.isSlowJogMode() && !!(motion && motion.rscPaceLive);
    const motionSourceHint = this.isSlowJogMode() ? '超慢跑' : '眼镜估算';
    const slowTargetMs = this.runSettings && this.runSettings.slowJogTargetMin > 0
      ? this.runSettings.slowJogTargetMin * 60000 : 0;
    let slowCoachLine = '原地小步 · 轻落地 · 保持轻松呼吸';
    if (slowTargetMs > 0 && snap.elapsedMs >= slowTargetMs) {
      slowCoachLine = '目标完成 · 可三按确认结束';
    } else if (cadenceReady && rawCadence >= 160 && rawCadence <= 195) {
      slowCoachLine = '节奏稳定 · 保持轻松呼吸';
    } else if (cadenceReady && rawCadence < 160) {
      slowCoachLine = '放小步幅 · 逐步接近 180';
    } else if (cadenceReady && rawCadence > 195) {
      slowCoachLine = '保持轻松 · 不必追求更快';
    }
    const workoutHud = this.advanceWorkoutClock(now, {
      bpm: hasHeartRate ? snap.bpm : null,
      cadenceSpm: cadenceReady ? rawCadence : null,
      paceSec: isPlausibleHudPace(dispPaceSec) ? dispPaceSec : null,
      heartZone: zone,
    });
    // 同一张跑步数据面板:无心率时不渲染心率位;眼镜自身始终给时间,传感器可用时估算步频/配速/距离。
    this.setData({
      bpm: hasHeartRate ? formatBpm(snap.bpm) : '',
      pace: paceVal,
      cadence: cadenceVal,
      elapsed: elapsedVal,
      distVal,
      slowStepCount: String(this.motionMetrics
        ? Math.max(0, Math.round(Number(this.motionMetrics.acceptedSteps) || 0)) : 0),
      slowHeartRate: hasHeartRate ? formatBpm(snap.bpm) : '--',
      slowCoachLine,
      hudEnvironment,
      safetyHudHint: this.runHeartRateHigh(hasHeartRate ? snap.bpm : 0)
        ? (heartRatePolicyConfidence(this.frozenHeartRatePolicy) === 'trusted'
          && zone >= 5 ? '心率 Z5 · 请降速' : '心率偏高 · 请降速') : '',
      runWarmupHint,
      ...workoutHud,
      ...heartZoneDotFields(zone),
      paceConnected,
      motionSourceHint,
      paceMod: unifiedPaceMod(paceVal),
      paceStateClass: '',
      distMod: unifiedDistMod(distVal),
      elapsedMod: unifiedElapsedMod(elapsedVal),
      gDistMod: glassesDistMod(distVal),
      gElapsedMod: glassesElapsedMod(elapsedVal),
      ...(coachLine !== undefined ? { coachLine } : {}),
      ...this.hudModeFields({
        // 单向棘轮:入场状态起步,数据到过就锁心率版面;断流只置空数字,绝不降级。
        connected: this.isHrUiEngaged(now),
        linked: this.data.bleState === 'connected',
      }),
    });
    // 先把安全文案提交到 HUD，再触发音频抢占；用户至少总有一条可见通道。
    if (proactiveCue) {
      this.playCueTts(proactiveCue, {
        safety: isHighRiskHeartRateCue(proactiveCue),
      });
    }
    // 把真实快照写进 storage,供 coach 页读取(带时间戳,教练只认 10s 内的"此刻")。
    // bpm 用与 HUD 同一套新鲜度门控:断连后的冻结值宁缺勿假,否则教练把死数据当"此刻"。
    if (this.ownerScopedRunWriteAllowed()) writeLiveSnapshot(wx, {
      bpm: hasHeartRate ? snap.bpm : null,
      heartDeviceName: this.data.bleState === 'connected' ? this.connectedHeartName : null,
      zone, paceSecPerKm: this.isSlowJogMode() ? null : livePaceSec,
      ...this.runHeartRatePolicyFields(),
      cadenceSpm: this.cadenceEverReady ? dispCadence : null,
      distanceM: this.isSlowJogMode() ? 0 : snap.distanceM,
      elapsedMs: snap.elapsedMs, paused: snap.paused,
    }, now);

    // 跑中每 15s 落一次总结检查点:被系统杀进程(低电/后台回收)时正常结束路径
    // (Backspace/onUnload)都不会执行,下次前台代次仍可后台归档;正常结束由最终快照覆盖。
    if (this.data.running
        && this.immersiveStartupSummaryGuardActive !== true
        && (this.lastSummaryCheckpointMs == null
        || now - this.lastSummaryCheckpointMs >= SUMMARY_CHECKPOINT_MS)) {
      const checkpointSummary = this.resolveSummaryMotion(now, motion);
      if (this.ownerScopedRunWriteAllowed() && writePendingRunSummary(wx, {
        mode: this.persistedRunMode(),
        startedAtMs: s.startMs,
        elapsedMs: snap.elapsedMs,
        distanceM: this.isSlowJogMode() ? 0 : snap.distanceM,
        avgPaceSecPerKm: this.isSlowJogMode()
          ? null : checkpointSummary.avgPaceSecPerKm,
        avgBpm: s.avgBpm(),
        maxBpm: s.maxBpm(),
        avgCadenceSpm: checkpointSummary.avgCadenceSpm,
        steps: this.motionMetrics ? this.motionMetrics.acceptedSteps : 0,
        minuteSeries: Array.isArray(this.minuteSeries) ? this.minuteSeries : [],
        endedAtMs: now,
        heartRatePolicy: this.frozenHeartRatePolicy,
      })) {
        // 只有 storage 写后读回成功才推进 15s 棘轮；宿主静默 no-op 时下一次
        // ticker 继续重试，不能把唯一的崩溃恢复检查点误判为已保存。
        this.lastSummaryCheckpointMs = now;
      }
    }
  },

  // ── BLE 心率（官方 heart_rate 样例模式）───────────────────────
  // 官方样例的心率页在扫描前从不调用 getAvailability——点按后直接 scanDevices。
  // 任何多余的桥往返都可能消耗手势上下文或撞上宿主桥序列化;此处只做同步的
  // API 存在性检查,与样例的调用形态严格一致。

  // 02 在 onReady 后进入这里。能力探测或 scan setup 失败时，当前可见代次
  // 静默停用真实 BLE；搜索文案和“下一步”仍可用，避免 Craft 调用风暴。


  // 连接并订阅 notify。首选稳定 ID 只提高验证优先级，不过滤全量扫描候选。

  // 心率源没了(GATT 断连事件 / 8s 无数据):静默回眼镜,跑步不中断。

  teardownBle({ terminal = false } = {}) {
    if (terminal && this.terminalBleCleanupPromise) {
      this.bleTerminated = true;
      return this.terminalBleCleanupPromise;
    }
    if (terminal) this.bleTerminated = true;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.beginBleSelection(terminal ? 'terminal-teardown' : 'teardown');
    this.autoConnectPending = false;
    this.autoConnectSelectionGeneration = null;
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.connectingAttemptId = null;
    this.connectingDevice = null;
    this.connectingSelectionGeneration = null;
    this.connectingSelectionSource = null;
    this.clearScanRetryTimer();
    this.clearHrWatchdogTimer();
    this.cancelHrNotificationRecovery('teardown', { resetAttempts: true });
    const scan = this.scanSession;
    const characteristic = this.hrCharacteristic;
    const listener = this.hrListener;
    const rscCharacteristic = this.rscCharacteristic;
    const rscListener = this.rscListener;
    const device = this.bleDevice;
    const dropListener = this.bleDropListener;
    this.scanSession = null;
    this.hrCharacteristic = null;
    this.hrListener = null;
    this.rscCharacteristic = null;
    this.rscListener = null;
    this.rscProbeGeneration = (this.rscProbeGeneration || 0) + 1;
    this.rscProbePromise = null;
    this.rscProbeRetryAtMs = null;
    this.rscFeatureProbePromise = null;
    this.clearRscSilentTimer();
    this.bleDevice = null;
    this.bleServer = null;
    this.bleDropListener = null;
    this.lastHrAtMs = null;
    this.hrSubscribedAtMs = null;
    this.invalidHrPackets = 0;
    this.hrDegradedByRsc = false;
    this.connectedHeartName = '';
    this.pendingEntryBpm = null;
    this.rscPacketCount = 0;
    this.rscInvalidPacketCount = 0;
    this.rscSubscribedAtMs = null;
    this.rscLive = false;
    this.rscFeatureFlags = null;
    this.lastRscAtMs = null;
    this.pendingRscMeasurement = null;
    if (this.motionMetrics) this.motionMetrics.onRscDisconnected(Date.now());
    this.resetRscStrideCalibration();
    this.clearLivePaceState(Date.now());
    // 断连即清"此刻心率":lastBpm 只喂显示/快照,均值/峰值累计(bpmSum/bpmMax)不受影响
    if (this.session) this.session.lastBpm = null;
    if (scan) { try { scan.stop(); } catch (_e) {} }
    if (device && dropListener && typeof device.removeEventListener === 'function') {
      try { device.removeEventListener('gattserverdisconnected', dropListener); } catch (_e) {}
    }
    this.bleDebug('BLE_TEARDOWN', 'terminal=' + String(terminal));
    // stopNotifications/disconnect 在最新 skill 中都是 Promise。先清实例引用
    // 防止断连事件重入。所有清理链按发起顺序串行并保存在实例上，避免页面
    // 恢复后的新 connect 被隐藏前迟到的 disconnect 拆掉。
    const previousCleanup = this.bleCleanupPromise;
    const releaseCapturedResources = () => this.releaseBleResources([
      { characteristic, listener },
      { characteristic: rscCharacteristic, listener: rscListener },
    ], device, true);
    let cleanup = null;
    try {
      cleanup = previousCleanup
        ? Promise.resolve(previousCleanup).catch(() => {}).then(releaseCapturedResources)
        : releaseCapturedResources();
    } catch (error) {
      this.bleDebug('BLE_TEARDOWN_FAILED', 'reason=' + this.bleErrorText(error));
      cleanup = false;
    }
    const tracked = Promise.resolve(cleanup).catch((error) => {
      this.bleDebug('BLE_TEARDOWN_FAILED', 'reason=' + this.bleErrorText(error));
      return false;
    });
    this.bleCleanupPromise = tracked;
    if (terminal) this.terminalBleCleanupPromise = tracked;
    tracked.then(() => {
      if (this.bleCleanupPromise === tracked) this.bleCleanupPromise = null;
    });
    return tracked;
  },

  finishRunForHostBack() {
    if (this.backspaceHandled) return;
    if ((this.runOwnerGeneration || 0) > 0) {
      this.reconcileRunOwnerContext('host-back');
      if (this.runOwnerInvalidated) return;
    }
    this.backspaceHandled = true;
    this.clearSurfaceTimers();
    this.clearHudReconnectTimer();
    this.reconnectDevice = null;
    if (this.calibrationStream && this.motionMetrics) {
      const now = Date.now();
      this.captureAiuiCalibrationSnapshot(
        now,
        this.motionMetrics.snapshot(now),
        { force: true, deferPersist: true },
      );
    }
    this.persistAiuiCalibrationBuffer();
    this.calibrationStream = null;
    this.queueRunForUpload();
    // 真跑过一场才提示首页预点亮退出确认(02 直接退出不算):跑完两下返回即离开应用。
    if (this.session && this.ownerScopedRunWriteAllowed()) writeRunFinishedHint(wx);
    // 先关 running，避免宿主随后派发 onHide 时重新写入一张“已暂停”快照。
    this.setData({ running: false, paused: false });
    this.stopTicker();
    this.stopAccel();
    this.stopMetronomePlayback({ destroy: true });
    this.beginTerminalBleCleanup();
    if (this.ownerScopedRunWriteAllowed()) clearLiveSnapshot(wx);
  },

  clearAgentExitTimer() {
    if (this.agentExitTimer) clearTimeout(this.agentExitTimer);
    this.agentExitTimer = null;
  },

  isTimedGuidePhase() {
    return this.data.surfacePhase === 'pre_run'
      || this.data.surfacePhase === 'recovery';
  },

  currentGuideStepCount() {
    return this.timedGuideKind === 'pre_run'
      ? WARMUP_STEP_COUNT : RECOVERY_STEP_COUNT;
  },

  timedGuideQuickExitEnabled() {
    return !!(this.runSettings && this.runSettings.guideQuickExit === true);
  },

  timedGuideSpeechEnabled() {
    // 快速结束允许用户在任意时刻离开当前指导；而 AIUI 系统
    // TTS 一旦派发没有 cancel API。因此该开关开启时只保留视觉倒计时，
    // 跑中心率/配速/安全语音仍由全局 voiceCue 正常播放。
    return !this.timedGuideQuickExitEnabled();
  },

  applyRecoveryStep(index) {
    const view = this.timedGuideKind === 'pre_run'
      ? getWarmupViewModel(index)
      : getRecoveryViewModel(index);
    if (!view) return false;
    this.recoveryIndex = index;
    this.setData({
      recoveryProgress: String(view.index) + ' / ' + String(view.count),
      recoveryTitle: view.title,
      recoveryDuration: view.durationLabel,
      recoveryInstruction: view.instruction,
      recoverySafety: view.safetyNote,
      recoveryImage: view.imagePath,
      recoveryActionLabel: this.timedGuideQuickExitEnabled()
        ? (this.timedGuideKind === 'pre_run' ? '跳过热身' : '快速完成')
        : view.buttonLabel,
      guideQuickExitEnabled: this.timedGuideQuickExitEnabled(),
      recoveryChoiceVisible: false,
    });
    return true;
  },

  cancelRecoveryCountdown(options = {}) {
    const preserveRemaining = options.preserveRemaining === true;
    if (preserveRemaining && this.recoveryCountdownActive === true
        && Number.isFinite(Number(this.recoveryStepEndsAtMs))) {
      this.recoveryCountdownRemainingSec = Math.max(
        1,
        Math.min(
          RECOVERY_STEP_DURATION_SEC,
          Math.ceil((Number(this.recoveryStepEndsAtMs) - Date.now()) / 1000),
        ),
      );
    }
    this.recoveryCountdownGeneration = (this.recoveryCountdownGeneration || 0) + 1;
    if (this.recoveryCountdownTimer) clearTimeout(this.recoveryCountdownTimer);
    this.recoveryCountdownTimer = null;
    this.recoveryCountdownActive = false;
    this.recoveryStepEndsAtMs = null;
    if (options.reset === true) {
      this.recoveryCountdownRemainingSec = RECOVERY_STEP_DURATION_SEC;
      this.recoveryMidpointCueSent = false;
      this.recoveryFinalCountCueSent = false;
      this.recoveryGuideCompleted = false;
    }
  },

  scheduleRecoveryCountdownTick(generation) {
    if (this.recoveryCountdownTimer) clearTimeout(this.recoveryCountdownTimer);
    this.recoveryCountdownTimer = setTimeout(() => {
      this.recoveryCountdownTimer = null;
      this.updateRecoveryCountdown(generation);
    }, 250);
  },

  beginRecoveryCountdown(durationSec = RECOVERY_STEP_DURATION_SEC, options = {}) {
    const seconds = Math.max(
      1,
      Math.min(RECOVERY_STEP_DURATION_SEC, Math.ceil(Number(durationSec) || 0)),
    );
    this.cancelRecoveryCountdown();
    if (options.preserveCues !== true) {
      this.recoveryMidpointCueSent = false;
      this.recoveryFinalCountCueSent = false;
    }
    this.recoveryGuideCompleted = false;
    this.recoveryCountdownRemainingSec = seconds;
    this.recoveryStepEndsAtMs = Date.now() + seconds * 1000;
    this.recoveryCountdownActive = true;
    const generation = (this.recoveryCountdownGeneration || 0) + 1;
    this.recoveryCountdownGeneration = generation;
    const finalWarmupStep = this.timedGuideKind === 'pre_run'
      && this.recoveryIndex >= this.currentGuideStepCount() - 1;
    this.setData({
      recoveryCountdown: String(seconds),
      recoveryCountdownUnit: '秒',
      recoveryAutoHint: options.resumed === true
        ? (finalWarmupStep
          ? '已继续 · 倒计时结束自动开跑'
          : '已继续 · 15秒后自动切换')
        : (finalWarmupStep
          ? '倒计时结束自动开跑'
          : '15秒后自动切换'),
    });
    this.scheduleRecoveryCountdownTick(generation);
    return true;
  },

  resumeRecoveryCountdown() {
    if (!this.isTimedGuidePhase()
        || this.pageVisible !== true
        || this.agentExitRequested
        || this.recoveryGuideCompleted === true) return false;
    return this.beginRecoveryCountdown(
      this.recoveryCountdownRemainingSec || RECOVERY_STEP_DURATION_SEC,
      { preserveCues: true, resumed: true },
    );
  },

  finishRecoveryCountdown() {
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown();
    this.recoveryGuideCompleted = true;
    this.recoveryCountdownRemainingSec = 0;
    const preRun = this.timedGuideKind === 'pre_run';
    const patch = {
      recoveryCountdown: '完成',
      recoveryCountdownUnit: '',
      recoveryAutoHint: preRun
        ? '热身完成 · 正在开跑'
        : '放松完成 · 请选择下一步',
      recoveryActionLabel: preRun ? '正在开跑' : '查看跑步总结',
      recoveryChoiceVisible: !preRun,
    };
    if (!preRun) {
      this.recoveryCompletionFocusIndex = 0;
      patch.recoverySummaryClass = 'recovery-choice-focused';
      patch.recoveryExitClass = '';
    }
    this.setData(patch);
    if (preRun) {
      // 跑前末项到点即开始跑步。proceedToHud/finishEntry 自带单向棘轮，
      // 可与最后一刻的手动“立即开跑”竞争而不会重复创建 session、传感器或计时器。
      // 不再排一条“请确认”语音，避免较慢的三二一播报尚未结束时叠加第二条 TTS。
      return this.proceedToHud({ suppressStartCue: true });
    }
    this.queueRecoverySpeech(RECOVERY_COMPLETION_TTS, { delayMs: 250 });
    return true;
  },

  advanceRecoveryStep(options = {}) {
    if (!this.isTimedGuidePhase()
        || this.agentExitRequested
        || this.recoveryIndex >= this.currentGuideStepCount() - 1) return false;
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown();
    const changed = this.applyRecoveryStep(this.recoveryIndex + 1);
    if (!changed) return false;
    this.beginRecoveryCountdown();
    this.queueRecoveryTts(this.recoveryIndex, {
      delayMs: options.automatic === true ? 350 : 0,
    });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  updateRecoveryCountdown(generation) {
    if (generation !== this.recoveryCountdownGeneration
        || this.recoveryCountdownActive !== true
        || this.pageVisible !== true
        || !this.isTimedGuidePhase()
        || this.agentExitRequested) return false;
    const remaining = Math.max(
      0,
      Math.ceil((Number(this.recoveryStepEndsAtMs) - Date.now()) / 1000),
    );
    if (remaining !== this.recoveryCountdownRemainingSec) {
      this.recoveryCountdownRemainingSec = remaining;
      this.setData({ recoveryCountdown: String(remaining) });
    }
    if (this.timedGuideSpeechEnabled()
        && remaining <= 7 && remaining > 3
        && this.recoveryMidpointCueSent !== true) {
      this.recoveryMidpointCueSent = true;
      const midpointCue = this.timedGuideKind === 'pre_run'
        ? getWarmupRhythmTtsCue(this.recoveryIndex, 7)
        : getRecoveryRhythmTtsCue(this.recoveryIndex, 7);
      if (midpointCue) this.playCueTts(midpointCue);
    }
    // 不再在末 3 秒派发无法取消的系统 TTS。视觉倒计时依旧逐秒
    // 显示，但自动换动作/进 HUD 后不会被“三二一”追播。
    if (remaining <= 0) {
      if (this.recoveryIndex >= this.currentGuideStepCount() - 1) {
        return this.finishRecoveryCountdown();
      }
      return this.advanceRecoveryStep({ automatic: true });
    }
    this.scheduleRecoveryCountdownTick(generation);
    return true;
  },

  cancelRecoveryTts() {
    this.recoveryTtsGeneration = (this.recoveryTtsGeneration || 0) + 1;
    if (this.recoveryTtsTimer) clearTimeout(this.recoveryTtsTimer);
    this.recoveryTtsTimer = null;
    this.recoveryTtsActive = false;
  },

  queueRecoverySpeech(cue, options = {}) {
    const text = String(cue || '').trim();
    if (!text || !this.timedGuideSpeechEnabled()) return false;
    if (this.recoveryTtsTimer) clearTimeout(this.recoveryTtsTimer);
    const generation = (this.recoveryTtsGeneration || 0) + 1;
    this.recoveryTtsGeneration = generation;
    this.recoveryTtsActive = true;
    const delayMs = Math.max(0, Math.min(1000, Number(options.delayMs) || 0));
    // AIUI has no TTS completion/cancel callback. Generation fences prevent
    // undispatched cues from surviving manual navigation, hide or exit.
    this.recoveryTtsTimer = setTimeout(() => {
      this.recoveryTtsTimer = null;
      if (generation !== this.recoveryTtsGeneration
          || this.recoveryTtsActive !== true
          || this.pageVisible !== true
          || !this.isTimedGuidePhase()
          || this.agentExitRequested) return;
      this.recoveryTtsActive = false;
      try { this.playCueTts(text); } catch (_e) {}
    }, delayMs);
    return true;
  },

  queueRecoveryTts(index, options = {}) {
    const cue = this.timedGuideKind === 'pre_run'
      ? getWarmupTtsCue(index, {
        includeIntro: options.includeIntro === true,
      })
      : getRecoveryTtsCue(index, {
        includeIntro: options.includeIntro === true,
      });
    return this.queueRecoverySpeech(cue, options);
  },

  startPreRunGuide() {
    if (!this.isSearchPhase()
        || this.entrySequenceStarted !== true
        || this.agentExitRequested) return false;
    this.clearPendingSurfaceGlobalHook();
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown({ reset: true });
    this.timedGuideKind = 'pre_run';
    this.applyRecoveryStep(0);
    this.setData({
      surfacePhase: 'pre_run',
      recoveryHeading: '跑前热身',
      recoveryOverview: WARMUP_OVERVIEW_COPY,
      guideQuickExitEnabled: this.timedGuideQuickExitEnabled(),
    });
    this.beginRecoveryCountdown();
    this.queueRecoveryTts(0, { includeIntro: true });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  startRecoveryGuide() {
    if (!this.isSummaryPhase() || this.agentExitRequested) return false;
    this.clearSummaryExitPrompt({ keepText: true });
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceActivationGate();
    this.cancelSummaryLlm();
    this.cancelRecoveryCountdown({ reset: true });
    this.timedGuideKind = 'recovery';
    this.recoveryCompletionFocusIndex = 0;
    this.applyRecoveryStep(0);
    this.setData({
      surfacePhase: 'recovery',
      recoveryHeading: '放松',
      recoveryOverview: RECOVERY_OVERVIEW_COPY,
      guideQuickExitEnabled: this.timedGuideQuickExitEnabled(),
      recoveryChoiceVisible: false,
      recoverySummaryClass: 'recovery-choice-focused',
      recoveryExitClass: '',
    });
    this.beginRecoveryCountdown();
    this.queueRecoveryTts(0, { includeIntro: true });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  onRecoveryTap() {
    if (!this.isTimedGuidePhase() || this.agentExitRequested) return false;
    if (this.recoveryGuideCompleted === true) {
      if (this.timedGuideKind === 'pre_run') return this.proceedToHud();
      return this.activateRecoveryCompletionFocused();
    }
    if (!this.timedGuideQuickExitEnabled()) return false;
    if (!this.claimSurfaceActivation('guide-quick-exit')) return false;
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown();
    this.recoveryIndex = Math.max(0, this.currentGuideStepCount() - 1);
    this.setData({
      recoveryProgress: String(this.currentGuideStepCount())
        + ' / ' + String(this.currentGuideStepCount()),
    });
    return this.finishRecoveryCountdown();
  },

  onRecoveryBack() {
    if (!this.isTimedGuidePhase() || this.agentExitRequested) return false;
    this.clearSurfaceActivationGate();
    if (this.recoveryIndex > 0) {
      this.cancelRecoveryTts();
      this.cancelRecoveryCountdown();
      const changed = this.applyRecoveryStep(this.recoveryIndex - 1);
      if (changed) {
        this.beginRecoveryCountdown();
        this.queueRecoveryTts(this.recoveryIndex);
        this.armSurfaceEntryInputGuard();
      }
      return changed;
    }
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown();
    if (this.timedGuideKind === 'pre_run') {
      return this.enterSearchReady({ fromWarmupBack: true });
    }
    this.timedGuideKind = null;
    this.setData({
      surfacePhase: 'summary',
      summaryExitText: SUMMARY_EXIT_COPY,
    });
    this.armSurfaceEntryInputGuard();
    return true;
  },

  isRecoveryChoicePhase() {
    return this.data.surfacePhase === 'recovery'
      && this.timedGuideKind === 'recovery'
      && this.recoveryGuideCompleted === true;
  },

  setRecoveryCompletionFocus(index) {
    if (!this.isRecoveryChoicePhase()) return false;
    const raw = Number(index) || 0;
    const next = ((raw % 2) + 2) % 2;
    this.recoveryCompletionFocusIndex = next;
    this.setData({
      recoverySummaryClass: next === 0 ? 'recovery-choice-focused' : '',
      recoveryExitClass: next === 1 ? 'recovery-choice-focused' : '',
    });
    return true;
  },

  onRecoveryChoiceFocus(event) {
    const index = event && event.currentTarget && event.currentTarget.dataset
      ? Number(event.currentTarget.dataset.index) : 0;
    if (!this.shouldAcceptHostFocus(
      'recovery',
      index,
      this.recoveryCompletionFocusIndex,
    )) return false;
    return this.setRecoveryCompletionFocus(index);
  },

  onRecoveryChoiceTap(event) {
    const index = event && event.currentTarget && event.currentTarget.dataset
      ? Number(event.currentTarget.dataset.index) : 0;
    if (!this.shouldAcceptHostFocus(
      'recovery',
      index,
      this.recoveryCompletionFocusIndex,
    )) return false;
    if (!this.setRecoveryCompletionFocus(index)) return false;
    if (!this.claimSurfaceActivation('recovery-choice-' + String(index))) return false;
    return this.activateRecoveryCompletionFocused();
  },

  showSummaryAfterRecovery() {
    if (!this.isRecoveryChoicePhase() || this.agentExitRequested) return false;
    this.clearPendingSurfaceGlobalHook();
    this.clearSurfaceActivationGate();
    this.cancelRecoveryTts();
    this.cancelRecoveryCountdown();
    this.timedGuideKind = null;
    this.summaryEnteredAtMs = Date.now();
    this.setData({
      surfacePhase: 'summary',
      recoveryChoiceVisible: false,
      summaryExitText: SUMMARY_EXIT_COPY,
    });
    this.armSurfaceEntryInputGuard();
    const summary = this.pendingSummarySnapshot;
    const wantsAi = !!fallbackRunSummary(summary)
      && (!this.runSettings || this.runSettings.aiSummary !== false);
    if (wantsAi && !this.summaryLlmSession
        && this.summaryLlmStartTimer == null
        && this.summaryLlmFlightGeneration == null
        && this.summaryLlmAttempted !== true) {
      this.summaryLlmStartTimer = setTimeout(() => {
        this.summaryLlmStartTimer = null;
        if (this.agentExitRequested || this.data.surfacePhase !== 'summary') return;
        this.generateSummaryAiText(summary);
      }, 80);
    }
    return true;
  },

  activateRecoveryCompletionFocused() {
    if (!this.isRecoveryChoicePhase()) return false;
    if (this.recoveryCompletionFocusIndex === 1) {
      return this.closeAgentFromSummary('recovery-skip-summary');
    }
    return this.showSummaryAfterRecovery();
  },

  clearSummaryExitPrompt(options = {}) {
    if (this.summaryExitPromptTimer) clearTimeout(this.summaryExitPromptTimer);
    this.summaryExitPromptTimer = null;
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    if (options.keepText !== true && this.isSummaryPhase()
        && this.data.summaryExitText !== SUMMARY_EXIT_COPY) {
      this.setData({ summaryExitText: SUMMARY_EXIT_COPY });
    }
  },

  armSummaryExitPrompt(now = Date.now()) {
    this.summaryExitArmedAtMs = now;
    this.setData({ summaryExitText: '再按确认键退出' });
    if (this.summaryExitPromptTimer) clearTimeout(this.summaryExitPromptTimer);
    this.summaryExitPromptTimer = setTimeout(() => {
      this.summaryExitPromptTimer = null;
      this.summaryExitArmedAtMs = null;
      this.lastSummaryConfirmKeyMs = null;
      this.summaryTouchTapAtMs = null;
      if (this.isSummaryPhase() && !this.agentExitRequested) {
        this.setData({ summaryExitText: SUMMARY_EXIT_COPY });
      }
    }, END_CONFIRM_WINDOW_MS);
  },

  onSummaryConfirmKey(code = '') {
    if (!this.isSummaryPhase() || this.agentExitRequested) return false;
    const now = Date.now();
    // 结束跑步的第二次确认可能在 summary 首帧后再尾随一个 Enter 别名。
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
        return this.closeAgentFromSummary('summary-double-tap');
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
      return this.closeAgentFromSummary('summary-double-confirm');
    }
    this.armSummaryExitPrompt(now);
    return false;
  },

  cancelSummaryLlm() {
    this.summaryLlmGeneration = (this.summaryLlmGeneration || 0) + 1;
    if (this.summaryLlmStartTimer != null) clearTimeout(this.summaryLlmStartTimer);
    this.summaryLlmStartTimer = null;
    // availability()/create() 也可能悬空且此时尚无 session 可 destroy。释放的
    // 必须是旧 generation 的 single-flight；旧 finally 只按自己的 generation
    // 清理，不能覆盖随后重新进入总结页建立的新 flight。
    this.summaryLlmFlightGeneration = null;
    const sessionRecord = this.summaryLlmSession;
    this.summaryLlmSession = null;
    this.destroySummaryLlmSession(sessionRecord);
  },

  destroySummaryLlmSession(sessionRecord) {
    if (!sessionRecord || sessionRecord.destroyed === true) return false;
    // cancelSummaryLlm() 与 askSummaryLlm() 的 finally 可能在同一原生会话上竞态。
    // 销毁位必须跟随该次 create() 的记录，而不能只依赖当前活动指针；否则退出
    // 先清指针并 destroy 后，迟到的 prompt 兑现仍会在 finally 二次 destroy。
    sessionRecord.destroyed = true;
    const session = sessionRecord.session;
    if (!session || typeof session.destroy !== 'function') return false;
    try {
      session.destroy();
      return true;
    } catch (_e) {
      return false;
    }
  },

  beginTerminalBleCleanup() {
    if (this.terminalBleCleanupPromise) return this.terminalBleCleanupPromise;
    try {
      return this.teardownBle({ terminal: true });
    } catch (error) {
      this.bleDebug('BLE_TEARDOWN_FAILED', 'reason=' + this.bleErrorText(error));
      this.terminalBleCleanupPromise = Promise.resolve(false);
      return this.terminalBleCleanupPromise;
    }
  },

  sealBleForSummary() {
    // 只做内存门禁，不触碰原生 bridge：在 summary 首帧前同步封死所有在途扫描、
    // connect、notify 和 RSC 探测，实际 stop/disconnect 留给首帧后的唯一清理链。
    this.bleTerminated = true;
    this.bleOperationGeneration = (this.bleOperationGeneration || 0) + 1;
    this.beginBleSelection('summary-seal');
    this.autoConnectPending = false;
    this.autoConnectSelectionGeneration = null;
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    this.connectAttemptId = (this.connectAttemptId || 0) + 1;
    this.connectingAttemptId = null;
    this.connectingSelectionGeneration = null;
    this.connectingSelectionSource = null;
    this.clearScanRetryTimer();
    this.rscProbeGeneration = (this.rscProbeGeneration || 0) + 1;
    this.rscProbeRetryAtMs = null;
    return true;
  },

  dispatchAgentExit() {
    if (this.agentExitDispatched || this.agentExitDispatching) return false;
    if (this.agentExitRequested && this.isSummaryPhase()
        && this.summaryExitPersistenceConfirmed !== true) {
      this.bleDebug('AGENT_EXIT_DEFERRED', 'reason=summary-storage-unconfirmed');
      return false;
    }
    this.agentExitDispatching = true;
    this.clearAgentExitTimer();
    this.bleDebug('AGENT_EXIT_DISPATCH', 'method=wx.exitMiniProgram');
    try {
      // 文档声明 options 可选；v0.15 尝鲜真机绑定实际要求一个参数。
      wx.exitMiniProgram({});
      this.agentExitDispatched = true;
      this.agentExitDispatching = false;
      return true;
    } catch (error) {
      this.bleDebug('AGENT_EXIT_FAILED', 'reason=' + this.bleErrorText(error));
      // finish() 是 v0.14.0 官方页面任务完成能力，仅作 exitMiniProgram 同步抛错的降级。
      try {
        if (typeof this.finish === 'function') {
          this.finish();
          this.agentExitDispatched = true;
          this.agentExitDispatching = false;
          return true;
        }
      } catch (_e) {}
      this.agentExitDispatching = false;
      this.agentExitRequested = false;
      return false;
    }
  },

  closeAgentFromSummary(source = 'summary-backspace') {
    if (this.agentExitRequested) return false;
    const requiresSummaryPersistence = this.isSummaryPhase() && !!(
      this.pendingSummarySnapshot
      || this.runUploadQueued
      || this.calibrationStream
      || (Array.isArray(this.calibrationCaptureBuffer)
        && this.calibrationCaptureBuffer.length)
    );
    // 总结首帧已经同步提交，但 storage / 上传入队原本由 setTimeout(0)
    // 延后执行。用户若在首帧出现后立即返回，宿主可能先触发 onUnload 并取消
    // finalizer；退出位一旦武装，onUnload 又不会重复入队，导致整场记录丢失。
    // 因此退出请求必须先把已冻结的总结同步写入本地队列，再进入原生清理链。
    const locallyStored = !requiresSummaryPersistence
      || this.persistSummaryQueues();
    this.summaryExitPersistenceConfirmed = locallyStored;
    this.agentExitRequested = true;
    this.backspaceHandled = true;
    this.pageVisible = false;
    this.bleDebug('AGENT_EXIT_REQUEST', 'source=' + source);
    this.clearSummaryExitPrompt({ keepText: true });
    this.cancelSummaryLlm();
    this.clearSurfaceTimers();
    this.clearHudReconnectTimer();
    this.reconnectDevice = null;
    this.stopTicker();
    try { this.stopAccel(); } catch (_e) {}
    try { this.stopMetronomePlayback({ destroy: true }); } catch (_e) {}
    try {
      if (this.ownerScopedRunWriteAllowed()) clearLiveSnapshot(wx);
    } catch (_e) {}
    // 复用“进入总结页”已经启动的唯一 terminal 清理链；不要二次 teardown 后
    // 误以为已等待原始 2A37/2A53 stopNotifications。
    const cleanup = this.beginTerminalBleCleanup();
    const finishExit = () => {
      if (!this.agentExitRequested || this.agentExitDispatched) return false;
      this.summaryExitPersistenceConfirmed = true;
      // 用户可在总结首帧出现后立即退出，早于 setTimeout(0) finalizer。此处也
      // 复用总结页唯一的 Hermes 协调器，一次启动跑步汇总与校准日志两类批量
      // 补传；800ms 退出硬兜底不等待慢网络，
      // 未明确 ACK 的事件仍留在本地，下一次首页继续补传。
      let summaryUploadFlight = null;
      try {
        summaryUploadFlight = this.startSummaryHermesUploads(
          true,
          { allowDuringExit: true },
        );
      } catch (_e) {}
      // 只有本地两条队列都写后读回确认后才武装硬兜底。storage 瞬时异常
      // 先在总结页内有界重试，不能为了 800ms 退出把整场内存样本直接丢掉。
      this.clearAgentExitTimer();
      this.agentExitTimer = setTimeout(
        () => this.dispatchAgentExit(),
        BLE_EXIT_CLEANUP_WAIT_MS,
      );
      Promise.all([
        Promise.resolve(cleanup).catch(() => false),
        Promise.resolve(summaryUploadFlight).catch(() => false),
      ]).then(() => this.dispatchAgentExit());
      return true;
    };
    if (locallyStored) {
      finishExit();
    } else {
      this.setData({
        summaryUploadText: '日志保存中 · 正在重试',
        summaryExitText: '正在保存，请稍候',
      });
      this.retrySummaryPersistence().then((stored) => {
        if (!this.agentExitRequested || this.agentExitDispatched) return;
        if (stored) {
          finishExit();
          return;
        }
        // storage 持续不可用时保持总结页和内存样本，让用户稍后再按返回重试。
        // BLE/传感器已安全停止，不会继续生成或覆盖本场数据。
        this.clearAgentExitTimer();
        this.summaryExitPersistenceConfirmed = false;
        this.agentExitRequested = false;
        this.backspaceHandled = false;
        this.pageVisible = true;
        this.setData({
          summaryUploadText: '日志保存失败 · 请重试',
          summaryExitText: '保存失败，请再按返回重试',
        });
      });
    }
    return true;
  },

  // HUD 内确认键 = 结束跑步入口(3 次独立确认防误触)。设备验证事实:宿主把确认手势派发
  // 为 GlobalHook keyup(首页"按确认键进入"同一通道);Enter/NumpadEnter 兼容收下。
  onHudConfirmKey() {
    if (this.data.surfacePhase !== 'hud' || !this.data.running) return false;
    const now = Date.now();
    // 进入 HUD 的那次确认手势的尾随 keyup 不得当成"结束"的第一次确认。
    if (this.hudEnteredAtMs != null
        && now - this.hudEnteredAtMs < HUD_CONFIRM_GRACE_MS) return false;
    if (this.endArmedAtMs != null
        && now - this.endArmedAtMs > END_CONFIRM_WINDOW_MS) {
      this.resetHudEndConfirmation();
    }
    if (this.lastConfirmKeyMs != null
        && now - this.lastConfirmKeyMs < HUD_CONFIRM_INDEPENDENT_GAP_MS) return false;
    if (this.endArmedAtMs == null) this.endArmedAtMs = now;
    this.lastConfirmKeyMs = now;
    this.hudEndConfirmCount = Math.min(
      HUD_CONFIRM_REQUIRED_COUNT,
      Math.max(0, Number(this.hudEndConfirmCount) || 0) + 1,
    );
    if (this.hudEndConfirmCount >= HUD_CONFIRM_REQUIRED_COUNT) {
      this.resetHudEndConfirmation({ clearHint: false });
      return this.finishRunToRecovery();
    }
    // 反馈走 HUD 顶部提示位(coachLine 在极简 HUD 里没有渲染绑定,写它用户看不见)。
    this.setData({
      hudHint: this.hudEndConfirmCount === 1 ? '再按2次结束' : '再按1次结束',
    });
    return false;
  },

  buildSummaryChart(snapshot, avgCadence) {
    const slow = this.isSlowJogMode();
    let data = Array.isArray(this.minuteSeries) ? this.minuteSeries.slice(-12) : [];
    if (!data.length) {
      const fallback = slow
        ? Number(avgCadence)
        : (snapshot ? Number(snapshot.avgPaceSecPerKm) : 0);
      if (fallback > 0 && Number.isFinite(fallback)) {
        data = [{ minute: 1, value: Math.round(fallback) }];
      }
    }
    const values = data.map((item) => Number(item.value)).filter((value) => value > 0);
    const padding = slow ? 10 : 30;
    const minimum = values.length
      ? Math.max(0, Math.floor(Math.min(...values) - padding)) : 0;
    const maximum = values.length
      ? Math.ceil(Math.max(...values) + padding) : (slow ? 200 : 900);
    const firstMinute = data.length ? data[0].minute : 1;
    const lastMinute = data.length ? data[data.length - 1].minute : 2;
    return {
      summaryChartTitle: slow ? '每分钟步频' : '每分钟配速',
      summaryChartUnit: slow ? '步/分钟' : '秒/公里',
      summaryChartData: data,
      summaryChartYAxis: { minimum, maximum: Math.max(maximum, minimum + 1) },
      summaryChartXAxis: { minimum: firstMinute, maximum: Math.max(lastMinute, firstMinute + 1) },
    };
  },

  finalizeRunAfterSummaryCommit(summary, wantsAi) {
    if (this.runFinalizationStarted) return false;
    this.runFinalizationStarted = true;
    this.summaryFinalizeTimer = null;
    // 这些调用可能跨 storage / sensor / audio / BLE 原生桥，全部放在 summary
    // 首帧提交之后；任何一个变慢都不再阻塞总结 UI 和退出按键注册。
    // queueRunForUpload() 会优先读取 pendingSummarySnapshot；保持无参调用，
    // 也让发布 Doctor 能静态确认总结首帧之后仍存在完整的延迟收场链。
    const locallyStored = this.persistSummaryQueues();
    // 本地两条 durable 记录都写后读回后，才向用户宣称“日志已保存”并启动
    // Hermes；上传状态独立于下方 AI 点评状态，任一路失败都不改写点评文案。
    if (locallyStored) {
      this.startSummaryHermesUploads(true);
    } else {
      this.setData({ summaryUploadText: '日志保存中 · 正在重试' });
      this.retrySummaryPersistence().then((stored) => {
        if (!this.isSummaryPhase() || this.runOwnerInvalidated) return;
        if (stored) {
          this.startSummaryHermesUploads(true);
        } else if (!this.agentExitRequested) {
          this.setData({ summaryUploadText: '日志保存失败 · 请重试' });
        }
      });
    }
    try { this.stopAccel(); } catch (_e) {}
    try { this.stopMetronomePlayback({ destroy: true }); } catch (_e) {}
    try {
      if (this.ownerScopedRunWriteAllowed()) clearLiveSnapshot(wx);
    } catch (_e) {}
    this.beginTerminalBleCleanup();
    if (wantsAi && !this.agentExitRequested
        && this.data.surfacePhase === 'summary'
        && !this.summaryLlmSession
        && this.summaryLlmStartTimer == null
        && this.summaryLlmFlightGeneration == null
        && this.summaryLlmAttempted !== true) {
      this.summaryLlmStartTimer = setTimeout(() => {
        this.summaryLlmStartTimer = null;
        if (this.agentExitRequested || this.backspaceHandled
            || this.data.surfacePhase !== 'summary') return;
        this.generateSummaryAiText(summary);
      }, 80);
    }
    return true;
  },

  // HUD 三次独立确认：同路由切到 04 总结页。
  // 先提交完整本地总结和退出入口，再异步存储、清资源和用 AI 原位升级。
  finishRunToSummary() {
    if (this.data.surfacePhase !== 'hud') return false;
    this.resetHudEndConfirmation({ clearHint: false });
    if ((this.runOwnerGeneration || 0) > 0) {
      this.reconcileRunOwnerContext('finish-summary');
      if (this.runOwnerInvalidated) return false;
    }
    this.clearSurfaceTimers();
    this.clearHudReconnectTimer();
    this.reconnectDevice = null;
    this.clearHrWatchdogTimer();
    const now = Date.now();
    const s = this.session;
    const motion = this.motionMetrics ? this.motionMetrics.snapshot(now) : null;
    this.captureAiuiCalibrationSnapshot(now, motion, {
      force: true,
      deferPersist: true,
    });
    this.summaryCalibrationStreamId = this.calibrationStream
      ? String(this.calibrationStream.streamId || '') : '';
    this.summaryClientRunId = '';
    const summaryMotion = this.resolveSummaryMotion(now, motion);
    if (s && motion) s.distanceM = motion.distanceM;
    const snap = s ? s.snapshot(now) : null;
    if (snap) {
      snap.avgPaceSecPerKm = summaryMotion.avgPaceSecPerKm;
    }
    const avgBpm = s ? s.avgBpm() : 0;
    const avgCadence = Math.round(summaryMotion.avgCadenceSpm || 0);
    const slow = this.isSlowJogMode();
    const steps = this.motionMetrics
      ? Math.max(0, Math.round(Number(this.motionMetrics.acceptedSteps) || 0)) : 0;
    if (this.workoutExecution) {
      this.workoutExecution = advanceWorkoutExecution(this.workoutExecution, {
        type: 'tick',
        nowMs: now,
        bpm: avgBpm > 0 ? avgBpm : null,
        cadenceSpm: avgCadence > 0 ? avgCadence : null,
      });
      this.workoutExecution = finishWorkoutExecution(this.workoutExecution, now);
      this.completedWorkoutExecution = this.workoutExecution;
      this.persistWorkoutCheckpoint(true, now);
    }
    const pendingSummary = snap ? {
      mode: this.persistedRunMode(),
      startedAtMs: s ? s.startMs : 0,
      elapsedMs: snap.elapsedMs,
      distanceM: slow ? 0 : snap.distanceM,
      avgPaceSecPerKm: slow ? null : snap.avgPaceSecPerKm,
      avgBpm,
      maxBpm: s ? s.maxBpm() : 0,
      avgCadenceSpm: summaryMotion.avgCadenceSpm || 0,
      steps,
      minuteSeries: Array.isArray(this.minuteSeries) ? this.minuteSeries.slice() : [],
      endedAtMs: now,
      heartRatePolicy: this.frozenHeartRatePolicy,
    } : null;
    const quickText = fallbackRunSummary(pendingSummary);
    const wantsAi = !!quickText
      && (!this.runSettings || this.runSettings.aiSummary !== false);
    this.sealBleForSummary();
    this.clearSummaryHermesRetry();
    this.summaryHermesRetryAttempt = 0;
    this.summaryEnteredAtMs = now;
    this.summaryExitArmedAtMs = null;
    this.lastSummaryConfirmKeyMs = null;
    this.summaryTouchTapAtMs = null;
    this.pendingSummarySnapshot = pendingSummary;
    this.runFinalizationStarted = false;
    this.summaryLlmAttempted = false;
    this.summaryExitPersistenceConfirmed = false;
    this.setData({
      surfacePhase: 'summary',
      running: false,
      paused: false,
      // 连接状态一并收场:迟到的 onShow 才不会对着已拆除的连接重挂看门狗。
      bleState: 'idle',
      hudHint: '',
      runWarmupHint: '',
      paceConnected: false,
      workoutActive: false,
      workoutStageLabel: '',
      workoutProgressText: '',
      sumDist: slow ? String(steps) : (snap ? formatDistanceKm(snap.distanceM) : '0.00'),
      sumElapsed: snap ? formatElapsed(snap.elapsedMs) : '00:00',
      sumPace: slow
        ? (avgCadence > 0 ? String(avgCadence) : '--')
        : (snap && snap.avgPaceSecPerKm > 0 ? formatPace(snap.avgPaceSecPerKm) : '--'),
      sumStat: slow
        ? (avgBpm > 0 ? String(Math.round(avgBpm)) : '--')
        : (avgCadence > 0 ? String(avgCadence) : '--'),
      sumStatLabel: slow ? '平均心率' : '平均步频',
      sumMetricOneLabel: slow ? '步数' : '公里',
      sumMetricTwoLabel: '用时',
      sumMetricThreeLabel: slow ? '平均步频' : '配速',
      sumMetricFourLabel: slow ? '平均心率' : '平均步频',
      ...this.buildSummaryChart(snap, avgCadence),
      // 第一帧始终有完整本地点评；AI 只做稍后的原位升级，绝不再用加载文案
      // 占住总结正文或阻塞退出。
      sumAiText: quickText || '时间较短，下次再战！',
      sumAiState: quickText ? '本地总结' : '本地点评',
      // 首帧尚未跨 storage 桥，不提前宣称已保存；0ms finalizer 完成写后读回
      // 后再切为上传中 / 已上传 / 待补传。
      summaryUploadText: '日志整理中',
      summaryExitText: SUMMARY_EXIT_COPY,
    });
    // 总结首帧已经同步提交；现场日志随后强制补终点帧并封存。任何 storage
    // 异常只留作本地诊断，不得改变总结、BLE 清理或退出路径。
    this.finishRunningLocalFieldCapture(pendingSummary, motion, now);
    this.stopTicker();
    this.summaryFinalizeTimer = setTimeout(
      () => this.finalizeRunAfterSummaryCommit(pendingSummary, wantsAi),
      0,
    );
    return true;
  },

  // 正常结束路径先冻结总结和启动 durable 保存，再立即显示跑后放松。
  // 这样日志上传、AI 点评与 BLE 清理都在后台继续，不占住用户的恢复交互。
  finishRunToRecovery() {
    if (!this.finishRunToSummary()) return false;
    return this.startRecoveryGuide();
  },

  // 总结页 Tier1:兜底已上屏,AI 文本到达后原位升级,并把文本写回后台归档待办，
  // 下次前台代次不二次生成，但归档前仍会重新过安全门，也不会改写首页。全程 best-effort。
  async generateSummaryAiText(summary) {
    if (!summary || this.summaryLlmAttempted === true
        || this.summaryLlmFlightGeneration != null) return;
    const runOwnerGeneration = this.runOwnerGeneration || 0;
    if (!this.ownerScopedRunWriteAllowed(runOwnerGeneration)) return;
    const generation = (this.summaryLlmGeneration || 0) + 1;
    this.summaryLlmGeneration = generation;
    // 一场跑步的总结最多请求模型一次。即使第一条请求很快完成，遗留的另一
    // 个 80ms 调度器也只能看到这个棘轮，不能顺序再建第二、第三个会话。
    this.summaryLlmAttempted = true;
    // 在第一个 await 之前同步占住 flight；否则两个 80ms 调度器都可能在
    // availability/create 尚未产出 session 的窗口里各启动一次模型会话。
    this.summaryLlmFlightGeneration = generation;
    let text = '';
    let deadlineTimer = null;
    // Do not put network retrieval on the visible summary critical path. The
    // most recent owner-scoped local summaries are available synchronously and
    // provide deterministic cross-run context; the resulting record continues
    // to upload to EverMind best-effort in the background.
    const memoryContext = buildLocalRunMemoryContext(wx, {
      language: 'zh-CN',
    });
    try {
      try {
        text = await Promise.race([
          this.askSummaryLlm(summary, memoryContext, generation),
          new Promise((resolve) => {
            deadlineTimer = setTimeout(() => resolve(''), SUMMARY_LLM_TIMEOUT_MS + 2000);
          }),
        ]);
      } catch (_e) { text = ''; }
      // 已离开总结页:不再碰本页,也不重写已被后台消费的待办。
      // backspaceHandled 在 Backspace keyup 同步置位 —— 设备上 onHide/onUnload 不保证派发,
      // 只有它能确定性关掉"迟到的 LLM 回写复活已消费待办"这条竞态。
      // 注意:仅息屏(仍停在总结页)不算离开——照常落文本,亮屏即见,只是不出声。
      if (generation !== this.summaryLlmGeneration
          || this.agentExitRequested
          || this.backspaceHandled === true
          || !this.isSummaryPhase()) return;
      if (!this.ownerScopedRunWriteAllowed(runOwnerGeneration)) return;
      const safeText = finalizeRunSummaryText(summary, text);
      const finalText = safeText.text || fallbackRunSummary(summary);
      if (!finalText) return;
      this.setData({
        sumAiText: finalText,
        sumAiState: safeText.usedModel ? 'AI 点评' : '本地点评',
      });
      // Rokid 本地 TTS 播报最终总结(遵循语音提示开关):AI 到了念 AI,超时/失败念兜底。
      if (this.pageVisible) {
        try { this.playCueTts(finalText); } catch (_e) {}
      }
      if (safeText.usedModel && this.ownerScopedRunWriteAllowed(runOwnerGeneration)) {
        writePendingRunSummary(wx, { ...summary, text: finalText });
      }
    } finally {
      if (deadlineTimer != null) clearTimeout(deadlineTimer);
      if (this.summaryLlmFlightGeneration === generation) {
        this.summaryLlmFlightGeneration = null;
      }
    }
  },

  async askSummaryLlm(summary, memoryContext = '',
    generation = this.summaryLlmGeneration) {
    if (typeof LanguageModel === 'undefined') return '';
    const availability = await LanguageModel.availability();
    if (generation !== this.summaryLlmGeneration || this.agentExitRequested
        || availability !== 'available') return '';
    const session = await LanguageModel.create({
      initialPrompts: [{
        role: 'system',
        content: '你是眼镜端跑步教练。只描述给出的事实，可提示恢复或稳定节奏；'
          + '不作医疗诊断，不承诺或建议提速，不猜测个人心率区间。'
          + '中文回答，不超过40个字，不用列表或表情。',
      }],
    });
    const sessionRecord = { session, destroyed: false };
    if (generation !== this.summaryLlmGeneration || this.agentExitRequested) {
      this.destroySummaryLlmSession(sessionRecord);
      return '';
    }
    this.summaryLlmSession = sessionRecord;
    let timer = null;
    try {
      const reply = await Promise.race([
        session.prompt(buildRunSummaryPrompt(summary, memoryContext)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(''), SUMMARY_LLM_TIMEOUT_MS); }),
      ]);
      return String(reply || '').trim();
    } finally {
      if (timer != null) clearTimeout(timer);
      if (this.summaryLlmSession === sessionRecord) this.summaryLlmSession = null;
      // 超时后底层流式请求不会自己停:destroy() 是文档给的唯一关闭活动任务手段。
      this.destroySummaryLlmSession(sessionRecord);
    }
  },

  // 生命周期/按键信标：02 屏设备列表头部的可见轨迹(L→S→R/F→C→A→V→按键码),
  // 真机上一眼定位"渲染之后到底走到了哪一步"。只在 02 阶段更新。
  // 结构约定(勿回退)：role=navigation 只落在 .connect-next-nav 静态按钮行——
  // 官方样例全仓 39 处 nav 容器的唯一模式是"字面量 class、无 ink:if、内容静态、
  // 只包 button"；整屏动态容器若挂 navigation,真机焦点登记会被每秒重绘打掉。
  markBeacon(tag) {
    if (!this.isSearchPhase()) return;
    const prev = this.data.keyBeacon || '';
    const next = prev ? prev + '·' + tag : String(tag);
    this.setData({ keyBeacon: next.length > 64 ? next.slice(-64) : next });
  },

  onHostFocus() {
    // AIUI 的宿主焦点会话可能在同一次物理滑动的 keydown / keyup 之间重建。
    // 焦点切换不参与方向提交，方向只在 onKeyUp 中处理一次。
    this.hostFocused = true;
    this.bleDebug('HOST_FOCUS', String(this.data.surfacePhase || ''));
    if (!this.pageVisible || this.bleTerminated === true
        || this.backspaceHandled === true || this.isSummaryPhase()) return;

    // 焦点恢复只继续用户已经建立的链路：HUD/入场重连、HRS 单路恢复
    // 与同一 GATT 上的 RSC 诊断。扫描重试和候选自动连接不会因 focus
    // 自动重启，避免一次焦点重建被解释成新的用户搜索。
    if (this.data.bleState === 'connected') {
      this.scheduleHrWatchdog();
      if (this.hrDegradedByRsc === true && this.isRscDataFresh()) {
        this.scheduleHrNotificationRecovery();
      }
      if (!this.isSlowJogMode()) {
        if (this.rscCharacteristic) {
          this.scheduleRscSilentDiagnostic(
            this.lastRscAtMs != null ? this.lastRscAtMs : this.rscSubscribedAtMs,
          );
        } else if (!this.rscProbePromise && this.bleDevice
            && (this.rscProbeRetryAtMs == null
              || Date.now() >= this.rscProbeRetryAtMs)) {
          this.probeOptionalRsc(this.bleDevice, this.bleServer);
        }
      }
    }
    if (this.reconnectDevice && this.data.bleState === 'idle'
        && (this.hudReconnectCount || 0) < HUD_RECONNECT_MAX
        && ((this.data.surfacePhase === 'hud' && this.data.running)
          || this.isEntryGattPhase())) {
      this.scheduleHudReconnect(this.reconnectDevice);
    }
  },

  onHostBlur() {
    // 只取消尚未判定的轻触，不清方向去重历史。新版宿主可能在一次滑动中短暂
    // blur/focus；若此处清历史，迟到的重复方向 keyup 会被误认成第二次滑动。
    // 同一次焦点重建也不能清掉 pending GlobalHook 已建立的 600ms 尾包门，
    // 否则迟到 TouchEnd/bindtap 会在方向码到达前误激活旧原生焦点。
    this.hostFocused = false;
    if (this.autoConnectTimer) clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
    if (this.scanRetryTimer) this.scanRetryDeferredByHostBlur = true;
    this.clearScanRetryTimer();
    this.clearHudReconnectTimer();
    this.clearHrWatchdogTimer();
    this.cancelHrNotificationRecovery('host-blur');
    if (this.rscSilentTimer || this.rscCharacteristic) {
      this.rscSilentDeferredByHostBlur = true;
    }
    this.clearRscSilentTimer();
    const guardUntilMs = this.surfaceEntryConfirmGuardUntilMs;
    this.clearPendingSurfaceGlobalHook();
    this.surfaceEntryConfirmGuardUntilMs = guardUntilMs;
    this.bleDebug('HOST_BLUR', String(this.data.surfacePhase || ''));
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (!this.isSurfaceDirectionCode(code) || !this.canHandleSurfaceDirection()) return;
    // 官方导航契约把可替代的焦点迁移和宿主默认拦截统一放在 keyup。
    // keydown 只做可观测诊断，避免宿主焦点重建后同一滑动被提交两次。
    this.bleDebug('DIRECTION_KEYDOWN', String(code));
  },

  onKeyUp(event) {
    const code = event && event.code;
    // 02/菜单 Backspace 仍由宿主返回；HUD Backspace 只阻止宿主弹栈并
    // 重置结束确认进度，不再绕过“三次独立确认”直接结束。
    if (code) this.bleDebug('KEY', String(code));
    // 双击退出已开始后，宿主迟到的 Enter/bindtap/方向尾包都不得复活扫描或开跑。
    if (this.agentExitRequested) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }
    if (code === 'Backspace') {
      this.clearPendingSurfaceGlobalHook();
      if (this.isTimedGuidePhase()) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.onRecoveryBack();
        return;
      }
      if (this.isSummaryPhase()) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.closeAgentFromSummary('summary-backspace');
        return;
      }
      if (this.data.surfacePhase === 'binding') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.showSettingsFromBinding();
        return;
      }
      if (this.data.surfacePhase === 'settings') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.showFeatureMenu();
        return;
      }
      if (this.data.surfacePhase === 'training') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.showFeatureMenu();
        return;
      }
      if (this.data.surfacePhase === 'hud') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        this.resetHudEndConfirmation();
        this.setData({ hudHint: '请按确认键3次结束' });
        return;
      }
      // Backspace 仍保留为双击手势之外的硬件兜底：第一下不拦截，由宿主回首页；
      // 首页消费 3 秒标记后等待第二下 Backspace 退出。
      if (this.isSearchPhase()) writeScanExitHint(wx);
      if (this.ownerScopedRunWriteAllowed()) markHostBackspaceIntent(wx, 'run_hud');
      this.finishRunForHostBack();
      return;
    }
    // 总结页保留原有 Backspace / 双击 / 双确认退出；向前划是独立的
    // “查看拉伸”入口，不占用确认键，也不会误触退出。
    if (this.isSummaryPhase() && this.timedGuideKind !== 'recovery'
        && (code === 'ArrowDown' || code === 'ArrowRight')) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.startRecoveryGuide();
      return;
    }
    if (this.isSurfaceDirectionCode(code) && this.canHandleSurfaceDirection()) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      // 单一提交点：无论宿主是否先派发 keydown、是否在中途重建焦点，
      // 一次物理滑动都只在 keyup 改变一次页面焦点。
      this.handleSurfaceDirection(code, Date.now(), 'keyup');
      return;
    }
    const isStableConfirm = code === 'Enter' || code === 'NumpadEnter'
      || code === 'Space';
    const isSurfaceConfirm = isStableConfirm || code === 'GlobalHook';
    if (this.isTimedGuidePhase() && !this.isRecoveryChoicePhase()
        && isSurfaceConfirm) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.onRecoveryTap();
      return;
    }
    // 总结页与 AI/图表加载完全解耦：返回键单击退出；确认键连续两次也可退出。
    // GlobalHook + Enter 等同一次物理按压的别名由独立 400ms 窗口收敛。
    if (this.isSummaryPhase() && !this.isTimedGuidePhase() && isSurfaceConfirm) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.onSummaryConfirmKey(code);
      return;
    }
    const isMultiTarget = this.isMultiTargetSurface();
    // 官方 samples 把滑动与轻拍视为两种动作。部分真机先发 GlobalHook，随后才
    // 确定它是方向滑动还是独立轻拍；新版宿主可能把方向码延迟到 220ms 以后，
    // 因此多目标页统一等满 600ms。搜索页仍只把 90–420ms 内第二击判为双击退出。
    // 等待窗口内方向码会取消待定确认，只留下焦点移动。
    if (code === 'GlobalHook' && isMultiTarget) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.deferSurfaceGlobalHook(Date.now());
      return;
    }
    // 同一轻拍若还派发稳定确认键，菜单/设置由稳定键接管；搜索页则继续等待
    // 单/双击判别，避免稳定键和原生 bindtap 抢先提交第一次单击。
    const isPendingSearchTapAlias = isStableConfirm
      && this.isSearchPhase()
      && this.pendingSurfaceGlobalHookTimer
      && this.pendingSurfaceGlobalHookPhase === this.data.surfacePhase;
    if (isPendingSearchTapAlias) {
      // 某些宿主会为同一次镜腿轻触补发 Enter/NumpadEnter/Space。搜索页必须继续
      // 等待单/双击判别，不能让这个别名走原生 bindtap 抢先执行第一次单击。
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }
    if (isStableConfirm && isMultiTarget) this.clearPendingSurfaceGlobalHook();
    // 搜索页主操作区只有一个原生 button：标准确认键遵循 AIUI Native
    // Single-Action，由宿主触发 bindtap；GlobalHook 才走页面替代动作。
    // 绑定页有“刷新/导出”两个目标，必须由页面焦点激活。
    if (isSurfaceConfirm && code !== 'GlobalHook'
        && this.isSearchPhase() && this.searchFocusIndex === 0) return;
    if (isSurfaceConfirm
        && (this.data.surfacePhase === 'menu'
          || this.data.surfacePhase === 'training'
          || this.data.surfacePhase === 'settings'
          || this.isRecoveryChoicePhase()
          || this.data.surfacePhase === 'binding'
          || this.isSearchPhase())) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (this.data.surfacePhase === 'menu' && this.isMenuEntryInputGuarded(now)) {
        // 不写 lastSurfaceConfirmKeyMs：被隔离的是上一页手势尾包，不应让它
        // 延长本页正常确认的 400ms 去重窗口。
        this.bleDebug('KEY_HANDOFF_IGNORED', String(code));
        return;
      }
      if (this.isSurfaceEntryInputGuarded(now)) {
        this.bleDebug('INPUT_ENTRY_IGNORED', String(code));
        return;
      }
      if (this.lastSurfaceConfirmKeyMs != null
          && now - this.lastSurfaceConfirmKeyMs < SURFACE_CONFIRM_DEDUPE_MS) return;
      this.lastSurfaceConfirmKeyMs = now;
      if (this.data.surfacePhase === 'menu'
          || this.data.surfacePhase === 'training'
          || this.data.surfacePhase === 'settings'
          || this.data.surfacePhase === 'binding'
          || this.isRecoveryChoicePhase()
          || this.isSearchPhase()) {
        this.activateMultiTargetFocused();
        return;
      }
    }
    // HUD 的三次独立确认是页面完整替代动作：前两次给明确进度，
    // 第三次原路切总结。每次都拦截 keyup，防止宿主默认动作弹出沉浸页。
    if (this.data.surfacePhase === 'hud' && this.data.running
        && (code === 'GlobalHook' || code === 'Enter' || code === 'NumpadEnter')) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.onHudConfirmKey();
      return;
    }
  },
};
</script>

<page>
  <view class="immersive-root">
  <view class="feature-menu {{ menuLayoutClass }}" ink:if="{{ surfacePhase === 'menu' }}">
    <view class="feature-head">
      <view class="feature-brand">
        <image class="feature-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
        <text class="feature-name">跑步教练</text>
      </view>
      <text class="feature-chip">选择功能</text>
    </view>
    <text class="feature-slogan">{{ menuNavigationHint }}</text>
    <view class="feature-nav" role="navigation">
      <button
        class="feature-main feature-today {{ menuTodayClass }}"
        tabindex="{{ menuTodayTabIndex }}"
        data-index="{{ menuTodayTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openTodayWorkout"
        ink:if="{{ todayWorkoutAvailable }}"
      >
        <text class="feature-main-title">{{ todayWorkoutTitle }}</text>
        <text class="feature-main-sub">{{ todayWorkoutDetail }}</text>
      </button>
      <button
        class="feature-main {{ menuFreeClass }}"
        tabindex="{{ menuFreeTabIndex }}"
        data-index="{{ menuFreeTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openFreeMode"
      >
        <text class="feature-main-title">自由跑</text>
        <text class="feature-main-sub">户外跑 · 设备配速与眼镜估算</text>
      </button>
      <button
        class="feature-secondary {{ menuSlowClass }}"
        tabindex="{{ menuSlowTabIndex }}"
        data-index="{{ menuSlowTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openSlowMode"
      >
        <text class="feature-secondary-title">超慢跑</text>
        <text class="feature-secondary-sub">原地小步 · 低冲击</text>
      </button>
      <button
        class="feature-secondary {{ menuVirtualClass }}"
        tabindex="{{ menuVirtualTabIndex }}"
        data-index="{{ menuVirtualTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openGarminVirtualMode"
      >
        <text class="feature-secondary-title">室内跑</text>
        <text class="feature-secondary-sub">Garmin 优先 · 无设备用眼镜估算</text>
      </button>
      <button
        class="feature-secondary {{ menuTrainingClass }}"
        tabindex="{{ menuTrainingTabIndex }}"
        data-index="{{ menuTrainingTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openTrainingMode"
      >
        <text class="feature-secondary-title">训练计划</text>
        <text class="feature-secondary-sub">LSD · 轻松 · 变速 · 间歇</text>
      </button>
      <button
        class="feature-secondary {{ menuSettingsClass }}"
        tabindex="{{ menuSettingsTabIndex }}"
        data-index="{{ menuSettingsTabIndex }}"
        bindfocus="onMenuFocus"
        bindtap="openSettingsMode"
      >
        <text class="feature-secondary-title">设置</text>
        <text class="feature-secondary-sub">步长 · 节拍器 · 心率设备</text>
      </button>
    </view>
  </view>

  <view class="training-screen" ink:if="{{ surfacePhase === 'training' }}">
    <view class="training-head">
      <text class="training-title">选择训练</text>
      <text class="training-chip">按时间完成 · 强度仅作提示</text>
    </view>
    <text class="training-guide">前后划选择 · 单击确认 · 返回键回菜单</text>
    <view class="training-nav" role="navigation">
      <button class="training-option {{ trainingEasyClass }}" tabindex="0" data-index="0" data-preset="easy" bindfocus="onTrainingFocus" bindtap="onTrainingTap">
        <text class="training-option-title">轻松跑</text>
        <text class="training-option-sub">30 分钟 · 可完整交谈</text>
      </button>
      <button class="training-option {{ trainingLongClass }}" tabindex="1" data-index="1" data-preset="long" bindfocus="onTrainingFocus" bindtap="onTrainingTap">
        <text class="training-option-title">LSD 长距离跑</text>
        <text class="training-option-sub">50 分钟 · 低强度耐力</text>
      </button>
      <button class="training-option {{ trainingFartlekClass }}" tabindex="2" data-index="2" data-preset="fartlek" bindfocus="onTrainingFocus" bindtap="onTrainingTap">
        <text class="training-option-title">法特莱克跑</text>
        <text class="training-option-sub">31 分钟 · 6 组快慢交替</text>
      </button>
      <button class="training-option {{ trainingIntervalClass }}" tabindex="3" data-index="3" data-preset="interval" bindfocus="onTrainingFocus" bindtap="onTrainingTap">
        <text class="training-option-title">间歇跑</text>
        <text class="training-option-sub">34 分钟 · 4 组跑休</text>
      </button>
      <button class="training-back {{ trainingBackClass }}" tabindex="4" data-index="4" data-preset="back" bindfocus="onTrainingFocus" bindtap="onTrainingTap">返回训练菜单</button>
    </view>
  </view>

  <view class="settings-screen" ink:if="{{ surfacePhase === 'settings' }}">
    <view class="settings-top">
      <text class="settings-title">跑步设置</text>
    </view>
    <view class="settings-list" role="navigation">
      <button class="setting-row {{ settingStrideClass }}" tabindex="0" data-setting="stride" data-index="0" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">估算步长</text><text class="setting-value">{{ settingStride }}</text>
      </button>
      <button class="setting-row {{ settingVoiceCueClass }}" tabindex="1" data-setting="voice" data-index="1" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">语音提示</text><text class="setting-value">{{ settingVoiceCue }}</text>
      </button>
      <button class="setting-row {{ settingMetronomeClass }}" tabindex="2" data-setting="metronome" data-index="2" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">节拍器</text><text class="setting-value">{{ settingMetronome }}</text>
      </button>
      <button class="setting-row {{ settingGuideQuickExitClass }}" tabindex="3" data-setting="guide" data-index="3" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">指导快速结束</text><text class="setting-value">{{ settingGuideQuickExit }}</text>
      </button>
      <button class="setting-row {{ settingBindingClass }}" tabindex="4" data-setting="binding" data-index="4" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">智能体绑定</text><text class="setting-value">{{ settingBinding }}</text>
      </button>
      <view class="setting-info">
        <text class="setting-name">AI 大模型</text><text class="setting-value">记忆使用 EverMind</text>
      </view>
      <button class="setting-row {{ settingHeartRateClass }}" tabindex="5" data-setting="heart" data-index="5" bindfocus="onSettingFocus" bindtap="onSettingTap">
        <text class="setting-name">心率搜索</text><text class="setting-value">{{ settingHeartRate }}</text>
      </button>
      <button class="settings-back {{ settingBackClass }}" tabindex="6" data-setting="back" data-index="6" bindfocus="onSettingFocus" bindtap="onSettingTap">返回</button>
    </view>
    <text class="settings-foot">{{ settingsSaveState }} · 前后划选择 · 单击调整</text>
  </view>

  <view class="binding-screen" ink:if="{{ surfacePhase === 'binding' }}">
    <view class="binding-top">
      <text class="binding-title">智能体绑定</text>
      <text class="binding-chip">{{ bindingChip }}</text>
    </view>
    <view class="binding-card">
      <text class="binding-label">AIUI ID</text>
      <text class="binding-id">{{ bindingAiuiId }}</text>
      <text class="binding-state">{{ bindingState }}</text>
      <text class="binding-detail">{{ bindingDetail }}</text>
    </view>
    <view class="binding-action-nav" role="navigation">
      <button class="binding-action {{ bindingRefreshClass }}" tabindex="0" data-action="refresh" data-index="0" bindfocus="onBindingFocus" bindtap="onBindingTap">{{ bindingActionLabel }}</button>
      <button class="binding-action binding-action-export {{ bindingExportClass }}" tabindex="1" data-action="export" data-index="1" bindfocus="onBindingFocus" bindtap="onBindingTap">{{ bindingExportLabel }}</button>
    </view>
    <text class="binding-foot">前后划选择 · 单击执行 · 返回键回设置</text>
  </view>

  <view class="container" ink:if="{{ surfacePhase === 'ready' || surfacePhase === 'connecting' }}">
    <view class="nav-shell">
      <view class="brand-row">
        <image class="brand-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
        <text class="title">准备开跑</text>
      </view>
      <text class="subtitle">{{ searchText }}</text>
    </view>

    <view class="section">
      <view class="control-card">
        <text class="card-kicker">心率设备</text>
        <text class="card-subtitle">{{ searchChip }} · {{ scanProgressText }}</text>
        <view class="connect-next-nav" role="navigation">
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
          <text class="scan-key-line scan-exit-line">{{ scanExitGuide }}</text>
        </view>
      </view>
    </view>

    <view class="section">
      <view class="list-card">
        <view class="device-list-head">
          <text class="card-kicker">设备列表</text>
          <text class="device-list-range" ink:if="{{ discoveredDeviceRange }}">{{ discoveredDeviceRange }}</text>
        </view>
        <text class="hint" ink:if="{{ discoveredDeviceCount === 0 }}">{{ scanDiagnostic }}</text>
        <text class="hint beacon-hint" ink:if="{{ keyBeacon }}">{{ keyBeacon }}</text>
        <button
          class="device-row {{ item.deviceSelectedClass }} {{ item.deviceFocusClass }}"
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
  </view>

  <view class="summary-wrap" ink:if="{{ surfacePhase === 'summary' }}">
    <view class="summary-card">
      <view class="summary-head">
        <image class="runner-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
        <text class="summary-title">跑步总结</text>
        <text class="summary-chip">{{ sumAiState }}</text>
      </view>
      <view class="summary-grid">
        <view class="summary-cell">
          <text class="summary-value">{{ sumDist }}</text>
          <text class="summary-label">{{ sumMetricOneLabel }}</text>
        </view>
        <view class="summary-cell">
          <text class="summary-value">{{ sumElapsed }}</text>
          <text class="summary-label">{{ sumMetricTwoLabel }}</text>
        </view>
        <view class="summary-cell">
          <text class="summary-value">{{ sumPace }}</text>
          <text class="summary-label">{{ sumMetricThreeLabel }}</text>
        </view>
        <view class="summary-cell">
          <text class="summary-value">{{ sumStat }}</text>
          <text class="summary-label">{{ sumMetricFourLabel }}</text>
        </view>
      </view>
      <view class="summary-chart-card">
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
          height="78"
          smooth="false"
          animate="false"
        ></chart>
      </view>
      <text class="summary-ai">{{ sumAiText }}</text>
      <text class="summary-upload">{{ summaryUploadText }}</text>
      <text class="summary-exit">{{ summaryExitText }}</text>
    </view>
  </view>

  <view class="recovery-wrap" ink:if="{{ surfacePhase === 'recovery' || surfacePhase === 'pre_run' }}">
    <view class="recovery-head">
      <view class="recovery-brand">
        <image class="runner-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
        <view class="recovery-heading-group">
          <text class="recovery-heading">{{ recoveryHeading }}</text>
          <text class="recovery-overview">{{ recoveryOverview }}</text>
        </view>
      </view>
      <text class="recovery-progress">{{ recoveryProgress }}</text>
    </view>
    <view class="recovery-body">
      <image class="recovery-figure" src="{{ recoveryImage }}" mode="aspectFit" />
      <view class="recovery-copy">
        <view class="recovery-title-row">
          <view class="recovery-title-group">
            <text class="recovery-title">{{ recoveryTitle }}</text>
          </view>
          <view class="recovery-timer">
            <text class="recovery-countdown">{{ recoveryCountdown }}</text>
            <text class="recovery-countdown-unit">{{ recoveryCountdownUnit }}</text>
          </view>
        </view>
        <text class="recovery-instruction">{{ recoveryInstruction }}</text>
        <text class="recovery-auto-hint">{{ recoveryAutoHint }}</text>
        <text class="recovery-safety">{{ recoverySafety }}</text>
      </view>
    </view>
    <view class="recovery-nav" role="navigation">
      <button class="recovery-action" ink:if="{{ !recoveryChoiceVisible && guideQuickExitEnabled }}" tabindex="0" bindtap="onRecoveryTap">{{ recoveryActionLabel }}</button>
      <button class="recovery-choice {{ recoverySummaryClass }}" ink:if="{{ recoveryChoiceVisible }}" tabindex="0" data-index="0" bindfocus="onRecoveryChoiceFocus" bindtap="onRecoveryChoiceTap">查看跑步总结</button>
      <button class="recovery-choice {{ recoveryExitClass }}" ink:if="{{ recoveryChoiceVisible }}" tabindex="1" data-index="1" bindfocus="onRecoveryChoiceFocus" bindtap="onRecoveryChoiceTap">结束退出</button>
    </view>
  </view>

  <view class="hud-wrap" ink:if="{{ surfacePhase === 'hud' }}">
    <view class="hud">
      <view class="run-screen">
        <view class="hud-top">
          <image class="runner-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
          <text class="hud-environment" ink:if="{{ !safetyHudHint && !hudHint }}">{{ hudEnvironment }}</text>
          <text class="hud-hint" ink:if="{{ safetyHudHint }}">{{ safetyHudHint }}</text>
          <text class="hud-hint" ink:if="{{ !safetyHudHint && hudHint }}">{{ hudHint }}</text>
          <view class="hud-status-group">
            <text class="mode-chip" ink:if="{{ runWarmupHint && !safetyHudHint && !hudHint }}">{{ runWarmupHint }}</text>
            <text class="mode-chip" ink:if="{{ !runWarmupHint && !paceConnected && !safetyHudHint && !hudHint }}">{{ motionSourceHint }}</text>
            <text class="mode-chip" ink:if="{{ showHeartRate }}">{{ modeLabel }}</text>
            <text class="mode-chip" ink:if="{{ !runWarmupHint && paceConnected }}">配速接入</text>
          </view>
        </view>

        <text class="workout-progress" ink:if="{{ workoutActive && !safetyHudHint && !hudHint }}">{{ workoutStageLabel }} {{ workoutProgressText }}</text>

        <view class="unified-grid" ink:if="{{ runMode !== 'slow' && showHeartRate }}">
          <view class="zone">
            <view class="{{ dot5 }}"></view>
            <view class="{{ dot4 }}"></view>
            <view class="{{ dot3 }}"></view>
            <view class="{{ dot2 }}"></view>
            <view class="{{ dot1 }}"></view>
          </view>
          <view class="run-metric run-hero">
            <text class="run-value run-value-hero">{{ bpm }}</text>
            <text class="metric-label">心率</text>
          </view>
          <view class="run-metric">
            <text class="run-value">{{ cadence }}</text>
            <text class="metric-label">步频</text>
          </view>
          <view class="run-metric">
            <text class="run-value {{ distMod }}">{{ distVal }}</text>
            <text class="metric-label">距离</text>
          </view>
          <view class="run-metric">
            <text class="run-value {{ elapsedMod }}">{{ elapsed }}</text>
            <text class="metric-label">时长</text>
          </view>
          <view class="run-metric">
            <text class="run-value {{ paceMod }} {{ paceStateClass }}">{{ pace }}</text>
            <text class="metric-label">配速</text>
          </view>
        </view>

        <view class="glasses-grid" ink:if="{{ runMode !== 'slow' && !showHeartRate }}">
          <view class="run-metric">
            <text class="run-value run-value-big">{{ cadence }}</text>
            <text class="metric-label">步频</text>
          </view>
          <view class="run-metric">
            <text class="run-value run-value-big {{ gDistMod }}">{{ distVal }}</text>
            <text class="metric-label">距离</text>
          </view>
          <view class="run-metric run-main">
            <text class="run-value run-value-big {{ gElapsedMod }}">{{ elapsed }}</text>
            <text class="metric-label">时长</text>
          </view>
          <view class="run-metric run-main">
            <text class="run-value run-value-big {{ paceMod }} {{ paceStateClass }}">{{ pace }}</text>
            <text class="metric-label">配速</text>
          </view>
        </view>

        <view class="slow-metrics" ink:if="{{ runMode === 'slow' }}">
          <view class="run-metric">
            <text class="run-value run-value-big">{{ cadence }}</text>
            <text class="metric-label">步频</text>
          </view>
          <view class="run-metric run-main">
            <text class="run-value run-value-big {{ gElapsedMod }}">{{ elapsed }}</text>
            <text class="metric-label">时长</text>
          </view>
          <view class="run-metric">
            <text class="run-value run-value-big">{{ slowStepCount }}</text>
            <text class="metric-label">步数</text>
          </view>
          <view class="run-metric">
            <text class="run-value run-value-big">{{ slowHeartRate }}</text>
            <text class="metric-label">心率</text>
          </view>
        </view>
        <text class="slow-coach" ink:if="{{ runMode === 'slow' }}">{{ slowCoachLine }}</text>

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
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: var(--color-background, #000000);
}

.summary-wrap {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  /* 与 .container 同法:流式根用 min-height 占满画布,显式 height 会被打包器计入路由总高 */
  min-height: 352px;
}

.summary-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  width: 456px;
  height: 328px;
  margin: 12px auto;
  padding: 8px 16px;
  border: 0;
  border-radius: var(--radius-sm, 12px);
}

.summary-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  width: 424px;
  height: 34px;
}

.summary-title {
  color: var(--color-primary, #40ff5e);
  font-size: 24px;
  line-height: 30px;
  font-weight: bold;
}

.summary-chip {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 16px;
  line-height: 22px;
}

.summary-grid {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  box-sizing: border-box;
  width: 424px;
  height: 58px;
  margin: 6px 0 0;
}

.summary-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.summary-value {
  color: var(--color-primary, #40ff5e);
  font-size: 25px;
  line-height: 30px;
  font-weight: bold;
  font-family: monospace;
  text-align: center;
}

.summary-label {
  margin: 2px 0 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}

.summary-ai {
  box-sizing: border-box;
  width: 424px;
  height: 38px;
  margin: 4px 0 0;
  color: var(--color-primary, #40ff5e);
  font-size: 16px;
  line-height: 19px;
  text-align: center;
}

.summary-upload {
  margin: 1px 0 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 17px;
  text-align: center;
}

.summary-exit {
  margin: 1px 0 0;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}

.summary-chart-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 424px;
  height: 112px;
  margin: 4px 0 0;
  padding: 4px 2px 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  overflow: hidden;
}

.summary-chart-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 420px;
  height: 24px;
}

.summary-chart-title {
  color: var(--color-primary, #40ff5e);
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.summary-chart-unit {
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 12px;
  line-height: 18px;
}

.summary-chart {
  width: 420px;
  height: 78px;
}

.recovery-wrap {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  margin: 0;
  padding: 12px;
  background-color: var(--color-background, #000000);
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
}

.recovery-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 456px;
  height: 36px;
}

.recovery-brand {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.recovery-heading-group {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 36px;
  margin: 0 0 0 8px;
}

.recovery-heading {
  margin: 0;
  color: var(--color-primary, #40ff5e);
  font-size: 21px;
  line-height: 22px;
  font-weight: bold;
}

.recovery-overview {
  margin: 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 14px;
}

.recovery-progress {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-family: monospace;
  font-size: 18px;
  line-height: 26px;
  font-weight: bold;
}

.recovery-body {
  display: flex;
  flex-direction: row;
  width: 456px;
  height: 230px;
  margin: 6px 0 0;
}

.recovery-figure {
  width: 196px;
  height: 230px;
}

.recovery-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  box-sizing: border-box;
  width: 252px;
  height: 230px;
  margin: 0 0 0 8px;
  padding: 10px;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.recovery-title-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 232px;
  min-height: 58px;
}

.recovery-title-group {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 142px;
}

.recovery-title {
  color: var(--color-primary, #40ff5e);
  font-size: 27px;
  line-height: 32px;
  font-weight: bold;
}

.recovery-timer {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  justify-content: flex-end;
  min-width: 76px;
}

.recovery-countdown {
  color: var(--color-primary, #40ff5e);
  font-family: monospace;
  font-size: 42px;
  line-height: 48px;
  font-weight: bold;
  text-align: right;
}

.recovery-countdown-unit {
  margin: 0 0 3px 2px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 18px;
  font-weight: bold;
}

.recovery-instruction {
  margin: 8px 0 0;
  color: var(--color-primary, #40ff5e);
  font-size: 22px;
  line-height: 30px;
  font-weight: bold;
}

.recovery-auto-hint {
  margin: 7px 0 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.recovery-safety {
  margin: 7px 0 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 15px;
  line-height: 20px;
}

.recovery-nav {
  display: flex;
  flex-direction: row;
  column-gap: 6px;
  width: 456px;
  height: 50px;
  margin: 6px 0 0;
}

.recovery-choice {
  box-sizing: border-box;
  width: 225px;
  height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 18px;
  line-height: 26px;
  font-weight: bold;
}

.recovery-choice.recovery-choice-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
  color: var(--color-primary, #40ff5e);
}

.recovery-action {
  box-sizing: border-box;
  width: 456px;
  height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary, #40ff5e);
  font-size: 21px;
  line-height: 30px;
  font-weight: bold;
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.feature-menu,
.settings-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  margin: 0;
  background-color: var(--color-background, #000000);
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
}

.feature-menu {
  padding: 14px;
}

.feature-head,
.settings-top {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 452px;
  height: 44px;
}

.feature-brand {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.feature-logo {
  width: 34px;
  height: 34px;
  margin: 0 9px 0 0;
}

.feature-name {
  color: var(--color-primary, #40ff5e);
  font-family: monospace;
  font-size: 27px;
  line-height: 34px;
  font-weight: bold;
}

.feature-chip,
.settings-chip {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 15px;
  line-height: 22px;
  font-weight: bold;
}

.feature-slogan {
  width: 452px;
  height: 28px;
  margin: 2px 0 9px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 20px;
  line-height: 28px;
  font-weight: bold;
  text-align: center;
}

.feature-nav {
  display: grid;
  grid-template-columns: 223px 223px;
  grid-template-rows: 74px 76px 76px;
  column-gap: 6px;
  row-gap: 6px;
  width: 452px;
  height: 238px;
}

.feature-menu-has-plan .feature-today {
  width: 223px;
  height: 74px;
}

.feature-main,
.feature-secondary,
.setting-row {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.feature-main,
.feature-secondary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.feature-main {
  width: 223px;
  height: 76px;
}

.feature-main-title {
  color: var(--color-primary, #40ff5e);
  font-size: 27px;
  line-height: 32px;
  font-weight: bold;
}

.feature-main-sub,
.feature-secondary-sub {
  margin: 3px 0 0;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.feature-secondary {
  width: 223px;
  height: 76px;
  margin: 0;
}

.feature-secondary-title {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 23px;
  line-height: 28px;
  font-weight: bold;
}

.feature-main.feature-focused,
.feature-secondary.feature-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.feature-secondary.feature-focused .feature-secondary-title {
  color: var(--color-primary, #40ff5e);
}

.training-screen {
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  padding: 14px;
  background-color: var(--color-background, #000000);
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
}

.training-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 452px;
  height: 42px;
}

.training-title {
  color: var(--color-primary, #40ff5e);
  font-size: 27px;
  line-height: 34px;
  font-weight: bold;
}

.training-chip {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.training-guide {
  width: 452px;
  height: 26px;
  margin: 2px 0 8px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 17px;
  line-height: 24px;
  font-weight: bold;
  text-align: center;
}

.training-nav {
  display: grid;
  grid-template-columns: 223px 223px;
  grid-template-rows: 82px 82px 62px;
  column-gap: 6px;
  row-gap: 6px;
  width: 452px;
  height: 238px;
}

.training-option,
.training-back {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.training-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 223px;
  height: 82px;
}

.training-back {
  grid-column: 1 / 3;
  width: 452px;
  height: 62px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 20px;
  line-height: 28px;
  font-weight: bold;
}

.training-option-title {
  color: var(--color-primary, #40ff5e);
  font-size: 22px;
  line-height: 28px;
  font-weight: bold;
}

.training-option-sub {
  margin: 2px 0 0;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
}

.training-option.training-option-focused,
.training-back.training-option-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.training-back.training-option-focused {
  color: var(--color-primary, #40ff5e);
}

.slow-metrics {
  display: grid;
  grid-template-columns: 109px 109px 109px 109px;
  column-gap: 6px;
  width: 454px;
  height: 76px;
  align-items: center;
}

.slow-coach {
  width: 454px;
  height: 24px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 16px;
  line-height: 22px;
  font-weight: bold;
  text-align: center;
}

.settings-title {
  color: var(--color-primary, #40ff5e);
  font-size: 25px;
  line-height: 32px;
  font-weight: bold;
}

.settings-back {
  position: absolute;
  top: -38px;
  right: 0;
  box-sizing: border-box;
  width: 82px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 16px;
  line-height: 22px;
  font-weight: bold;
}

.settings-back.setting-row-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
  color: var(--color-primary, #40ff5e);
}

.settings-screen {
  padding: 12px 14px;
}

.settings-top {
  height: 36px;
}

.settings-list {
  display: flex;
  flex-direction: column;
  position: relative;
  width: 452px;
  height: 264px;
  margin: 2px 0 0;
}

.setting-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 452px;
  height: 40px;
  padding: 0 12px;
  background-color: transparent;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.setting-info {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  width: 452px;
  height: 24px;
  padding: 0 12px;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

.setting-info .setting-name,
.setting-info .setting-value {
  font-size: 13px;
  line-height: 18px;
}

.setting-row.setting-row-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary, #40ff5e);
}

.setting-name {
  color: inherit;
  font-size: 16px;
  line-height: 22px;
  font-weight: bold;
}

.setting-value {
  width: 190px;
  color: inherit;
  font-family: monospace;
  font-size: 15px;
  line-height: 22px;
  font-weight: bold;
  text-align: right;
}

.settings-foot {
  width: 452px;
  height: 24px;
  margin: 2px 0 0;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 13px;
  line-height: 24px;
  font-weight: bold;
  text-align: center;
}

.binding-screen {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 480px;
  height: 352px;
  padding: 12px 14px;
}

.binding-top {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 452px;
  height: 36px;
}

.binding-title {
  color: var(--color-primary, #40ff5e);
  font-size: 25px;
  line-height: 32px;
  font-weight: bold;
}

.binding-chip {
  min-width: 76px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary, #40ff5e);
  font-size: 15px;
  line-height: 30px;
  font-weight: bold;
  text-align: center;
}

.binding-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 452px;
  height: 190px;
  margin: 6px 0 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.binding-label {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 15px;
  line-height: 20px;
  font-weight: bold;
}

.binding-id {
  margin: 2px 0 0;
  color: var(--color-primary, #40ff5e);
  font-family: monospace;
  font-size: 43px;
  line-height: 52px;
  font-weight: bold;
}

.binding-state {
  margin: 6px 0 0;
  color: var(--color-primary, #40ff5e);
  font-size: 20px;
  line-height: 26px;
  font-weight: bold;
}

.binding-detail {
  margin: 3px 0 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 14px;
  line-height: 20px;
  font-weight: bold;
  text-align: center;
}

.binding-action-nav {
  display: flex;
  flex-direction: row;
  width: 452px;
  height: 44px;
  margin: 8px 0 0;
}

.binding-action {
  width: 222px;
  height: 44px;
  border: 2px solid var(--color-primary, #40ff5e);
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  color: var(--color-primary, #40ff5e);
  font-size: 18px;
  line-height: 24px;
  font-weight: bold;
}

.binding-action-export {
  margin: 0 0 0 8px;
}

.binding-action-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
  background-color: var(--color-primary-16, rgba(64, 255, 94, 0.16));
}

.binding-foot {
  width: 452px;
  height: 24px;
  margin: 2px 0 0;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 13px;
  line-height: 24px;
  font-weight: bold;
  text-align: center;
}

.hud-hint {
  margin: 0 0 0 8px;
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
  font-size: 14px;
  line-height: 26px;
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

.workout-progress {
  width: 456px;
  height: 24px;
  margin: 0;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 15px;
  line-height: 24px;
  font-weight: bold;
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

/* ── 02 屏:官方 bluetooth 样例的结构克隆(流式布局,静态卡片) ── */
.container {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px 16px 10px;
  background-color: #000000;
  min-height: 352px;
}

.nav-shell {
  display: flex;
  flex-direction: column;
  padding: 0 2px 6px;
}

.brand-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.brand-logo {
  width: 20px;
  height: 20px;
  margin: 0 8px 0 0;
}

.title {
  font-size: 22px;
  line-height: 28px;
  font-weight: bold;
  color: var(--color-primary, #40ff5e);
}

.subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 18px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.section {
  display: flex;
  flex-direction: column;
  margin: 0 0 6px;
}

.control-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 2px solid var(--color-primary-60, rgba(64, 255, 94, 0.6));
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.card-kicker {
  font-size: 12px;
  line-height: 15px;
  font-weight: bold;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.card-subtitle {
  margin: 1px 0 4px;
  font-size: 14px;
  line-height: 17px;
  color: var(--color-primary, #40ff5e);
}

.primary-button {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 36px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-16, rgba(64, 255, 94, 0.16));
  color: var(--color-primary, #40ff5e);
  font-size: 18px;
  line-height: 24px;
  font-weight: bold;
}

.connect-next-nav {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 36px;
}

.scan-key-guide {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 30px;
  margin: 3px 0 0;
}

.scan-key-line {
  width: 100%;
  height: 15px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 15px;
  font-weight: bold;
  text-align: center;
}

.scan-exit-line {
  color: var(--color-primary-40, rgba(64, 255, 94, 0.4));
}

.primary-button.search-target-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}


.list-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 2px solid var(--color-primary-60, rgba(64, 255, 94, 0.6));
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.device-list-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 15px;
}

.device-list-range {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 15px;
  font-family: monospace;
}

.hint {
  margin: 1px 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
}

.beacon-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--color-primary, #40ff5e);
}

.connect-hr-label {
  color: var(--color-primary, #40ff5e);
  font-size: 18px;
  line-height: 22px;
}

.device-row {
  display: grid;
  grid-template-columns: 1fr 78px 72px;
  column-gap: 6px;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  margin: 0 0 2px;
  padding: 0 8px;
  border: 0;
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
  border-radius: var(--radius-sm, 12px);
  text-align: left;
}

.device-row.device-row-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

.device-row-selected {
  background-color: var(--color-primary-16, rgba(64, 255, 94, 0.16));
}

.device-row-name,
.device-row-status {
  color: var(--color-primary, #40ff5e);
  font-size: 15px;
  line-height: 18px;
  font-weight: bold;
}

.device-row-meta {
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 16px;
  font-family: monospace;
  text-align: center;
}

.device-row-status {
  text-align: right;
}

.run-screen {
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

.mode-chip {
  height: 24px;
  padding: 0 9px;
  border: 2px solid var(--color-primary-60, rgba(64, 255, 94, 0.6));
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

.runner-logo {
  width: 26px;
  height: 26px;
}

.unified-grid {
  display: grid;
  grid-template-columns: 14px 68px 60px 80px 94px 115px;
  column-gap: 5px;
  width: 456px;
  height: 76px;
  align-items: center;
}

.glasses-grid {
  display: grid;
  grid-template-columns: 84px 92px 116px 149px;
  column-gap: 5px;
  width: 456px;
  height: 76px;
  align-items: center;
}

.run-metric {
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

.run-hero,
.run-main {
  flex-direction: column;
  background-color: transparent;
}

.run-value {
  color: var(--color-primary, #40ff5e);
  font-size: 28px;
  line-height: 32px;
  font-weight: bold;
  font-family: monospace;
  text-align: center;
}

.run-value-hero,
.run-value-big {
  font-size: 34px;
  line-height: 36px;
}

.run-value-pending {
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

.glasses-grid .run-value-pending {
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

.dot-on {
  background-color: var(--color-primary, #40ff5e);
}

</style>
