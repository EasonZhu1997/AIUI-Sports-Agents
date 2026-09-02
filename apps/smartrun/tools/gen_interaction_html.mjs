// Generate docs/aismartrun-interaction-logic.html from the workflow journal that
// extracted each page's interaction logic. Read-only spec for review: an interactive
// mindmap overview + each page's green UI screenshot beside its interaction logic.
//   node tools/gen_interaction_html.mjs <journal.jsonl>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const journalPath = process.argv[2];
if (!journalPath || !fs.existsSync(journalPath)) {
  console.error('usage: node tools/gen_interaction_html.mjs <journal.jsonl>');
  process.exit(1);
}

const results = [];
for (const line of fs.readFileSync(journalPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'result') continue;
  let r = o.result;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* leave */ } }
  if (r && r.purpose && r.keys) results.push(r);
}

const META = [
  { key: 'index', label: '首页 Home', file: 'pages/index/index.ink', match: '首页', color: '#2563eb', img: 'pages/home.png' },
  { key: 'run_hud', label: '跑步 HUD', file: 'pages/run_hud/index.ink', match: 'HUD', color: '#16a34a', img: 'pages/run.png' },
  { key: 'bluetooth', label: '设备 Devices', file: 'pages/bluetooth/index.ink', match: '设备', color: '#9333ea', img: 'pages/device.png' },
  { key: 'settings', label: '设置 Settings', file: 'pages/settings/index.ink', match: '设置', color: '#d97706', img: 'pages/settings.png' },
  { key: 'coach', label: '教练 Coach', file: 'pages/coach/index.ink', match: '教练', color: '#dc2626', img: 'pages/coach.png' },
];
const ordered = META.map((m) => ({ meta: m, data: results.find((r) => (r.page || '').includes(m.match)) })).filter((x) => x.data);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function keysTable(keys) {
  const rows = keys.map((k) => `
        <tr>
          <td><code>${esc(k.code)}</code></td>
          <td>${esc(k.behavior)}</td>
          <td class="center">${k.preventDefault ? '✓' : '—'}</td>
        </tr>`).join('');
  return `<table class="tbl">
        <thead><tr><th style="width:190px">按键</th><th>行为</th><th style="width:110px">preventDefault</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

function focusTable(targets) {
  const rows = targets.map((t) => `
        <tr>
          <td class="center">${esc(t.index)}</td>
          <td><b>${esc(t.label)}</b></td>
          <td>${esc(t.action)}</td>
          <td>${t.destination && t.destination !== '—' ? `<code>${esc(t.destination)}</code>` : '—'}</td>
        </tr>`).join('');
  return `<table class="tbl">
        <thead><tr><th style="width:52px">序</th><th style="width:160px">目标</th><th>激活行为</th><th style="width:210px">跳转</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

function list(items) {
  return `<ul class="bul">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function pageSection(x, i) {
  const { meta, data } = x;
  const life = (data.lifecycle || []).map((l) => `<li><code>${esc(l.hook)}</code> — ${esc(l.does)}</li>`).join('');
  const nav = (data.navigatesTo || []).map((n) => `<li><span class="trig">${esc(n.trigger)}</span> <span class="arr">→</span> <b>${esc(n.page)}</b></li>`).join('');
  return `
    <section class="page" id="${meta.key}">
      <div class="page-head" style="border-left-color:${meta.color}">
        <span class="pidx" style="background:${meta.color}">${i + 1}</span>
        <div>
          <h2>${esc(meta.label)}</h2>
          <code class="fp">${esc(meta.file)}</code>
        </div>
      </div>
      <div class="visual">
        <div class="shot-wrap">
          <img class="page-shot" src="${esc(meta.img)}" alt="${esc(meta.label)} 界面" loading="lazy" />
          <span class="shot-cap">眼镜实际界面(单绿色)</span>
        </div>
        <p class="purpose">${esc(data.purpose)}</p>
      </div>

      <div class="block"><h3>生命周期</h3><ul class="life">${life}</ul></div>
      <div class="block"><h3>硬件按键</h3>${keysTable(data.keys || [])}</div>
      <div class="block"><h3>焦点 / 可激活目标(tab 顺序)</h3>${focusTable(data.focusTargets || [])}</div>
      <div class="block"><h3>语音唤醒</h3><p class="pline">${esc(data.voiceWakeup)}</p></div>
      <div class="block"><h3>关键行为 / 边界</h3>${list(data.special || [])}</div>
      <div class="block"><h3>可跳转到</h3><ul class="nav">${nav}</ul></div>
    </section>`;
}

const mindmapMd = `# AISmartRun
## 跑前准备
### 首页 Home · 跑前就绪
- 自动检测授权 / 已有连接,**不在短画布新建 GATT**
- 焦点:设备 / 开跑(默认=开跑)
- Backspace = 复位开跑焦点后交宿主默认处理
- 语音唤醒 = 一键开跑
- 去向:设备 → · 跑步 HUD →
### 设备 Devices · 蓝牙心率配对
- 搜索并**记住**标准蓝牙心率带
- 自动心率开关 · 焦点覆盖 6 个目标
- 底部「设置/开跑」支持硬件激活
- 去向:设置 → · 跑步 HUD →
### 设置 Settings · 跑前偏好
- 步长 / 自动心率 / 语音 / 记忆
- 每改即存(无保存键)
- 焦点覆盖 4 项设置 + 底部开跑
- 去向:跑步 HUD →
## 跑步中
### 跑步 HUD · 进页自动开跑
- 纯展示卡片,**无按钮**
- 时间 / 步频 / 距离 / 配速(未稳定时显示“获取中”;接入后 + 心率)
- Backspace = 保存并结束记录后交宿主默认返回
- 息屏自动暂停 · 心率断连静默回眼镜
- 去向:首页(退出) →
### 教练 Coach · AI 语音
- 语音问 配速 / 心率 / 节奏
- LLM 10s 超时 → 规则兜底 · Z5 跳过模型
- Backspace = 清理当前轮次后交宿主默认返回
- ⚠ App 内暂无入口`;

const mindmap = `
  <div class="mm-wrap">
    <div class="markmap" style="width:100%;height:560px">
      <script type="text/template">
${mindmapMd}
      </script>
    </div>
    <p class="mm-hint">可拖动 / 缩放 / 点节点圆点折叠展开。脑图为联网加载(markmap);离线时看下方各页详情即可。</p>
  </div>`;

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AISmartRun · 各页面交互逻辑(确认稿)</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;}
  .wrap{max-width:1000px;margin:0 auto;padding:32px 22px 72px;}
  h1{font-size:24px;margin:0 0 6px;}
  .lede{color:#475569;font-size:15px;margin:0 0 20px;}
  code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:#e2e8f0;border-radius:5px;padding:1px 6px;font-size:.9em;}
  .legend{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px;}
  .legend .k{background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:6px 12px;font-size:13px;}
  .mm-wrap{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:10px 12px 6px;margin:0 0 8px;}
  .markmap{display:block;}
  .markmap > svg{width:100%;height:100%;}
  .mm-hint{font-size:12px;color:#94a3b8;margin:2px 4px 6px;}
  .warn{background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:14px 18px;margin:16px 0 24px;}
  .warn h3{margin:0 0 8px;color:#991b1b;font-size:15px;}
  .warn ol{margin:0;padding-left:20px;color:#7f1d1d;font-size:14px;}
  .warn ol li{margin:4px 0;}
  .page{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:4px 20px 18px;margin:0 0 22px;}
  .page-head{display:flex;align-items:center;gap:12px;border-left:5px solid;padding:14px 0 12px 14px;margin:0 -20px 8px;padding-left:20px;}
  .pidx{color:#fff;font-weight:800;width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex:0 0 auto;}
  .page-head h2{margin:0;font-size:19px;}
  .fp{font-size:12px;background:transparent;color:#64748b;padding:0;}
  .purpose{margin:2px 0 14px;color:#334155;font-size:14px;}
  .visual{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap;margin:6px 0 10px;}
  .shot-wrap{flex:0 0 auto;display:flex;flex-direction:column;gap:5px;}
  .page-shot{width:430px;max-width:100%;border-radius:11px;border:1px solid #cbd5e1;display:block;background:#000;}
  .shot-cap{font-size:11px;color:#94a3b8;text-align:center;}
  .visual .purpose{flex:1;min-width:240px;margin:6px 0 0;font-size:14.5px;}
  .block{margin:14px 0;}
  .block h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:0 0 7px;font-weight:800;}
  .tbl{width:100%;border-collapse:collapse;font-size:13.5px;}
  .tbl th{text-align:left;background:#f8fafc;border:1px solid #e2e8f0;padding:7px 10px;color:#475569;font-weight:700;}
  .tbl td{border:1px solid #e2e8f0;padding:7px 10px;vertical-align:top;}
  .tbl td.center,.tbl th.center{text-align:center;}
  ul.bul,ul.life,ul.nav{margin:0;padding-left:18px;font-size:13.5px;}
  ul.bul li,ul.life li,ul.nav li{margin:5px 0;}
  ul.nav .trig{color:#334155;} ul.nav .arr{color:#94a3b8;margin:0 4px;}
  .pline{font-size:13.5px;margin:0;color:#334155;}
  .toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px;}
  .toc a{text-decoration:none;font-size:13px;font-weight:700;color:#fff;border-radius:8px;padding:6px 12px;}
</style>
</head>
<body>
<div class="wrap">
  <h1>AISmartRun · 各页面交互逻辑(确认稿)</h1>
  <p class="lede">下面是从每个页面 <code>.ink</code> 源码里逐条抽取的真实交互逻辑。顶部是**页面脑图**(按 跑前 / 跑中 分支,每页挂关键交互),下面每页配眼镜实际绿色界面 + 详情表。眼镜硬件只有几个键:</p>
  <div class="legend">
    <div class="k"><b>Backspace</b> 页面只监听，宿主执行默认返回</div>
    <div class="k"><b>↑/↓/←/→</b> 移动焦点</div>
    <div class="k"><b>Enter · Space · GlobalHook</b> 激活当前焦点(GlobalHook=镜腿触控)</div>
    <div class="k"><b>语音唤醒</b> onVoiceWakeup</div>
  </div>

  <div class="toc">
    ${ordered.map((x, i) => `<a href="#${x.meta.key}" style="background:${x.meta.color}">${i + 1}. ${esc(x.meta.label)}</a>`).join('\n    ')}
  </div>

  ${mindmap}

  <div class="warn">
    <h3>一处请重点确认</h3>
    <ol>
      <li><b>教练页没有 App 内入口:</b>首页 / HUD / 设备 / 设置 都没有跳到 <code>pages/coach</code> 的动作,HUD 也没有 onVoiceWakeup。目前只能靠宿主/外部方式进入。是否要在 HUD 或首页加一个「问教练」入口?</li>
    </ol>
  </div>

  ${ordered.map((x, i) => pageSection(x, i)).join('\n')}
</div>
<script src="https://cdn.jsdelivr.net/npm/markmap-autoloader@0.18"></script>
</body>
</html>`;

const OUT = path.join(ROOT, 'docs/aismartrun-interaction-logic.html');
fs.writeFileSync(OUT, html);
console.log(`Wrote ${path.relative(ROOT, OUT)} (${ordered.length} pages, ${Math.round(html.length / 1024)} KB)`);
