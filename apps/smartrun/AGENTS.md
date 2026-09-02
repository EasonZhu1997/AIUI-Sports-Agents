# Agent Manifest — AISmartRun

## Store Description

SmartRun tracks free runs on Rokid Glasses, connects compatible heart-rate devices, and shows cadence, pace, distance, time and run summaries.

## Identity

- **Name**: 跑步教练
- **Version**: 0.1.114
- **Description**: SmartRun tracks free runs on Rokid Glasses, connects compatible heart-rate devices, and shows cadence, pace, distance, time and run summaries.
- **Author**: Yixiao Zhu

## Capabilities

- **Permissions**:
  - bluetooth
  - accelerometer
  - gyroscope
  - audio
  - network

### Permission usage

- `bluetooth`：仅在用户主动点击搜索后发现并连接兼容设备；标准 HRS（`0x180D/0x2A37`）用于心率，可选 RSC（`0x1814/0x2A53`）用于速度与步频。
- `accelerometer`：在没有可用 RSC 时，使用眼镜 IMU 估算步数、步频、距离和配速。
- `gyroscope`：辅助拒绝转头、扶眼镜和触碰产生的伪运动，不把角速度积分为距离。
- `audio`：播放本地节拍音和简短的跑步、安全提示。
- `network`：可选上传用户明确启用的跑步汇总与派生数据；离线时核心跑步、HUD 和本地总结仍可工作。

## Runtime contract

- Garmin 仅作为标准 BLE 兼容性示例，不代表合作或认证。普通“广播心率”通常只保证 HRS；只有设备实际暴露并持续发送 RSC 时才使用其速度与步频。部分 Garmin 型号需进入 Virtual Run 并按 START。
- 发现服务或订阅成功不等于实时数据。HRS 以首个合法 `0x2A37` 通知确认，RSC 以首个合法 `0x2A53` 通知确认；断流后分别按 8 秒和 2.5 秒的新鲜度窗口降级。
- RSC 诊断以 `RSC_FIRST_PACKET` 标记首个合法通知，以 `RSC_SILENT` 标记已订阅但未形成有效数据流；两者都只记录脱敏里程碑和有界元数据。
- RSC 缺失、静默、无效或过期时保留可用 HRS，并回退眼镜 IMU。距离只由一个账本维护，来源切换时重锚，避免重复累计。
- 每次新的眼镜运动段在质量已确认为跑动时需要 3 个严格证据；质量仍不确定时需要 4 个不高于 210spm 且节律一致的证据，未确认候选不会事后补记。
- HUD 对当前可信步频只做最多 3.5 秒短保持；实时节律过期后恢复 `--`，跑后总结仍独立保留有效样本计算出的平均步频。
- 跑后先冻结本地规则总结；总结阶段可用 `LanguageModel` 原位升级点评，模型不可用、失败或超时时仍保留本地结果。
- `app.json` 不申请定位权限；运行时不使用 GPS 或连续路径积分。网络配置必须是 HTTPS，仓库不内置服务地址、密钥、设备凭据或用户数据。
- 原始 BLE 包、原始加速度和原始陀螺仪数据不持久化、不上传。日志仅保留经过限制且可脱敏的里程碑与派生指标。

## Pages

- `pages/run_hud/index`：第一页面和默认 480×352 沉浸式入口，承载训练菜单、设备搜索、热身、跑步 HUD、恢复、总结和设置。
- `pages/index/index`：第二页面，提供 448×150 兼容入口；不自动扫描或连接蓝牙。

两页均保留最小 title-only 元数据。真实画布、焦点、按键、BLE 生命周期和退出行为仍以目标 AIUI 宿主的真机结果为准。

## Evidence boundary

- 已有分段实机证据证明标准 Garmin HRS 路径可收到合法通知。
- 当前同一构建版本上的 Rokid 眼镜完整闭环，以及 Garmin Virtual Run 的持续 RSC 数据，仍是发布前真机门槛；未完成前不得宣称已验证完整 RSC 增强路径。

## Build boundary

- 使用 `@yodaos-pkg/aix-cli` 兼容打包链生成 AIX；`VERSION` 是每个包独立生成的 UUID，不是产品语义版本。
- CN、EN、JA 包从同一源码树生成并分别通过 Reader、UUID、来源和 2 MB 限制检查。
- 生成的 `.aix` 文件只用于本地验证，不纳入本源码仓库；上传 AIUI Studio、安装到眼镜或提交商店需要单独授权。
