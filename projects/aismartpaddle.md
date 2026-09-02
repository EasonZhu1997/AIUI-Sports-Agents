# AISmartPaddle

- **运动**：户外皮划艇与室内划船机，两个证据域严格隔离
- **当前轨道**：Incubating
- **当前语义版本**：0.3.1
- **AIUI 兼容探针**：0.16.1
- **公开证据等级**：L2（本地测试、Doctor、Preview、AIX Reader/Inspector）
- **户外核心来源**：GPS、可选标准 HRS、默认关闭的实验 IMU 桨频
- **室内核心来源**：标准 FTMS Rower Data，可用心率仅取自同一 FTMS 数据集
- **计划源码分发**：`pending`；当前 Hub 只公开项目上下文，不公开应用源码或 AIX

## 玩法

用户在菜单中只选择一次户外皮划艇或室内划船机。两个模式共享低干扰的热身、HUD、
总结和放松体验骨架，但传感器、距离账本、指标来源、历史 schema 与开放门互不混用。

户外模式只在用户开赛后启用 GPS。可信路径距离与当前速度来自连续合法定位；实验桨频
默认关闭，开启后也只作为明确标注的 IMU 估算，不能生成距离。室内模式只接受标准
Fitness Machine Service `0x1826`，读取 8 字节 Machine Feature `0x2ACC`，并订阅
Rower Data `0x2AD1`。

## 数据真实性

- GPS 与 FTMS 距离都区分 `unavailable`、`stationary`、`measured`；没有证据时显示
  `--`，只有可信静止才显示零。
- FTMS 生命周期分开表达 `scanning`、`connecting`、`validating`、
  `subscribed_silent` 与 `live`；订阅成功不等于收到首个合法完整数据集。
- Rower Data 可选字段必须同时满足 flags、长度、有限数、产品范围和 `0x2ACC` Feature
  位；断流后隐藏旧值，不由 GPS、IMU 或独立 HRS 补造室内字段。
- 户外与室内总结都只保存聚合指标，不保存坐标、轨迹、设备名、设备标识或原始 BLE/IMU。

## v0.3.1 本地证据快照

快照于 2026-09-02（Asia/Shanghai）复核，仅支持 L2 结论。完整命令、源 commit、
包文件名、通过/跳过项和声明边界见
[L2 本地包证据记录](../results/evidence/aismartpaddle-v0.3.1-l2.md)。

- 358/358 项本地自动化通过；AIUI Doctor、24 态双 target Preview 与 AIX Inspector 通过；
- 中文 AIX UUID：`15a4a694-9908-48ec-b265-7e793d1df030`；
- AIX SHA-256：`b6b43116ec1c525ec42489fff493c57bb25e6c09a840b0007e11e58abfacce19`；
- source tree SHA-256：`181ba3bfef4b9947c2f2c42d9c14eb67a3ba3840f656e1cb814eac6c936c6643`；
- official-transform payload tree SHA-256：
  `5dce9c840661ab2a730507ef3081e35179cbe186d1db51ce12794c312fa99baa`；
- manifest `engine: "*"`，Reader 实际执行 `supports_engine("0.16.1")`。

这些标识只记录本地包证据；AIX 文件本身不进入 Hub。

## 安全与网络边界

- 室内 v0.3.1 仅只读遥测，不发现、订阅或写入 Fitness Machine Control Point `0x2AD9`；
- 设备连接必须由用户明确选择，不自动扫描、自动配对、按名称猜测或持久化设备；
- 户外天气只在开赛后把最新合法点临时发送给自有 Hermes，原始轨迹、BLE 和 IMU 不上传；
- 本地总结先完成，网络失败不能覆盖本地确定性结论。

## 开放门

- Craft 导入、官方签名与 Rokid Glasses AIUI 0.16.1 的默认 480×352 入口、焦点和按键；
- 至少一台物理标准 FTMS 划船机的 Feature、flags、首包、静默、stale、断流与同对象重连；
- 真实水上 GPS 漂移/断流、Garmin FIT 对照，以及开启实验桨频后的人工视频校准；
- Hermes Paddle 身份域、天气成功/失败/过期/退避与隐藏恢复；
- 本地 canonical Git history 已建立但未公开；仍需完成源码权利、第三方素材和双许可审批。

户外专项入口见 [Paddling Benchmark](../benchmark/paddling.md)，室内字段与真机门使用
[Indoor Rowing Benchmark](../benchmark/indoor-rowing.md)。AISmartRower v0.0.1 的具名
设备兼容、独立 HRS 双链路和 watchdog 合同不作为本项目证据。
