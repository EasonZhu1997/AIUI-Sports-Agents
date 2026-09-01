# 许可证政策

> 本文说明当前仓库与未来独立应用源码的预期许可边界，不替代任何许可证或已签署合同，也不构成法律意见。发生不一致时，以具体文件、仓库或交付物在取得时附带的许可证和书面合同为准。

## 一句话结论

- 当前 `AIUI-Sports-Agents` 是采用 Apache License 2.0 的开放源代码（open source）评测与治理 Hub。
- 未来若单独公开 AISmartRun、AIBike、AISmartRower 等应用源码，计划采用“PolyForm Noncommercial 1.0.0 免费非商业许可 + 单独书面商业许可”的双许可模式。这些应用源码将属于源码可见（source-available），而不是符合 OSI 定义的开放源代码。
- 本政策不会、也不能追溯撤回已经依 Apache-2.0 授予的权利。

## 许可矩阵

| 范围 | 识别方式 | 免费许可 | 商业使用 | 当前状态 |
| --- | --- | --- | --- | --- |
| 当前 `AIUI-Sports-Agents` Hub 的自有代码、文档、评测、配置与原创资产 | 仓库根目录 [`LICENSE`](./LICENSE)；个别文件另有明确声明的除外 | Apache License 2.0 | 可以，但必须遵守 Apache-2.0；无需另行购买本项目商业许可 | 已生效，OSI 开源 |
| 本 Hub 中已经按 Apache-2.0 发布的历史 commit、tag、release 或副本 | 该版本发布时附带的 Apache-2.0 | 该版本的 Apache-2.0 权利继续有效 | 可以，仍按该版本的 Apache-2.0 | 不追溯变更 |
| 第三方代码、SDK、字体、图片、协议资料或其他内容 | 文件头、NOTICE、依赖清单或上游许可证 | 由第三方条款决定 | 由第三方条款决定；本项目不能代为授权 | 不自动转为 Apache-2.0 或商业许可 |
| 未来独立发布并明确标记为 PolyForm Noncommercial 1.0.0 的应用源码 | 独立仓库或交付包的根许可证、文件头与 Required Notice | 仅限该许可证允许的非商业目的 | 必须在使用前取得权利人的单独书面商业许可 | 规划中，尚未由本政策自动启用 |
| AIX、APK、签名包、设备固件、厂商 SDK、素材和其他二进制交付物 | 每次交付随附的条款或合同 | 不因源代码可见或 Hub 开源而自动获准 | 以实际交付条款、第三方权利和书面合同为准 | 不属于本政策的自动授权范围 |

仓库中的项目卡、评测结果、导出清单或路线图不表示对应应用源码或二进制已经发布，也不授予其使用权。

## Apache-2.0 的既有权利不会被追回

Apache License 2.0 第 2 节授予符合其条件的永久、全球、非独占、免费、免版税且不可撤销的著作权许可。该许可证本身另有明确条件和终止机制时，依其原文处理。

因此：

1. 某一版本一旦由有权许可者按 Apache-2.0 发布，取得该版本的人可以继续依 Apache-2.0 使用该版本。
2. 后续修改许可证、将仓库设为私有、删除 release 或删除 Git 历史，不会把已经授出的 Apache-2.0 权利追溯变成“仅限非商业”。
3. 权利人可以在权利链允许的前提下，为未来版本选择不同条款，但新条款只约束其实际覆盖的新版本或新作品。
4. 本文件不是对当前 Hub 的重新许可，也不会把当前 Hub 变为 PolyForm Noncommercial。

Apache License 2.0 官方文本：<https://www.apache.org/licenses/LICENSE-2.0>

## 未来应用源码的双许可边界

未来应用源码只有同时满足以下条件时，才进入计划中的双许可模式：

1. 它位于与当前 Hub 清晰分离的独立仓库或独立发布包中；
2. 根目录放置未经修改的 PolyForm 许可证，并在独立 `COPYRIGHT` 与分发物中保留以 `Required Notice:` 开头、准确标识许可方的纯文本行；
3. 发布记录明确列出版本、commit、覆盖文件、权利主体和第三方例外；
4. 源码经过来源、密钥、隐私、第三方材料和可再许可权审计；
5. 外部贡献在启用并完成法律审阅的 CLA 流程后才合并。

符合上述标记的应用源码拟提供两条可选的使用路径：

- **免费非商业路径：**严格遵守未经修改的 [PolyForm Noncommercial License 1.0.0](./licenses/PolyForm-Noncommercial-1.0.0.md)。
- **商业路径：**在商业使用开始前，与实际权利人签署单独的商业许可合同；询价流程见 [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md)。

仓库中的 PolyForm 文件是从官方 `1.0.0` tag 逐字复制的参考文本；它的存在不会给当前 Hub 增加第二套许可证，也不会自动把任何未来源码纳入该许可证。只有具体应用仓库或发布包作出清晰的适用声明时，PolyForm 条款才覆盖该声明指定的软件。

PolyForm Noncommercial 限制使用目的，因而不满足 [Open Source Initiative 的开放源代码定义](https://opensource.org/osd)中不得歧视业务领域的要求。对外描述应使用“源码可见”“source-available”或“非商业源码许可”，不应将该应用源码宣传为“OSI 开源”。

## 适用规则

- 许可证以取得特定版本时的实际标记为准，不能仅凭项目名称、README 宣传语或本政策推定。
- 商业合同只覆盖合同列明的版本、主体、关联方、产品、用途、期限和地域；未列明部分不自动获准。
- 商业许可不当然包含商标、第三方材料、专利保证、技术支持、SLA、赔偿或设备认证，除非合同逐项写明。
- 对“是否属于非商业目的”存在疑问时，应在开始使用前联系权利人，不应把沉默视为授权。
- 许可证约束的是其实际覆盖的软件表达及相关许可权，不当然垄断运动方法、抽象算法思想、功能或独立完成的实现；品牌、专利、商业秘密与合同权利应分别评估。

## 官方参考

- Apache License 2.0：<https://www.apache.org/licenses/LICENSE-2.0>
- PolyForm Noncommercial 1.0.0 官方原文：<https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md>
- PolyForm Project 对许可证文本修改的说明：<https://github.com/polyformproject/polyform-licenses>
- OSI Open Source Definition：<https://opensource.org/osd>
