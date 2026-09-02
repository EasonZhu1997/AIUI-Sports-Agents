<script type="application/json" def>
{
  "navigationBarTitleText": "跑步教练"
}
</script>

<script setup>
// 同一兼容首页按宿主 target 自适应：_current 保持 448x150 摘要卡，
// _blank 展开为 480x352 首页。心率、扫描和设置仍只在沉浸跑步页执行。
import wx from 'wx';
import {
  resolveCoachBackendConfig, buildAnonLoginRequest, parseAnonLoginResponse,
  buildAiuiRecordRequest, parseAiuiRecordResponse,
  buildMemoryContextRequest, parseMemoryContext,
  COACH_TOKEN_STORAGE_KEY,
} from '../../lib/coach_api.js';
import {
  ensureLocalDeviceIdentity,
  bootstrapDeviceIdentity,
  clearDeviceAuth,
  DEVICE_BINDING_STORAGE_KEY,
  DEVICE_TOKEN_STORAGE_KEY,
  LEGACY_DEVICE_ID_STORAGE_KEY,
  ownerScopedDataAvailable,
  PUBLIC_DEVICE_ID_STORAGE_KEY,
  shouldClearOwnerScopedState,
} from '../../lib/device_identity.js';
import {
  enqueueAiuiRecord, readPendingAiuiRecords, removePendingAiuiRecord,
  clearPendingAiuiRecords,
} from '../../lib/aiui_record_queue.js';
import { readRunSettings } from '../../lib/settings.js';
import {
  enqueueLocalRunMemory, buildLocalRunMemoryContext, clearLocalRunMemories,
} from '../../lib/local_run_memory.js';
import {
  readPendingRunSummary, clearPendingRunSummary, buildRunSummaryPrompt,
  fallbackRunSummary, finalizeRunSummaryText, RUN_SUMMARY_QUESTION,
} from '../../lib/run_summary.js';
import {
  readPendingRunUploadsState,
  removePendingRunUpload, enqueueRunUpload,
  buildRunUploadPayload,
  buildRunUploadRequest, parseRunUploadResponse,
  isPermanentRunUploadRejection,
} from '../../lib/run_upload.js';
import {
  AIUI_CALIBRATION_BATCH_SIZE,
  buildAiuiCalibrationRequest,
  isPermanentAiuiCalibrationRejection,
  parseAiuiCalibrationResponse,
  readPendingAiuiCalibrationEventsState,
  removePendingAiuiCalibrationEvents,
} from '../../lib/aiui_calibration.js';
import {
  quarantineAiuiCalibrationEvent,
  quarantineRunUpload,
} from '../../lib/run_upload_records.js';
import {
  beginInternalSurfaceNavigation,
  completeHomeResume,
  consumeScanExitHint,
  consumeRunFinishedHint,
} from '../../lib/surface_resume.js';
import { normalizeWxJsonResponse } from '../../lib/wx_json.js';

const UPLOAD_TIMEOUT_MS = 2500;   // 补传是后台行为,不许拖慢首页
const RUN_ROUTE = '/pages/run_hud/index';

const LLM_SUMMARY_TIMEOUT_MS = 8000; // 内置模型生成上限,超时走规则兜底
const EXIT_CONFIRM_WINDOW_MS = 3000; // 双按返回退出:第一按亮提示,3s 内再按才真退出
const RUN_SUMMARY_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 陈年后台归档待办直接丢弃
const HOME_CONFIRM_DEDUPE_MS = 400;
const HOME_MENU_ROUTE = RUN_ROUTE + '?mode=menu&inputGuard=1&fromHome=1';
const LOCAL_MEMORY_LANGUAGE = 'zh-CN';

