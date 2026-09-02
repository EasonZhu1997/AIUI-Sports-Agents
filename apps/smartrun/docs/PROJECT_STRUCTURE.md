# AISmartRun 公开源码导览

产品版本：`0.1.114`

AISmartRun 是面向 Rokid Glasses 的跑步 AIX。它以眼镜 IMU 作为可独立工作的运动数据基础，并可连接标准 BLE 心率设备；设备同时提供 RSC 时，应用可增强速度与步频显示。

## 源码地图

```text
AIUI_AISmartRun_AIX_Public/
├── AGENTS.md                 # AIX 身份、权限和运行边界
├── app.js
├── app.json                  # 两条页面路由；不申请定位权限
├── LICENSE
├── COPYRIGHT
├── package.json              # 版本、测试和三语打包命令
├── VERSION                   # 每个 AIX 包的独立 UUID
├── assets/                   # 随包图像、动画和本地声音
├── pages/
│   ├── run_hud/index.ink     # 默认 480×352 沉浸式运行页
│   └── index/index.ink       # 448×150 兼容入口
├── lib/                      # BLE、IMU、指标、总结和本地数据模块
├── tools/                    # doctor、打包、Reader 和发布校验
├── test/                     # 单元、页面、BLE 与发布回归
└── docs/
    ├── GARMIN_BLE_DEMO.md
    ├── SMARTRUN_BLE_GATT_CONTRACT.md
    └── assets/               # 文档架构图，不进入运行时 assets
```

## 两个运行页面

- `pages/run_hud/index` 是 `app.json` 的第一页面，也是默认沉浸式入口。训练菜单、设备搜索、热身、跑步 HUD、恢复、总结和设置都在这一页面的受控状态中完成。
- `pages/index/index` 是第二页面，为较小的宿主画布提供安全兼容入口。它不会在用户操作前扫描或连接蓝牙。

两页均使用最小 title-only 元数据。预览和 Reader 校验只能证明包结构可读；画布、焦点、按键和 BLE 生命周期最终仍需目标 AIUI 版本与真实眼镜验证。

## 运动数据路径

1. 用户在设备搜索页面主动启动 BLE 扫描。
2. 标准 HRS `0x180D/0x2A37` 提供心率；订阅成功后仍须等到首个合法通知，才能标记为实时数据。
3. 自由跑和室内跑可在同一 GATT 上探测可选 RSC `0x1814/0x2A53`。只有首个合法且新鲜的 RSC 通知才会增强速度和步频。
4. RSC 不存在、静默、无效或过期时，应用保留可用 HRS，并回退眼镜 IMU。
5. 指标仲裁层只维护一个距离账本，数据来源切换时重锚，避免 RSC 与 IMU 重复累计。
6. HUD 使用选中的可信指标，结束后先生成本地跑步总结。

Garmin 是标准 BLE 兼容性演示设备之一，并非合作方或唯一支持设备。普通 Garmin“广播心率”通常只表示 HRS；Virtual Run 并按 START 后是否持续提供 RSC，取决于具体型号、固件和宿主 BLE 行为。

## 数据与网络边界

- 应用不申请定位权限，不使用 GPS 或连续轨迹积分。
- 原始 BLE 包、原始加速度和原始陀螺仪数据不持久化、不上传。
- 跑步核心、HUD 和本地规则总结可以离线工作。
- 可选在线能力只接受用户配置的 HTTPS 地址；仓库不包含内置服务地址、密钥、设备凭据或真实用户数据。
- BLE 诊断只记录脱敏里程碑、首个合法通知的有限元数据和包计数。

## Garmin 演示与证据等级

- `docs/GARMIN_BLE_DEMO.md` 给出普通 HRS 与 Virtual Run/RSC 的操作步骤。
- `docs/SMARTRUN_BLE_GATT_CONTRACT.md` 定义标准 UUID、包解析、新鲜度、降级和隐私约束。
- `docs/assets/garmin-ble-running-architecture-handdrawn.png` 展示 Garmin、眼镜 AIX、IMU 回退、指标仲裁和本地总结的关系。
- 规范和自动化测试证明协议与实现一致性；历史分段 HRS 实测只证明相应路径。当前同一构建版本的 Rokid 完整闭环，以及持续 RSC 数据，仍需真实硬件验收，不能由模拟器或文档替代。

## 本地校验与打包

```bash
npm ci
npm test
npm run doctor:aiui
npm run build:all
```

`build:all` 从同一源码树生成 CN、EN、JA 三个本地 AIX，并执行 Reader、语言、UUID、来源与 2 MB 限制检查。`LICENSE` 和 `COPYRIGHT` 随 AIX 源码清单进入包内。生成的 `.aix` 文件受忽略规则保护，不应提交到本源码仓库。

本仓库完成的是源码发布和本地构建验证；上传 AIUI Studio、安装到眼镜或提交商店属于独立发布动作。
