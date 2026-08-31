## 这次改了什么

<!-- 一个 PR 只解决一个清晰问题。说明用户可见变化、为什么需要，以及不在本次范围内的内容。 -->

- Summary：
- Related Issue / 贡献问卷：

## Scope

<!-- 勾选所有适用项；专项指标只在同一运动与兼容协议内比较。 -->

- [ ] Run
- [ ] Bike
- [ ] Rower
- [ ] Paddle / Rider（孵化项目）
- [ ] Common / Benchmark / Registry
- [ ] 文档、治理或工具

## Tests

<!-- 只列实际执行的命令/操作及原始结果；没有运行就写 not_run 和原因。 -->

| 命令或操作 | 环境/版本 | 结果（pass/fail/skipped） |
| --- | --- | --- |
|  |  |  |

- [ ] 已覆盖与本次改动相关的正常、错误、缺失、断流及生命周期边界。
- [ ] 未用“测试已过”代替具体命令、版本和结果。

## Evidence

- Evidence-Level：`not_run / L1 / L2 / L3 / L4 / L5`
- Evidence-Ref：
- Commit / Version / Locale：
- Artifact UUID / SHA-256（L2 以上且适用时）：
- Host / Firmware / Peripheral class（L3/L4 以上且适用时；不要填序列号或 MAC）：

<!-- Reader/Preview、Craft/Host、Rokid 真机、现场对照必须分别声明，不能向上推断。 -->

- [ ] 证据与当前 commit、包和环境身份一致。
- [ ] 已保留失败、跳过、不可用和降级结果，没有只展示最佳一次。
- [ ] 不适用或未执行的验证已放入 Open gates。

## Data Source

<!-- 对每个新增或改变的指标说明 measured / estimated / unavailable；不涉及时写 N/A。 -->

- Measured：
- Estimated：
- Unavailable：
- 新鲜度、断流与零值处理：

- [ ] 缺失字段保持 unavailable，没有以 `0` 或无关字段冒充实测。
- [ ] UI 和结果卡能够区分 measured 与 estimated。

## Privacy

- [ ] 不包含 key、token、账号、签名材料、真实 MAC 地址、序列号、精确位置/轨迹、本机绝对路径或未脱敏日志。
- [ ] 新增的数据字段、权限、日志、存储、网络端点或后台任务已说明收集、处理、保存、上传、删除和失败状态。
- [ ] 默认保持离线；任何上传都需要针对具体目的显式开启，并能再次关闭和删除。
- [ ] 安全漏洞或个人数据通过私密报告流程提交，没有放在公开 Issue / PR。

## Third-party

- [ ] 本次不含第三方代码、SDK、固件、图片、字体、音频、视频或数据；或已在下方逐项说明。
- [ ] 我有权按本仓库许可证提交自己的贡献。

| 内容 | 作者/来源链接 | 版本 | 许可证 | 是否修改 |
| --- | --- | --- | --- | --- |
| N/A |  |  |  |  |

## Safety and sport-specific checks

- [ ] 运动中提示保持低干扰，并保留明确停止/退出路径；或本次不涉及。
- [ ] 若涉及 BLE，已区分扫描、连接、服务发现、订阅成功与收到首个合法完整数据。
- [ ] 若涉及 Rower，只使用 FTMS Rower Data 与可选 HRS；没有发现、订阅或写入 Control Point `0x2AD9`。
- [ ] 若涉及设备控制、自动连接或后台上传，已有单独设计/威胁评审和维护者批准；或本次不涉及。

## Open gates

<!-- 明确仍未完成的 Reader、Craft、真机、兼容性、隐私、安全、第三方或发布门。 -->

- [ ] Reader / Preview：
- [ ] Craft / Host：
- [ ] Rokid 真机：
- [ ] 其他型号 / 固件 / 外设：
- [ ] 隐私 / 安全 / 第三方：
- [ ] AIX / APK / 固件 / 商店或 AIUI 平台提交：

## Release boundary

- [ ] 本 PR 不包含 AIX、APK、固件、签名文件、私有 SDK 或未经授权的二进制。
- [ ] 我理解“合并 PR”不等于打包、上传 AIUI 平台、安装、部署或公开发布；这些动作需要发布负责人另行明确批准。
