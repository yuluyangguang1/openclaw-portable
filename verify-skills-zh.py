#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-skills-zh.py — 校验 openclaw-portable/skills-zh/ 与 skills-zh-manifest.json 一致。

用途：CI / 发布前完整性比对，确保便携包内 16 个中文技能未被篡改、缺失或混入多余文件。

退出码：
  0 = 完全一致
  1 = 存在差异（缺失 / 多余 / 内容或大小不符）
  2 = 无法运行（缺少 manifest 或 skills-zh 目录）

用法：
  python verify-skills-zh.py            # 默认：脚本所在目录为 openclaw-portable 根
  python verify-skills-zh.py <root>    # 指定根目录（含 skills-zh/ 与 skills-zh-manifest.json）
"""
import hashlib
import json
import os
import sys


def sha256_and_size(path: str):
    """Return (sha256, size) of the LF-normalized content.

    Normalization is mandatory for both values: git stores LF in blobs but
    materializes CRLF in the working tree when core.autocrlf=true (Windows).
    CI (Linux, autocrlf off) checks out LF. Recording the raw on-disk size
    alongside a normalized hash makes the two disagree by exactly one byte
    per line on Windows-authored files - the manifest must therefore store
    the normalized size too, so both platforms verify identically.
    """
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            normalized = chunk.replace(b"\r\n", b"\n")
            h.update(normalized)
            size += len(normalized)
    return h.hexdigest(), size


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    skills_dir = os.path.join(root, "skills-zh")
    manifest_path = os.path.join(root, "skills-zh-manifest.json")

    if not os.path.isdir(skills_dir):
        print(f"[ERROR] skills-zh 目录不存在: {skills_dir}", file=sys.stderr)
        return 2
    if not os.path.isfile(manifest_path):
        print(f"[ERROR] manifest 不存在: {manifest_path}", file=sys.stderr)
        return 2

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    expected = {e["path"]: e for e in manifest.get("files", [])}
    errors = []

    # 1) 比对清单中每一项是否真实存在且内容一致
    for rel, meta in expected.items():
        fp = os.path.join(skills_dir, rel)
        if not os.path.isfile(fp):
            errors.append(f"缺失: {rel}")
            continue
        digest, norm_size = sha256_and_size(fp)
        if norm_size != meta.get("size"):
            errors.append(f"大小不符: {rel} (清单 {meta.get('size')} / 实际 {norm_size})")
            continue
        if digest != meta.get("sha256"):
            errors.append(f"内容篡改: {rel} (sha256 不一致)")

    # 2) 反向扫描，找出清单之外的多余文件
    actual = set()
    for dirpath, _dirs, files in os.walk(skills_dir):
        for fn in files:
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, skills_dir).replace("\\", "/")
            actual.add(rel)
    for rel in sorted(actual - set(expected.keys())):
        errors.append(f"多余文件: {rel}")

    # 3) 输出结论
    print(f"清单记录: {manifest.get('file_count')} 文件 / {manifest.get('total_bytes')} 字节")
    print(f"实际扫描: {len(actual)} 文件")
    if errors:
        print("\n[FAIL] 发现以下差异:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("\n[PASS] skills-zh 与 manifest 完全一致，便携包技能完整性 OK。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
