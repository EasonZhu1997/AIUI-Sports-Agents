# 三套运动 Agent 源码

本目录把跑步、骑行与划船机三套 AIUI 应用集成在一个公开主仓中，方便统一浏览、测试和评测：

| 目录 | 应用 | 主要数据通道 |
| --- | --- | --- |
| [`smartrun/`](smartrun/) | AISmartRun | HRS / RSC / 眼镜 IMU |
| [`aibike/`](aibike/) | AIBike | HRS / CSC / CPS / FTMS / 眼镜 IMU |
| [`aismartrower/`](aismartrower/) | AISmartRower | FTMS Rower Data / HRS |

“集成”指同一个 GitHub 仓库、同一个项目入口与同一套证据治理，不表示把三种运动硬合成一个运行时。每套应用仍有独立页面状态机、协议解析、测试、AIX 构建和真机开放门。

## 许可证边界

仓库根目录的 Apache-2.0 **不覆盖** `apps/` 下的应用源码。每个应用目录均带有自己的 `LICENSE`、`COPYRIGHT` 和 `COMMERCIAL_LICENSE.md`：

- 免费使用仅限 PolyForm Noncommercial 1.0.0 允许的非商业目的；
- 商业使用必须在开始前取得权利人的单独书面商业许可；
- 第三方依赖与素材继续受各自条款约束；
- 具体文件如有更明确的许可证声明，以该声明为准。

这些应用源码属于 source-available，不是 OSI 定义的开源软件。完整作用域见仓库根目录的 [`LICENSE_POLICY.md`](../LICENSE_POLICY.md)。

## 本地验证

进入具体应用目录后，按照该目录 README 使用锁文件安装依赖并运行测试。构建生成的 `.aix` 只保存在本地，不会由这些命令上传、安装、提审或上架。
