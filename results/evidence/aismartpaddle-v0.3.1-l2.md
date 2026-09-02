# AISmartPaddle v0.3.1 · L2 本地包证据记录

## 身份

- **项目 / 运动**：AISmartPaddle；户外皮划艇与室内划船机双模式
- **语义版本**：0.3.1
- **源 commit**：`9c31dfa0802440640ccdaf48fb1c121e0c18f017`
- **源可见性**：本地 canonical Git commit，未公开、未配置远端；本记录不授予源码访问权
- **测试日期 / 时区**：2026-09-02；Asia/Shanghai（UTC+08:00）
- **协议与宿主基线**：AIUI 0.16.1；FTMS Rower Data `0x2AD1`、Machine Feature
  `0x2ACC`，按 FTMS 1.0.1 字段顺序；标准 HRS `0x180D / 0x2A37`
- **本地工具**：`@yodaos-pkg/aix@0.7.0`；`@yodaos-pkg/aix-cli@0.8.2`

## 实际执行记录

| 命令 | 结果 |
|---|---|
| `npm test` | pass；30 个 spec 文件，358/358 项通过，0 fail |
| `npm run doctor:aiui` | pass；39/39 个必需项目文件和发布边界通过 |
| `npm run preview:check` | pass；24 个中文状态覆盖双 Home target、户外与室内流程 |
| `npm run inspect:aix` | pass；Reader/官方 transform、manifest、闭包和 provenance 通过 |
| `shasum -a 256 release/AISmartPaddle-AIUI-v0.3.1-cn.aix` | pass；与下列包摘要一致 |

本轮没有本地失败项。Craft、Rokid 真机、物理 FTMS、真实水上、Garmin 对照及 Hermes
真机链路均为 skipped/not_run，并保留在开放门中。

## L2 包身份

- **文件名**：`AISmartPaddle-AIUI-v0.3.1-cn.aix`
- **Locale**：`zh-CN`
- **AIX UUID**：`15a4a694-9908-48ec-b265-7e793d1df030`
- **AIX SHA-256**：`b6b43116ec1c525ec42489fff493c57bb25e6c09a840b0007e11e58abfacce19`
- **包文件大小**：471,225 bytes
- **source tree SHA-256**：`181ba3bfef4b9947c2f2c42d9c14eb67a3ba3840f656e1cb814eac6c936c6643`
- **official-transform payload tree SHA-256**：
  `5dce9c840661ab2a730507ef3081e35179cbe186d1db51ce12794c312fa99baa`
- **manifest**：`engine: "*"`；Reader 实际执行 `supports_engine("0.16.1")`

AIX 文件本身未上传到 Hub；这些标识只证明该本地包通过所列 L2 检查。

## 数据来源与声明边界

- **measured**：包字节、UUID、文件大小、SHA-256、Reader/Inspector 输出和自动化测试结果；
- **estimated**：产品中的实验 IMU 桨频仍默认关闭，本证据没有生成或声称现场估算值；
- **unavailable**：真实 GPS 路径、物理 FTMS/HRS 数据、设备屏或 Garmin 对照、Craft 与
  Rokid Host 行为均无本轮证据。

因此可以声明“该 SHA-256 的本地中文 AIX 可由所列工具读取并通过静态 Preview/Inspector”；
不能声明 Craft、眼镜按键、BLE 无线链路、物理划船机或真实皮划艇已经通过。

## Open gates

- 完成源码权利、第三方素材、许可方身份和双许可审批后，再决定独立源码分发；
- Craft 导入、官方签名及 Rokid Glasses AIUI 0.16.1 的入口、焦点、按键与生命周期；
- 物理标准 FTMS 划船机的 Feature、flags、首包、静默、stale、断流和同对象重连；
- 真实水上 GPS、Garmin FIT 与实验桨频人工视频对照；
- Hermes Paddle 身份域、天气和聚合训练回执的真机隐私链路。

登记范围见 [Issue #1](https://github.com/EasonZhu1997/AIUI-Sports-Agents/issues/1)。
