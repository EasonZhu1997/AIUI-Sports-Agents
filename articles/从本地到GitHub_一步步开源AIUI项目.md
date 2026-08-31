# 从本地到 GitHub：一步步开源 AIUI 项目

把一个 AIUI 项目放到 GitHub，看起来只是一次 `git push`，实际上更像一次小型发布：你要决定什么能公开、什么必须留在本地、哪些结论已经有证据，以及以后别人该怎样参与。

一套可靠的做法，不是先上传再清理，而是先建立一个干净的公开候选，再让 GitHub 只接收这份候选。下面以 AIUI Sports Agents 的实践为例，给出从本地项目到公开仓库的完整流程。

## 先把四件事分开

AIUI 项目常见的四个动作不能互相代替：

| 动作 | 公开了什么 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| GitHub 源码公开 | 经过审核的源码、测试、文档和契约 | 别人可以审阅、复现和贡献 | AIX 已发布、平台已上架、真机已通过 |
| AIX 构建或 GitHub Release | 一个具有版本、UUID、locale 和哈希的二进制候选 | 该候选可被单独检查 | AIUI 平台已经接收、所有设备都兼容 |
| Reader、Preview 或真机证据 | 绑定具体包和环境的验证记录 | 只支持对应证据等级的结论 | 自动授予源码或素材的再许可权 |
| AIUI 平台上传 | 将指定包提交到指定平台账号和流程 | 平台侧流程已被执行 | GitHub 仓库因此安全、合规或可复现 |

所以，`源码已开源`、`AIX 已生成`、`Reader 已通过`、`Rokid 真机已验证`、`AIUI 平台已上传` 应该是五条独立状态。任何一步完成，都不自动触发下一步。

## 谁可以怎么玩

一个好的开源仓库不只服务作者。以 AIUI Sports Agents 为例，可以按四种身份参与：

- **普通用户**：选择 Run、Bike 或 Rower，先看项目卡和兼容范围，再按说明体验模拟数据、Reader、Preview 或真机版本。
- **开发者**：修复解析器、状态机和 UI，或新增运动专项能力；同时补测试、数据来源和开放门。
- **评测者**：在固定版本、设备和协议条件下复测 Common 与 Sport 指标，不用一个模糊总分跨运动排名。
- **证据贡献者**：提交脱敏后的失败样例、真机摘要和结果卡，让“支持某设备”变成可核对的结论。

这四类参与者共用 `Common / Sport / Evidence` 三层玩法：

- **Common** 检查所有 AIUI 运动 Agent 的共同底线，例如数据诚实、生命周期、人因安全、隐私、离线和可复现性。
- **Sport** 检查跑步、骑行、划船机各自的专项指标；专项结果只在同一运动和相近硬件条件下比较。
- **Evidence** 说明结论由哪一级证据支撑，而不是给项目贴一个宣传标签。

## 第一步：写清楚准备公开什么

在复制任何文件前，先写一个公开范围。一个最小、可协作的 AIUI 源码仓库通常至少包含：

```text
README.md
LICENSE
CONTRIBUTING.md
SECURITY.md
PRIVACY.md
THIRD_PARTY_NOTICES.md
.gitignore
AGENTS.md                 # 若它属于公开运行契约
app.json
app.js
pages/
assets/                   # 只含权利已确认的资产
tests/
docs/
.github/workflows/        # 只放最小权限的验证流程
```

README 需要回答：项目解决什么问题、适用什么 AIUI 环境、怎样安装依赖和运行测试、哪些能力已验证、哪些仍未验证。不要只写一个演示效果，也不要把“能编译”写成“真机可用”。

同时决定哪些内容明确不公开：私有 Git 历史、内部 issue、聊天记录、构建缓存、AIX/APK、签名文件、现场原始日志、厂商固件、未授权 SDK 和来源不明的素材。若某个文件无法证明来源，默认排除，而不是默认放行。

## 第二步：选择许可证，但不要把许可证当成所有权证明

如果项目采用 Apache License 2.0，应在仓库根目录放置完整的 `LICENSE` 文本，并在 README 中说明适用范围。Apache-2.0 适合需要明确专利授权和宽松再使用条件的代码项目，但它只能覆盖你有权授权的作品。

以下内容不会因为根目录出现 Apache-2.0 就自动变成 Apache-2.0：

