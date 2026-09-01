# 应用源码公开审批记录

`SOURCE_DISTRIBUTION_APPROVAL.json` 是未来独立运动应用仓的机器可读发布门。它不是许可证、商业合同或 CLA，也不会自动授予发布权限；它只把一次人工权利审查绑定到具体候选内容，防止旧的 `READY` 标记在源码变化后继续放行。

当前 Run、Bike、Rower 的 Registry 状态均为 `pending`，许可方为空，应用仓也未具备本文件，因此当前不能导出或发布应用源码。

## 文件位置与模板

审批文件必须位于独立应用源码仓根目录，文件名固定为 `SOURCE_DISTRIBUTION_APPROVAL.json`。从 Hub 的 [`registry/source-distribution-approval.example.json`](../registry/source-distribution-approval.example.json) 复制后填写；不要把占位内容标为 `ready`。

应用仓中的审批文件只是候选副本。维护者还必须把完全相同的审批记录放入 Hub 的权威路径 `registry/source-approvals/<project-id>.json`，并由 Registry 的 `approvalRecord` 精确指向它。导出时以 Hub 副本为权威，两个副本逐字段不一致就阻断，因此仅能修改应用仓的人不能凭自填 JSON 完成自我批准。

“权威”表示导出器要求该记录、Registry 与导出脚本已经被 Git 跟踪、提交并与当前 Hub HEAD 一致，并不表示 GitHub 远端已自动具备分支保护，也不等同于密码学签名。在任何项目转为 `ready` 前，仓库管理员还必须实际启用 ruleset 或 branch protection，要求 Pull Request、必要审批和 CODEOWNERS 审阅，并核对管理员绕过策略。

## 字段

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 固定为 `1` |
| `status` | 审查中使用 `draft`；全部门关闭后才改为 `ready` |
| `projectId` / `version` | 必须与 Hub Registry 和应用 `package.json` 一致 |
| `licensor` | 有权提供 PolyForm 与商业许可的准确个人或法律实体名称，必须与 Registry、`COPYRIGHT`、商业咨询文件一致 |
| `contributorRightsStatus` | 只有贡献者权利链核清后才能设为 `verified` |
| `contributorRightsBasis` | `sole-author`、`cla-complete`、`written-assignments`、`mixed-reviewed` 之一；不能用尚未启用的 CLA 草案充数 |
| `thirdPartyRightsStatus` | 第三方代码、依赖、字体、媒体、SDK、固件和数据逐项核清后才能设为 `verified` |
| `reviewedSourceRevision` | 审查所基于的完整 40 位 Git commit；必须存在且是当前 HEAD 的祖先，从该 commit 到当前 HEAD 只能改变审批 JSON |
| `contentManifestSha256` | 导出器对除本审批文件外的候选路径、大小与内容 hash 生成的摘要 |
| `reviewedBy` / `reviewedAt` | 实际审阅者身份与 `YYYY-MM-DD` 日期；不能填 `TODO`、`TBD` 或 `unknown` |

## 准备流程

1. 应用源码仓先完成许可证、密钥、隐私、第三方、贡献者权利和 Git 历史审查。
2. 根 `LICENSE` 使用未经修改的 PolyForm Noncommercial 1.0.0；`package.json` 的 `license` 与之匹配。
3. `COPYRIGHT` 放置精确一行：`Required Notice: Copyright <实际许可方>`。
4. `COMMERCIAL_LICENSE.md` 放置精确一行：`Commercial Licensor: <实际许可方>`，并明确普通联系、报价或付款不构成授权。
5. 从示例复制审批 JSON，先保持 `draft`，提交到应用仓并确保工作树干净。
6. 在 Hub 中运行 `npm run export:dry -- --project <project-id>`。命令会列出 blocker，并输出当前候选的 `content manifest SHA-256`；存在 blocker 时退出码非零。
7. 由有权限的审阅者核对候选，将准确 manifest、权利状态、审阅修订、姓名和日期写入应用仓审批 JSON，再用一个只改变该审批 JSON 的提交完成记录；审阅修订之后若改了任何其他文件，必须重新审查并更新审阅修订。
8. 由 Hub 维护者把同一审批对象复制到 `registry/source-approvals/<project-id>.json`，通过 Pull Request 独立核对逐字段一致；应用仓提交者不得单独批准自己的候选。
9. 将 Hub Registry 的 `licensor`、`approvalRecord`、状态和必要时的 `sourceRepository` 更新为真实值，重新运行严格审计与预演。
10. 只有预演退出 0、所有 blocker 清零、工作树干净且人工发布决定已明确时，才可运行写入导出。

## 自动阻断条件

导出器会阻断以下情况：

- 项目 ID 或输出路径可能逃出 Hub 的 `dist/`；
- Hub Registry、权威审批记录或导出器未被 Git 跟踪，或其工作区内容与当前 Hub HEAD 不一致；
- 必需文件缺失、是符号链接，或应用 `package.json` 的版本、许可证、测试/构建脚本不匹配；
- PolyForm 文本不是官方 1.0.0 原文；
- 许可方、Required Notice、商业咨询文件、应用仓审批副本与 Hub 权威审批记录不一致；
- Git 工作树不干净、候选文件未被 Git 跟踪、审阅修订不属于当前历史，或审阅修订之后改变了审批 JSON 以外的文件；
- 候选源码包含常见密钥、私钥、凭据 URL、疑似密码赋值、MAC 或本机绝对路径；
- 当前候选 manifest 与审批记录不同；
- `dist` 或输出目标是符号链接、已经存在，或复制后的文件 hash 改变。

自动检查不能证明权利一定完整。法定许可主体、雇佣/委托关系、第三方再分发与商业再许可权、CLA/书面转授权证据，以及最终商业合同仍须人工和法律审阅。
