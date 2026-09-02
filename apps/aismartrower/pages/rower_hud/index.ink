<script type="application/json" def>
{ "navigationBarTitleText": "划船机教练" }
</script>

<script setup>
import wx from 'wx';
import { ActiveClock } from '../../lib/active_clock.js';
import { DirectionDeduper, SurfaceActionGate } from '../../lib/input.js';
import { PendingConfirm } from '../../lib/pending_confirm.js';
import { FtmsRowerSession } from '../../lib/ftms_session.js';
import { HeartRateSession } from '../../lib/heart_rate_session.js';
import {
  FTMS_HEART_RATE_SOURCE,
  INDEPENDENT_HRS_SOURCE,
  HeartRateSourceArbiter,
} from '../../lib/heart_rate_source.js';
import {
  IndoorRowerMetrics,
  formatDuration,
  formatSplit,
} from '../../lib/rower_metrics.js';
import {
  buildRowerChart,
  buildRowerHistoryTrend,
  buildRowerLocalReview,
  buildRowerSummary,
} from '../../lib/rower_summary.js';
import {
  loadRowerHistory,
  saveRowerHistorySummary,
} from '../../lib/rower_history.js';
import {
  GUIDE_STEP_DURATION_SEC,
  RECOVERY_STEPS,
  WARMUP_STEPS,
  guideStep,
} from '../../lib/guide.js';
import {
  loadRowerSettings,
  saveRowerSettings,
} from '../../lib/local_storage.js';

const CONFIRM_WINDOW_MS = 3000;
const RECONNECT_DELAY_MS = 4000;
const RECONNECT_MAX = 5;
const TERMINAL_CLEANUP_MS = 800;
const SUMMARY_RETRY_DELAYS_MS = [0, 500, 1500, 3000];
const MULTI_TARGET_PHASES = new Set(['menu', 'settings', 'ftms', 'hrs']);

function speak(text, enabled) {
  if (!enabled || !text) return;
  try {
    if (wx.speech && typeof wx.speech.playTTS === 'function') {
      wx.speech.playTTS({ text: String(text) });
    }
  } catch (_error) {}
}

function roundText(value, digits = 0) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '--';
  return Number(value).toFixed(digits);
}

function heartRateSourceLabel(value) {
  if (value === 'independent_hrs') return '外置 HRS';
  if (value === 'ftms') return 'FTMS 机载心率';
  if (value === 'mixed') return '混合心率来源';
  if (value === 'partial') return '心率片段不足';
  return '心率不可用';
}

function samePeripheral(left, right) {
  return !!left && left === right;
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(finish, timeoutMs);
    Promise.resolve(promise).then(finish, finish);
  });
}