- 第三方依赖源码、SDK 和示例代码；
- 图片、字体、图标、GIF、音乐、视频和训练内容；
- 蓝牙规范正文、厂商说明书和固件；
- 真机照片、录屏、日志和真人运动数据；
- AI 生成但权利来源仍不清楚的资产。

在 `THIRD_PARTY_NOTICES.md` 中记录名称、版本或 commit、来源链接、原许可证、是否修改以及最终发布物是否包含。需要保留的版权和 NOTICE 必须一起保留。来源不明时，用原创占位、合成数据或外部链接替代。

Apache 官方也要求在将许可证应用到作品时使用对应声明，并把方括号中的年份和权利人替换为真实信息。许可证选择会产生法律后果；不确定的第三方内容应先获得权利确认，而不是靠 README 免责声明解决。

## 第三步：先做数据和凭据盘点

AIUI 运动项目容易同时触碰健康、位置和设备数据。公开前至少逐类检查：

| 风险类别 | 常见内容 | 公开处理 |
| --- | --- | --- |
| 凭据 | API key、token、Cookie、密码、私钥、证书、签名口令 | 不进入源码、日志、截图或提交历史；运行时通过安全配置注入 |
| 健康与运动 | 心率、功率、配速、运动时长、训练计划 | 优先使用合成夹具；真人数据只保留最少、已同意且已脱敏的摘要 |
| 位置与轨迹 | GPS、地图、起终点、时间模式 | 默认不公开；删除元数据也要检查截图和视频画面 |
| 设备标识 | MAC 地址、序列号、稳定 UUID、账号 ID | 用本次测试随机别名，例如 `bike-a`、`hrs-b` |
| 现场证据 | BLE/IMU 原始包、录屏、照片、环境声音 | 原件留在受控环境；公开最小片段和结构化结果 |
| 基础设施 | 内网域名、测试服务器、数据库地址、开发机绝对路径 | 改为安全占位符，并确认应用默认离线或明确 opt-in |

`.env` 加进 `.gitignore` 只是最后一道防误操作，不是脱敏方案。还要检查历史、测试夹具、错误快照、打包脚本、注释、文档和媒体元数据。

如果真实 key 曾经进入任何 commit，应先在服务端撤销或轮换，再处理代码与历史。只删除当前文件并不能让旧提交中的 key 失效；也不要把泄漏值粘贴到公开 issue 里讨论。

## 第四步：使用白名单导出，不要直接推整个工作目录

首次开源最稳妥的方式是新建一个暂存树，只复制明确允许的文件。下面的命令使用占位路径，不包含任何真实账号或凭据：

```bash
SOURCE_DIR="<PATH_TO_PRIVATE_WORKING_COPY>"
STAGE_DIR="$(mktemp -d)"

mkdir -p "$STAGE_DIR"
git -C "$SOURCE_DIR" archive --format=tar HEAD \
  README.md LICENSE CONTRIBUTING.md SECURITY.md PRIVACY.md \
  THIRD_PARTY_NOTICES.md .gitignore AGENTS.md app.json app.js \
  pages tests docs package.json package-lock.json \
  .github/workflows \
  | tar -x -C "$STAGE_DIR"
```

这段命令的重点不是文件名本身，而是“从允许清单开始”。每个项目应根据真实结构调整清单；没有某个文件时先补齐或删掉对应条目。不要把整个目录复制后寄希望于 `.gitignore` 帮你兜底，也不要复制原私有仓库的 `.git`。

对于 `assets/`，建议逐个登记并复制已确认的文件，而不是一次导出整个目录。AIX、APK、固件、证书、`node_modules`、缓存、数据库、录屏、原始 captures 和 release 目录应走单独的发布决策。

## 第五步：在暂存树里重新检查和测试

先看最终文件面，而不是看原工作区：

```bash
cd "$STAGE_DIR"

find . -type f -size +10M -print
find . -type f \( -name '*.aix' -o -name '*.apk' -o -name '*.zip' \
  -o -name '*.pem' -o -name '*.p12' -o -name '*.keystore' \
  -o -name '.env*' \) -print

rg -n --hidden -g '!.git' \
  '(api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key|BEGIN .* PRIVATE KEY)' .

LOCAL_HOME_PATH="$(cd && pwd)"
rg -n --hidden -g '!.git' -F "$LOCAL_HOME_PATH" .
rg -n --hidden -g '!.git' '(localhost|internal\.example)' .
```

