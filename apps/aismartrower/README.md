# AISmartRower｜划船机教练

AISmartRower v0.0.1 是 `AIUI-Sports-Agents` 中的划船机子项目。它在 AIUI
眼镜上读取标准蓝牙 FTMS 划船数据，并可由用户另行连接一个标准 HRS 心率设备。
应用只做遥测和本地指导，不控制划船机。

## 现在包含什么

- 用户点按后搜索、点选并验证 FTMS `0x1826 / 0x2ACC / 0x2AD1`；
- 只有 Feature Read、Rower Data Notify 和首个合法完整记录都通过后才进入 `LIVE`；
- 每个可选 Rower Data 字段都受 `0x2ACC` 对应 Feature 位与产品范围双重约束；
- 可选 HRS `0x180D / 0x2A37` 独立连接，失败时不阻断 FTMS；
- 热身、实时 HUD、本机聚合总结、可选放松与有界清理；
- 默认完全离线：运行时没有上传、账号、分析、固定服务器或网络请求。

## 本地运行与验证

需要 Node.js 20+、Python 3 和 Info-ZIP `zip`：

```bash
npm ci
npm test
npm run doctor:aiui
npm run contract:lint
npm run preview:check
```

创建并检查本地 AIX：

```bash
npm run pack:aix
npm run inspect:aix
npm run aix:preview:check
```

产物写入 `release/`，该目录被 Git 忽略。上述命令不会上传、安装、导入、签名或发布。

## 隐私与安全边界

- 不保存或记录设备名、稳定设备标识、原始 BLE 包或原生错误文本；
- 候选设备只在当前页面内以“划船机 1 / 心率设备 1”这类临时标签显示；
- 历史只保留经过白名单裁剪的本地聚合结果；
- 不发现、不订阅、不写入 Fitness Machine Control Point `0x2AD9`；
- 不包含 Android/Unity bridge、厂商私有命令、固件、抓包或硬编码地址。

协议和生命周期的规范性说明见
[`docs/FTMS_GATT_CONTRACT.md`](docs/FTMS_GATT_CONTRACT.md)。本地测试只能证明代码
与打包闭包；FTMS + HRS 双外设、Rokid 输入和持续连接仍需在同一 AIX UUID/SHA 下真机验收。

## 视觉资产边界

公开子项目不带来源未核清的图标或动作 GIF。当前界面使用文字、边框和程序化几何占位；
贡献者如要加入图片，必须同时提供可核验的权属与再分发许可，且不能使用厂商 Logo 暗示背书。

## 许可证

源代码按 [PolyForm Noncommercial 1.0.0](LICENSE) 提供，仅授权非商业用途。
商业使用需要与 Yixiao Zhu 另行签署书面商业许可；详情见
[`COMMERCIAL_LICENSE.md`](COMMERCIAL_LICENSE.md)。项目名称与商标边界见
[`TRADEMARKS.md`](TRADEMARKS.md)。
