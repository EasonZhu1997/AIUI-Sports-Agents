<script type="application/json" def>
{
  "navigationBarTitleText": "AIBike",
  "description": "Shows the AIBike brand and opens the immersive cycling flow.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {}
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import {
  beginInternalSurfaceNavigation,
  completeHomeResume,
  consumeRideFinishedHint,
  consumeScanExitHint,
} from '../../lib/ride_surface.js';
import { formatDistanceKm, formatElapsed } from '../../lib/ride_format.js';
import { readLastRideSummary } from '../../lib/ride_summary.js';

const RIDE_ROUTE = '/pages/ride_hud/index';
const RIDE_MENU_ROUTE = RIDE_ROUTE + '?mode=menu&inputGuard=1&returnCard=1';
const EXIT_CONFIRM_WINDOW_MS = 3000;
const HOME_CONFIRM_DEDUPE_MS = 400;
const HOME_RETURN_INPUT_GUARD_MS = 800;
const RIDE_FINISHED_HINT_MAX_AGE_MS = 60000;

export default {
  data: {
    homeVersion: 'v0.3.80',
    homeSlogan: '自由骑行，智能相伴',
    enterText: '按确认键进入',
  },

  onLoad() {
    this.rideNavigationPending = false;
    this.lastHomeConfirmAtMs = null;
    this.homeEntryGuardUntilMs = null;
    this.homeIdleEnterText = '按确认键进入';
    this.disarmExitPrompt();
    this.refreshHomeCard();
    if (consumeScanExitHint(wx, EXIT_CONFIRM_WINDOW_MS)) this.armExitPrompt();
  },

  onShow() {
    this.rideNavigationPending = false;
    if (consumeRideFinishedHint(wx, RIDE_FINISHED_HINT_MAX_AGE_MS)) {
      completeHomeResume(wx);
      this.homeEntryGuardUntilMs = Date.now() + HOME_RETURN_INPUT_GUARD_MS;
    }
    this.refreshHomeCard();
    if (consumeScanExitHint(wx, EXIT_CONFIRM_WINDOW_MS)) this.armExitPrompt();
  },

  onUnload() {
    if (this.navPendingTimer) clearTimeout(this.navPendingTimer);
    this.navPendingTimer = null;
    this.clearExitPromptTimer();
  },

  openMode() {
    if (this.homeEntryGuardUntilMs != null
        && Date.now() < this.homeEntryGuardUntilMs) return false;
    if (this.rideNavigationPending) return false;
    this.rideNavigationPending = true;
    if (this.navPendingTimer) clearTimeout(this.navPendingTimer);
    this.navPendingTimer = setTimeout(() => {
      this.navPendingTimer = null;
      this.rideNavigationPending = false;
    }, 3000);
    beginInternalSurfaceNavigation(wx);
    try {
      wx.navigateTo({
        url: RIDE_MENU_ROUTE,
        fail: () => { this.rideNavigationPending = false; },
      });
    } catch (_error) {
      this.rideNavigationPending = false;
      return false;
    }
    return true;
  },

  openMenu() {
    return this.openMode();
  },

  refreshHomeCard() {
    const summary = readLastRideSummary(wx);
    if (!summary) {
      this.homeIdleEnterText = '按确认键进入';
      this.setData({
        homeSlogan: '自由骑行，智能相伴',
        enterText: this.homeIdleEnterText,
      });
      return false;
    }
    const elapsed = formatElapsed(summary.elapsedMs);
    const distanceText = summary.distanceM >= 5
      ? `${formatDistanceKm(summary.distanceM)} km`
      : (summary.distanceM > 0 ? '距离很短' : '距离未形成');
    this.homeIdleEnterText = '再次骑行';
    this.setData({
      homeSlogan: `最近骑行 ${elapsed} · ${distanceText}`,
      enterText: this.homeIdleEnterText,
    });
    return true;
  },

  clearExitPromptTimer() {
    if (this.exitPromptTimer) clearTimeout(this.exitPromptTimer);
    this.exitPromptTimer = null;
  },

  disarmExitPrompt() {
    this.clearExitPromptTimer();
    this.exitArmedAtMs = null;
    const idleText = this.homeIdleEnterText || '按确认键进入';
    if (this.data.enterText !== idleText) {
      this.setData({ enterText: idleText });
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
      const now = Date.now();
      if (this.exitArmedAtMs != null
          && now - this.exitArmedAtMs <= EXIT_CONFIRM_WINDOW_MS) {
        this.disarmExitPrompt();
        // AIUI 0.15 的 JS 定义允许省略 options，但部分真机桥仍要求对象参数。
        try { wx.exitMiniProgram({}); } catch (_error) {}
        return;
      }
      this.armExitPrompt(now);
      return;
    }
    if (code === 'GlobalHook') {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (this.lastHomeConfirmAtMs != null
          && now - this.lastHomeConfirmAtMs < HOME_CONFIRM_DEDUPE_MS) return;
      this.lastHomeConfirmAtMs = now;
      this.openMenu();
    }
  },

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
          <view class="bike-logo"><text class="bike-logo-text">AB</text></view>
          <text class="home-brand-name">AIBike</text>
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
  font-size: 13px;
  line-height: 18px;
  font-weight: bold;
  font-family: monospace;
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
</style>