export default {
  data: {
    // target 只表示宿主承载语义，不当作精确视口或业务状态使用。
    hostTarget: '_current',
    // 对话流卡只保留一个安全入口；多目标选择放在沉浸菜单。
    homeVersion: 'v0.1.114',
    homeSlogan: '自由开跑，智能相伴',
    // 主入口行兼职退出提示位:双按返回的第一按在这里亮"再按返回键退出"。
    enterText: '按确认键进入',
  },

  onLoad() {
    this.lastHomeConfirmAtMs = null;
    // 代次只增不减：AIUI 若复用同一页面实例，上一次 onLoad 留下的
    // 异步总结/提示也必须在新代次失效，不能把数字重置后意外通过校验。
    this.ownerDataGeneration = (Number(this.ownerDataGeneration) || 0) + 1;
    this.ownerAuthGeneration = (Number(this.ownerAuthGeneration) || 0) + 1;
    this.ownerDataBlocked = false;
    this.observedOwnerBinding = null;
    // AIUI 可能复用页面实例；冷启代次先撤下上一代的内存总结/退出武装。
    this.disarmExitPrompt();
    this.setData({
      hostTarget: '_current',
      homeSlogan: '自由开跑，智能相伴',
      enterText: '按确认键进入',
    });
    // 扫描页第一下返回由宿主弹栈；若首页在 3 秒内冷建，直接承接第二下退出。
    if (consumeScanExitHint(wx, EXIT_CONFIRM_WINDOW_MS)) this.armExitPrompt();
    if (this.ownerDataIsAvailable()) completeHomeResume(wx);
    // 首次身份由服务器签发并在本地原子缓存；未绑定 APK 也拥有独立账号，
    // 绑定后同一个 public_device_id 自动切到 APK 用户/智能体，不迁移或丢失待传队列。
    const identityConfig = resolveCoachBackendConfig(wx);
    this.refreshDeviceIdentity(identityConfig);
    // 静默补传跑步记录(best-effort,不 await、不影响首页任何交互):
    // run_hud 退出时只入队,真正的网络发送收敛在这里 —— 页面存活期内完成更可靠。
    this.flushRunUploads();
    this.flushAiuiCalibrationUploads();
    this.flushAiuiRecords();
    this.archiveRunSummary();
    // 跑完提示同样属于 owner-scoped 数据；先等共享 bootstrap 判定归属，避免快速
    // bind→unbind 后把旧用户提示武装到新匿名所有者。
    this.syncRunFinishedHint(identityConfig);
  },

  onShow() {
    // navigateTo 成功后保持锁定，直到宿主真正返回首页，避免同一次物理确认
    // 同时派发 GlobalHook / Enter 时把同一个沉浸页压栈两次。
    this.runNavigationPending = false;
    // 首页实例通常只是从隐藏恢复，必须在任何网络 bootstrap 之前消费这枚
    // 3 秒标记，否则冷连接会让“连续两次返回”窗口失效。
    if (consumeScanExitHint(wx, EXIT_CONFIRM_WINDOW_MS)) this.armExitPrompt();
    // 绑定/解绑可能是在沉浸设置页完成的，那个页面已经清了 storage，
    // 但隐藏的首页实例没收到它的回调。用首页上次观测到的不透明 marker
    // 复核当前 storage，保证返回时同步撤下旧 owner 的内存文本。
    const ownerDataReady = this.reconcileStoredOwnerBinding();
    if (ownerDataReady) completeHomeResume(wx);
    // 从设置/手机绑定流程回来时主动刷新一次，拿到最新 bound 状态与轮换 token。
    const identityConfig = resolveCoachBackendConfig(wx);
    this.refreshDeviceIdentity(identityConfig, { force: true });
    this.syncRunFinishedHint(identityConfig);
    // 宿主恢复现有首页实例时可能只触发 onShow;补传同时挂在这里,
    // 避免新跑完的记录要等下次冷启动才发。
    this.flushRunUploads();
    this.flushAiuiCalibrationUploads();
    this.flushAiuiRecords();
    this.archiveRunSummary();
  },

  // ── 跑步记录补传(source="aiui" 落后端 runs 表,复用 APK 生态跑后管线)──
  wxRequest(req) {
    const requestUrl = String(req && req.url || '').trim();
    if (!/^https:\/\//i.test(requestUrl)) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      let requestTask = null;
      const requestedTimeout = Number(req && req.timeout);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout : UPLOAD_TIMEOUT_MS;
      let timer = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      timer = setTimeout(() => {
        try {
          if (requestTask && typeof requestTask.abort === 'function') requestTask.abort();
        } catch (_e) {}
        finish(null);
      }, timeoutMs + 250);
      try {
        requestTask = wx.request({
          ...req,
          dataType: 'json',
          responseType: 'text',
          timeout: timeoutMs,
          success: (r) => finish(normalizeWxJsonResponse(r)),
          fail: () => finish(null),
        });
      } catch (_e) { finish(null); }
    });
  },

  // 旧 anon-login 的兼容 ID：只要存在 smartrun_device_id 就继续沿用它，
  // 不因新后端已分配 public_device_id 而在旧账号体系制造第二个匿名用户。
  ensureDeviceId() {
    const identity = ensureLocalDeviceIdentity(wx, {
      cryptoObject: typeof crypto === 'undefined' ? null : crypto,
    });
    this.deviceIdCache = identity.legacyDeviceId
      || identity.publicDeviceId || identity.installationId;
    return this.deviceIdCache;
  },

  async refreshDeviceIdentity(config, opts = {}) {
    if (!config) {
      const local = ensureLocalDeviceIdentity(wx, {
        cryptoObject: typeof crypto === 'undefined' ? null : crypto,
      });
      this.deviceIdentityCache = local;
      return local;
    }
    const storedAtStart = this.readStoredOwnerContext();
    const expectedOwner = opts.operation && opts.operation.owner
      ? opts.operation.owner
      : (storedAtStart.status === 'ok' ? storedAtStart.context : null);
    const requestOwnerKey = this.ownerContextKey(expectedOwner)
      + '#' + String(Number(this.ownerAuthGeneration) || 0);
    if (this.deviceIdentityPromise
        && this.deviceIdentityPromiseOwner === requestOwnerKey) {
      return this.deviceIdentityPromise;
    }
    if (this.deviceIdentityAttempted && !opts.force
        && (!expectedOwner
          || expectedOwner.kind === 'legacy'
          || this.sameOwnerContext(
            this.ownerBindingFromIdentity(this.deviceIdentityCache),
            expectedOwner,
          ))) return this.deviceIdentityCache;
    this.deviceIdentityAttempted = true;
    const requestTicket = (Number(this.deviceIdentityRequestTicket) || 0) + 1;
    this.deviceIdentityRequestTicket = requestTicket;
    const requestAuthGeneration = Number(this.ownerAuthGeneration) || 0;
    const promise = bootstrapDeviceIdentity({
      storage: wx,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      appKey: config.appKey,
      navigatorObject: typeof navigator === 'undefined' ? null : navigator,
      cryptoObject: typeof crypto === 'undefined' ? null : crypto,
      TextEncoderCtor: typeof TextEncoder === 'undefined' ? null : TextEncoder,
      coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY,
      onOwnerDataCleared: () => this.handleOwnerDataCleared(),
      request: (request) => this.wxRequest(request),
    }).then((identity) => {
      if (requestTicket !== (Number(this.deviceIdentityRequestTicket) || 0)
          || requestAuthGeneration !== (Number(this.ownerAuthGeneration) || 0)) {
        return identity;
      }
      const storedAfter = this.readStoredOwnerContext();
      const identityOwner = this.ownerBindingFromIdentity(identity);
      if (storedAfter.status !== 'ok'
          || !this.sameOwnerContext(identityOwner, storedAfter.context)) {
        this.deviceIdentityCache = null;
        return identity;
      }
      this.deviceIdentityCache = identity;
      // 路由依据是 token 类型而不是“本次 bootstrap 是否联网成功”：已有 device token
      // 时短暂离线仍必须走 /coach/aiui-runs，绝不能误发旧 /runs 后被 401 清掉。
      this.deviceIdentityUsesBootstrap = !!(identity && identity.deviceToken);
      if (identity && identity.effectiveDeviceId) this.deviceIdCache = identity.effectiveDeviceId;
      this.reconcileObservedOwnerBinding(identity, {
        alreadyCleared: !!(identity && identity.ownerDataCleared),
      });
      return identity;
    });
    this.deviceIdentityPromise = promise;
    this.deviceIdentityPromiseOwner = requestOwnerKey;
    try {
      return await promise;
    } finally {
      if (this.deviceIdentityPromise === promise) {
        this.deviceIdentityPromise = null;
        this.deviceIdentityPromiseOwner = null;
      }
    }
  },

  // 复用教练页同一枚匿名 JWT;无 coach_app_key(后端链路未开通)则不发登录请求。
  async ensureUploadToken(config, operation) {
    if (!config || !this.ownerOperationIsCurrent(operation, 'token-start')) return '';
    // 首页 onLoad 会并行触发记录补传、记忆补传和总结生成。三条链路共享
    // 同一个 owner/token Promise；完整 marker 或 auth 代次不同绝不共享。
    const promiseOwnerKey = this.ownerContextKey(operation.owner)
      + '#' + String(operation.authGeneration);
    if (this.uploadTokenPromise
        && this.uploadTokenPromiseOwner === promiseOwnerKey) {
      return this.uploadTokenPromise;
    }
    const promise = (async () => {
      // 新链路每次页面代次至少 bootstrap 一次：匿名设备可直接上传；APK 完成绑定后
      // 后端会返回刷新 token，必须替换旧 coach_token 才能把后续数据归入绑定用户。
      const identity = await this.refreshDeviceIdentity(config, { operation });
      if (!this.ownerOperationIsCurrent(operation, 'token-after-bootstrap')) return '';
      if (identity && identity.deviceToken) {
        return this.identityMatchesOwnerOperation(identity, operation)
          ? identity.deviceToken : '';
      }
      // 明确 credential 失败不能降级到另一套匿名账号，否则会绕过设备所有权边界。
      if (identity && (identity.statusCode === 401
          || identity.credentialRecoveryRequired
          || identity.credentialStorageUnavailable
          || identity.credentialPersistenceFailed
          || identity.ownerTransitionBlocked)) return '';

      // 新端点尚未部署/离线时兼容旧 token + anon-login，待传队列保持原样。
      let stored = '';
      try {
        stored = wx.getStorageSync(COACH_TOKEN_STORAGE_KEY) || '';
      } catch (_e) {
        return '';
      }
      if (!this.ownerOperationIsCurrent(operation, 'token-after-legacy-read')) return '';
      if (stored) return stored;
      // legacy anon-login 仍强制 app_key；新 bootstrap 也失败时不打一个注定 422 的请求。
      if (!config.appKey) return '';
      const resp = await this.wxRequest(buildAnonLoginRequest({
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        appKey: config.appKey,
        deviceId: this.ensureDeviceId(),
      }));
      if (!this.ownerOperationIsCurrent(operation, 'token-after-anon-login')) return '';
      const fresh = parseAnonLoginResponse(resp) || '';
      if (fresh) {
        if (!this.ownerOperationIsCurrent(operation, 'token-before-legacy-write')) return '';
        try { wx.setStorageSync(COACH_TOKEN_STORAGE_KEY, fresh); } catch (_e) {}
        if (!this.ownerOperationIsCurrent(operation, 'token-after-legacy-write')) return '';
      }
      return fresh;
    })();
    this.uploadTokenPromise = promise;
    this.uploadTokenPromiseOwner = promiseOwnerKey;
    try {
      return await promise;
    } finally {
      if (this.uploadTokenPromise === promise) {
        this.uploadTokenPromise = null;
        this.uploadTokenPromiseOwner = null;
      }
    }
  },

  invalidateDeviceIdentityAuth(operation, token) {
    if (!this.tokenStillOwnedByOperation(operation, token)) return false;
    clearDeviceAuth(wx, { coachTokenStorageKey: COACH_TOKEN_STORAGE_KEY });
    this.deviceIdentityAttempted = false;
    this.deviceIdentityUsesBootstrap = false;
    this.deviceIdentityCache = null;
    this.deviceIdentityPromise = null;
    this.deviceIdentityPromiseOwner = null;
    this.uploadTokenPromise = null;
    this.uploadTokenPromiseOwner = null;
    return true;
  },

  handleOwnerDataCleared(reason = 'owner-transition') {
    this.ownerDataGeneration = (Number(this.ownerDataGeneration) || 0) + 1;
    this.resetOwnerNetworkState(reason);
    // 若旧 owner 的跑完提示已在另一次生命周期回调中点亮，所有权清理必须同步撤销。
    this.disarmExitPrompt();
    // 归属切换时撤销旧 owner 的所有后台数据；首页只恢复静态入口说明。
    this.setData({ homeSlogan: '自由开跑，智能相伴' });
  },

  ownerDataIsAvailable() {
    let replayed = false;
    let available = false;
    try {
      available = ownerScopedDataAvailable(wx, {
        onReplayed: () => { replayed = true; },
      });
    } catch (_e) {
      if (!this.ownerDataBlocked) {
        this.resetOwnerNetworkState('owner-storage-unknown');
      }
      this.ownerDataBlocked = true;
      return false;
    }
    if (replayed) this.handleOwnerDataCleared('owner-journal-replayed');
    if (!available) {
      if (!this.ownerDataBlocked && !replayed) {
        this.handleOwnerDataCleared('owner-storage-unavailable');
      }
      this.ownerDataBlocked = true;
      return false;
    }
    if (this.ownerDataBlocked) {
      // storage 恢复后必须重新 bootstrap；不可复用阻断期间缓存的空身份。
      this.deviceIdentityAttempted = false;
      this.deviceIdentityUsesBootstrap = false;
      this.deviceIdentityCache = null;
    }
    this.ownerDataBlocked = false;
    return true;
  },

  ownerBindingFromIdentity(identity) {
    if (!identity) return null;
    const ownershipEpoch = Number(identity.ownershipEpoch);
    const dataNamespace = typeof identity.dataNamespace === 'string'
      ? identity.dataNamespace.trim() : '';
    const publicDeviceId = typeof identity.publicDeviceId === 'string'
      ? identity.publicDeviceId.trim() : '';
    if (!publicDeviceId || publicDeviceId.length > 160
        || !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 0
        || !dataNamespace || dataNamespace.length > 220) return null;
    return {
      bound: identity.bound === true,
      ownershipEpoch,
      dataNamespace,
      publicDeviceId,
    };
  },

  sameOwnerContext(previous, next) {
    if (previous && next
        && (previous.kind === 'legacy' || next.kind === 'legacy')) {
      return previous.kind === 'legacy'
        && next.kind === 'legacy'
        && previous.legacyDeviceId === next.legacyDeviceId;
    }
    return !!(previous && next
      && previous.publicDeviceId === next.publicDeviceId
      && previous.bound === next.bound
      && previous.ownershipEpoch === next.ownershipEpoch
      && previous.dataNamespace === next.dataNamespace);
  },

  ownerContextKey(context) {
    if (context && context.kind === 'legacy') {
      // legacy JWT 会刷新；owner 只由稳定的旧 device id 标识。token 是否仍
      // 属于本次操作由 tokenStillOwnedByOperation 单独校验，不能把刷新误判为换绑。
      return ['legacy', context.legacyDeviceId].join('|');
    }
    return context
      ? [
        context.publicDeviceId,
        context.bound === true ? '1' : '0',
        String(context.ownershipEpoch),
        context.dataNamespace,
      ].join('|')
      : '';
  },

  isContinuousFirstClaim(previous, next) {
    return !!(previous && next
      && previous.bound !== true
      && next.bound === true
      && previous.publicDeviceId === next.publicDeviceId
      && next.ownershipEpoch === previous.ownershipEpoch + 1);
  },

  readStoredOwnerContext() {
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
      const context = this.ownerBindingFromIdentity({
        publicDeviceId: publicDeviceIdRaw,
        bound: binding && binding.bound === true,
        ownershipEpoch: binding && (
          binding.ownershipEpoch !== undefined
            ? binding.ownershipEpoch : binding.ownership_epoch
        ),
        dataNamespace: binding && (
          binding.dataNamespace !== undefined
            ? binding.dataNamespace : binding.data_namespace
        ),
      });
      if (context) return { status: 'ok', context };
      const legacyDeviceIdRaw = wx.getStorageSync(LEGACY_DEVICE_ID_STORAGE_KEY);
      const legacyTokenRaw = wx.getStorageSync(COACH_TOKEN_STORAGE_KEY);
      const deviceTokenRaw = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY);
      const legacyDeviceId = typeof legacyDeviceIdRaw === 'string'
        ? legacyDeviceIdRaw.trim() : '';
      const legacyToken = typeof legacyTokenRaw === 'string'
        ? legacyTokenRaw.trim() : '';
      // 只有已有稳定 legacy device id 的旧安装可走兼容 realm；新安装绝不
      // 生成本地 ID。device token 存在却缺完整 server marker 时必须 fail closed。
      if (legacyDeviceId && legacyDeviceId.length <= 160
          && legacyToken.length <= 4096 && !deviceTokenRaw) {
        return {
          status: 'ok',
          context: {
            kind: 'legacy',
            legacyDeviceId,
            legacyToken,
          },
        };
      }
      return { status: 'unknown', context: null };
    } catch (_e) {
      return { status: 'unknown', context: null };
    }
  },

  resetOwnerNetworkState(reason = 'owner-auth-advanced') {
    this.ownerAuthGeneration = (Number(this.ownerAuthGeneration) || 0) + 1;
    this.deviceIdentityAttempted = false;
    this.deviceIdentityUsesBootstrap = false;
    this.deviceIdentityCache = null;
    this.deviceIdentityPromise = null;
    this.deviceIdentityPromiseOwner = null;
    this.uploadTokenPromise = null;
    this.uploadTokenPromiseOwner = null;
    try { console.log('[SmartRun Owner] AUTH_RESET reason=' + reason); } catch (_e) {}
  },

  beginOwnerOperation(reason = 'owner-operation') {
    const stored = this.readStoredOwnerContext();
    if (stored.status === 'destructive') {
      this.handleOwnerDataCleared(reason + '-journal');
      return null;
    }
    if (stored.status !== 'ok') return null;
    return {
      owner: { ...stored.context },
      authGeneration: Number(this.ownerAuthGeneration) || 0,
      dataGeneration: Number(this.ownerDataGeneration) || 0,
      reason,
    };
  },

  async prepareOwnerOperation(config, reason, opts = {}) {
    let operation = this.beginOwnerOperation(reason);
    const identity = await this.refreshDeviceIdentity(config, {
      ...opts,
      operation: operation || undefined,
    });
    if (operation) {
      if (!this.ownerOperationIsCurrent(
        operation,
        reason + '-after-bootstrap',
      )) return { operation: null, identity };
    } else {
      operation = this.beginOwnerOperation(reason);
    }
    if (!this.ownerOperationIsCurrent(
      operation,
      reason + '-prepared',
    )) return { operation: null, identity };
    return { operation, identity };
  },

  ownerOperationIsCurrent(operation, reason = 'owner-operation-check') {
    if (!operation || !operation.owner
        || operation.authGeneration !== (Number(this.ownerAuthGeneration) || 0)
        || operation.dataGeneration !== (Number(this.ownerDataGeneration) || 0)) {
      return false;
    }
    const stored = this.readStoredOwnerContext();
    if (stored.status === 'unknown') return false;
    if (stored.status === 'ok'
        && this.sameOwnerContext(operation.owner, stored.context)) return true;

    // 正常首次 claim 保留匿名历史，但旧 epoch token 的所有异步操作都中止；
    // 其他完整 marker 变化则撤下旧 owner 的内存状态。两者都不改写新 owner storage。
    if (stored.status === 'ok'
        && this.isContinuousFirstClaim(operation.owner, stored.context)) {
      this.observedOwnerBinding = { ...stored.context };
      this.resetOwnerNetworkState(reason + '-claim');
    } else {
      this.handleOwnerDataCleared(reason + (
        stored.status === 'destructive' ? '-journal' : '-mismatch'
      ));
      if (stored.status === 'ok') this.observedOwnerBinding = { ...stored.context };
    }
    return false;
  },

  identityMatchesOwnerOperation(identity, operation) {
    return !!(operation
      && this.sameOwnerContext(
        this.ownerBindingFromIdentity(identity),
        operation.owner,
      ));
  },

  tokenStillOwnedByOperation(operation, token) {
    if (!token || !this.ownerOperationIsCurrent(operation, 'token-storage-check')) {
      return false;
    }
    try {
      const deviceToken = wx.getStorageSync(DEVICE_TOKEN_STORAGE_KEY) || '';
      const coachToken = wx.getStorageSync(COACH_TOKEN_STORAGE_KEY) || '';
      return token === deviceToken || token === coachToken;
    } catch (_e) {
      return false;
    }
  },

  reconcileObservedOwnerBinding(identity, opts = {}) {
    const next = this.ownerBindingFromIdentity(identity);
    const previous = this.observedOwnerBinding;
    if (!next) {
      // 已观测过完整 marker 后突然丢失 marker，无法证明还是同一所有者；
      // 撤下内存数据并等下次 bootstrap 恢复，不在 UI 层推测数据库身份。
      if (previous && opts.alreadyCleared !== true) this.handleOwnerDataCleared();
      this.observedOwnerBinding = null;
      return;
    }
    if (previous && !this.sameOwnerContext(previous, next)) {
      if (opts.alreadyCleared !== true
          && shouldClearOwnerScopedState(previous, next)) {
        this.handleOwnerDataCleared('identity-marker-change');
      } else {
        // first claim 的队列可连续保留；网络凭据不可连续复用。
        this.resetOwnerNetworkState('identity-marker-advanced');
      }
    }
    this.observedOwnerBinding = next;
  },

  reconcileStoredOwnerBinding() {
    // 上一次轮换若在关键身份提交前中断，journal 清理也必须能够
    // 立即失效首页内存中正在显示/生成的旧 owner 数据。
    if (!this.ownerDataIsAvailable()) return false;
    const local = ensureLocalDeviceIdentity(wx, {
      cryptoObject: typeof crypto === 'undefined' ? null : crypto,
    });
    this.reconcileObservedOwnerBinding(local);
    return true;
  },

  ownerContextIsCurrent(generation) {
    return this.ownerDataIsAvailable()
      && (Number(this.ownerDataGeneration) || 0) === generation;
  },

  async syncRunFinishedHint(config) {
    const prepared = await this.prepareOwnerOperation(
      config,
      'run-finished-hint',
    );
    const operation = prepared.operation;
    if (!this.ownerOperationIsCurrent(operation, 'run-finished-before-read')) return;
    if (consumeRunFinishedHint(wx)) {
      this.armExitPrompt();
    } else if (this.exitArmedAtMs == null
        || Date.now() - this.exitArmedAtMs > EXIT_CONFIRM_WINDOW_MS) {
      this.disarmExitPrompt();
    }
  },

  async flushRunUploads() {
    if (this.flushingUploads) return;   // onLoad+onShow 双触发/快速切页:防并发重复上传
    this.flushingUploads = true;
    try {
      const config = resolveCoachBackendConfig(wx);
      const prepared = await this.prepareOwnerOperation(config, 'run-upload');
      const operation = prepared.operation;
      if (!this.ownerOperationIsCurrent(operation, 'run-upload-before-read')) return;
      const initialQueueState = readPendingRunUploadsState(wx);
      if (!initialQueueState.ok || !initialQueueState.items.length) return;
      const token = await this.ensureUploadToken(config, operation);
      if (!token) return;   // 无 key / 登录失败:队列保留,下次进首页再试
      if (!this.ownerOperationIsCurrent(operation, 'run-upload-after-token')) return;
      const pendingState = readPendingRunUploadsState(wx);
      if (!pendingState.ok) return;
      const pending = pendingState.items;
      if (!pending.length) return;
      let activeToken = token;
      let deviceTokenMode = this.identityMatchesOwnerOperation(
        this.deviceIdentityCache,
        operation,
      ) && this.deviceIdentityCache.deviceToken === activeToken;
      for (let i = 0; i < pending.length; i += 1) {
        const item = pending[i];
        let authRetried = false;
        while (true) {
          if (!this.ownerOperationIsCurrent(
            operation,
            'run-upload-before-send',
          ) || !this.tokenStillOwnedByOperation(
            operation,
            activeToken,
          )) return;
          const resp = await this.wxRequest(buildRunUploadRequest({
            baseUrl: config.baseUrl,
            token: activeToken,
            payload: item,
            deviceToken: deviceTokenMode,
          }));
          if (!this.ownerOperationIsCurrent(
            operation,
            'run-upload-after-send',
          )) return;
          if (resp && resp.statusCode === 401) {
            if (authRetried) return;
            if (!deviceTokenMode) {
              // 旧 /runs 没有长期设备凭据可原位换 token。先清理失效 JWT，
              // 保留 FIFO，等下一次生命周期重新 anon-login 后再传。
              this.invalidateDeviceIdentityAuth(operation, activeToken);
              return;
            }
            // token/epoch 轮换：保留队列，凭长期 device_credential bootstrap 后仅重试本条一次。
            if (!this.invalidateDeviceIdentityAuth(operation, activeToken)) return;
            activeToken = await this.ensureUploadToken(config, operation);
            if (!activeToken) return;
            if (!this.ownerOperationIsCurrent(
              operation,
              'run-upload-after-auth-refresh',
            ) || !this.tokenStillOwnedByOperation(
              operation,
              activeToken,
            )) return;
            deviceTokenMode = this.identityMatchesOwnerOperation(
              this.deviceIdentityCache,
              operation,
            ) && this.deviceIdentityCache.deviceToken === activeToken;
            const retryQueueState = readPendingRunUploadsState(wx);
            if (!retryQueueState.ok) return;
            const stillQueued = retryQueueState.items.some(
              (queued) => queued.client_run_id === item.client_run_id,
            );
            if (!stillQueued) break; // 所有权轮换已隔离旧队列，绝不能用新 token 重放快照。
            authRetried = true;
            continue;
          }
          if (!this.ownerOperationIsCurrent(
            operation,
            'run-upload-before-result',
          )) return;
          if (resp && isPermanentRunUploadRejection(resp.statusCode)) {
            // 400/409/422 原样重试不会恢复。必须先把白名单证据写入隔离区并
            // 读回确认，再从主 FIFO 移除；隔离失败就保留毒丸，绝不丢证据。
            try {
              console.warn('[SmartRun Upload] quarantine invalid run status=' + resp.statusCode
                + ' client_run_id=' + item.client_run_id);
            } catch (_e) {}
            if (!this.ownerOperationIsCurrent(
              operation,
              'run-upload-before-quarantine',
            )) return;
            if (!quarantineRunUpload(wx, item, resp.statusCode)) return;
            if (removePendingRunUpload(wx, item) === null) return;
            break;
          }
          // 429/5xx/网络失败均保留并停止 FIFO，等待之后重试。
          if (!parseRunUploadResponse(resp)) return;
          // 从最新 storage 移除已确认项，绝不拿请求前的旧快照覆盖新入队跑步。
          if (!this.ownerOperationIsCurrent(
            operation,
            'run-upload-before-ack',
          )) return;
          removePendingRunUpload(wx, item);
          break;
        }
      }
    } finally {
      this.flushingUploads = false;
    }
  },

  // APK/Garmin 与 AIUI 是两条独立实验流。首页只负责把 HUD 已持久化的 AIUI
  // 派生指标补传到设备专用入口；服务端再按当前绑定 owner/epoch 与墙钟时间配对。
  async flushAiuiCalibrationUploads() {
    if (this.flushingAiuiCalibration) return;
    this.flushingAiuiCalibration = true;
    try {
      const config = resolveCoachBackendConfig(wx);
      const prepared = await this.prepareOwnerOperation(
        config,
        'calibration-upload',
      );
      let identity = prepared.identity;
      const operation = prepared.operation;
      if (!this.ownerOperationIsCurrent(
        operation,
        'calibration-upload-before-read',
      )) return;
      const initialQueueState = readPendingAiuiCalibrationEventsState(wx);
      if (!initialQueueState.ok || !initialQueueState.events.length) return;
      let token = identity && identity.deviceToken;
      if (!token || !this.identityMatchesOwnerOperation(identity, operation)) return;
      let authRetried = false;
      let batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
      let completedBatches = 0;
      // 正常最多上传 20 批；遇到 400/409/422 时用前缀二分隔离单条毒丸，
      // 所以给定位过程额外网络尝试预算，但绝不整批丢弃有效实验数据。
      for (let attempt = 0;
        attempt < 40 && completedBatches < 20;
        attempt += 1) {
        if (!this.ownerOperationIsCurrent(
          operation,
          'calibration-upload-before-batch-read',
        )) return;
        const pendingState = readPendingAiuiCalibrationEventsState(wx);
        if (!pendingState.ok || !pendingState.events.length) return;
        const batch = pendingState.events.slice(0, batchLimit);
        if (!this.ownerOperationIsCurrent(
          operation,
          'calibration-upload-before-send',
        ) || !this.tokenStillOwnedByOperation(operation, token)) return;
        const response = await this.wxRequest(buildAiuiCalibrationRequest({
          baseUrl: config.baseUrl,
          token,
          events: batch,
        }));
        if (!this.ownerOperationIsCurrent(
          operation,
          'calibration-upload-after-send',
        )) return;
        if (response && response.statusCode === 401) {
          if (authRetried) return;
          // token_version/ownership_epoch 变化后只凭长期设备凭据重新 bootstrap。
          // bootstrap 若执行 owner 隔离，下面会重读队列，绝不把旧快照换 token 重放。
          if (!this.invalidateDeviceIdentityAuth(operation, token)) return;
          identity = await this.refreshDeviceIdentity(config, {
            force: true,
            operation,
          });
          token = identity && identity.deviceToken;
          if (!token
              || !this.identityMatchesOwnerOperation(identity, operation)
              || !this.ownerOperationIsCurrent(
                operation,
                'calibration-upload-after-auth-refresh',
              )
              || !this.tokenStillOwnedByOperation(operation, token)) return;
          const latestIds = {};
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
        if (!this.ownerOperationIsCurrent(
          operation,
          'calibration-upload-before-result',
        )) return;
        if (response
            && isPermanentAiuiCalibrationRejection(response.statusCode)) {
          if (batch.length > 1) {
            batchLimit = Math.max(1, Math.floor(batch.length / 2));
            continue;
          }
          // 本地已严格白名单化；若旧版本毒丸仍被后端 400/409/422 拒绝，
          // 二分到单条后先写后读隔离证据，再移出主 FIFO。429/5xx/网络
          // 失败仍完整保留。
          console.warn(
            '[SmartRun Calibration] quarantine invalid event status='
              + response.statusCode + ' event=' + batch[0].event_id,
          );
          if (!this.ownerOperationIsCurrent(
            operation,
            'calibration-upload-before-quarantine',
          )) return;
          if (!quarantineAiuiCalibrationEvent(
            wx,
            batch[0],
            response.statusCode,
          )) return;
          if (removePendingAiuiCalibrationEvents(
            wx,
            [batch[0].event_id],
          ) === null) return;
          batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
          continue;
        }
        const parsed = parseAiuiCalibrationResponse(response, batch);
        if (!parsed) return;
        if (!this.ownerOperationIsCurrent(
          operation,
          'calibration-upload-before-ack',
        )) return;
        if (removePendingAiuiCalibrationEvents(wx, parsed.ackedEventIds) === null) return;
        completedBatches += 1;
        batchLimit = AIUI_CALIBRATION_BATCH_SIZE;
        console.log(
          '[SmartRun Calibration] uploaded=' + parsed.ackedEventIds.length
            + ' matched=' + parsed.matched,
        );
      }
    } finally {
      this.flushingAiuiCalibration = false;
    }
  },

  // 新版 AIUI 的 wx storage 已支持跨页面/重启持久化：AI 总结先入本地 FIFO，
  // 再 best-effort 写后端。断网、token 过期或尚未 provision app key 都不会丢记录。
  async flushAiuiRecords() {
    if (this.flushingAiuiRecords) return;
    this.flushingAiuiRecords = true;
    try {
      const config = resolveCoachBackendConfig(wx);
      const prepared = await this.prepareOwnerOperation(
        config,
        'aiui-record-upload',
      );
      const operation = prepared.operation;
      if (!this.ownerOperationIsCurrent(
        operation,
        'aiui-record-before-settings',
      )) return;
      const settings = readRunSettings(wx);
      if (settings.memoryContext === false) {
        if (!this.ownerOperationIsCurrent(
          operation,
          'aiui-record-before-disabled-clear',
        )) return;
        clearPendingAiuiRecords(wx);
        clearLocalRunMemories(wx);
        return;
      }
      if (!readPendingAiuiRecords(wx).length) return;
      const token = await this.ensureUploadToken(config, operation);
      if (!token) return;
      if (!this.ownerOperationIsCurrent(
        operation,
        'aiui-record-after-token',
      )) return;
      // 与跑步队列相同：bootstrap 可能刚刚检测到所有者轮换并完成隔离。
      const pending = readPendingAiuiRecords(wx);
      if (!pending.length) return;
      for (let i = 0; i < pending.length; i += 1) {
        const item = pending[i];
        if (!this.ownerOperationIsCurrent(
          operation,
          'aiui-record-before-send',
        ) || !this.tokenStillOwnedByOperation(operation, token)) return;
        const resp = await this.wxRequest(buildAiuiRecordRequest({
          baseUrl: config.baseUrl,
          token,
          question: item.question,
          reply: item.reply,
          source: item.source,
          recordId: item.id,
        }));
        if (!this.ownerOperationIsCurrent(
          operation,
          'aiui-record-after-send',
        )) return;
        if (resp && resp.statusCode === 401) {
          this.invalidateDeviceIdentityAuth(operation, token);
          return;
        }
        if (!parseAiuiRecordResponse(resp)) return;
        // 与跑步上传相同：网络往返期间可能生成新记录，只删当前已确认项。
        if (!this.ownerOperationIsCurrent(
          operation,
          'aiui-record-before-ack',
        )) return;
        removePendingAiuiRecord(wx, item);
      }
    } finally {
      this.flushingAiuiRecords = false;
    }
  },

  // ── 跑后 AI 总结归档:Tier1 内置 LanguageModel(可注入后端记忆) → Tier2 规则兜底;
  // 04 总结页是唯一可见跑后界面；这里仅后台落本地记忆与 aiui-record，不改首页 UI。
  async archiveRunSummary() {
    if (this.summaryRunning) return;
    this.summaryRunning = true;
    let consumedPending = false;
    try {
      // 无论本地缓存显示 bound/unbound，都先等待 onLoad/onShow 已启动的同一 bootstrap。
      // 离线返回有界；联网时先应用 ownership marker，再允许读取任何 owner-scoped 待办。
      const prepared = await this.prepareOwnerOperation(
        resolveCoachBackendConfig(wx),
        'summary-archive',
      );
      const operation = prepared.operation;
      if (!this.ownerOperationIsCurrent(
        operation,
        'summary-before-read',
      )) return;
      const pending = readPendingRunSummary(wx);
      if (!pending) return;
      // 陈年待办(跑中被杀、隔天才重开)不再归档为本次完成记录，直接丢弃。
      if (pending.endedAtMs > 0 && Date.now() - pending.endedAtMs > RUN_SUMMARY_MAX_AGE_MS) {
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-expired-clear',
        )) return;
        consumedPending = clearPendingRunSummary(wx);
        return;
      }
      // 04 总结页已有文本时不重复调用模型，但仍重新经过安全门；否则后台生成或兜底。
      const preText = pending.text || '';
      const quickText = fallbackRunSummary(pending);
      if (!quickText) return;
      if (!this.ownerOperationIsCurrent(
        operation,
        'summary-before-settings',
      )) return;
      const settings = readRunSettings(wx);
      const memoryEnabled = settings.memoryContext !== false;
      const aiSummaryEnabled = settings.aiSummary !== false;
      const config = resolveCoachBackendConfig(wx, { memoryEnabled });
      let text = '';
      if (!preText && aiSummaryEnabled) {
        // 本地最近跑步始终先作为上下文；配置的后端可用时再合并远端记忆。
        // 因此干净安装没有 app key 也具备真正可用的跨会话记忆。
        let memoryContext = memoryEnabled
          ? buildLocalRunMemoryContext(wx, { language: LOCAL_MEMORY_LANGUAGE }) : '';
        const token = memoryEnabled
          ? await this.ensureUploadToken(config, operation) : '';
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-after-token',
        )) return;
        if (token) {
          if (!this.ownerOperationIsCurrent(
            operation,
            'summary-before-memory-request',
          ) || !this.tokenStillOwnedByOperation(operation, token)) return;
          const memResp = await this.wxRequest(buildMemoryContextRequest({
            baseUrl: config.baseUrl, token, query: RUN_SUMMARY_QUESTION,
          }));
          if (!this.ownerOperationIsCurrent(
            operation,
            'summary-after-memory-request',
          )) return;
          if (memResp && memResp.statusCode === 401) {
            // 云端记忆鉴权失败不应中断本地总结事务。清理失效凭据后继续使用
            // 本地最近记录与规则/端侧模型，待传队列留给下个生命周期重试。
            this.invalidateDeviceIdentityAuth(operation, token);
          }
          const mem = memResp && memResp.statusCode !== 401
            ? parseMemoryContext(memResp) : null;
          if (mem) {
            memoryContext = [memoryContext, mem.profile, ...(mem.memories || []).slice(0, 2)]
              .filter(Boolean).join('；');
          }
        }
        // 整个 Tier1(availability/create/prompt 三次桥往返)统一限时:任何一步悬死
        // 都不许锁死 summaryRunning,首页也永远等得到最终文本。
        let deadlineTimer = null;
        try {
          text = await Promise.race([
            this.askLlmSummary(pending, memoryContext),
            new Promise((resolve) => {
              deadlineTimer = setTimeout(() => resolve(''), LLM_SUMMARY_TIMEOUT_MS + 2000);
            }),
          ]);
        } catch (_e) { text = ''; }
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-after-llm',
        )) return;
      }
      const safeText = finalizeRunSummaryText(pending, preText || text);
      text = safeText.text || quickText;
      if (!this.ownerOperationIsCurrent(
        operation,
        'summary-before-archive',
      )) return;
      if (memoryEnabled) {
        // 本地记忆立即可用；云端记录先存后传，退出、断网或桥超时都不丢。
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-local-memory',
        )) return;
        const localMemories = enqueueLocalRunMemory(
          wx, { ...pending, text, endedAtMs: pending.endedAtMs || Date.now() },
        );
        if (!localMemories) return;
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-record-enqueue',
        )) return;
        const queuedRecords = enqueueAiuiRecord(wx, {
          question: RUN_SUMMARY_QUESTION,
          reply: text,
          source: 'run-summary',
          createdAtMs: pending.endedAtMs || Date.now(),
        });
        if (!queuedRecords) return;
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-upload-recovery',
        )) return;
        // HUD 可能已把 summary 落盘，但随后 run-upload storage 桥静默 no-op。
        // 首页在消费唯一 summary 前重建同一 client_run_id；enqueue 按 ID 去重，
        // 因此 HUD 已成功入队和这里的恢复入队不会制造两条跑步。
        const recoveryEndMs = Number(pending.endedAtMs) || 0;
        const recoveryElapsedMs = Number(pending.elapsedMs) || 0;
        const persistedStartMs = Number(pending.startedAtMs) || 0;
        const recoveryStartMs = persistedStartMs > 0
          ? persistedStartMs
          : (recoveryEndMs > recoveryElapsedMs ? recoveryEndMs - recoveryElapsedMs : 0);
        const recoveryPayload = recoveryStartMs > 0
          ? buildRunUploadPayload({
            startMs: recoveryStartMs,
            endMs: recoveryEndMs,
            mode: pending.mode,
            elapsedMs: recoveryElapsedMs,
            distanceM: pending.distanceM,
            avgPaceSecPerKm: pending.avgPaceSecPerKm,
            avgBpm: pending.avgBpm,
            maxBpm: pending.maxBpm,
            avgCadenceSpm: pending.avgCadenceSpm,
          }) : null;
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-upload-enqueue',
        )) return;
        if (recoveryPayload && !enqueueRunUpload(wx, recoveryPayload)) return;
        if (!this.ownerOperationIsCurrent(
          operation,
          'summary-before-clear',
        )) return;
        // 唯一 summary 是归档事务的重放依据；本地记忆与云端待传队列都确认
        // 写后读回后才能删除。任一 storage throw/no-op 都保留它供下次幂等重试。
        if (!clearPendingRunSummary(wx)) return;
        consumedPending = true;
        this.flushAiuiRecords();
        this.flushRunUploads();
      }
    } finally {
      this.summaryRunning = false;
    }
    // 归档期间又落了新待办(连跑两场的极端):立刻再跑一轮,不吞不滞留。
    // archiveRunSummary 开头即消费待办,递归必然收敛。
    if (consumedPending && this.ownerDataIsAvailable() && readPendingRunSummary(wx)) {
      this.archiveRunSummary();
    }
  },

  async askLlmSummary(summary, memoryContext) {
    if (typeof LanguageModel === 'undefined') return '';
    const availability = await LanguageModel.availability();
    if (availability !== 'available') return '';
    const session = await LanguageModel.create({
      initialPrompts: [{
        role: 'system',
        content: '你是眼镜端跑步教练。只描述给出的事实，可提示恢复或稳定节奏；'
          + '不作医疗诊断，不承诺或建议提速，不猜测个人心率区间。'
          + '中文回答，不超过40个字，不用列表或表情。',
      }],
    });
    let timer = null;
    try {
      const reply = await Promise.race([
        session.prompt(buildRunSummaryPrompt(summary, memoryContext)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(''), LLM_SUMMARY_TIMEOUT_MS); }),
      ]);
      return String(reply || '').trim();
    } finally {
      if (timer) clearTimeout(timer);
      // 超时后底层流式请求不会自己停:destroy() 是文档给的唯一关闭活动任务手段。
      try { if (session && typeof session.destroy === 'function') session.destroy(); } catch (_e) {}
    }
  },

  openMode() {
    if (this.runNavigationPending) return;
    this.runNavigationPending = true;
    // navigateTo 是全应用唯一没加等待上限的桥调用,且文档没有 fail 通道:
    // 悬空一次就永久锁死"确认键进入"。3s 自解锁(足够吞掉同一次按压的重复键码)。
    if (this.navPendingTimer) clearTimeout(this.navPendingTimer);
    this.navPendingTimer = setTimeout(() => {
      this.navPendingTimer = null;
      this.runNavigationPending = false;
    }, 3000);
    beginInternalSurfaceNavigation(wx, 'run_hud');
    // 只有宿主显式打开兼容卡时它才位于导航栈下方；默认沉浸首屏不经过此页。
    try {
      wx.navigateTo({
        // 首页的原生确认在部分真机上会同时派发 GlobalHook 与 Enter。
        // 将一次性入场保护交给目标页，避免尾随键码直接确认默认的“自由跑”。
        url: HOME_MENU_ROUTE,
        fail: () => { this.runNavigationPending = false; },
      });
    } catch (_e) {
      this.runNavigationPending = false;
    }
  },

  openMenu() {
    this.openMode();
  },

  clearExitPromptTimer() {
    if (this.exitPromptTimer) clearTimeout(this.exitPromptTimer);
    this.exitPromptTimer = null;
  },

  disarmExitPrompt() {
    this.clearExitPromptTimer();
    this.exitArmedAtMs = null;
    if (this.data.enterText !== '按确认键进入') {
      this.setData({ enterText: '按确认键进入' });
    }
  },

  armExitPrompt(now = Date.now()) {
    this.exitArmedAtMs = now;
    this.setData({ enterText: '再按返回键退出' });
    this.clearExitPromptTimer();
    this.exitPromptTimer = setTimeout(() => {
      this.exitPromptTimer = null;
      this.disarmExitPrompt();
    }, EXIT_CONFIRM_WINDOW_MS);
  },

  onKeyUp(event) {
    const code = event && event.code;
    if (code === 'Backspace') {
      // 双按退出:首页在栈底,宿主对返回无默认动作(观察到"退不出去")。
      // 第一按只亮 3s 提示,窗口内第二按才调用 wx.exitMiniProgram 真正退出;
      // 依旧只观察按键、不拦截宿主默认行为、不发起任何路由。
      const now = Date.now();
      if (this.exitArmedAtMs != null && now - this.exitArmedAtMs <= EXIT_CONFIRM_WINDOW_MS) {
        this.disarmExitPrompt();
        // v0.15 真机桥把 options 标成可选，但底层绑定仍要求一个参数对象。
        try { wx.exitMiniProgram({}); } catch (_e) {}
        return;
      }
      this.armExitPrompt(now);
      return;
    }
    // 首页只有一个真实 button。Enter / NumpadEnter / Space 必须遵循 AIUI
    // Native Single-Action 规则，交给宿主激活 bindtap，不能在 onKeyUp 再手动
    // navigateTo。GlobalHook 没有稳定的原生 button 默认动作，单独保留兼容路径。
    if (code === 'GlobalHook') {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (this.lastHomeConfirmAtMs != null
          && now - this.lastHomeConfirmAtMs < HOME_CONFIRM_DEDUPE_MS) return;
      this.lastHomeConfirmAtMs = now;
      this.openMenu();
    }
  },

  // 官方 target 生命周期只同步承载状态；布局由 @media(target) 完成。
  // 不在这里自动 navigate，避免 _current → _blank 时重复入栈或吞掉首个按键。
  onTargetChanged(target, previousTarget) {
    const hostTarget = target === '_blank' ? '_blank' : '_current';
    this.lastHomeConfirmAtMs = null;
    this.disarmExitPrompt();
    this.setData({ hostTarget });
    try {
      console.log('[SmartRun Home] TARGET_CHANGED '
        + String(previousTarget || 'unknown') + ' -> ' + hostTarget);
    } catch (_e) {}
  },

  // 对话流卡不直接开跑；语音唤醒同样只打开沉浸菜单。
  onVoiceWakeup() {
    this.openMenu();
  },
};
</script>

