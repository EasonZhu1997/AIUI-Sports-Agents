#!/usr/bin/env python3
"""Lint the release BLE contract for required engineering decisions."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REQUIRED_HEADINGS = {
    "scope and sources": ("scope", "source"),
    "roles and runtime": ("role", "runtime"),
    "discovery": ("discovery", "scan", "advertis"),
    "gatt inventory": ("gatt", "service", "characteristic"),
    "data packets": ("packet", "field", "data"),
    "commands and responses": ("command", "response", "control"),
    "state and freshness": ("state", "fresh", "live"),
    "lifecycle and cleanup": ("lifecycle", "cleanup", "disconnect"),
    "errors and recovery": ("error", "recovery", "retry"),
    "security and privacy": ("security", "privacy", "pair"),
    "validation": ("validation", "test", "acceptance"),
}
FULL_UUID_RE = re.compile(
    r"(?i)(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])"
)
SHORT_UUID_RE = re.compile(r"(?i)(?<![0-9a-f])0x[0-9a-f]{4}(?![0-9a-f])")


def has_any(text: str, terms: tuple[str, ...]) -> bool:
    lower = text.lower()
    return any(term.lower() in lower for term in terms)


def lint(text: str) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    headings = [
        match.group(1).strip().lower()
        for match in re.finditer(r"(?m)^#{1,6}\s+(.+?)\s*$", text)
    ]
    lower = text.lower()

    for label, aliases in REQUIRED_HEADINGS.items():
        if not any(any(alias in heading for alias in aliases) for heading in headings):
            errors.append(f"missing section: {label}")
    if not ("central" in lower and "peripheral" in lower and "gatt" in lower):
        errors.append("roles must explicitly include Central, Peripheral, and GATT")
    if not (FULL_UUID_RE.search(text) or SHORT_UUID_RE.search(text)):
        errors.append("no canonical 16-bit or 128-bit UUID found")
    if not has_any(text, ("required", "optional", "必选", "可选")):
        errors.append("required versus optional capabilities are not distinguished")
    if not has_any(text, ("notify", "indicate", "read", "write")):
        errors.append("characteristic properties are not declared")

    field_groups = {
        "endianness": ("endian", "little-endian", "小端"),
        "signedness": ("signed", "unsigned", "uint", "sint", "有符号", "无符号"),
        "scale": ("scale", "resolution", "倍率", "分辨率"),
        "unit": ("unit", "单位"),
        "invalid/sentinel": ("invalid", "sentinel", "data not available", "无效值", "哨兵"),
        "reserved/RFU": ("reserved", "rfu", "保留位"),
    }
    for label, terms in field_groups.items():
        if not has_any(text, terms):
            warnings.append(f"field contract does not mention {label}")
    if not (has_any(text, ("subscribed", "subscription", "订阅成功"))
            and has_any(text, ("first valid", "first_valid", "first packet", "第一包", "首包"))):
        errors.append("subscription and first valid packet must be separate milestones")
    if not has_any(text, ("freshness", "last_valid", "stale", "silent", "新鲜度", "静默")):
        errors.append("freshness or silent-stream behavior is missing")
    if not has_any(text, ("generation", "epoch", "session id", "代次")):
        errors.append("late-callback generation/session guard is missing")
    if not (has_any(text, ("removeeventlistener", "remove listener", "listener"))
            and has_any(text, ("disconnect", "stopnotifications", "cleanup", "清理"))):
        errors.append("listener and connection cleanup ownership is incomplete")
    if has_any(text, ("control point", "控制点", "command")):
        if not (has_any(text, ("write ack", "transport", "写入回调", "传输确认"))
                and has_any(text, ("protocol response", "indication", "result code", "协议响应"))):
            warnings.append("control write acknowledgement is not separated from protocol result")
        if not has_any(text, ("timeout", "超时")):
            warnings.append("control procedure timeout is not specified")
        if not has_any(text, ("rollback", "roll back", "回退")):
            warnings.append("control rejection rollback is not specified")
    if not has_any(text, ("golden", "hex bytes", "test vector", "测试向量", "原始 bytes")):
        warnings.append("golden packet vectors are not specified")
    if not has_any(text, ("real-device", "real device", "真机", "hardware")):
        warnings.append("real-device acceptance is not specified")
    if "tbd" in lower:
        warnings.append(f"contract still contains {lower.count('tbd')} TBD markers")
    return errors, warnings


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: lint_ble_contract.py CONTRACT.md", file=sys.stderr)
        return 2
    contract = Path(sys.argv[1]).expanduser().resolve()
    if not contract.is_file():
        print(f"ERROR: contract not found: {contract}")
        return 2
    errors, warnings = lint(contract.read_text(encoding="utf-8"))
    for item in errors:
        print(f"ERROR: {item}")
    for item in warnings:
        print(f"WARN: {item}")
    print(f"SUMMARY: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
