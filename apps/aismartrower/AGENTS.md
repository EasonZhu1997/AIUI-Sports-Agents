# Agent Manifest — AISmartRower

## 平台描述 / Store Description

AISmartRower is a standalone rowing-machine coach for Rokid Glasses with required
FTMS telemetry, optional external HRS, guided preparation and privacy-bounded
summaries.

## Identity

- **Name**: 划船机教练
- **Version**: 0.0.1
- **Description**: AISmartRower is a standalone rowing-machine coach for Rokid
  Glasses with required FTMS telemetry, optional external HRS, guided
  preparation and privacy-bounded summaries.
- **Author**: Yixiao Zhu

## Capabilities

- **Permissions**:
  - bluetooth
  - audio

### 权限用途

- `bluetooth`：只在用户明确操作后搜索、验证和订阅标准 Fitness Machine Service
  划船机；划船机数据就绪后，用户可再显式连接另一台标准 Heart Rate Service 心率
  设备。两条链路不按名称、地址或历史记录自动连接。
- `audio`：播放简短热身、动作、安全、开始和结束提示；语音不定义可见业务状态。

`app.json` 不声明定位、相机或麦克风权限。本工程只启用划船机训练所需的 FTMS/HRS
数据、语音和本地聚合复盘链路。v0.0.1 不包含运行时网络请求、固定服务地址或上传。

## 产品边界

- 本工程是独立划船机产品，只包含划船机训练流程；业务页面、指标账本与历史均由
  本工程独立维护。
- v0.0.1 只读遥测：禁止发现、写入或调用 Fitness Machine Control Point `0x2AD9`，
  不启动/停止机器、不调阻力、不设置训练程序。
- 不移植 Android AAR、Unity bridge、私有字符串命令、MAC/硬件地址假设或手写 CCCD。
- 本地 mock、Doctor、Preview 和 AIX Reader 只能证明实现与包闭包；不能证明 Rokid
  宿主可同时维持 FTMS 与 HRS 两台外设。双连接必须保留为真机开放门。

## FTMS 必需链路

- 只接受标准 FTMS `0x1826`。用户点选候选后依次验证：服务存在、Fitness Machine
  Feature `0x2ACC` 支持 Read 且恰好返回 8 字节、Rower Data `0x2AD1` 支持 Notify。
  Indicate-only 不满足 Rower Data 要求。
- 状态固定为 `idle → scanning → connecting → validating → subscribed_silent → live`。
  服务发现、GATT 已连接、Feature 已读或通知已订阅都不能单独宣称可用；只有首个通过
  flags、长度、字段顺序、有限值和必需基础字段校验的完整最终数据集才能进入 `live`。
- Rower Data flags 按 little-endian `UINT16` 解释，bit 0 的 More Data 为倒置基础字段
  语义。分片只在 final 到达后原子发布；2.5s 分片超时和 3.5s live window 是本产品
  策略，不冒充 Bluetooth 标准常量。
- 只接受标准字段布局。任何尾随字节、截断字段或与 `0x2ACC` Feature 位冲突的可选
  字段都会使整个数据集失效，不能建立或刷新 `live`。
- 通知可能早于 `startNotifications()` Promise 返回；里程碑仍必须保持
  `subscribed → first_valid → live` 单向推进，不能从 `live` 回退。
- 距离增量通过 `12m/s + 1m` 量化余量门，累计划次通过 `127.5spm + 1次` 量化余量
  门。计数回滚、超限、隐藏、断流与重连只重锚，不补断流数据。
- 划船机距离总结证据为 `unavailable`、`stationary`、`measured` 三态。setup 首包只可作
  开赛锚点，不算本场字段覆盖；开赛后没有合法 distance 字段必须显示 `--`，有合法
  覆盖且无增长才允许显示 `0`。

## HRS 可选链路与心率仲裁

- 只有 FTMS 首个合法完整数据集通过后才进入可选 HRS 步骤。用户可跳过，不得让 HRS
  搜索、订阅静默、接触不良或连接失败阻断划船训练。
- 独立 HRS 只接受标准 `0x180D / 0x2A37 Notify`。解析 UINT8/UINT16 心率、接触状态、
  Energy Expended 与 RR Interval 的结构边界；产品显示只接受 20–240 bpm。
- FTMS 与 HRS 使用完全独立的 scan、connection、reconnect generation、监听、GATT
  对象、目标对象和清理 Promise。任何一条链路失败或断开都不得递增、替换或清理另一条
  链路的代次与资源。
- 两个 profile 不能对同一 `BluetoothDevice` 重复 `gatt.connect()`。若候选与当前
  FTMS 是同一对象，拒绝独立 HRS 连接并提示使用机载心率。
- 当前显示优先级：5s 内新鲜、结构合法且 `contactDetected !== false` 的独立 HRS；
  否则回退到 3.5s 内新鲜的 FTMS bit 9 心率；否则显示 `--`。两路不平均、不取最大、
  不叠加覆盖。
- 总结心率来源只允许 `independent_hrs`、`ftms`、`mixed`、`partial`、`unavailable`，
  使用同一 active-time 轴做去重时间加权并分别保留两路覆盖时长。

## 双链路生命周期

- FTMS 与 HRS 扫描不重叠。开始 HRS 搜索前必须停止 FTMS scan，但保留已验证的 FTMS
  GATT 与 Notify。若宿主拒绝连接中扫描或第二条 GATT，显示诚实降级提示，保留 FTMS。
