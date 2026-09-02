# AISmartRower

<img src="../assets/project-icons/aismartrower-orange.svg" alt="AISmartRower 室内划船机项目图标" width="96">

- **运动**：室内划船机
- **当前轨道**：Labs
- **当前语义版本**：0.0.1
- **公开证据等级**：L2；另有非 Rokid 主机的局部设备证据，不能升级为 L4
- **核心来源**：必需 FTMS Rower Data，可选独立 HRS
- **应用源码**：[`apps/aismartrower`](../apps/aismartrower/)；PolyForm Noncommercial 1.0.0，属于 source-available
- **商业使用**：必须在开始前取得许可方的单独书面商业许可；根层 Apache-2.0 不覆盖该应用目录

## 玩法

用户明确选择标准 FTMS 划船机。应用完成服务、Feature、Rower Data 属性验证并收到首个合法完整数据集后，才进入 live。可选 HRS 是第二条独立连接；连接失败不能破坏已经工作的 FTMS 遥测。

HUD 展示活动时长、500m 配速、桨频、距离、功率和当前心率。字段缺失、过期或订阅静默时显示不可用，不沿用旧值。

## 安全边界

- v0.0.1 仅提供只读遥测；
- 不调用 Fitness Machine Control Point；
- 不启动、停止机器或修改阻力；
- 不复制 Android AAR、Unity bridge、MAC 假设或手写 CCCD；
- 网络不上传设备名、设备标识、原始 BLE 包或逐包数据。

## 开放门

- 完成 Rokid 真机 FTMS 广告、Feature、Notify、首包、持续流、第二条 HRS GATT，以及双链路 15 分钟、单路断开、hide/show 与幂等清理；
- 已观测的 KS/WMX 双字节阻力形状已有窄范围兼容与回归向量；仍需在同一设备上重跑持续流，并补不同活动状态与固件证据；
- 保持 Fitness Machine Control Point `0x2AD9` 关闭；若未来确需控制，必须另立安全契约并完成物理效果验收。

公共 GATT 轮廓见 [FTMS Rower Profile](../contracts/ftms-rower-profile.md)。
