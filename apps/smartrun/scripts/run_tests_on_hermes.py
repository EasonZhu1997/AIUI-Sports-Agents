#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIUI_AISmartRun 测试入口。

入口名沿用 Stop hook 的 TEST_CMD 约定（python3 scripts/run_tests_on_hermes.py），
但本项目是 AIUI 眼镜端 JS 项目、没有 hermes 后端：实际在本机运行
`node --test test/*.spec.mjs`（node:test 内置框架，零依赖）。
测试失败原样透传退出码 —— 不吞错、不降级。
"""
import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
specs = sorted(glob.glob(os.path.join(ROOT, "test", "*.spec.mjs")))

if not specs:
    print("FAIL: test/ 下没有任何 *.spec.mjs", file=sys.stderr)
    sys.exit(1)

node = shutil.which("node")
if not node:
    print("FAIL: 找不到 node，可执行 `node --version` 检查 PATH", file=sys.stderr)
    sys.exit(1)

print("running %d spec files via node --test ..." % len(specs))
result = subprocess.run([node, "--test", *specs], cwd=ROOT)
sys.exit(result.returncode)