export default {
  data: {
    phase: 'menu',
    focusIndex: 0,
    menuItems: ['自由划', '设置'],
    planReady: false,
    planTitle: '',
    voiceText: '开启',
    cooldownText: '开启',

    ftmsCandidates: [],
    ftmsScanState: 'idle',
    ftmsPrimaryLabel: '开始搜索',
    ftmsStatus: '未连接',
    ftmsDetail: '需要标准 FTMS 划船机',
    ftmsReadyForWarmup: false,

    hrsCandidates: [],
    hrsScanState: 'idle',
    hrsPrimaryLabel: '开始搜索心率',
    hrsSkipLabel: '跳过并开始热身',
    hrsStatus: '可选',
    hrsDetail: '可连接标准蓝牙心率带',

    guideHeading: '划前热身',
    guideProgress: '1 / 4',
    guideTitle: '',
    guideInstruction: '',
    guideSafety: '',
    guideCountdown: '15',
    guideCountdownUnit: '秒',
    guideActionLabel: '下一项',
    guideAutoHint: '15 秒后自动下一项',

    elapsedText: '00:00',
    splitText: '--:--',
    strokeText: '--',
    distanceText: '--',
    powerText: '--',
    heartText: '--',
    heartSourceText: '心率 --',
    ftmsChipText: 'FTMS 等待',
    hrsChipText: 'HRS 可选',
    stageTitle: '自由划',
    stageTarget: '保持动作完整',
    coachCue: '腿、躯干、手臂依次发力',
    finishHint: '按确认键结束',
    hudEnding: false,

    summaryElapsed: '00:00',
    summaryDistance: '--',
    summarySplit: '--:--',
    summaryStroke: '--',
    summaryEvidence: '等待本地证据',
    summaryReview: '正在生成本地复盘',
    summaryReviewSource: '本地规则 · 聚合指标',
    summarySaveText: '正在保存本机',
    summaryTrendText: '近 7 天训练 0 场',
    summaryExitText: '确认保存并退出',
    summaryForwardText: '前划进入 1 分钟放松',
    showSummaryChart: false,
    summaryChartTitle: '每分钟 500m 配速',
    summaryChartUnit: '秒/500m',
    summaryChartData: [],
    summaryChartSeries: [{
      yName: 'value', xName: 'minute', color: '#40ff5e', width: 2, smooth: false,
    }],
    summaryChartYAxis: { minimum: 0, maximum: 360 },
    summaryChartXAxis: { minimum: 1, maximum: 2 },
    summaryChartEmptyText: '有效分钟配速未形成',
    doneText: '本次放松已完成',
    exitText: '完成并退出',
  },

  onLoad() {
    this.destroyed = false;
    this.pageVisible = true;
    this.wasHidden = false;
    this.exitPending = false;
    this.exitDispatched = false;
    this.direction = new DirectionDeduper();
    this.actions = new SurfaceActionGate();
    this.globalConfirm = new PendingConfirm();
    this.lastDirectionAtMs = null;
    this.settings = loadRowerSettings(wx);
    this.history = loadRowerHistory(wx);
    this.clock = new ActiveClock();
    this.metrics = null;
    this.stageMetrics = null;
    this.heartArbiter = null;

    this.ftmsSession = new FtmsRowerSession({
      onState: (state) => this.onFtmsState(state),
      onRecord: (record) => this.onFtmsRecord(record),
    });
    this.heartRateSession = new HeartRateSession({
      onState: (state) => this.onHeartRateState(state),
      onMeasurement: (measurement) => this.onHeartRateMeasurement(measurement),
    });

    this.ftmsCandidateRefs = [];
    this.hrsCandidateRefs = [];
    this.ftmsTarget = null;
    this.hrsTarget = null;
    this.ftmsLastRecord = null;
    this.ftmsLastValidAtMs = null;
    this.ftmsSubscribed = false;
    this.ftmsLive = false;
    this.ftmsValidatedForSession = false;
    this.ftmsStaleHandled = false;
    this.hrsSubscribed = false;
    this.hrsLive = false;
    this.hrsLastMeasurement = null;
    this.hrsStaleHandled = false;
    this.ftmsScanAttempt = 0;
    this.ftmsConnectAttempt = 0;
    this.hrsScanAttempt = 0;
    this.hrsConnectAttempt = 0;
    this.bleSetupChain = Promise.resolve();
    this.reconnect = {
      ftms: { timer: null, promise: null, generation: 0, count: 0 },
      hrs: { timer: null, promise: null, generation: 0, count: 0 },
    };

    this.guideKind = null;
    this.guideIndex = 0;
    this.guideDeadline = null;
    this.guideRemainingMs = null;
    this.guideTimer = null;
    this.guideGeneration = 0;
    this.guideCompleted = false;
    this.sessionStartClaimed = false;
    this.hudTimer = null;
    this.finishArmedAtMs = null;
    this.summaryExitArmedAtMs = null;
    this.summaryExitTimer = null;
    this.pendingSummary = null;
    this.summaryStored = false;
    this.summaryPersistAttempt = 0;
    this.summaryPersistTimer = null;
    this.terminalCleanupPromise = null;

    this.plan = null;
    this.selectedPlan = false;
    this.planStageIndex = 0;
    this.planStageStartedElapsedMs = 0;
    this.planStageResults = [];
    this.executionId = '';

    this.setData({
      voiceText: this.settings.voiceEnabled ? '开启' : '关闭',
      cooldownText: this.settings.cooldownEnabled ? '开启' : '关闭',
    });
    this.actions.markSurfaceEntry(Date.now());
  },

  onShow() {
    this.pageVisible = true;
    if (!this.wasHidden) return;
    this.wasHidden = false;
    const now = Date.now();
    if ((this.data.phase === 'warmup' || this.data.phase === 'recovery')
        && this.guideRemainingMs != null) {
      this.guideDeadline = now + this.guideRemainingMs;
      this.guideRemainingMs = null;
      this.startGuideTicker();
    }
    if (this.data.phase === 'hud' && this.clock.state === 'paused') {
      this.clock.resume(now);
      if (this.metrics) this.metrics.markDiscontinuity('show');
      if (this.stageMetrics) this.stageMetrics.markDiscontinuity('show');
      if (this.heartArbiter) {
        this.heartArbiter.markDiscontinuity('all', {
          elapsedMs: this.clock.elapsedMs(now), nowMs: now,
        });
      }
      this.startHudTicker();
    }
    if (['ftms', 'hrs', 'warmup', 'hud'].includes(this.data.phase)) {
      this.resumeSelectedDevices();
    }
  },

  onHide() {
    this.pageVisible = false;
    this.wasHidden = true;
    this.globalConfirm.cancel();
    const now = Date.now();
    if (this.data.phase === 'warmup' || this.data.phase === 'recovery') {
      this.guideRemainingMs = this.guideDeadline == null
        ? GUIDE_STEP_DURATION_SEC * 1000
        : Math.max(0, this.guideDeadline - now);
      this.stopGuideTicker();
    }
    if (this.data.phase === 'hud') {
      this.stopHudTicker();
      if (this.clock.state === 'active') this.clock.pause(now);
      if (this.metrics) this.metrics.markDiscontinuity('hidden');
      if (this.stageMetrics) this.stageMetrics.markDiscontinuity('hidden');
      if (this.heartArbiter) {
        this.heartArbiter.markDiscontinuity('all', {
          elapsedMs: this.clock.elapsedMs(now), nowMs: now,
        });
      }
    }
    this.ftmsScanAttempt += 1;
    this.ftmsConnectAttempt += 1;
    this.hrsScanAttempt += 1;
    this.hrsConnectAttempt += 1;
    if (this.data.phase === 'ftms' && !this.ftmsTarget) {
      this.ftmsCandidateRefs = [];
      this.setData({
        ftmsCandidates: [],
        ftmsScanState: 'idle',
        ftmsPrimaryLabel: '重新搜索',
        ftmsStatus: '搜索已暂停',
        ftmsDetail: '返回前台后请重新确认搜索',
      });
    }
    if (this.data.phase === 'hrs' && !this.hrsTarget) {
      this.hrsCandidateRefs = [];
      this.setData({
        hrsCandidates: [],
        hrsScanState: 'idle',
        hrsPrimaryLabel: '重新搜索心率',
        hrsStatus: '搜索已暂停',
        hrsDetail: '划船机目标已保留 · 可重新搜索或跳过',
      });
    }
    this.cancelReconnect('ftms', { clearTarget: false });
    this.cancelReconnect('hrs', { clearTarget: false });
    Promise.resolve(this.ftmsSession.suspend('hidden')).catch(() => {});
    Promise.resolve(this.heartRateSession.suspend('hidden')).catch(() => {});
  },

  onUnload() {
    this.destroyed = true;
    this.pageVisible = false;
    this.globalConfirm.cancel();
    this.stopGuideTicker();
    this.stopHudTicker();
    this.clearSummaryTimers();
    this.cancelReconnect('ftms', { clearTarget: true });
    this.cancelReconnect('hrs', { clearTarget: true });
    this.beginTerminalCleanup('unload');
    if (this.exitPending) this.dispatchExit();
  },

  runBleSetup(factory) {
    const operation = this.bleSetupChain
      .catch(() => {})
      .then(() => factory());
    this.bleSetupChain = operation.catch(() => {});
    return operation;
  },

  setSurface(phase, patch = {}) {
    this.globalConfirm.cancel();
    this.setData({ phase, focusIndex: 0, ...patch });
    this.actions.markSurfaceEntry(Date.now());
  },

  resetSessionResources(reason = 'menu') {
    this.stopGuideTicker();
    this.stopHudTicker();
    this.cancelReconnect('ftms', { clearTarget: true });
    this.cancelReconnect('hrs', { clearTarget: true });
    this.ftmsScanAttempt += 1;
    this.ftmsConnectAttempt += 1;
    this.hrsScanAttempt += 1;
    this.hrsConnectAttempt += 1;
    this.ftmsTarget = null;
    this.hrsTarget = null;
    this.ftmsLastRecord = null;
    this.ftmsLastValidAtMs = null;
    this.ftmsSubscribed = false;
    this.ftmsLive = false;
    this.ftmsValidatedForSession = false;
    this.hrsSubscribed = false;
    this.hrsLive = false;
    this.hrsLastMeasurement = null;
    this.ftmsCandidateRefs = [];
    this.hrsCandidateRefs = [];
    this.sessionStartClaimed = false;
    Promise.resolve(this.ftmsSession.cleanup(reason)).catch(() => {});
    Promise.resolve(this.heartRateSession.cleanup(reason)).catch(() => {});
  },

  enterMenu() {
    this.resetSessionResources('menu');
    this.setSurface('menu');
  },

  activateMenu(index) {
    const item = this.data.menuItems[index];
    if (!item) return false;
    if (item === '设置') {
      this.setSurface('settings');
      return true;
    }
    this.selectedPlan = item === '今日训练' && !!this.plan;
    this.enterFtmsSetup();
    return true;
  },

  chooseMenu(event) {
    const index = Number(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.index);
    if (!Number.isInteger(index)
        || !this.actions.canClaim(`menu:${index}`, Date.now())) return false;
    if (index !== this.data.focusIndex) this.setData({ focusIndex: index });
    return this.activateMenu(index);
  },

  activateSetting(index) {
    if (index === 0) this.settings.voiceEnabled = !this.settings.voiceEnabled;
    else if (index === 1) this.settings.cooldownEnabled = !this.settings.cooldownEnabled;
    else if (index === 2) { this.enterMenu(); return true; }
    else return false;
    saveRowerSettings(wx, this.settings);
    this.setData({
      voiceText: this.settings.voiceEnabled ? '开启' : '关闭',
      cooldownText: this.settings.cooldownEnabled ? '开启' : '关闭',
    });
    return true;
  },

  toggleSetting(event) {
    const index = Number(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.index);
    if (!Number.isInteger(index)
        || !this.actions.canClaim(`setting:${index}`, Date.now())) return false;
    if (index !== this.data.focusIndex) this.setData({ focusIndex: index });
    return this.activateSetting(index);
  },

  enterFtmsSetup() {
    this.resetSessionResources('new_session');
    this.ftmsScanAttempt += 1;
    this.ftmsConnectAttempt += 1;
    this.setSurface('ftms', {
      ftmsCandidates: [],
      ftmsScanState: 'idle',
      ftmsPrimaryLabel: '开始搜索',
      ftmsStatus: '未连接',
      ftmsDetail: '需要标准 FTMS 划船机',
      ftmsReadyForWarmup: false,
    });
  },

  addCandidate(kind, device) {
    if (!device || !device.gatt) return false;
    const refs = kind === 'ftms' ? this.ftmsCandidateRefs : this.hrsCandidateRefs;
    const duplicate = refs.some((item) => samePeripheral(item.device, device));
    if (duplicate) return false;
    const fallback = kind === 'ftms'
      ? `划船机 ${refs.length + 1}` : `心率设备 ${refs.length + 1}`;
    refs.push({
      device,
      name: fallback,
      status: kind === 'ftms' ? '点按验证' : '点按连接',
    });
    const visible = refs.slice(0, 3).map((item) => ({
      name: item.name,
      status: item.status,
    }));
    if (kind === 'ftms') this.setData({ ftmsCandidates: visible });
    else this.setData({ hrsCandidates: visible });
    return true;
  },

  syncCandidates(kind) {
    const refs = kind === 'ftms' ? this.ftmsCandidateRefs : this.hrsCandidateRefs;
    const visible = refs.slice(0, 3).map((item) => ({
      name: item.name,
      status: item.status,
    }));
    if (kind === 'ftms') this.setData({ ftmsCandidates: visible });
    else this.setData({ hrsCandidates: visible });
  },

  async startFtmsScan() {
    if (this.data.phase !== 'ftms' || !this.pageVisible
        || this.ftmsTarget
        || this.data.ftmsScanState === 'scanning'
        || this.data.ftmsScanState === 'connecting') return false;
    const attempt = ++this.ftmsScanAttempt;
    this.ftmsCandidateRefs = [];
    this.setData({
      ftmsCandidates: [],
      ftmsScanState: 'scanning',
      ftmsPrimaryLabel: '正在搜索',
      ftmsStatus: '搜索中',
      ftmsDetail: '等待附近标准 FTMS 广播',
    });
    try {
      await this.ftmsSession.beginScan((device) => {
        if (attempt === this.ftmsScanAttempt && this.data.phase === 'ftms'
            && this.pageVisible) this.addCandidate('ftms', device);
      });
      if (attempt !== this.ftmsScanAttempt || this.data.phase !== 'ftms'
          || !this.pageVisible) {
        try { await this.ftmsSession.suspend('stale_scan'); } catch (_error) {}
        return false;
      }
      return true;
    } catch (_error) {
      if (attempt !== this.ftmsScanAttempt) return false;
      this.setData({
        ftmsScanState: 'failed',
        ftmsPrimaryLabel: '重新搜索',
        ftmsStatus: '搜索失败',
        ftmsDetail: '请确认蓝牙和划船机已开启',
      });
      return false;
    }
  },

  async selectFtms(index) {
    const record = this.ftmsCandidateRefs[index];
    if (!record || !record.device || this.ftmsTarget
        || this.data.ftmsScanState === 'connecting') return false;
    const attempt = ++this.ftmsConnectAttempt;
    record.status = '校验中';
    this.syncCandidates('ftms');
    this.setData({
      ftmsScanState: 'connecting',
      ftmsStatus: '校验中',
      ftmsDetail: '读取 0x2ACC 并订阅 0x2AD1 Notify',
      ftmsPrimaryLabel: '等待有效数据',
    });
    try {
      await this.runBleSetup(() => {
        if (attempt !== this.ftmsConnectAttempt || !this.pageVisible
            || this.data.phase !== 'ftms') {
          return Promise.reject(new Error('STALE_FTMS_SELECTION'));
        }
        return this.ftmsSession.connect(
          record.device,
          { userAuthorized: true },
        );
      });
      if (attempt !== this.ftmsConnectAttempt || !this.pageVisible
          || this.data.phase !== 'ftms'
          || this.ftmsSession.selectedDevice !== record.device) return false;
      this.ftmsTarget = record.device;
      record.status = '等待数据';
      const ready = this.ftmsLastRecord
        && this.ftmsLastRecord.generation === this.ftmsSession.generation
        && this.ftmsSession.streamState(Date.now()) === 'live';
      if (ready) this.commitFtmsReady();
      else {
        this.setData({
          ftmsScanState: 'subscribed_silent',
          ftmsStatus: '已订阅 · 未接入',
          ftmsDetail: '请轻拉一桨，等待完整有效数据',
          ftmsPrimaryLabel: '等待有效数据',
        });
      }
      this.syncCandidates('ftms');
      return true;
    } catch (_error) {
      if (attempt !== this.ftmsConnectAttempt) return false;
      record.status = '验证失败';
      this.syncCandidates('ftms');
      this.setData({
        ftmsScanState: 'failed',
        ftmsStatus: '未接入',
        ftmsDetail: '需要 0x2ACC Read 与 0x2AD1 Notify',
        ftmsPrimaryLabel: '重新搜索',
      });
      return false;
    }
  },

  onFtmsCandidateTap(event) {
    const index = Number(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.index);
    if (!Number.isInteger(index)
        || !this.actions.canClaim(`ftms-device:${index}`, Date.now())) return false;
    this.setData({ focusIndex: index + 1 });
    return this.selectFtms(index);
  },

  commitFtmsReady() {
    if (!this.ftmsTarget
        || this.ftmsSession.selectedDevice !== this.ftmsTarget) return false;
    this.ftmsValidatedForSession = true;
    this.ftmsLive = true;
    this.ftmsSubscribed = true;
    this.ftmsStaleHandled = false;
    this.reconnect.ftms.count = 0;
    this.clearReconnectTimer('ftms');
    for (const item of this.ftmsCandidateRefs) {
      if (item.device === this.ftmsTarget) item.status = '数据已就绪';
    }
    this.syncCandidates('ftms');
    if (this.data.phase === 'ftms') {
      this.setData({
        ftmsScanState: 'live',
        ftmsStatus: '数据已就绪',
        ftmsDetail: '完整 0x2AD1 数据已验证 · 只读遥测',
        ftmsPrimaryLabel: '下一步：心率',
        ftmsReadyForWarmup: true,
        focusIndex: 0,
      });
    }
    return true;
  },

  ftmsReadyNow(nowMs = Date.now()) {
    return this.ftmsValidatedForSession === true
      && this.ftmsTarget
      && this.ftmsSession.selectedByUser === true
      && this.ftmsSession.selectedDevice === this.ftmsTarget
      && this.ftmsSession.streamState(nowMs) === 'live';
  },

  onFtmsState(state = {}) {
    if (this.destroyed || !state) return false;
    const stage = String(state.stage || '');
    if (stage === 'SUBSCRIBED') {
      this.ftmsSubscribed = true;
      if (!this.ftmsLive && this.data.phase === 'ftms') {
        this.setData({
          ftmsScanState: 'subscribed_silent',
          ftmsStatus: '已订阅 · 未接入',
          ftmsDetail: '订阅成功不等于划船数据可用',
          ftmsPrimaryLabel: '等待有效数据',
        });
      }
      return true;
    }
    if (stage === 'GATT_DISCONNECTED') {
      this.ftmsSubscribed = false;
      this.ftmsLive = false;
      this.ftmsLastValidAtMs = null;
      this.ftmsStaleHandled = true;
      if (this.metrics) this.metrics.markDiscontinuity('disconnect');
      if (this.stageMetrics) this.stageMetrics.markDiscontinuity('disconnect');
      if (this.heartArbiter && this.clock.state !== 'idle') {
        const now = Date.now();
        this.heartArbiter.markDiscontinuity(FTMS_HEART_RATE_SOURCE, {
          elapsedMs: this.clock.elapsedMs(now), nowMs: now,
        });
      }
      if (this.pageVisible && this.reconnectEligible('ftms')) {
        this.scheduleReconnect('ftms', RECONNECT_DELAY_MS);
      }
      if (this.data.phase === 'hud') this.refreshHud();
      return true;
    }
    if (stage === 'PACKET_INVALID' && this.data.phase === 'ftms') {
      this.setData({ ftmsDetail: '收到无效或不完整数据 · 继续等待' });
    }
    return true;
  },

  onFtmsRecord(record) {
    if (!record || record.valid !== true || record.complete !== true
        || record.published !== true || !Number.isFinite(record.receivedAtMs)) {
      return false;
    }
    this.ftmsLastRecord = record;
    this.ftmsLastValidAtMs = record.receivedAtMs;
    this.ftmsLive = true;
    this.ftmsSubscribed = true;
    this.ftmsStaleHandled = false;
    if (this.ftmsTarget
        && this.ftmsSession.selectedDevice === this.ftmsTarget) {
      this.commitFtmsReady();
    }
    if (this.data.phase === 'hud' && this.clock.state === 'active') {
      const elapsedMs = this.clock.elapsedMs(record.receivedAtMs);
      const fields = { ...record.fields, heartRateBpm: null };
      const metricRecord = { ...record, fields };
      if (this.metrics) this.metrics.accept(metricRecord, { elapsedMs });
      if (this.stageMetrics) this.stageMetrics.accept(metricRecord, { elapsedMs });
      if (this.heartArbiter) this.heartArbiter.acceptFtms(record, { elapsedMs });
      this.refreshHud(record.receivedAtMs);
    }
    return true;
  },

  enterHeartRateSetup() {
    if (!this.ftmsValidatedForSession || !this.ftmsTarget) return false;
    this.ftmsSession.stopScan();
    this.setSurface('hrs', {
      hrsCandidates: [],
      hrsScanState: this.hrsTarget ? 'subscribed' : 'idle',
      hrsPrimaryLabel: this.hrsTarget ? '开始热身' : '开始搜索心率',
      hrsSkipLabel: this.hrsTarget ? '使用当前心率并热身' : '跳过并开始热身',
      hrsStatus: this.hrsTarget ? '已连接' : '可选',
      hrsDetail: this.hrsTarget
        ? '独立心率优先，失效时回退机载心率'
        : '标准 HRS 可选 · 不影响划船机数据',
    });
    return true;
  },

  async startHeartRateScan() {
    if (this.data.phase !== 'hrs' || !this.pageVisible
        || this.hrsTarget
        || this.data.hrsScanState === 'scanning'
        || this.data.hrsScanState === 'connecting') return false;
    if (this.reconnect.ftms.timer || this.reconnect.ftms.promise) {
      this.setData({
        hrsScanState: 'idle',
        hrsPrimaryLabel: '等待划船机恢复',
        hrsStatus: '划船机重连中',
        hrsDetail: '必需 FTMS 优先 · 恢复后可搜索心率',
      });
      return false;
    }
    const attempt = ++this.hrsScanAttempt;
    this.hrsCandidateRefs = [];
    this.setData({
      hrsCandidates: [],
      hrsScanState: 'scanning',
      hrsPrimaryLabel: '正在搜索心率',
      hrsStatus: '搜索中',
      hrsDetail: '划船机保持连接 · 等待标准 HRS 广播',
    });
    try {
      await this.heartRateSession.beginScan((device) => {
        if (attempt === this.hrsScanAttempt && this.data.phase === 'hrs'
            && this.pageVisible) this.addCandidate('hrs', device);
      });
      if (attempt !== this.hrsScanAttempt || this.data.phase !== 'hrs'
          || !this.pageVisible) {
        try { await this.heartRateSession.suspend('stale_scan'); } catch (_error) {}
        return false;
      }
      return true;
    } catch (_error) {
      if (attempt !== this.hrsScanAttempt) return false;
      this.setData({
        hrsScanState: 'failed',
        hrsPrimaryLabel: '重试搜索心率',
        hrsStatus: '心率不可用',
        hrsDetail: '当前宿主可能不支持双设备 · 可直接跳过',
      });
      return false;
    }
  },

  async selectHeartRate(index) {
    const record = this.hrsCandidateRefs[index];
    if (!record || !record.device || this.hrsTarget
        || this.data.hrsScanState === 'connecting') return false;
    if (this.reconnect.ftms.timer || this.reconnect.ftms.promise) {
      this.setData({
        hrsStatus: '划船机重连中',
        hrsDetail: '必需 FTMS 恢复后再连接可选心率',
      });
      return false;
    }
    if (samePeripheral(record.device, this.ftmsTarget)) {
      record.status = '与划船机相同';
      this.syncCandidates('hrs');
      this.setData({
        hrsStatus: '不能重复连接',
        hrsDetail: '同一设备请使用 FTMS 机载心率',
      });
      return false;
    }
    const attempt = ++this.hrsConnectAttempt;
    record.status = '连接中';
    this.syncCandidates('hrs');
    this.setData({
      hrsScanState: 'connecting',
      hrsStatus: '连接中',
      hrsDetail: '验证 0x2A37 Notify',
    });
    try {
      await this.runBleSetup(() => {
        if (attempt !== this.hrsConnectAttempt || !this.pageVisible
            || this.data.phase !== 'hrs'
            || this.reconnect.ftms.timer || this.reconnect.ftms.promise) {
          return Promise.reject(new Error('STALE_HRS_SELECTION'));
        }
        return this.heartRateSession.connect(
          record.device,
          { userAuthorized: true },
        );
      });
      if (attempt !== this.hrsConnectAttempt || !this.pageVisible
          || this.data.phase !== 'hrs'
          || this.heartRateSession.selectedDevice !== record.device) return false;
      this.hrsTarget = record.device;
      this.hrsSubscribed = true;
      record.status = '等待心率';
      this.syncCandidates('hrs');
      this.setData({
        hrsScanState: 'subscribed',
        hrsPrimaryLabel: '开始热身',
        hrsSkipLabel: '使用当前心率并热身',
        hrsStatus: '已订阅',
        hrsDetail: '等待首个合法心率 · 不阻塞热身',
        focusIndex: 0,
      });
      return true;
    } catch (_error) {
      if (attempt !== this.hrsConnectAttempt) return false;
      record.status = '连接失败';
      this.syncCandidates('hrs');
      this.setData({
        hrsScanState: 'failed',
        hrsPrimaryLabel: '重试搜索心率',
        hrsStatus: '心率不可用',
        hrsDetail: '划船机未受影响 · 可直接跳过',
      });
      return false;
    }
  },

  onHeartRateCandidateTap(event) {
    const index = Number(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.index);
    if (!Number.isInteger(index)
        || !this.actions.canClaim(`hrs-device:${index}`, Date.now())) return false;
    this.setData({ focusIndex: index + 1 });
    return this.selectHeartRate(index);
  },

  onHeartRateState(state = {}) {
    if (this.destroyed || !state) return false;
    const stage = String(state.stage || '');
    if (stage === 'SUBSCRIBED') {
      this.hrsSubscribed = true;
      if (this.data.phase === 'hrs') {
        this.setData({
          hrsScanState: 'subscribed',
          hrsStatus: '已订阅',
          hrsDetail: '等待首个合法心率 · 可直接热身',
          hrsPrimaryLabel: '开始热身',
          hrsSkipLabel: '使用当前心率并热身',
        });
      }
      return true;
    }
    if (stage === 'GATT_DISCONNECTED') {
      this.hrsSubscribed = false;
      this.hrsLive = false;
      this.hrsStaleHandled = true;
      if (this.heartArbiter && this.clock.state !== 'idle') {
        const now = Date.now();
        this.heartArbiter.markDiscontinuity(INDEPENDENT_HRS_SOURCE, {
          elapsedMs: this.clock.elapsedMs(now), nowMs: now,
        });
      }
      if (this.pageVisible && this.reconnectEligible('hrs')) {
        this.scheduleReconnect('hrs', RECONNECT_DELAY_MS);
      }
      if (this.data.phase === 'hud') this.refreshHud();
      return true;
    }
    if (stage === 'CONTACT_POOR') {
      this.hrsLive = false;
      if (this.data.phase === 'hrs') {
        this.setData({ hrsStatus: '接触不良', hrsDetail: '调整佩戴后可继续热身' });
      }
    }
    return true;
  },

  onHeartRateMeasurement(measurement) {
    if (!measurement || measurement.valid !== true) return false;
    this.hrsLastMeasurement = measurement;
    this.hrsLive = measurement.usable === true
      && measurement.contactDetected !== false;
    this.hrsStaleHandled = false;
    if (this.hrsLive) {
      this.reconnect.hrs.count = 0;
      this.clearReconnectTimer('hrs');
    }
    if (this.data.phase === 'hrs') {
      this.setData({
        hrsStatus: measurement.contactDetected === false ? '接触不良' : '心率正常',
        hrsDetail: measurement.contactDetected === false
          ? '调整心率带接触 · 仍可继续热身'
          : `当前 ${roundText(measurement.heartRateBpm)} bpm · 外置 HRS 优先`,
        hrsPrimaryLabel: '开始热身',
        hrsSkipLabel: '使用当前心率并热身',
      });
    }
    if (this.data.phase === 'hud' && this.clock.state === 'active'
        && this.heartArbiter) {
      this.heartArbiter.acceptIndependentHrs(measurement, {
        elapsedMs: this.clock.elapsedMs(measurement.receivedAtMs),
        nowMs: measurement.receivedAtMs,
      });
      this.refreshHud(measurement.receivedAtMs);
    }
    return true;
  },

  clearReconnectTimer(kind) {
    const state = this.reconnect[kind];
    if (state && state.timer) clearTimeout(state.timer);
    if (state) state.timer = null;
  },

  cancelReconnect(kind, { clearTarget = false } = {}) {
    const state = this.reconnect[kind];
    if (!state) return false;
    this.clearReconnectTimer(kind);
    state.generation += 1;
    state.promise = null;
    if (clearTarget) {
      state.count = 0;
      if (kind === 'ftms') this.ftmsTarget = null;
      else this.hrsTarget = null;
    }
    return true;
  },

  yieldOptionalHeartRateSetupForFtms() {
    const hrsReconnect = this.reconnect.hrs;
    const reconnectActive = !!(hrsReconnect
      && (hrsReconnect.timer || hrsReconnect.promise));
    const initialSetupActive = !this.hrsTarget
      && (this.data.hrsScanState === 'scanning'
        || this.data.hrsScanState === 'connecting');
    if (!reconnectActive && !initialSetupActive) return false;
    this.cancelReconnect('hrs', { clearTarget: false });
    this.hrsScanAttempt += 1;
    this.hrsConnectAttempt += 1;
    this.hrsCandidateRefs = [];
    const cleanup = this.hrsTarget
      ? this.heartRateSession.suspend('ftms_priority')
      : this.heartRateSession.cleanup('ftms_priority');
    Promise.resolve(cleanup).catch(() => {});
    if (this.data.phase === 'hrs') {
      this.setData({
        hrsCandidates: [],
        hrsScanState: 'idle',
        hrsPrimaryLabel: '等待划船机恢复',
        hrsStatus: '划船机重连中',
        hrsDetail: '已暂停可选心率连接，优先恢复必需 FTMS',
      });
    }
    return true;
  },

  reconnectEligible(kind) {
    const target = kind === 'ftms' ? this.ftmsTarget : this.hrsTarget;
    const state = this.reconnect[kind];
    return !!target && !!state && state.count < RECONNECT_MAX
      && this.pageVisible
      && ['ftms', 'hrs', 'warmup', 'hud'].includes(this.data.phase)
      && !this.exitPending;
  },

  scheduleReconnect(kind, delayMs = RECONNECT_DELAY_MS) {
    if (kind === 'ftms') this.yieldOptionalHeartRateSetupForFtms();
    const state = this.reconnect[kind];
    if (!this.reconnectEligible(kind) || state.timer || state.promise) return false;
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (generation === state.generation) this.attemptReconnect(kind);
    }, Math.max(0, Number(delayMs) || 0));
    return true;
  },

  async attemptReconnect(kind) {
    if (!this.reconnectEligible(kind)) return false;
    if (kind === 'ftms') this.yieldOptionalHeartRateSetupForFtms();
    const state = this.reconnect[kind];
    const generation = state.generation;
    const target = kind === 'ftms' ? this.ftmsTarget : this.hrsTarget;
    const session = kind === 'ftms' ? this.ftmsSession : this.heartRateSession;
    state.count += 1;
    const operation = this.runBleSetup(() => {
      if (generation !== state.generation || !this.reconnectEligible(kind)) {
        return Promise.reject(new Error('STALE_RECONNECT'));
      }
      return session.reconnect(target);
    });
    state.promise = operation;
    let subscribed = false;
    try { await operation; subscribed = true; } catch (_error) {}
    if (generation !== state.generation) return false;
    state.promise = null;
    if (subscribed) {
      if (kind === 'ftms') {
        this.ftmsSubscribed = true;
        this.ftmsStaleHandled = false;
        if (this.data.phase === 'hrs' && !this.hrsTarget) {
          this.setData({
            hrsScanState: 'idle',
            hrsPrimaryLabel: '开始搜索心率',
            hrsStatus: '可选',
            hrsDetail: '划船机已恢复 · 可搜索标准 HRS 或直接跳过',
          });
        }
        if (this.hrsTarget
            && this.heartRateSession.streamState(Date.now()) !== 'live') {
          this.scheduleReconnect('hrs', 0);
        }
      } else {
        this.hrsSubscribed = true;
        this.hrsStaleHandled = false;
      }
      return true;
    }
    if (this.reconnectEligible(kind)) this.scheduleReconnect(kind);
    return false;
  },

  resumeSelectedDevices() {
    if (this.ftmsTarget && this.ftmsSession.streamState(Date.now()) !== 'live') {
      this.attemptReconnect('ftms');
      return true;
    }
    if (this.hrsTarget && this.heartRateSession.streamState(Date.now()) !== 'live') {
      this.attemptReconnect('hrs');
      return true;
    }
    return false;
  },

  async handleFtmsStale() {
    if (this.ftmsStaleHandled || !this.ftmsTarget) return false;
    this.ftmsStaleHandled = true;
    this.ftmsLive = false;
    if (this.metrics) this.metrics.markDiscontinuity('stale');
    if (this.stageMetrics) this.stageMetrics.markDiscontinuity('stale');
    if (this.heartArbiter && this.clock.state !== 'idle') {
      const now = Date.now();
      this.heartArbiter.markDiscontinuity(FTMS_HEART_RATE_SOURCE, {
        elapsedMs: this.clock.elapsedMs(now), nowMs: now,
      });
    }
    await this.ftmsSession.suspend('stale');
    if (this.reconnectEligible('ftms')) this.scheduleReconnect('ftms');
    return true;
  },

  async handleHeartRateStale() {
    if (this.hrsStaleHandled || !this.hrsTarget) return false;
    this.hrsStaleHandled = true;
    this.hrsLive = false;
    if (this.heartArbiter && this.clock.state !== 'idle') {
      const now = Date.now();
      this.heartArbiter.markDiscontinuity(INDEPENDENT_HRS_SOURCE, {
        elapsedMs: this.clock.elapsedMs(now), nowMs: now,
      });
    }
    await this.heartRateSession.suspend('stale');
    if (this.reconnectEligible('hrs')) this.scheduleReconnect('hrs');
    return true;
  },

  startGuide(kind) {
    if (kind === 'warmup' && (!this.ftmsValidatedForSession || !this.ftmsTarget)) {
      return false;
    }
    if (kind === 'recovery' && this.data.phase !== 'summary') return false;
    if (kind === 'warmup' && !this.hrsTarget) {
      this.hrsScanAttempt += 1;
      this.hrsConnectAttempt += 1;
      Promise.resolve(
        this.heartRateSession.cleanup('optional_hrs_skipped'),
      ).catch(() => {});
      this.hrsCandidateRefs = [];
    }
    this.stopGuideTicker();
    this.guideKind = kind;
    this.guideIndex = 0;
    this.guideCompleted = false;
    this.sessionStartClaimed = false;
    this.setSurface(kind === 'warmup' ? 'warmup' : 'recovery', {
      guideHeading: kind === 'warmup' ? '划前热身' : '划后放松',
      guideActionLabel: '下一项',
      guideAutoHint: '15 秒后自动下一项',
      guideCountdownUnit: '秒',
    });
    this.applyGuideStep();
    this.startGuideTicker();
    return true;
  },

  currentGuideSteps() {
    return this.guideKind === 'recovery' ? RECOVERY_STEPS : WARMUP_STEPS;
  },

  applyGuideStep(remainingMs = GUIDE_STEP_DURATION_SEC * 1000) {
    const step = guideStep(this.currentGuideSteps(), this.guideIndex);
    if (!step) return false;
    const durationMs = Math.max(0, Number(remainingMs) || 0);
    this.guideDeadline = Date.now() + durationMs;
    this.guideCompleted = false;
    this.setData({
      guideProgress: `${step.index} / ${step.count}`,
      guideTitle: step.title,
      guideInstruction: step.instruction,
      guideSafety: step.safety,
      guideCountdown: String(Math.max(0, Math.ceil(durationMs / 1000))),
      guideCountdownUnit: '秒',
      guideActionLabel: this.guideIndex === this.currentGuideSteps().length - 1
        ? (this.guideKind === 'warmup' ? '完成热身并开始' : '完成放松')
        : '下一项',
      guideAutoHint: '15 秒后自动下一项',
    });
    speak(step.cue, this.settings.voiceEnabled);
    return true;
  },

  startGuideTicker() {
    this.stopGuideTicker();
    const generation = ++this.guideGeneration;
    this.guideTimer = setInterval(() => {
      if (generation !== this.guideGeneration || !this.pageVisible
          || !['warmup', 'recovery'].includes(this.data.phase)) return;
      const remaining = Math.max(
        0,
        Math.ceil((this.guideDeadline - Date.now()) / 1000),
      );
      this.setData({ guideCountdown: String(remaining) });
      if (remaining === 0) this.advanceGuide(true);
    }, 250);
  },

  stopGuideTicker() {
    this.guideGeneration += 1;
    if (this.guideTimer) clearInterval(this.guideTimer);
    this.guideTimer = null;
  },

  finishRecoveryGuide() {
    this.stopGuideTicker();
    this.guideCompleted = true;
    this.setSurface('recovery_done', {
      doneText: '四项放松已完成，确认后安全退出',
      exitText: '完成并退出',
    });
    speak('放松完成。', this.settings.voiceEnabled);
    return true;
  },

  advanceGuide(automatic = false) {
    if (!['warmup', 'recovery'].includes(this.data.phase)
        || this.guideCompleted) return false;
    const steps = this.currentGuideSteps();
    if (this.guideIndex + 1 < steps.length) {
      this.stopGuideTicker();
      this.guideIndex += 1;
      this.applyGuideStep();
      this.startGuideTicker();
      return true;
    }
    if (this.guideKind === 'warmup') return this.startHud({ automatic });
    return this.finishRecoveryGuide();
  },

  onGuideAction() {
    if (this.guideKind === 'recovery' && this.guideCompleted) {
      return this.closeAgent();
    }
    return this.advanceGuide(false);
  },

  startHud() {
    if (this.data.phase !== 'warmup' || this.sessionStartClaimed
        || !this.ftmsValidatedForSession || !this.ftmsTarget) return false;
    this.sessionStartClaimed = true;
    this.stopGuideTicker();
    const now = Date.now();
    this.clock = new ActiveClock();
    if (!this.clock.start(now)) {
      this.sessionStartClaimed = false;
      return false;
    }
    const anchor = this.ftmsLastRecord && this.ftmsLastRecord.fields || {};
    this.metrics = new IndoorRowerMetrics();
    if (!this.metrics.start({
      elapsedMs: 0,
      totalDistanceM: anchor.totalDistanceM,
      strokeCount: anchor.strokeCount,
    })) this.metrics.start({ elapsedMs: 0 });
    this.heartArbiter = new HeartRateSourceArbiter({
      minimumBpm: 20,
      maximumBpm: 240,
    });
    this.heartArbiter.start({ elapsedMs: 0, nowMs: now });
    this.executionId = `row-${now}-${Math.floor(Math.random() * 100000)}`;
    this.planStageIndex = 0;
    this.planStageStartedElapsedMs = 0;
    this.planStageResults = [];
    this.startStageMetrics(0);
    this.finishArmedAtMs = null;
    this.pendingSummary = null;
    this.summaryStored = false;
    this.summaryPersistAttempt = 0;
    const stage = this.currentPlanStage();
    this.setSurface('hud', {
      elapsedText: '00:00',
      splitText: '--:--',
      strokeText: '--',
      distanceText: '--',
      powerText: '--',
      heartText: '--',
      heartSourceText: '心率 --',
      ftmsChipText: this.ftmsReadyNow(now) ? 'FTMS LIVE' : 'FTMS 等待',
      hrsChipText: this.hrsTarget ? 'HRS 等待' : 'HRS 未连接',
      stageTitle: stage ? stage.title : '自由划',
      stageTarget: stage ? this.stageTargetText(stage) : '保持动作完整',
      coachCue: stage ? stage.cue : '腿、躯干、手臂依次发力',
      finishHint: '按确认键结束',
      hudEnding: false,
    });
    this.startHudTicker();
    if (!this.ftmsReadyNow(now)) this.handleFtmsStale();
    speak('热身完成，开始划船训练。先轻阻力，再逐步增加力量。', this.settings.voiceEnabled);
    return true;
  },

  currentPlanStage() {
    return this.selectedPlan && this.plan
      ? this.plan.stages[this.planStageIndex] || null : null;
  },

  stageTargetText(stage) {
    const target = stage && stage.target || {};
    if (target.strokeRateMinSpm != null && target.strokeRateMaxSpm != null) {
      return `目标桨频 ${target.strokeRateMinSpm}–${target.strokeRateMaxSpm}`;
    }
    if (target.splitMinSecPer500m != null && target.splitMaxSecPer500m != null) {
      return `目标配速 ${formatSplit(target.splitMinSecPer500m)}–${formatSplit(target.splitMaxSecPer500m)}`;
    }
    return '按体感稳定完成';
  },

  startStageMetrics(elapsedMs) {
    const anchor = this.ftmsLastRecord && this.ftmsLastRecord.fields || {};
    this.stageMetrics = new IndoorRowerMetrics();
    if (!this.stageMetrics.start({
      elapsedMs,
      totalDistanceM: anchor.totalDistanceM,
      strokeCount: anchor.strokeCount,
    })) this.stageMetrics.start({ elapsedMs });
  },

  captureCurrentStage(status, elapsedMs) {
    const stage = this.currentPlanStage();
    if (!stage || this.planStageResults.some((item) => item.stageId === stage.stageId)) {
      return false;
    }
    const snapshot = this.stageMetrics
      ? this.stageMetrics.snapshot({ elapsedMs, nowMs: Date.now() }) : {};
    this.planStageResults.push({
      stageId: stage.stageId,
      status,
      durationSec: Math.max(
        0,
        Math.floor((elapsedMs - this.planStageStartedElapsedMs) / 1000),
      ),
      distanceM: Math.max(0, Number(snapshot.distanceM) || 0),
      metrics: {
        avgSplitSecPer500m: snapshot.averageSplitSecPer500m,
        avgStrokeRateSpm: snapshot.averageStrokeRateSpm,
        avgPowerW: snapshot.averagePowerW,
        avgHeartRateBpm: null,
      },
    });
    return true;
  },

  updatePlanStage(elapsedMs) {
    const stage = this.currentPlanStage();
    if (!stage) return;
    const stageElapsedMs = elapsedMs - this.planStageStartedElapsedMs;
    if (stageElapsedMs < stage.durationSec * 1000) return;
    this.captureCurrentStage('completed', elapsedMs);
    this.planStageIndex += 1;
    this.planStageStartedElapsedMs = elapsedMs;
    this.startStageMetrics(elapsedMs);
    const next = this.currentPlanStage();
    this.setData({
      stageTitle: next ? next.title : '计划完成',
      stageTarget: next ? this.stageTargetText(next) : '可继续自由划或结束',
      coachCue: next ? next.cue : '保持轻松节奏，准备结束',
    });
    if (next) speak(next.cue, this.settings.voiceEnabled);
  },

  startHudTicker() {
    this.stopHudTicker();
    if (this.data.phase !== 'hud' || this.clock.state !== 'active') return false;
    this.hudTimer = setInterval(() => this.refreshHud(), 500);
    return true;
  },

  stopHudTicker() {
    if (this.hudTimer) clearInterval(this.hudTimer);
    this.hudTimer = null;
  },

  refreshHud(nowMs = Date.now()) {
    if (this.data.phase !== 'hud' || !this.metrics || !this.heartArbiter) return false;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const elapsedMs = this.clock.elapsedMs(now);
    const metrics = this.metrics.snapshot({ elapsedMs, nowMs: now });
    const ftmsState = this.ftmsSession.streamState(now);
    const ftmsFresh = ftmsState === 'live' && metrics.fresh === true;
    if (!ftmsFresh && (ftmsState === 'stale' || ftmsState === 'silent')) {
      this.handleFtmsStale();
    }
    const hrsState = this.hrsTarget
      ? this.heartRateSession.streamState(now) : 'disconnected';
    if (this.hrsTarget && hrsState === 'stale') this.handleHeartRateStale();
    const heart = this.heartArbiter.snapshot({ elapsedMs, nowMs: now });
    const fields = ftmsFresh && metrics.current ? metrics.current : {};
    const distanceText = ftmsFresh && metrics.distanceEvidence !== 'unavailable'
      ? roundText(metrics.distanceM) : '--';
    const currentHeart = heart.heartRateBpm == null ? '--' : roundText(heart.heartRateBpm);
    let hrsChipText = this.hrsTarget ? 'HRS 等待' : 'HRS 未连接';
    if (heart.externalContactPoor) hrsChipText = 'HRS 接触不良';
    else if (heart.currentSource === INDEPENDENT_HRS_SOURCE) hrsChipText = 'HRS LIVE';
    else if (this.hrsTarget && hrsState === 'stale') hrsChipText = 'HRS 过期';
    else if (this.reconnect.hrs.timer || this.reconnect.hrs.promise) hrsChipText = 'HRS 重连';
    let ftmsChipText = ftmsFresh ? 'FTMS LIVE' : 'FTMS 等待';
    if (this.reconnect.ftms.timer || this.reconnect.ftms.promise) ftmsChipText = 'FTMS 重连';
    const sourceText = heart.currentSource === INDEPENDENT_HRS_SOURCE
      ? '外置 HRS' : (heart.currentSource === FTMS_HEART_RATE_SOURCE ? 'FTMS 心率' : '心率 --');
    this.setData({
      elapsedText: formatDuration(elapsedMs),
      splitText: ftmsFresh ? formatSplit(fields.splitSecPer500m) : '--:--',
      strokeText: ftmsFresh ? roundText(fields.strokeRateSpm, 1) : '--',
      distanceText,
      powerText: ftmsFresh ? roundText(fields.powerW) : '--',
      heartText: currentHeart,
      heartSourceText: sourceText,
      ftmsChipText,
      hrsChipText,
    });
    this.updatePlanStage(elapsedMs);
    const stage = this.currentPlanStage();
    if (stage) {
      const cue = stage.cue || '保持动作完整，按当前节奏完成本段';
      if (cue && cue !== this.data.coachCue) {
        this.setData({ coachCue: cue });
        speak(cue, this.settings.voiceEnabled);
      }
    }
    return true;
  },

  requestFinish() {
    if (this.data.phase !== 'hud' || this.exitPending) return false;
    const now = Date.now();
    if (this.finishArmedAtMs != null
        && now - this.finishArmedAtMs <= CONFIRM_WINDOW_MS) {
      return this.finishSessionToSummary();
    }
    this.finishArmedAtMs = now;
    this.setData({
      hudEnding: true,
      finishHint: '再按一次确认结束',
    });
    setTimeout(() => {
      if (this.data.phase !== 'hud' || this.finishArmedAtMs !== now) return;
      this.finishArmedAtMs = null;
      this.setData({ hudEnding: false, finishHint: '按确认键结束' });
    }, CONFIRM_WINDOW_MS);
    return true;
  },

  finishSessionToSummary() {
    if (this.data.phase !== 'hud' || !this.metrics || !this.heartArbiter) return false;
    const now = Date.now();
    this.stopHudTicker();
    if (this.clock.state === 'active') this.clock.pause(now);
    const elapsedMs = this.clock.elapsedMs(now);
    this.metrics.markDiscontinuity('finish');
    if (this.stageMetrics) this.stageMetrics.markDiscontinuity('finish');
    const metricSnapshot = this.metrics.snapshot({ elapsedMs, nowMs: now });
    const heartSnapshot = this.heartArbiter.finish({ elapsedMs, nowMs: now });
    const currentStage = this.currentPlanStage();
    if (currentStage) {
      const elapsedInStage = elapsedMs - this.planStageStartedElapsedMs;
      this.captureCurrentStage(elapsedInStage > 0 ? 'partial' : 'skipped', elapsedMs);
      for (let index = this.planStageIndex + 1; this.plan && index < this.plan.stages.length; index += 1) {
        const stage = this.plan.stages[index];
        this.planStageResults.push({
          stageId: stage.stageId,
          status: 'skipped',
          durationSec: 0,
          distanceM: 0,
          metrics: {},
        });
      }
    }
    this.clock.finish(now);
    const summary = buildRowerSummary({
      ...metricSnapshot,
      sessionId: this.executionId,
      startedAtMs: this.clock.startedAtMs,
      finishedAtMs: now,
      elapsedMs,
      averageHeartRateBpm: heartSnapshot.averageHeartRateBpm,
      maxHeartRateBpm: heartSnapshot.maxHeartRateBpm,
      heartRateCoveragePct: heartSnapshot.heartRateCoveragePct,
      heartRateSource: heartSnapshot.heartRateSource,
      independentHrsCoveragePct: heartSnapshot.independentHrsCoveragePct,
      ftmsHeartRateCoveragePct: heartSnapshot.ftmsHeartRateCoveragePct,
      sensorSources: [
        'ftms',
        ...(heartSnapshot.independentHrsCoverageMs > 0 ? ['independent_hrs'] : []),
      ],
    });
    this.pendingSummary = summary;
    this.summaryStored = false;
    this.summaryPersistAttempt = 0;
    const chart = buildRowerChart(summary);
    const review = buildRowerLocalReview(summary);
    const heartValue = summary.averageHeartRateBpm == null
      ? '--' : roundText(summary.averageHeartRateBpm);
    const powerValue = summary.averagePowerW == null
      ? '--' : roundText(summary.averagePowerW);
    const distance = summary.distanceEvidence === 'unavailable'
      ? '--' : roundText(summary.distanceM);
    this.setSurface('summary', {
      summaryElapsed: formatDuration(summary.elapsedMs),
      summaryDistance: distance,
      summarySplit: formatSplit(summary.averageSplitSecPer500m),
      summaryStroke: roundText(summary.averageStrokeRateSpm, 1),
      summaryEvidence: `DISTANCE ${summary.distanceEvidence.toUpperCase()} · 均功率 ${powerValue} W · 心率 ${heartValue} · FTMS ${roundText(summary.ftmsCoveragePct)}%`,
      summaryReview: review.detail,
      summaryReviewSource: `${review.sourceNote} · ${heartRateSourceLabel(summary.heartRateSource)}`,
      summarySaveText: '正在保存本机',
      summaryTrendText: buildRowerHistoryTrend(this.history, summary, 'pending'),
      summaryExitText: '确认保存并退出',
      summaryForwardText: this.settings.cooldownEnabled === false
        ? '划后放松已在设置中关闭'
        : '前划进入 1 分钟放松',
      ...chart,
    });
    this.scheduleSummaryPersistence(SUMMARY_RETRY_DELAYS_MS[0]);
    this.beginTerminalCleanup('summary');
    speak('本次划船训练结束，总结已经生成。', this.settings.voiceEnabled);
    return true;
  },

  scheduleSummaryPersistence(delayMs) {
    if (this.summaryStored || !this.pendingSummary || this.summaryPersistTimer) return false;
    this.summaryPersistTimer = setTimeout(() => {
      this.summaryPersistTimer = null;
      this.persistPendingSummary(true);
    }, Math.max(0, Number(delayMs) || 0));
    return true;
  },

  persistPendingSummary(allowRetry) {
    if (!this.pendingSummary) return false;
    const saved = saveRowerHistorySummary(wx, this.pendingSummary);
    this.summaryStored = saved;
    if (saved) {
      this.history = loadRowerHistory(wx);
      this.setData({
        summarySaveText: '已保存本机',
        summaryTrendText: buildRowerHistoryTrend(
          this.history,
          this.pendingSummary,
          'saved',
        ),
      });
      return true;
    }
    this.summaryPersistAttempt += 1;
    const nextDelay = SUMMARY_RETRY_DELAYS_MS[this.summaryPersistAttempt];
    if (allowRetry && nextDelay != null) this.scheduleSummaryPersistence(nextDelay);
    const retrying = allowRetry && nextDelay != null;
    this.setData({
      summarySaveText: retrying ? '保存失败 · 自动重试' : '保存失败 · 退出前重试',
      summaryTrendText: buildRowerHistoryTrend(
        this.history,
        this.pendingSummary,
        retrying ? 'pending' : 'failed',
      ),
    });
    return false;
  },

  clearSummaryTimers() {
    if (this.summaryPersistTimer) clearTimeout(this.summaryPersistTimer);
    if (this.summaryExitTimer) clearTimeout(this.summaryExitTimer);
    this.summaryPersistTimer = null;
    this.summaryExitTimer = null;
    this.summaryExitArmedAtMs = null;
  },

  requestSummaryExit() {
    if (!['summary', 'recovery_done'].includes(this.data.phase)
        || this.exitPending) return false;
    const now = Date.now();
    if (this.summaryExitArmedAtMs != null
        && now - this.summaryExitArmedAtMs <= CONFIRM_WINDOW_MS) {
      this.summaryExitArmedAtMs = null;
      return this.closeAgent();
    }
    this.summaryExitArmedAtMs = now;
    if (this.data.phase === 'summary') this.setData({ summaryExitText: '再按一次确认键退出' });
    else this.setData({ exitText: '再按一次确认键退出' });
    this.summaryExitTimer = setTimeout(() => {
      this.summaryExitTimer = null;
      if (this.summaryExitArmedAtMs !== now) return;
      this.summaryExitArmedAtMs = null;
      if (this.data.phase === 'summary') this.setData({ summaryExitText: '确认保存并退出' });
      else if (this.data.phase === 'recovery_done') this.setData({ exitText: '完成并退出' });
    }, CONFIRM_WINDOW_MS);
    return true;
  },

  startRecovery() {
    if (this.data.phase !== 'summary' || this.exitPending) return false;
    if (this.settings.cooldownEnabled === false) return false;
    if (!this.summaryStored && !this.summaryPersistTimer) {
      this.scheduleSummaryPersistence(0);
    }
    return this.startGuide('recovery');
  },

  beginTerminalCleanup(reason) {
    if (this.terminalCleanupPromise) return this.terminalCleanupPromise;
    this.cancelReconnect('ftms', { clearTarget: false });
    this.cancelReconnect('hrs', { clearTarget: false });
    this.terminalCleanupPromise = Promise.all([
      Promise.resolve(this.ftmsSession.cleanup(reason)).catch(() => false),
      Promise.resolve(this.heartRateSession.cleanup(reason)).catch(() => false),
    ]).then(() => true, () => false);
    return this.terminalCleanupPromise;
  },

  async closeAgent() {
    if (this.exitPending) return false;
    if (!this.summaryStored && !this.persistPendingSummary(false)) {
      if (this.data.phase === 'summary') {
        this.setData({ summaryExitText: '保存失败 · 重试退出' });
      } else {
        this.setData({ exitText: '保存失败 · 重试退出' });
      }
      return false;
    }
    this.exitPending = true;
    this.stopGuideTicker();
    this.stopHudTicker();
    this.clearSummaryTimers();
    const cleanup = this.beginTerminalCleanup('exit');
    await settleWithin(cleanup, TERMINAL_CLEANUP_MS);
    this.dispatchExit();
    return true;
  },

  dispatchExit() {
    if (this.exitDispatched) return false;
    this.exitDispatched = true;
    try { wx.exitMiniProgram({}); } catch (_error) {}
    return true;
  },

  onTargetFocus(event) {
    const index = Number(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.index);
    const now = Date.now();
    if (this.lastDirectionAtMs != null && now - this.lastDirectionAtMs >= 0
        && now - this.lastDirectionAtMs < 600
        && index !== this.data.focusIndex) return false;
    if (Number.isInteger(index) && index !== this.data.focusIndex) {
      this.setData({ focusIndex: index });
    }
    return true;
  },

  focusCount() {
    if (this.data.phase === 'menu') return this.data.menuItems.length;
    if (this.data.phase === 'settings') return 3;
    if (this.data.phase === 'ftms') return 1 + this.data.ftmsCandidates.length;
    if (this.data.phase === 'hrs') return 2 + this.data.hrsCandidates.length;
    return 1;
  },

  moveFocus(delta, now) {
    this.lastDirectionAtMs = now;
    this.actions.markDirectionRelease(now);
    if (this.data.phase === 'summary' && delta > 0) return this.startRecovery();
    const count = this.focusCount();
    if (count <= 1) return false;
    const next = (this.data.focusIndex + delta + count) % count;
    this.setData({ focusIndex: next });
    return true;
  },

  executeFocused() {
    const phase = this.data.phase;
    const index = this.data.focusIndex;
    if (phase === 'menu') return this.activateMenu(index);
    if (phase === 'settings') return this.activateSetting(index);
    if (phase === 'ftms') {
      if (index === 0) {
        return this.ftmsValidatedForSession
          ? this.enterHeartRateSetup() : this.startFtmsScan();
      }
      return this.selectFtms(index - 1);
    }
    if (phase === 'hrs') {
      if (index === 0) {
        return this.hrsTarget ? this.startGuide('warmup') : this.startHeartRateScan();
      }
      if (index === this.data.hrsCandidates.length + 1) return this.startGuide('warmup');
      return this.selectHeartRate(index - 1);
    }
    if (phase === 'warmup' || phase === 'recovery') return this.onGuideAction();
    if (phase === 'hud') return this.requestFinish();
    if (phase === 'summary') return this.requestSummaryExit();
    if (phase === 'recovery_done') return this.closeAgent();
    return false;
  },

  onActionTap(event) {
    if (this.exitPending) return false;
    const action = String(event && event.currentTarget
      && event.currentTarget.dataset && event.currentTarget.dataset.action || 'action');
    if (!this.actions.canClaim(`tap:${action}`, Date.now(), {
      crossChannelDedupe: action !== 'hud-finish',
    })) return false;
    if (action === 'ftms-primary') {
      return this.ftmsValidatedForSession
        ? this.enterHeartRateSetup() : this.startFtmsScan();
    }
    if (action === 'hrs-primary') {
      return this.hrsTarget ? this.startGuide('warmup') : this.startHeartRateScan();
    }
    if (action === 'hrs-skip') return this.startGuide('warmup');
    if (action === 'guide') return this.onGuideAction();
    if (action === 'hud-finish') return this.requestFinish();
    if (action === 'summary-exit') return this.requestSummaryExit();
    if (action === 'done-exit') return this.closeAgent();
    return this.executeFocused();
  },

  handleBack() {
    if (this.exitPending) return false;
    const phase = this.data.phase;
    if (phase === 'menu') {
      try { wx.navigateBack({ delta: 1 }); } catch (_error) {}
      return true;
    }
    if (phase === 'settings') { this.enterMenu(); return true; }
    if (phase === 'ftms') { this.enterMenu(); return true; }
    if (phase === 'hrs') {
      Promise.resolve(this.heartRateSession.cleanup('back')).catch(() => {});
      this.hrsTarget = null;
      this.hrsCandidateRefs = [];
      this.setSurface('ftms', {
        ftmsReadyForWarmup: this.ftmsValidatedForSession,
        ftmsPrimaryLabel: this.ftmsValidatedForSession ? '下一步：心率' : '等待有效数据',
        ftmsStatus: this.ftmsValidatedForSession ? '已验证' : '等待数据',
      });
      return true;
    }
    if (phase === 'warmup' || phase === 'recovery') {
      if (this.guideCompleted && phase === 'recovery') {
        this.guideCompleted = false;
        this.guideIndex = RECOVERY_STEPS.length - 1;
        this.applyGuideStep();
        this.startGuideTicker();
        return true;
      }
      if (this.guideIndex > 0) {
        this.stopGuideTicker();
        this.guideIndex -= 1;
        this.applyGuideStep();
        this.startGuideTicker();
        return true;
      }
      if (phase === 'warmup') return this.enterHeartRateSetup();
      this.stopGuideTicker();
      this.setSurface('summary');
      return true;
    }
    if (phase === 'hud') return this.finishSessionToSummary();
    if (phase === 'summary') return this.requestSummaryExit();
    if (phase === 'recovery_done') {
      this.guideCompleted = false;
      this.guideKind = 'recovery';
      this.guideIndex = RECOVERY_STEPS.length - 1;
      this.setSurface('recovery', {
        guideHeading: '划后放松',
        guideActionLabel: '完成放松',
        guideAutoHint: '15 秒后自动完成',
        guideCountdownUnit: '秒',
      });
      this.applyGuideStep();
      this.startGuideTicker();
      return true;
    }
    return false;
  },

  onKeyUp(event) {
    const code = event && event.code;
    if (this.exitPending) {
      if (event && event.preventDefault) event.preventDefault();
      return;
    }
    if (code === 'Backspace') {
      this.globalConfirm.cancel();
      if (event && event.preventDefault) event.preventDefault();
      this.handleBack();
      return;
    }
    const now = Date.now();
    const claim = this.direction.claim(code, this.data.phase, now);
    if (claim.handled) {
      this.globalConfirm.cancel();
      if (event && event.preventDefault) event.preventDefault();
      if (claim.accepted) this.moveFocus(claim.delta, now);
      return;
    }
    if (code !== 'GlobalHook') return;
    if (event && event.preventDefault) event.preventDefault();
    if (MULTI_TARGET_PHASES.has(this.data.phase)) {
      this.globalConfirm.schedule(() => {
        const confirmedAt = Date.now();
        if (this.actions.canClaim(
          `${this.data.phase}:${this.data.focusIndex}`,
          confirmedAt,
        )) this.executeFocused();
      });
      return;
    }
    if (this.actions.canClaim(
      `${this.data.phase}:${this.data.focusIndex}`,
      now,
      { crossChannelDedupe: this.data.phase !== 'hud' },
    )) this.executeFocused();
  },
};
</script>

