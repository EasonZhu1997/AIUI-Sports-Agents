<script type="application/json" def>
{
  "navigationBarTitleText": "划船机教练",
  "description": "Opens a standalone rowing-machine coach with required FTMS telemetry, optional external heart rate, guided warm-up and private summaries.",
  "schema": { "data": { "type": "object", "properties": {} } }
}
</script>

<script setup>
import wx from 'wx';
import { PendingConfirm } from '../../lib/pending_confirm.js';

export default {
  data: { action: '按确认键进入' },
  onLoad() {
    this.locked = false;
    this.routeGeneration = 0;
    this.routeUnlockTimer = null;
    this.globalConfirm = new PendingConfirm();
  },
  onShow() {
    this.locked = false;
    this.routeGeneration += 1;
    if (this.routeUnlockTimer) clearTimeout(this.routeUnlockTimer);
    this.routeUnlockTimer = null;
    if (this.globalConfirm) this.globalConfirm.cancel();
  },
  onUnload() {
    this.routeGeneration += 1;
    if (this.routeUnlockTimer) clearTimeout(this.routeUnlockTimer);
    this.routeUnlockTimer = null;
    if (this.globalConfirm) this.globalConfirm.cancel();
  },
  open() {
    if (this.globalConfirm) this.globalConfirm.cancel();
    if (this.locked) return;
    this.locked = true;
    const generation = ++this.routeGeneration;
    if (this.routeUnlockTimer) clearTimeout(this.routeUnlockTimer);
    this.routeUnlockTimer = setTimeout(() => {
      this.routeUnlockTimer = null;
      if (generation === this.routeGeneration) this.locked = false;
    }, 3000);
    const unlock = () => {
      if (generation !== this.routeGeneration) return;
      this.locked = false;
      if (this.routeUnlockTimer) clearTimeout(this.routeUnlockTimer);
      this.routeUnlockTimer = null;
    };
    try {
      wx.navigateTo({
        url: '/pages/rower_hud/index?mode=menu&inputGuard=1',
        success: unlock,
        fail: unlock,
      });
    } catch (_error) { unlock(); }
  },
  onKeyUp(event) {
    const code = event && event.code;
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight') {
      if (this.globalConfirm) this.globalConfirm.cancel();
      if (event && event.preventDefault) event.preventDefault();
      return;
    }
    // Confirm keys use the focused native button's bindtap.  GlobalHook is a
    // fallback only for hosts that do not dispatch native activation.
    if (code === 'GlobalHook' && this.globalConfirm) this.globalConfirm.schedule(() => this.open());
  },
};
</script>

<page>
  <view class="home-wrap">
    <view class="home-card">
      <view class="brand"><view class="mark"><view class="mark-wheel"></view><view class="mark-rail"></view><view class="mark-seat"></view></view><text class="name">划船机教练</text><text class="version">v0.0.1</text></view>
      <text class="slogan">每一桨，都更清楚</text>
      <button class="enter focused" bindtap="open"><text>{{ action }}</text></button>
    </view>
  </view>
</page>

<style>
.home-wrap { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; box-sizing: border-box; width: 448px; height: 150px; margin: 0 auto; position: fixed; right: 0; bottom: 0; left: 0; }
.home-card { display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; width: 448px; height: 150px; padding: 5px 14px; overflow: hidden; background-color: #000000; border-radius: 12px; }
.brand { display: flex; flex-direction: row; align-items: center; justify-content: center; width: 420px; height: 38px; }
.mark { position: relative; width: 32px; height: 32px; margin-right: 8px; }
.mark-wheel { position: absolute; left: 1px; bottom: 2px; box-sizing: border-box; width: 14px; height: 14px; border-width: 2px; border-style: solid; border-color: #40ff5e; border-radius: 7px; }
.mark-rail { position: absolute; right: 1px; bottom: 7px; width: 20px; height: 2px; background-color: #40ff5e; }
.mark-seat { position: absolute; right: 5px; bottom: 11px; width: 8px; height: 3px; background-color: #40ff5e; }
.name { color: #40ff5e; font-size: 28px; line-height: 34px; font-weight: bold; font-family: monospace; }
.version { width: 54px; margin-left: 7px; color: rgba(64,255,94,0.6); font-size: 11px; line-height: 18px; font-family: monospace; }
.slogan { width: 420px; height: 24px; color: rgba(64,255,94,0.6); font-size: 18px; line-height: 24px; font-weight: bold; text-align: center; }
.enter { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 420px; height: 36px; margin-top: 3px; padding: 0; background-color: rgba(64,255,94,0.08); border: 0; border-radius: 12px; color: #40ff5e; font-size: 18px; line-height: 24px; font-weight: bold; }
.enter.focused { outline-width: 2px; outline-style: solid; outline-color: #40ff5e; outline-offset: -2px; }
</style>