搜索命中不一定就是泄漏，但每一条都必须人工判断。用于说明配置格式的占位符应明确写成 `<API_KEY>`、`${API_TOKEN}` 等不可用值，不能使用看起来像真实凭据的长随机串。

然后只在暂存树重新安装依赖和运行仓库真实提供的命令，例如：

```bash
node --version
npm ci
npm test
npm run validate
```

如果项目没有某条脚本，不要用“同类命令已运行”代替。记录实际命令、工具版本、通过、失败和跳过项。构建如果借用了私有工作区的 `node_modules`、缓存或本地服务，就还不能证明公开快照可复现。

## 第六步：用 L1–L5 写诚实证据

AIUI 项目的验证应逐级声明：

| 等级 | 最低证据 | 可以说 | 不能顺带说 |
| --- | --- | --- | --- |
| L1 | 固定输入的自动化测试 | 解析器、算法和错误分支按这些测试工作 | AIUI 宿主或真机可用 |
| L2 | AIX、Reader/Preview、包体和 SHA-256 | 这个具体包能被对应工具读取或预览 | BLE、IMU、按键和真机生命周期通过 |
| L3 | 指定版本的 Craft、InkView 或宿主集成记录 | 所列宿主流程可复现 | 真实眼镜和外设持续流通过 |
| L4 | Rokid 真机与真实外设 | 这个包在所列型号、固件和 AIUI host build 上通过 | 其他设备、固件或长时间场景同样通过 |
| L5 | 完整现场会话与参考设备对照 | 指定场景下的误差、失败率和闭环表现 | 医疗有效性或未覆盖环境的泛化结论 |

L2 以上应绑定 AIX 文件名、版本、locale、UUID 和 SHA-256；L4 还要记录眼镜型号、固件、AIUI host build、外设类别、持续时间与失败场景。公开材料不保留设备地址、序列号、账号和精确位置。

一条合格声明可以是：“commit `<COMMIT_ID>` 的解析器通过 42 个合成与错误样本，当前为 L1；Reader、Rokid 真机和真实外设仍未验证。”这比一句“全平台支持”更能帮助下一位贡献者。

## 第七步：在第一次提交前保护提交邮箱

Git commit 会记录作者邮箱。若不希望个人邮箱出现在公开历史中，先在 GitHub 的 **Settings → Emails** 开启邮箱隐私，并从该页面取得 GitHub 实际提供的 `noreply` 地址；不要自行猜测格式。

只给当前公开候选设置身份，避免意外影响其他仓库：

```bash
git init -b main
git config user.name "<GITHUB_DISPLAY_NAME>"
git config user.email "<GITHUB_NOREPLY_EMAIL>"
git var GIT_AUTHOR_IDENT
```

确认输出中没有私人邮箱后再提交。GitHub 的说明明确指出，新配置只影响未来提交；旧 commit 仍保留原邮箱。因此首次公开时不要直接搬运带私人邮箱的旧历史，优先从干净快照创建新的公开历史。

## 第八步：检查暂存区，再创建 GitHub 仓库

先完成本地提交：

```bash
git add --all
git status --short
git diff --cached --stat
git diff --cached
git commit -m "chore: publish initial open-source snapshot"
```

`git diff --cached` 是最后一次逐行看“究竟会公开什么”。确认后再登录 GitHub CLI：

```bash
gh auth status
gh auth login --hostname github.com --web --git-protocol https
gh auth status
```

不要把 token 作为命令参数、聊天内容或 shell 历史的一部分。浏览器或设备授权完成后，创建空的公开仓库并核对远端：

```bash
gh repo create "<OWNER>/<REPO>" \
  --public \
  --source=. \
  --remote=origin

git remote -v
git push -u origin main
```

GitHub 官方也支持给 `gh repo create` 增加 `--push`，但把“创建远端”和“首次推送”拆开，更方便在中间复核 remote、分支和最终提交。

### 遇到 workflow scope 错误怎么办

如果提交中包含 `.github/workflows/`，使用 OAuth 或 classic token 时可能看到“没有 `workflow` scope，拒绝创建或更新 workflow”的错误。GitHub 将 `workflow` 定义为添加或更新 Actions workflow 文件的独立 OAuth scope。对 GitHub CLI 保存的当前账号，可以重新授权：