<page>
  <view class="stage">
    <view class="surface menu" ink:if="{{phase === 'menu'}}">
      <view class="topbar"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">划船机教练</text></view><text class="version">v0.0.1</text></view>
      <view class="plan-line" ink:if="{{planReady}}"><text>今日计划</text><text class="plan-title">{{planTitle}}</text></view>
      <button ink:for="{{menuItems}}" ink:key="index" data-index="{{index}}" class="menu-button {{focusIndex === index ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="chooseMenu"><text>{{item}}</text></button>
      <text class="footer">前后划选择 · 单击确认</text>
    </view>

    <view class="surface settings" ink:elif="{{phase === 'settings'}}">
      <view class="topbar"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">设置</text></view><text class="channel-note">本机优先</text></view>
      <button data-index="0" class="setting-row {{focusIndex === 0 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="toggleSetting"><text>语音提示</text><text>{{voiceText}}</text></button>
      <button data-index="1" class="setting-row {{focusIndex === 1 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="toggleSetting"><text>划后放松</text><text>{{cooldownText}}</text></button>
      <button data-index="2" class="setting-row {{focusIndex === 2 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="toggleSetting"><text>返回训练菜单</text><text>确认</text></button>
      <view class="privacy-note"><text>只保存聚合指标，不保存设备名、标识或原始蓝牙数据</text></view>
      <text class="footer">前后划循环 · 单击修改</text>
    </view>

    <view class="surface devices" ink:elif="{{phase === 'ftms'}}">
      <view class="topbar"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">连接划船机</text></view><text class="channel-note">步骤 1 / 2</text></view>
      <view class="sensor-channel"><view class="sensor-name"><view class="sensor-mark"><text>F</text></view><text>FTMS 划船机 · 必选</text></view><text class="sensor-state">{{ftmsStatus}}</text></view>
      <text class="device-detail">{{ftmsDetail}}</text>
      <button data-index="0" data-action="ftms-primary" class="primary-button {{focusIndex === 0 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="onActionTap"><text>{{ftmsPrimaryLabel}}</text></button>
      <view class="device-list">
        <button ink:for="{{ftmsCandidates}}" ink:key="index" data-index="{{index}}" class="device-row {{focusIndex === index + 1 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="onFtmsCandidateTap"><text class="device-name">{{item.name}}</text><text class="device-state">{{item.status}}</text></button>
        <text class="empty" ink:if="{{ftmsCandidates.length === 0}}">{{ftmsScanState === 'scanning' ? '正在等待附近设备广播' : '用户确认后才开始搜索'}}</text>
      </view>
      <text class="footer">订阅成功不等于数据已接入</text>
    </view>

    <view class="surface devices" ink:elif="{{phase === 'hrs'}}">
      <view class="topbar"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">连接心率</text></view><text class="channel-note">步骤 2 / 2</text></view>
      <view class="sensor-pair"><view class="mini-channel"><view class="sensor-mark"><text>F</text></view><text>FTMS 已验证</text></view><view class="mini-channel"><view class="sensor-mark"><text>H</text></view><text>HRS {{hrsStatus}}</text></view></view>
      <text class="device-detail">{{hrsDetail}}</text>
      <button data-index="0" data-action="hrs-primary" class="primary-button {{focusIndex === 0 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="onActionTap"><text>{{hrsPrimaryLabel}}</text></button>
      <view class="device-list compact-list">
        <button ink:for="{{hrsCandidates}}" ink:key="index" data-index="{{index}}" class="device-row {{focusIndex === index + 1 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="onHeartRateCandidateTap"><text class="device-name">{{item.name}}</text><text class="device-state">{{item.status}}</text></button>
        <text class="empty" ink:if="{{hrsCandidates.length === 0}}">心率带可选，失败不会断开划船机</text>
      </view>
      <button data-index="{{hrsCandidates.length + 1}}" data-action="hrs-skip" class="secondary-button {{focusIndex === hrsCandidates.length + 1 ? 'focused' : ''}}" bindfocus="onTargetFocus" bindtap="onActionTap"><text>{{hrsSkipLabel}}</text></button>
    </view>

    <view class="surface guide" ink:elif="{{phase === 'warmup' || phase === 'recovery'}}">
      <view class="topbar"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">{{guideHeading}}</text></view><text class="channel-note">{{guideProgress}}</text></view>
      <view class="guide-panel"><view class="guide-figure"><view class="guide-machine"><view class="guide-wheel"></view><view class="guide-rail"></view><view class="guide-seat"></view><view class="guide-handle"></view></view><text class="guide-step-mark">{{guideProgress}}</text></view><view class="guide-copy"><view class="guide-title-row"><text class="guide-title">{{guideTitle}}</text><view class="guide-timer"><text class="guide-count">{{guideCountdown}}</text><text class="guide-unit">{{guideCountdownUnit}}</text></view></view><text class="guide-instruction">{{guideInstruction}}</text><text class="guide-safety">{{guideSafety}}</text><text class="guide-auto">{{guideAutoHint}}</text></view></view>
      <button data-action="guide" class="guide-button focused" bindtap="onActionTap"><text>{{guideActionLabel}}</text></button>
    </view>

    <view class="surface hud" ink:elif="{{phase === 'hud'}}">
      <view class="hud-top"><view class="product"><view class="logo-mark small-logo"><text>R</text></view><text class="stage-name">{{stageTitle}}</text></view><text class="end-warning" ink:if="{{hudEnding}}">{{finishHint}}</text><view class="status-pair" ink:else><text class="status-chip">{{ftmsChipText}}</text><text class="status-chip">{{hrsChipText}}</text></view></view>
      <view class="metric-grid"><view class="metric main-metric"><text class="metric-value split-value">{{splitText}}</text><text class="metric-label">500m 配速</text></view><view class="metric"><text class="metric-value">{{elapsedText}}</text><text class="metric-label">活动计时</text></view><view class="metric"><text class="metric-value">{{strokeText}}</text><text class="metric-label">桨频 spm</text></view><view class="metric"><text class="metric-value">{{distanceText}}</text><text class="metric-label">距离 m</text></view><view class="metric"><text class="metric-value">{{powerText}}</text><text class="metric-label">功率 W</text></view><view class="metric"><text class="metric-value">{{heartText}}</text><text class="metric-label">{{heartSourceText}}</text></view></view>
      <view class="coach"><text class="stage-target">{{stageTarget}}</text><text class="coach-cue">{{coachCue}}</text></view>
      <button data-action="hud-finish" class="hud-finish focused" bindtap="onActionTap"><text>{{finishHint}}</text></button>
    </view>

    <view class="surface summary" ink:elif="{{phase === 'summary'}}">
      <view class="topbar summary-top"><view class="product"><view class="logo-mark"><text>R</text></view><text class="title">训练总结</text></view><text class="channel-note">{{summarySaveText}}</text></view>
      <view class="summary-core"><view class="summary-metric"><text class="summary-value">{{summaryElapsed}}</text><text class="summary-label">时长</text></view><view class="summary-metric"><text class="summary-value">{{summaryDistance}}</text><text class="summary-label">距离 m</text></view><view class="summary-metric"><text class="summary-value">{{summarySplit}}</text><text class="summary-label">平均 500m</text></view><view class="summary-metric"><text class="summary-value">{{summaryStroke}}</text><text class="summary-label">平均桨频</text></view></view>
      <view class="chart-panel" ink:if="{{showSummaryChart}}"><view class="chart-head"><text>{{summaryChartTitle}}</text><text>{{summaryChartUnit}}</text></view><chart class="summary-chart" type="line" series="{{summaryChartSeries}}" data="{{summaryChartData}}" y-axis="{{summaryChartYAxis}}" x-axis="{{summaryChartXAxis}}" width="438" height="48" smooth="false" animate="false"></chart></view>
      <view class="chart-panel chart-empty" ink:else><text>{{summaryChartEmptyText}}</text></view>
      <text class="summary-evidence">{{summaryEvidence}}</text>
      <view class="review-panel"><text class="review-copy">{{summaryReview}}</text><text class="review-source">{{summaryReviewSource}} · {{summaryTrendText}}</text></view>
      <button data-action="summary-exit" class="summary-exit focused" bindtap="onActionTap"><text>{{summaryExitText}}</text></button>
      <text class="summary-forward">{{summaryForwardText}}</text>
    </view>

    <view class="surface done" ink:elif="{{phase === 'recovery_done'}}"><view class="done-logo"><text>R</text></view><text class="done-title">放松完成</text><text class="done-copy">{{doneText}}</text><button data-action="done-exit" class="done-exit focused" bindtap="onActionTap"><text>{{exitText}}</text></button></view>

    <view class="surface error-surface" ink:else><view class="done-logo"><text>R</text></view><text class="done-title">状态已重置</text><text class="done-copy">请返回后重新进入训练</text></view>
  </view>