- 设备点选与搜索各自单飞并带代次；只有服务、Feature、特征属性和通知订阅全部成功后
  才原子提交本场目标，旧设备数据不能标到新选择上。界面只使用本地生成的临时序号标签。
- 意外断开后，仅对本场显式选择且成功连接的同一内存设备对象按 4 秒最多重连 5 次；
  FTMS 优先、HRS 次之，setup 串行，不自动重新扫描。
- `onHide` 暂停 active-time 与引导倒计时，先同步作废两路在途代次，再停止通知并断开
  GATT，同时保留同一内存目标与剩余预算。`onShow` 先恢复 FTMS，再恢复 HRS；新首包只
  重锚，不能补隐藏期间距离或划次。
- 总结首帧不等待蓝牙清理。退出时两路均按 remove listener → stopNotifications →
  disconnect 幂等清理；总退出最多等待 800ms，迟到回调不得复活状态，
  `wx.exitMiniProgram` 只派发一次。

## 训练指标与总结

- HUD 核心字段：本地活动计时、500m 配速、桨频、距离、功率和当前心率。FTMS
  waiting/stale 时除本地计时外所有 FTMS 字段显示 `--`；独立 HRS 若仍新鲜可单独显示。
- 所有聚合使用扣除隐藏时间的 active-time。active-time 或 wall-time 倒退的乱序包直接
  拒绝，不移动锚点、不计覆盖。
- 配速、桨频、功率、距离和心率按字段独立覆盖；缺失字段不能互相推导或伪装零值。
  60 秒趋势必须以真实覆盖计权，低于 50% 的桶不出点；没有可信趋势显示空态。
- 本地历史使用独立 schema v1 envelope，最多保留 20 条聚合记录。坏基线拒绝覆盖，
  写入后完整 envelope 回读一致才算成功。不保存设备名、id、raw packet 或逐包记录。
- 总结首帧使用本地确定性规则；保存失败可进入本地放松，但最终退出必须重新通过完整
  写后读回门。运行时完全离线，结束与蓝牙清理不依赖外部服务。

## 页面与交互

1. `pages/index/index`：448×150 callable 入口。
2. `pages/rower_hud/index`：480×352 沉浸页，包含 Menu、Settings、必需 FTMS、可选
   HRS、4×15s 热身、HUD、总结、可选 4×15s 放松和退出。

流程固定为：

`Home → Menu → FTMS 首包就绪 → HRS 可选/跳过 → 热身 → HUD → 总结 → 放松 → 退出`

- 多目标页以前后划循环选择，方向只在 `onKeyUp` 提交并 `preventDefault()`；单动作页
  即时确认。方向释放后 600ms 内拒绝迟到 `bindfocus` 抢回旧焦点。
- HUD 确认键第一次显示结束提示，3 秒内第二次确认结束；Back 直接进入总结。
- 热身/放松均为 4 项×15 秒，绝对截止时间配合 250ms 检查。自动换项，热身末项只开赛
  一次；手动确认与归零竞态不得重复。放松末项第一次确认只进入完成态，第二次才退出。
- 引导首项 Back 分别返回 HRS 或总结，其余项返回上一项并重置 15 秒。
- 动作安全文案必须区分机上技术动作与停机后平地拉伸。站立拉伸时先停止机器、离开
  滑轨/滑座/手柄并站在平地；不得指导用户坐在移动滑座上拉伸。

## 视觉与素材

- 画布固定为 Home 448×150、沉浸页 480×352；沉浸内容安全区 448×324。
- 黑底、单一 Rokid Green 四级透明度、1px 结构线、4px 控件圆角、6px 面板圆角；
  2px 只用于焦点。不使用第二色、渐变、阴影、CSS animation、keyframes 或 transition。
- 公开版本不携带权属未核清的图标或动作 GIF。品牌和传感器标记用文字、边框与
  程序化几何表达；引导动作始终由标题、步骤与安全文案完整说明。
- HUD 使用开放式 3×2 指标网格；500m 主配速 32px 以上，其余核心数值 28px 以上。
  LIVE、waiting/stale 和结束确认必须互斥可辨；心率明确标注来源 HRS 或 FTMS。

## 发布与验收边界

- 正式本地构建名为 `AISmartRower-AIUI-v0.0.1-cn.aix`，仅中文版。每次打包生成新的
  UUID v4 并原子更新 `VERSION`；验证运行闭包、source/payload SHA-256、ZIP 无重复
  条目、官方 AIX Preview 与 2MB 上限。
- 本地只打包与验证，不上传、不安装、不导入 Craft、不签名、不发布。
- 真机必须记录眼镜型号、固件、AIUI host build、同一 AIX UUID/SHA，并关闭：FTMS
  广告/Feature/Notify/首包/分片/持续流、HRS UINT8/UINT16/接触状态、FTMS 已连接时
  HRS 扫描、两条 GATT/Notify 至少 15 分钟交错、单路断开不影响另一条、stale、隐藏恢复、
  同对象重连、双清理、按键去重与 8 个 GIF 完整播放。
- 至少使用一台标准 FTMS 划船机和一台标准广播 HRS 胸带。
  任一真机门未完成时，只能表述为“本地架构已兼容，目标宿主双连接待验证”。