```bash
gh auth refresh --hostname github.com --scopes workflow
gh auth status
git push -u origin main
```

只在确实需要提交 workflow 时申请该权限，并在授权页面核对账号和范围。若使用 fine-grained token，应给目标仓库最小必要的 Contents/Workflows 写权限；不要为了省事改成无限期、全仓库、全权限 token。

这里还有另一组容易混淆的权限：workflow 文件在本地推送所需的账号 token 权限，与 workflow 运行时使用的 `GITHUB_TOKEN` 权限不是一回事。运行时应在 YAML 中显式使用最小权限，例如纯验证任务通常只需要：

```yaml
permissions:
  contents: read
```

第三方 Action 最稳妥的固定方式是经核验后使用完整 commit SHA，例如 `actions/checkout@<FULL_COMMIT_SHA>`。不要把真实部署凭据直接写入 YAML；确需自动化时使用 GitHub Secrets，并让每个 job 只获得完成任务所需的最小权限。

## 第九步：上传后再做一次公开面核验

首次 push 成功不代表开源工作结束。检查公开仓库，而不是只看本地：

```bash
gh repo view "<OWNER>/<REPO>" --web
gh run list --repo "<OWNER>/<REPO>"
git ls-remote --heads origin
```

逐项确认 README、LICENSE、贡献和安全入口可以打开，Actions 使用公开快照重新运行且结果真实，提交作者没有暴露私人邮箱，仓库中没有本机绝对路径或内部地址。

然后进入仓库设置检查安全能力。不要声称某项已经开启，除非你在当前仓库实际确认过：

1. **Secret scanning**：GitHub 当前会对公开仓库自动运行受支持模式的 secret scanning，但仍要检查 Security 页面中的告警；通用模式和 AI 检测是否可用、是否启用，应以仓库当前页面为准。
2. **Push protection**：到 **Settings → Security and quality → Advanced Security** 检查并按需启用仓库级 push protection。它用于在敏感信息进入历史前阻止 push；不要把“用于测试”当成随意绕过的理由。
3. **Private vulnerability reporting**：同一设置页可检查并启用。启用后，研究者可以通过仓库的私密漏洞报告入口联系维护者，而不是在公开 issue 中暴露细节。
4. **分支保护或 ruleset**：至少考虑要求 PR、通过状态检查、解决 review conversation，并限制强推和删除默认分支。
5. **Actions 权限**：检查允许的 Actions 来源以及默认 `GITHUB_TOKEN` 权限；验证型 workflow 通常保持只读。

`SECURITY.md` 与 Private vulnerability reporting 是互补关系：前者说明支持版本和响应规则，后者提供私密通道。Secret scanning 和 push protection 也不是本地审计的替代品，因为它们只能发现被支持的模式和已经到达检测面的内容。

## 第十步：把贡献规则写成可执行门

建议在 `CONTRIBUTING.md` 和 PR 模板中至少要求：

```text
Scope: run | bike | rower | common | docs
Source-Revision: <COMMIT_ID>
Tests: <ACTUAL_COMMANDS_AND_RESULTS>
Evidence-Level: L1 | L2 | L3 | L4 | L5
Evidence-Ref: <SANITIZED_REFERENCE_OR_NONE>
Data-Source: measured | estimated | unavailable
Third-Party-Changes: <SOURCE_LICENSE_AND_MODIFICATIONS_OR_NONE>
Privacy-Impact: <DATA_FLOW_CHANGE_OR_NONE>
Open-Gates: <UNVERIFIED_DEVICE_COMPATIBILITY_OR_RELEASE_GATES>
```

共同规则可以简化为：

- 一个 PR 解决一个清晰问题，不顺带提交缓存、包和无关格式化。
- 新协议、权限、网络、持久化、健康字段和设备控制先写设计与数据流。
- 解析器、算法和状态机至少有确定性测试与错误样本。
- 数据拿不到就显示 unavailable；estimated 不能包装成 measured。
- Preview 不等于真机，订阅成功不等于收到合法首包。
- 真机证据绑定版本、包、设备、固件和 host，不使用稳定设备标识。
- 第三方代码和资产同时提交来源、许可证、修改和再分发说明。
- 安全漏洞和个人数据走私密通道，不放公开 issue 或 PR。
- 默认离线；任何上传都要针对具体目的显式 opt-in，并提供关闭和删除路径。

