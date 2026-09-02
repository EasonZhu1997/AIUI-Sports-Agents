import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const home = fs.readFileSync(new URL('../pages/index/index.ink', import.meta.url), 'utf8');
const hud = fs.readFileSync(new URL('../pages/rower_hud/index.ink', import.meta.url), 'utf8');
const app = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8'));

function methodSource(name) {
  const match = new RegExp(`\\n  (?:async )?${name}\\([^\\n]*\\) \\{`).exec(hud);
  assert.ok(match, `missing page method: ${name}`);
  const end = hud.indexOf('\n  },', match.index);
  assert.notEqual(end, -1, `unterminated page method: ${name}`);
  return hud.slice(match.index, end + 5);
}

function assertOrdered(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ${fragment}`);
    assert.ok(next > cursor, `${label}: ${fragment} is out of order`);
    cursor = next;
  }
}

function pageMethod(name) {
  const source = methodSource(name).trim().replace(/,$/, '');
  return Function(`"use strict"; return ({${source}}).${name};`)();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function delayedScanSession(gate) {
  let cleanupPending = true;
  let scanAlive = false;
  let scanCalls = 0;
  let stopCalls = 0;
  const cleanup = gate.promise.finally(() => { cleanupPending = false; });
  return {
    async beginScan() {
      await cleanup;
      scanCalls += 1;
      scanAlive = true;
    },
    async suspend() {
      if (cleanupPending) return cleanup;
      if (scanAlive) {
        scanAlive = false;
        stopCalls += 1;
      }
      return true;
    },
    snapshot() { return { scanAlive, scanCalls, stopCalls }; },
  };
}

test('declares only the v0.0.1 callable home and immersive rower routes', () => {
  assert.deepEqual(app.pages, ['pages/index/index', 'pages/rower_hud/index']);
  assert.deepEqual(app.permissions, []);
  assert.equal(app.window.navigationBarTitleText, '划船机教练');
  assert.match(home, /"description": "Opens a standalone rowing-machine coach[^\n]+"/);
  assert.match(home, /"schema": \{ "data": \{ "type": "object", "properties": \{\} \} \}/);
  assert.match(home, /"navigationBarTitleText": "划船机教练"/);
  assert.match(hud, /"navigationBarTitleText": "划船机教练"/);
  assert.match(home, /<text class="name">划船机教练<\/text>/);
  assert.match(hud, /<text class="title">划船机教练<\/text>/);
  assert.doesNotMatch(home + hud, /室内/);
  assert.match(home, /<text class="version">v0\.0\.1<\/text>/);
  assert.match(hud, /<text class="version">v0\.0\.1<\/text>/);
  assert.doesNotMatch(home + hud, /v0\.1\.0/);
  assert.match(home, /\.home-wrap\s*\{[^}]*width:\s*448px;[^}]*height:\s*150px;/s);
  assert.match(home, /\.home-card\s*\{[^}]*width:\s*448px;[^}]*height:\s*150px;/s);
  assert.match(hud, /\.stage\s*\{[^}]*width:\s*480px;[^}]*height:\s*352px;/s);
  assert.match(hud, /\.surface\s*\{[^}]*width:\s*448px;[^}]*height:\s*324px;/s);
});

test('uses the exact FTMS then optional HRS rowing-machine page flow', () => {
  assert.match(hud, /const MULTI_TARGET_PHASES = new Set\(\['menu', 'settings', 'ftms', 'hrs'\]\)/);
  for (const phase of ['menu', 'settings', 'ftms', 'hrs', 'warmup', 'hud', 'summary', 'recovery', 'recovery_done']) {
    assert.match(hud, new RegExp(`['"]${phase}['"]`));
  }
  assert.doesNotMatch(hud, /phase\s*===\s*['"]scan['"]|setSurface\(['"]scan['"]\)/);
  assert.match(methodSource('activateMenu'), /this\.enterFtmsSetup\(\)/);
  assert.match(methodSource('enterFtmsSetup'), /this\.setSurface\('ftms'/);
  assert.match(methodSource('enterHeartRateSetup'), /this\.setSurface\('hrs'/);
  assert.match(methodSource('startGuide'), /kind === 'warmup'[\s\S]*this\.setSurface\(kind === 'warmup' \? 'warmup' : 'recovery'/);
  assert.match(methodSource('startHud'), /this\.setSurface\('hud'/);
  assert.match(methodSource('finishSessionToSummary'), /this\.setSurface\('summary'/);
  assert.match(methodSource('startRecovery'), /this\.startGuide\('recovery'\)/);
  assert.match(methodSource('finishRecoveryGuide'), /this\.guideCompleted = true[\s\S]*this\.setSurface\('recovery_done'[\s\S]*exitText: '完成并退出'/);
});

test('FTMS remains required until one valid complete published rower record', () => {
  assert.match(hud, /class="sensor-mark"><text>F<\/text>/);
  assert.match(hud, /FTMS 划船机 · 必选/);
  assert.match(hud, /0x2ACC/);
  assert.match(hud, /0x2AD1 Notify/);

  const scan = methodSource('startFtmsScan');
  assert.match(scan, /this\.data\.phase !== 'ftms'/);
  assert.match(scan, /ftmsScanState === 'scanning'[\s\S]*ftmsScanState === 'connecting'/);
  assert.match(scan, /this\.ftmsSession\.beginScan/);
  assert.match(scan, /this\.addCandidate\('ftms', device\)/);

  const select = methodSource('selectFtms');
  assert.match(select, /this\.ftmsSession\.connect\([\s\S]*userAuthorized: true/);
  assert.match(select, /this\.ftmsSession\.selectedDevice !== record\.device/);
  assert.match(select, /const ready = this\.ftmsLastRecord[\s\S]*generation === this\.ftmsSession\.generation[\s\S]*streamState\(Date\.now\(\)\) === 'live'/);
  assert.match(select, /if \(ready\) this\.commitFtmsReady\(\);[\s\S]*ftmsScanState: 'subscribed_silent'/);
  assert.match(select, /等待完整有效数据|等待有效数据/);

  const record = methodSource('onFtmsRecord');
  assert.match(record, /record\.valid !== true \|\| record\.complete !== true[\s\S]*record\.published !== true/);
  assert.match(record, /this\.ftmsSession\.selectedDevice === this\.ftmsTarget[\s\S]*this\.commitFtmsReady\(\)/);

  const commit = methodSource('commitFtmsReady');
  assert.match(commit, /this\.ftmsSession\.selectedDevice !== this\.ftmsTarget/);
  assert.match(commit, /this\.ftmsValidatedForSession = true/);
  assert.match(commit, /ftmsScanState: 'live'/);
  assert.match(commit, /ftmsPrimaryLabel: '下一步：心率'/);
});

test('external HRS is independent, user-triggered and always skippable', () => {
  assert.match(hud, /class="sensor-mark"><text>H<\/text>/);
  assert.match(hud, /FTMS 已验证/);
  assert.match(hud, /data-action="hrs-skip"/);
  assert.match(hud, /跳过并开始热身/);

  const enter = methodSource('enterHeartRateSetup');
  assert.match(enter, /!this\.ftmsValidatedForSession \|\| !this\.ftmsTarget/);
  assert.match(enter, /this\.ftmsSession\.stopScan\(\)/);
  assert.match(enter, /标准 HRS 可选 · 不影响划船机数据/);

  const scan = methodSource('startHeartRateScan');
  assert.match(scan, /this\.data\.phase !== 'hrs'/);
  assert.match(scan, /hrsScanState === 'scanning'[\s\S]*hrsScanState === 'connecting'/);
  assert.match(scan, /reconnect\.ftms\.timer \|\| this\.reconnect\.ftms\.promise/);
  assert.match(scan, /this\.heartRateSession\.beginScan/);
  assert.match(scan, /this\.addCandidate\('hrs', device\)/);
  assert.match(scan, /可直接跳过/);

  const select = methodSource('selectHeartRate');
  assert.match(select, /samePeripheral\(record\.device, this\.ftmsTarget\)/);
  assert.match(select, /同一设备请使用 FTMS 机载心率/);
  assert.match(select, /this\.heartRateSession\.connect\([\s\S]*userAuthorized: true/);
  assert.match(select, /this\.heartRateSession\.selectedDevice !== record\.device/);
  assert.match(select, /reconnect\.ftms\.timer \|\| this\.reconnect\.ftms\.promise/);
  assert.match(select, /划船机未受影响 · 可直接跳过/);

  const actions = methodSource('onActionTap');
  assert.match(actions, /action === 'hrs-skip'\) return this\.startGuide\('warmup'\)/);
  const guide = methodSource('startGuide');
  assert.match(guide, /!this\.ftmsValidatedForSession \|\| !this\.ftmsTarget/);
  assert.match(guide, /kind === 'warmup' && !this\.hrsTarget[\s\S]*hrsConnectAttempt \+= 1[\s\S]*cleanup\('optional_hrs_skipped'\)/);
  assert.doesNotMatch(guide, /!this\.hrs(?:Target|Live|Subscribed)\) return false/);
});

test('a scan delayed behind cleanup cannot start after the page becomes hidden', async () => {
  for (const profile of [
    {
      method: 'startFtmsScan', phase: 'ftms', attempt: 'ftmsScanAttempt',
      target: 'ftmsTarget', state: 'ftmsScanState', session: 'ftmsSession',
    },
    {
      method: 'startHeartRateScan', phase: 'hrs', attempt: 'hrsScanAttempt',
      target: 'hrsTarget', state: 'hrsScanState', session: 'heartRateSession',
    },
  ]) {
    const gate = deferred();
    const session = delayedScanSession(gate);
    const context = {
      data: { phase: profile.phase, [profile.state]: 'idle' },
      pageVisible: true,
      [profile.attempt]: 0,
      [profile.target]: null,
      [profile.session]: session,
      ftmsCandidateRefs: [],
      hrsCandidateRefs: [],
      reconnect: { ftms: { timer: null, promise: null } },
      setData(patch) { Object.assign(this.data, patch); },
      addCandidate() { throw new Error('stale scan must not publish candidates'); },
    };

    const pending = pageMethod(profile.method).call(context);
    await Promise.resolve();
    context.pageVisible = false;
    context[profile.attempt] += 1;
    void session.suspend('hidden');
    gate.resolve();

    assert.equal(await pending, false, `${profile.phase} scan should be stale`);
    assert.deepEqual(
      session.snapshot(),
      { scanAlive: false, scanCalls: 1, stopCalls: 1 },
      `${profile.phase} hidden scan must be stopped after cleanup settles`,
    );
  }
});

test('HUD keeps FTMS freshness separate from optional HRS heart rate', () => {
  assert.match(hud, /<view class="metric-grid">/);
  for (const label of ['500m 配速', '活动计时', '桨频 spm', '距离 m', '功率 W']) {
    assert.match(hud, new RegExp(label));
  }
  assert.match(hud, /<text class="metric-label">\{\{heartSourceText\}\}<\/text>/);
  assert.match(hud, /ink:if="\{\{hudEnding\}\}"[\s\S]*ink:else/);

  const start = methodSource('startHud');
  assert.match(start, /this\.data\.phase !== 'warmup' \|\| this\.sessionStartClaimed/);
  assert.match(start, /!this\.ftmsValidatedForSession \|\| !this\.ftmsTarget/);
  for (const field of ['splitText', 'strokeText', 'distanceText', 'powerText', 'heartText']) {
    assert.match(start, new RegExp(`${field}: '--`));
  }
  assert.match(start, /ftmsChipText: this\.ftmsReadyNow\(now\) \? 'FTMS LIVE' : 'FTMS 等待'/);
  assert.match(start, /hrsChipText: this\.hrsTarget \? 'HRS 等待' : 'HRS 未连接'/);

  const refresh = methodSource('refreshHud');
  assert.match(refresh, /const ftmsFresh = ftmsState === 'live' && metrics\.fresh === true/);
  assert.match(refresh, /splitText: ftmsFresh \?[^\n]+: '--:--'/);
  assert.match(refresh, /strokeText: ftmsFresh \?[^\n]+: '--'/);
  assert.match(refresh, /powerText: ftmsFresh \?[^\n]+: '--'/);
  assert.match(refresh, /const currentHeart = heart\.heartRateBpm == null \? '--'/);
  assert.match(refresh, /currentSource === INDEPENDENT_HRS_SOURCE[\s\S]*'外置 HRS'[\s\S]*FTMS_HEART_RATE_SOURCE[\s\S]*'FTMS 心率'/);
  assert.match(refresh, /HRS 接触不良|HRS 过期/);
});

test('hide pauses active-time and both BLE links; show resumes the same targets', () => {
  const hide = methodSource('onHide');
  assert.match(hide, /guideRemainingMs[\s\S]*stopGuideTicker\(\)/);
  assert.match(hide, /this\.clock\.state === 'active'\) this\.clock\.pause\(now\)/);
  assert.match(hide, /this\.metrics\.markDiscontinuity\('hidden'\)/);
  assert.match(hide, /cancelReconnect\('ftms', \{ clearTarget: false \}\)/);
  assert.match(hide, /cancelReconnect\('hrs', \{ clearTarget: false \}\)/);
  assert.match(hide, /this\.ftmsSession\.suspend\('hidden'\)/);
  assert.match(hide, /this\.heartRateSession\.suspend\('hidden'\)/);
  assert.match(hide, /this\.ftmsScanAttempt \+= 1[\s\S]*this\.hrsConnectAttempt \+= 1/);
  assert.match(hide, /phase === 'ftms' && !this\.ftmsTarget[\s\S]*ftmsScanState: 'idle'/);
  assert.match(hide, /phase === 'hrs' && !this\.hrsTarget[\s\S]*hrsScanState: 'idle'/);
  assert.doesNotMatch(hide, /finishSessionToSummary|finishSession\(/);

  const show = methodSource('onShow');
  assert.match(show, /this\.clock\.resume\(now\)/);
  assert.match(show, /this\.metrics\.markDiscontinuity\('show'\)/);
  assert.match(show, /this\.resumeSelectedDevices\(\)/);

  const resume = methodSource('resumeSelectedDevices');
  assertOrdered(resume, ["this.ftmsTarget", "attemptReconnect('ftms')", "this.hrsTarget", "attemptReconnect('hrs')"], 'resume order');
  assert.match(methodSource('reconnectEligible'), /\['ftms', 'hrs', 'warmup', 'hud'\]/);
  const priority = methodSource('yieldOptionalHeartRateSetupForFtms');
  assert.match(priority, /hrsReconnect\.timer \|\| hrsReconnect\.promise/);
  assert.match(priority, /hrsScanState === 'scanning'[\s\S]*hrsScanState === 'connecting'/);
  assert.match(priority, /heartRateSession\.suspend\('ftms_priority'\)[\s\S]*heartRateSession\.cleanup\('ftms_priority'\)/);
  assert.match(methodSource('scheduleReconnect'), /kind === 'ftms'[\s\S]*yieldOptionalHeartRateSetupForFtms/);
});

test('finish, summary persistence and dual cleanup remain bounded and explicit', () => {
  const request = methodSource('requestFinish');
  assert.match(request, /CONFIRM_WINDOW_MS/);
  assert.match(request, /再按一次确认结束/);
  assert.match(request, /return this\.finishSessionToSummary\(\)/);
  assert.match(methodSource('handleBack'), /if \(phase === 'hud'\) return this\.finishSessionToSummary\(\)/);

  const finish = methodSource('finishSessionToSummary');
  assertOrdered(finish, ["this.setSurface('summary'", 'this.scheduleSummaryPersistence', "this.beginTerminalCleanup('summary')"], 'summary first frame');
  assert.match(finish, /distanceEvidence === 'unavailable'[\s\S]*\? '--'/);
  assert.match(finish, /summaryEvidence: `DISTANCE \$\{summary\.distanceEvidence\.toUpperCase\(\)\} · 均功率[^`]+FTMS/);
  assert.match(finish, /summaryForwardText: this\.settings\.cooldownEnabled === false/);
  assert.match(methodSource('startRecovery'), /this\.settings\.cooldownEnabled === false\) return false/);
  assert.match(hud, /<text class="summary-forward">\{\{summaryForwardText\}\}<\/text>/);

  const cleanup = methodSource('beginTerminalCleanup');
  assert.match(cleanup, /this\.ftmsSession\.cleanup\(reason\)/);
  assert.match(cleanup, /this\.heartRateSession\.cleanup\(reason\)/);
  const close = methodSource('closeAgent');
  assert.match(close, /!this\.summaryStored && !this\.persistPendingSummary\(false\)/);
  assert.match(close, /settleWithin\(cleanup, TERMINAL_CLEANUP_MS\)/);
  assert.match(methodSource('dispatchExit'), /if \(this\.exitDispatched\) return false/);
  assert.match(hud, /const TERMINAL_CLEANUP_MS = 800/);
});

test('native taps and hardware keys share guarded phase-specific actions', () => {
  assert.match(home, /bindtap="open"/);
  assert.doesNotMatch(home, /code === ['"](?:Enter|NumpadEnter|Space)['"][\s\S]{0,120}open\(\)/);
  assert.match(home, /GlobalHook[\s\S]*globalConfirm\.schedule/);
  assert.match(home, /ArrowUp[\s\S]*globalConfirm\.cancel\(\)/);

  assert.match(hud, /SurfaceActionGate/);
  assert.match(hud, /DirectionDeduper/);
  assert.match(hud, /bindfocus="onTargetFocus"/);
  for (const action of ['ftms-primary', 'hrs-primary', 'hrs-skip', 'guide', 'hud-finish', 'summary-exit', 'done-exit']) {
    assert.match(hud, new RegExp(`data-action="${action}"`));
  }
  assert.match(methodSource('chooseMenu'), /actions\.canClaim\(`menu:/);
  assert.match(methodSource('toggleSetting'), /actions\.canClaim\(`setting:/);
  assert.match(methodSource('onFtmsCandidateTap'), /actions\.canClaim\(`ftms-device:/);
  assert.match(methodSource('onHeartRateCandidateTap'), /actions\.canClaim\(`hrs-device:/);
  assert.match(methodSource('onTargetFocus'), /now - this\.lastDirectionAtMs < 600[\s\S]*index !== this\.data\.focusIndex/);
  assert.match(methodSource('moveFocus'), /markDirectionRelease\(now\)[\s\S]*phase === 'summary'[\s\S]*startRecovery\(\)/);

  const keys = methodSource('onKeyUp');
  assert.match(keys, /this\.exitPending[\s\S]*event\.preventDefault/);
  assert.match(keys, /code === 'Backspace'[\s\S]*event\.preventDefault[\s\S]*this\.handleBack\(\)/);
  assert.match(keys, /claim\.handled[\s\S]*event\.preventDefault/);
  assert.match(keys, /MULTI_TARGET_PHASES\.has\(this\.data\.phase\)[\s\S]*globalConfirm\.schedule/);
  assert.doesNotMatch(keys, /code === ['"](?:Enter|NumpadEnter|Space)['"][\s\S]{0,120}executeFocused/);
});

test('guide, HUD and summary each use one bounded static production surface', () => {
  assert.equal((hud.match(/class="surface guide"/g) || []).length, 1);
  assert.equal((hud.match(/class="surface hud"/g) || []).length, 1);
  assert.equal((hud.match(/class="surface summary"/g) || []).length, 1);
  assert.equal((hud.match(/class="summary-core"/g) || []).length, 1);
  assert.equal((hud.match(/<text class="title">设置<\/text>/g) || []).length, 1);
  assert.match(hud, /class="guide-machine"[\s\S]*guideTitle[\s\S]*guideInstruction[\s\S]*guideSafety/);
  assert.match(hud, /\.guide-figure\s*\{[^}]*width:\s*160px;[^}]*height:\s*160px;/s);
  assert.match(hud, /\.metric-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr 1fr;[^}]*grid-template-rows:\s*92px 92px;/s);
  assert.match(hud, /\.metric-value\s*\{[^}]*font-size:\s*28px;/s);
  assert.match(hud, /\.split-value\s*\{[^}]*font-size:\s*34px;/s);
  assert.match(hud, /smooth="false" animate="false"/);
  assert.match(hud, /chart-panel chart-empty/);
  assert.doesNotMatch(home + hud, /@keyframes|\banimation(?:-[a-z-]+)?\s*:|\btransition\s*:|gradient\s*\(/i);
  assert.match(hud, /\.focused\s*\{\s*outline-width:[^}]*outline-style:[^}]*outline-color:[^}]*outline-offset:/s);
  assert.doesNotMatch(hud, /\.focused\s*\{[^}]*border:/s);
});

test('runtime and page copy stay rowing-machine specific, aggregate-only and read-only', () => {
  for (const label of ['今日训练', '自由划', '训练总结', '划后放松']) assert.match(hud, new RegExp(label));
  assert.match(hud, /只保存聚合指标，不保存设备名、标识或原始蓝牙数据/);
  assert.doesNotMatch(home + hud, /navigator\.geolocation|wx\.getLocation|GPS|皮划艇|Kayak|SUP|桨板/);
  const runtime = fs.readdirSync(new URL('../lib/', import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'))
    .join('\n') + hud;
  assert.doesNotMatch(runtime, /UnitySendMessage|AndroidJavaObject|sendCommand|\bMAC\b|0x2ad9|writeValue(?:With|Without)?Response/i);
  assert.doesNotMatch(runtime, /['"](?:AA|A_[^'"]*|B_[^'"]*|C_[^'"]*|D_[^'"]*|DP_[^'"]*)['"]/);
  assert.doesNotMatch(runtime, /119\.28|wx\.request|fetch\(|https?:\/\//i);
  assert.doesNotMatch(runtime, /device\.(?:name|deviceName|id|deviceId)|error\.message/);
});