</page>

<style>
.stage { display: flex; flex-direction: column; box-sizing: border-box; width: 480px; height: 352px; padding: 14px 16px; overflow: hidden; background-color: #000000; color: #40ff5e; }
.surface { display: flex; flex-direction: column; box-sizing: border-box; width: 448px; height: 324px; overflow: hidden; }
.topbar, .hud-top { display: flex; flex-direction: row; align-items: center; justify-content: space-between; box-sizing: border-box; width: 448px; height: 36px; border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: rgba(64,255,94,0.28); }
.product { display: flex; flex-direction: row; align-items: center; min-width: 0; }
.logo-mark { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 28px; height: 28px; margin-right: 8px; border-width: 1px; border-style: solid; border-color: #40ff5e; border-radius: 14px; color: #40ff5e; font-family: monospace; font-size: 16px; line-height: 20px; }
.small-logo { width: 24px; height: 24px; margin-right: 6px; }
.title { color: #40ff5e; font-size: 24px; line-height: 30px; font-weight: 500; }
.version, .channel-note { color: rgba(64,255,94,0.6); font-family: monospace; font-size: 14px; line-height: 20px; }
.focused { outline-width: 2px; outline-style: solid; outline-color: #40ff5e; outline-offset: -2px; }
.footer { width: 448px; margin-top: auto; color: rgba(64,255,94,0.48); font-size: 15px; line-height: 20px; text-align: center; }
.plan-line { display: flex; flex-direction: row; align-items: center; box-sizing: border-box; width: 448px; height: 38px; margin: 5px 0 3px; padding: 0 10px; overflow: hidden; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.28); border-radius: 6px; color: rgba(64,255,94,0.72); font-size: 15px; line-height: 20px; }
.plan-title { flex-grow: 1; margin-left: 10px; overflow: hidden; color: #40ff5e; text-align: right; }
.menu-button, .setting-row, .primary-button, .secondary-button, .device-row, .guide-button, .summary-exit, .done-exit { display: flex; flex-direction: row; align-items: center; justify-content: space-between; box-sizing: border-box; width: 448px; margin: 4px 0; padding: 0 14px; background-color: rgba(64,255,94,0.06); border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.32); border-radius: 4px; color: #40ff5e; }
.menu-button { justify-content: center; height: 54px; font-size: 21px; line-height: 28px; font-weight: 500; }
.setting-row { height: 54px; font-size: 18px; line-height: 24px; }
.privacy-note { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 448px; height: 54px; margin-top: 5px; padding: 0 16px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.22); border-radius: 6px; color: rgba(64,255,94,0.6); font-size: 15px; line-height: 20px; text-align: center; }
.sensor-channel, .sensor-pair { display: flex; flex-direction: row; align-items: center; justify-content: space-between; box-sizing: border-box; width: 448px; height: 36px; margin-top: 5px; padding: 0 8px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.32); border-radius: 6px; }
.sensor-name, .mini-channel { display: flex; flex-direction: row; align-items: center; color: #40ff5e; font-size: 15px; line-height: 20px; }
.sensor-mark { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 20px; height: 20px; margin-right: 6px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.72); border-radius: 10px; color: #40ff5e; font-family: monospace; font-size: 12px; line-height: 16px; }
.sensor-state { color: rgba(64,255,94,0.72); font-size: 15px; line-height: 20px; }
.mini-channel { width: 204px; }
.device-detail { width: 448px; height: 24px; margin-top: 2px; overflow: hidden; color: rgba(64,255,94,0.6); font-size: 15px; line-height: 24px; text-align: center; }
.primary-button { justify-content: center; height: 42px; font-size: 18px; line-height: 24px; font-weight: 600; }
.secondary-button { justify-content: center; height: 38px; margin-top: 3px; color: rgba(64,255,94,0.82); font-size: 16px; line-height: 22px; }
.device-list { display: flex; flex-direction: column; box-sizing: border-box; width: 448px; height: 148px; overflow: hidden; }
.compact-list { height: 104px; }
.device-row { height: 42px; margin: 2px 0; font-size: 16px; line-height: 22px; }
.device-name { width: 286px; overflow: hidden; text-align: left; }
.device-state { width: 120px; color: rgba(64,255,94,0.6); text-align: right; }
.empty { width: 448px; margin-top: 42px; color: rgba(64,255,94,0.48); font-size: 15px; line-height: 20px; text-align: center; }
.compact-list .empty { margin-top: 28px; }
.guide-panel { display: flex; flex-direction: row; align-items: center; box-sizing: border-box; width: 448px; height: 220px; margin: 6px 0; padding: 8px; overflow: hidden; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.28); border-radius: 6px; }
.guide-figure { display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; width: 160px; height: 160px; margin-right: 12px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.28); border-radius: 6px; }
.guide-machine { position: relative; width: 132px; height: 78px; }
.guide-wheel { position: absolute; left: 2px; bottom: 2px; box-sizing: border-box; width: 50px; height: 50px; border-width: 3px; border-style: solid; border-color: #40ff5e; border-radius: 25px; }
.guide-rail { position: absolute; right: 2px; bottom: 17px; width: 94px; height: 3px; background-color: #40ff5e; }
.guide-seat { position: absolute; right: 22px; bottom: 23px; width: 28px; height: 5px; background-color: #40ff5e; }
.guide-handle { position: absolute; left: 41px; top: 5px; width: 48px; height: 2px; background-color: rgba(64,255,94,0.72); }
.guide-step-mark { margin-top: 12px; color: rgba(64,255,94,0.6); font-family: monospace; font-size: 16px; line-height: 20px; }
.guide-copy { display: flex; flex-direction: column; box-sizing: border-box; width: 252px; height: 196px; overflow: hidden; }
.guide-title-row { display: flex; flex-direction: row; align-items: center; justify-content: space-between; width: 252px; height: 58px; }
.guide-title { width: 154px; font-size: 23px; line-height: 29px; font-weight: 600; }
.guide-timer { display: flex; flex-direction: row; align-items: baseline; justify-content: flex-end; width: 94px; }
.guide-count { font-family: monospace; font-size: 40px; line-height: 48px; font-weight: 700; }
.guide-unit { margin-left: 3px; color: rgba(64,255,94,0.6); font-size: 15px; line-height: 20px; }
.guide-instruction { margin-top: 8px; color: #40ff5e; font-size: 17px; line-height: 23px; }
.guide-safety { margin-top: 8px; color: rgba(64,255,94,0.72); font-size: 15px; line-height: 21px; }
.guide-auto { margin-top: auto; color: rgba(64,255,94,0.48); font-size: 15px; line-height: 20px; }
.guide-button { justify-content: center; height: 50px; margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; }
.hud-top { height: 34px; }
.stage-name { max-width: 130px; overflow: hidden; font-size: 19px; line-height: 25px; font-weight: 600; }
.status-pair { display: flex; flex-direction: row; align-items: center; justify-content: flex-end; }
.status-chip { box-sizing: border-box; margin-left: 5px; padding: 1px 5px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.38); border-radius: 4px; color: rgba(64,255,94,0.72); font-family: monospace; font-size: 12px; line-height: 18px; }
.end-warning { color: #40ff5e; font-size: 17px; line-height: 22px; font-weight: 600; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 92px 92px; box-sizing: border-box; width: 448px; height: 184px; margin-top: 5px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.3); border-radius: 6px; }
.metric { display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; border-right-width: 1px; border-right-style: solid; border-right-color: rgba(64,255,94,0.22); border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: rgba(64,255,94,0.22); }
.metric-value { font-family: monospace; font-size: 28px; line-height: 34px; font-weight: 700; }
.split-value { font-size: 34px; line-height: 40px; }
.metric-label { color: rgba(64,255,94,0.55); font-size: 15px; line-height: 20px; text-align: center; }
.coach { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 448px; height: 72px; overflow: hidden; }
.stage-target { color: #40ff5e; font-size: 17px; line-height: 23px; font-weight: 600; }
.coach-cue { width: 438px; color: rgba(64,255,94,0.68); font-size: 15px; line-height: 21px; text-align: center; }
.hud-finish { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 448px; height: 28px; padding: 0; background-color: transparent; border: 0; color: rgba(64,255,94,0.55); font-size: 15px; line-height: 20px; }
.summary-top { height: 34px; }
.summary-core { display: flex; flex-direction: row; box-sizing: border-box; width: 448px; height: 60px; margin-top: 4px; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.28); border-radius: 6px; }
.summary-metric { display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; width: 112px; border-right-width: 1px; border-right-style: solid; border-right-color: rgba(64,255,94,0.2); }
.summary-value { font-family: monospace; font-size: 20px; line-height: 26px; font-weight: 700; }
.summary-label { color: rgba(64,255,94,0.52); font-size: 15px; line-height: 20px; }
.chart-panel { display: flex; flex-direction: column; align-items: center; box-sizing: border-box; width: 448px; height: 70px; margin-top: 4px; padding: 2px 4px; overflow: hidden; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.24); border-radius: 6px; color: rgba(64,255,94,0.58); font-size: 15px; line-height: 18px; }
.chart-head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; width: 438px; height: 18px; }
.summary-chart { width: 438px; height: 48px; }
.chart-empty { justify-content: center; }
.summary-evidence { width: 448px; height: 20px; margin-top: 2px; overflow: hidden; color: rgba(64,255,94,0.68); font-size: 15px; line-height: 20px; text-align: center; }
.review-panel { display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; width: 448px; height: 55px; margin-top: 2px; padding: 2px 8px; overflow: hidden; border-width: 1px; border-style: solid; border-color: rgba(64,255,94,0.2); border-radius: 6px; }
.review-copy { width: 432px; color: rgba(64,255,94,0.8); font-size: 15px; line-height: 20px; text-align: center; }
.review-source { width: 432px; overflow: hidden; color: rgba(64,255,94,0.45); font-size: 13px; line-height: 18px; text-align: center; }
.summary-exit { justify-content: center; height: 36px; margin: 3px 0 0; font-size: 16px; line-height: 22px; }
.summary-forward { width: 448px; height: 18px; color: rgba(64,255,94,0.45); font-size: 14px; line-height: 18px; text-align: center; }
.done, .error-surface { align-items: center; justify-content: center; }
.done-logo { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 72px; height: 72px; border-width: 2px; border-style: solid; border-color: #40ff5e; border-radius: 36px; color: #40ff5e; font-family: monospace; font-size: 36px; line-height: 44px; }
.done-title { margin-top: 12px; font-size: 28px; line-height: 34px; font-weight: 600; }
.done-copy { margin: 10px 0 18px; color: rgba(64,255,94,0.68); font-size: 17px; line-height: 23px; }
.done-exit { justify-content: center; width: 360px; height: 46px; font-size: 18px; line-height: 24px; }
</style>