对于运动 Agent，还要坚持跨项目只比较 Common，Run、Bike、Rower 的 Sport 分只在同一运动中比较。涉及现实器械控制的功能不能作为普通 UI PR 进入；必须另有协议契约、威胁模型、明确操作确认和回滚策略。

## 第十一步：源码公开之后，怎样发布 AIX

当源码仓库稳定后，可以单独准备 AIX 发布候选，但仍需重新检查实际包内容：

1. 固定 source commit、语义版本和 locale。
2. 生成独立包身份，记录 AIX 文件名、UUID、大小和 SHA-256。
3. 检查包内没有测试、日志、旧包、凭据和多余素材。
4. 分别记录 Reader/Preview、Craft/宿主、Rokid 真机与现场对照结果。
5. 在 Release Notes 中列出失败、跳过、兼容范围和开放门。
6. 明确决定 AIX 是否适合放 GitHub Releases；源码许可证并不自动覆盖包内所有第三方内容。

AIUI 平台上传仍是另一项操作：使用哪个账号、上传哪个精确包、填写哪些平台字段、是否提交审核，都应以平台当时的界面和规则为准，并获得一次明确授权。GitHub Actions 不应因为 main 分支更新就默认上传平台或安装到设备。

## 如果已经发现泄漏

一旦发现真实 key、证书、个人数据或未授权材料已进入公开历史，处理顺序应是：

1. 立即撤销或轮换凭据，先控制真实风险。
2. 暂停发布与自动化，确认受影响范围。
3. 从当前树和 Git 历史移除敏感内容，或重新生成干净公开快照。
4. 检查 fork、Release、Actions 日志、缓存和外部镜像是否还有副本。
5. 通过私密安全流程记录和协调披露；不要在公开 issue 重复敏感值。
6. 重新运行本地扫描、测试和公开面核验后再恢复发布。

历史清理不能让已泄漏凭据重新安全，所以“轮换凭据”必须在“美化 Git 历史”之前。

## 一张可直接照着走的检查表

公开前：

- [ ] 源码、AIX、Reader/真机证据、AIUI 平台上传已分开定义。
- [ ] 公开候选来自白名单暂存树，没有复制原私有 `.git`。
- [ ] Apache-2.0 只覆盖有权授权的作品，第三方内容已登记。
- [ ] 固件、SDK、AIX/APK、证书、日志、缓存和未授权素材已排除。
- [ ] key、token、私钥、健康数据、轨迹、设备标识和本机路径已检查。
- [ ] 提交邮箱已设置为 GitHub 实际提供的 `noreply` 地址。
- [ ] 测试只在干净公开候选中运行，命令和失败项已记录。
- [ ] 结论按 L1–L5 声明，没有把 Preview 写成真机通过。
- [ ] `git diff --cached` 已由发布者逐行复核。

公开后：

- [ ] 远端、默认分支、README、LICENSE 与 Actions 结果已核验。
- [ ] Secret scanning、push protection 和私密漏洞报告的当前状态已实际检查。
- [ ] Actions 使用最小 `GITHUB_TOKEN` 权限，第三方 Action 已评估和固定。
- [ ] 分支保护、PR 规则与安全响应入口已建立。
- [ ] AIX Release 和 AIUI 平台上传仍由独立发布决定控制。

## 官方参考

- [GitHub：将本地代码添加到 GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)
- [GitHub CLI：刷新授权范围](https://cli.github.com/manual/gh_auth_refresh)
- [GitHub：OAuth scopes 与 workflow 权限](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [GitHub：设置提交邮箱](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
- [GitHub：Secret scanning 告警](https://docs.github.com/en/code-security/concepts/secret-security/about-alerts)
- [GitHub：Push protection](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)
- [GitHub：配置私密漏洞报告](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
- [GitHub：安全使用 Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- [Apache License 2.0 正文与应用说明](https://httpd.apache.org/docs/2.4/en/license.html)

真正成熟的 AIUI 开源项目，不是“代码已经上传”这么简单。它应该让普通用户知道能怎么玩，让开发者知道改动边界，让评测者知道结论如何复现，也让证据贡献者知道什么可以公开。代码、包、平台和证据各自过门，开源才会从一次上传变成一套可以长期协作的产品方法。