<page>
  <view class="home-wrap">
    <view class="home-card" role="navigation">
      <view class="home-content">
        <view class="home-brand">
          <view class="home-version-spacer"></view>
          <image class="runner-logo" src="../../assets/smartrun-runner-48.png" mode="aspectFit" />
          <text class="home-brand-name">跑步教练</text>
          <text class="home-version">{{ homeVersion }}</text>
        </view>
        <text class="home-slogan">{{ homeSlogan }}</text>
        <button
          class="home-enter home-action-focused"
          role="button"
          tabindex="0"
          bindtap="openMenu"
        >
          <text class="home-enter-text">{{ enterText }}</text>
        </button>
      </view>
    </view>
  </view>
</page>

<style>
.home-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  box-sizing: border-box;
  width: 448px;
  height: 150px;
  margin: 0 auto;
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
}

.home-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 448px;
  height: 150px;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: var(--color-surface, #000000);
  border-radius: var(--radius-md, 12px);
}

.home-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 444px;
  height: 146px;
  padding: 4px 12px;
}

.home-brand,
.home-enter {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.home-brand {
  width: 420px;
  height: 34px;
}

.runner-logo {
  width: 32px;
  height: 32px;
  margin: 0 2px 0 0;
}

.home-brand-name {
  color: var(--color-primary, #40ff5e);
  font-size: 30px;
  line-height: 34px;
  font-weight: bold;
  font-family: monospace;
  text-align: center;
}

.home-version-spacer {
  box-sizing: border-box;
  width: 64px;
  height: 18px;
}

.home-version {
  box-sizing: border-box;
  width: 64px;
  height: 18px;
  padding: 0 0 0 6px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 12px;
  line-height: 18px;
  font-weight: bold;
  font-family: monospace;
  text-align: left;
}

.home-slogan {
  width: 420px;
  height: 24px;
  margin: 1px 0 3px;
  color: var(--color-primary-60, rgba(64, 255, 94, 0.6));
  font-size: 18px;
  line-height: 24px;
  font-weight: bold;
  text-align: center;
}

.home-enter {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 420px;
  height: 34px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 12px);
  background-color: var(--color-primary-08, rgba(64, 255, 94, 0.08));
}

.home-enter-text {
  color: var(--color-primary, #40ff5e);
  font-size: 18px;
  line-height: 24px;
  font-weight: bold;
}

.home-enter.home-action-focused {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--color-primary, #40ff5e);
  outline-offset: -2px;
}

/* 对话流：宿主内联卡只显示紧凑摘要。 */
@media (target: _current) {
  .home-wrap {
    width: 448px;
    height: 150px;
    justify-content: flex-end;
    padding: 0;
  }

  .home-card {
    width: 448px;
    height: 150px;
  }
}

/* 沉浸式：同一首页填满 480x352 宿主，内容保留 448px 安全宽度。 */
@media (target: _blank) {
  .home-wrap {
    width: 480px;
    height: 352px;
    justify-content: center;
    padding: 0 16px;
  }

  .home-card {
    width: 448px;
    height: 352px;
  }

  .home-content {
    width: 444px;
    height: 348px;
    padding: 32px 12px;
  }

  .home-brand {
    width: 420px;
    height: 52px;
  }

  .runner-logo {
    width: 44px;
    height: 44px;
    margin: 0 4px 0 0;
  }

  .home-brand-name {
    font-size: 40px;
    line-height: 48px;
  }

  .home-slogan {
    width: 420px;
    height: 32px;
    margin: 20px 0 32px;
    font-size: 24px;
    line-height: 32px;
  }

  .home-enter {
    width: 420px;
    height: 48px;
  }

  .home-enter-text {
    font-size: 24px;
    line-height: 32px;
  }
}

</style>
