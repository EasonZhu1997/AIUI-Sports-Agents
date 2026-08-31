# AIUI Sports Agents

面向智能眼镜的证据优先运动 Agent 开源计划。

这个项目不是把不同运动应用塞进一个大应用，而是用一套公开、可复核的方法，维护多个独立运行的垂直产品：

- **AISmartRun**：跑步；HRS、RSC 与眼镜 IMU。
- **AIBike**：骑行；HRS、CSC、Cycling Power、FTMS 与眼镜 IMU。
- **AISmartRower**：划船机；标准 FTMS Rower Data，可选独立 HRS。当前以只读遥测为主，机器控制关闭。

核心原则只有四条：

1. 真实传感器优先。
2. 估算必须明确标注。
3. 没有证据就保持不可用。
4. 每一项能力都绑定版本、环境与证据等级。

## 项目怎么组织

```text
AIUI Sports Agents             统一品牌、评测和治理
├── AISmartRun                 独立应用、独立发布
├── AIBike                     独立应用、独立发布
└── AISmartRower               独立应用、独立发布
```

本仓库只承载公共方法和项目索引，不把三套应用硬合成一个单体。运动算法、页面状态机、权限和硬件验收分别维护；稳定复用的协议解析、输入去重、生命周期、存储与打包工具，经过两个项目验证后才进入共享层。

## 三种玩法

### 1. 作为使用者体验

选择一个运动应用，先阅读对应项目卡和硬件兼容矩阵，再按该应用的本地构建说明生成 AIX。浏览器预览只能检查页面与 Ink 解析；BLE、IMU、按键、后台恢复和双设备连接必须在 Rokid 真机上验证。

### 2. 作为开发者贡献

修复或新增能力时，同时提交：

- 实现与自动化测试；
- 对应的协议或数据来源说明；
- 一张结果卡，写明版本、设备、固件和仍未关闭的门；
- 若宣称真机可用，提供经过脱敏的真机证据等级。

### 3. 作为评测者复现

所有运动共享 Common Benchmark，再执行各自的 Sport Benchmark。Common 结果可以跨运动比较；Sport 结果只在同一运动、同类硬件中比较，禁止用一个总分判断“跑步优于骑行”。

## 快速开始

本仓库没有运行时依赖，Node.js 20 及以上即可：

```bash
npm run validate
npm run report
```

检查相邻的本地应用源码：

```bash
cp registry/local-projects.example.json registry/local-projects.json
npm run audit:local
```

严格模式会在发现缺少开源文件、危险产物或不适合公开的目录时返回失败：

```bash
npm run audit:local:strict
```

白名单导出工具默认只预演，不写文件：

```bash
npm run export:dry -- --project aibike
```

确认清单后，才在本地生成 `dist/` 快照：

```bash
npm run export:local -- --project aibike
```

这一步只生成本地文件，不会创建远端仓库，也不会上传、安装、签名或发布 AIX。

## 评测输出

每个结果由三部分组成：

- **Common**：场景闭环、数据诚实、实时与生命周期、人因安全、离线与隐私、可复现性。
- **Sport**：跑步、骑行或划船机的专项准确性与降级规则。
- **Evidence Level**：L1 自动化测试到 L5 完整现场对照。

详细规则见 [评测入口](benchmark/README.md)；当前项目状态见：

- [AISmartRun 项目卡](projects/smartrun.md)
- [AIBike 项目卡](projects/aibike.md)
- [AISmartRower 项目卡](projects/aismartrower.md)

面向公众号和技术社区的完整介绍见独立文章：
[《AIUI Sports Agents 开源项目怎么玩》](articles/AIUI_Sports_Agents_开源项目怎么玩.md)。

## 当前边界

- 这是本地开源准备仓，尚未发布到任何代码托管平台。
- 结果卡中的 `pass` 只在标注的证据等级内成立，不能越级解释为真机通过。
- 原始设备日志、运动备份、稳定设备标识、凭据、固件包、AIX 和未确认授权素材不进入公开快照。
- 网络能力默认关闭或显式选择；离线运动闭环不得依赖后端。

## 许可证

本仓库自有代码与文档采用 Apache License 2.0。第三方依赖、示例和素材仍受各自许可证约束；未确认授权的内容不属于公开发布范围。
