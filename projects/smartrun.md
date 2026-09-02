# AISmartRun

<img src="../assets/project-icons/smartrun-orange.png" alt="AISmartRun 跑步项目图标" width="96">

- **运动**：跑步
- **当前轨道**：Candidate
- **当前语义版本**：0.1.114
- **公开证据等级**：L2（本地测试、AIX/Reader/预览）
- **核心来源**：标准 HRS、可选 RSC、眼镜 IMU
- **应用源码**：[`apps/smartrun`](../apps/smartrun/)；PolyForm Noncommercial 1.0.0，属于 source-available
- **商业使用**：必须在开始前取得许可方的单独书面商业许可；根层 Apache-2.0 不覆盖该应用目录

## 玩法

用户可选择自由跑、室内跑或超慢跑。设备数据存在时优先采用标准通知；缺少 RSC 时回退眼镜 IMU，并明确标注估算来源。跑步结束先生成本地总结，网络与模型不能阻断核心闭环。

## 公开重点

- 低采样率下的步频与活动确认；
- RSC/IMU 距离账本切换；
- 心率设备断流和重连；
- 480×352 眼镜 HUD 与低误触交互；
- 不使用 GPS 时的数据诚实边界。

## 开放门

- Craft/目标 AIUI host 与 Rokid 真机仍需绑定相同版本证据；
- BLE、IMU、录屏、hide/show 和长时间跑步需完成脱敏真机矩阵。
