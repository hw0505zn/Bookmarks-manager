# -*- coding: utf-8 -*-
"""
打包 Chrome 扩展为可上传到 Chrome Web Store 的 zip。

铁律：
  1. manifest.json 必须在 zip 根目录（本脚本已保证）
  2. 只装能跑的东西 —— .workbuddy/ store/ *.md *.py 一律排除

运行：python store/pack.py
输出：与项目同级的 shuqian-extension.zip

上传新版本前记得先递增 manifest.json 的 version，否则会被后台直接拒绝。
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(ROOT), "shuqian-extension.zip")

# 顶层文件白名单
ROOT_FILES = ["manifest.json", "service-worker.js"]
# 目录白名单
ROOT_DIRS = ["js", "popup", "options", "icons"]
# 扩展名黑名单（图标生成脚本等开发文件）
SKIP_EXT = {".py", ".md", ".zip", ".ps1", ".bat", ".log"}


def collect():
    items = []
    for f in ROOT_FILES:
        if not os.path.isfile(os.path.join(ROOT, f)):
            sys.exit(f"[错误] 缺少必需文件：{f}")
        items.append(f)
    for d in ROOT_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            sys.exit(f"[错误] 缺少必需目录：{d}")
        for dp, dns, fns in os.walk(base):
            dns[:] = [x for x in dns if not x.startswith(".")]
            for fn in sorted(fns):
                if fn.startswith(".") or os.path.splitext(fn)[1] in SKIP_EXT:
                    continue
                items.append(os.path.relpath(os.path.join(dp, fn), ROOT).replace(os.sep, "/"))
    return sorted(items)


def main():
    items = collect()
    if "manifest.json" not in items:
        sys.exit("[错误] manifest.json 不在包根目录")

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in items:
            z.write(os.path.join(ROOT, rel.replace("/", os.sep)), rel)

    # 上传前自检
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        assert "manifest.json" in names, "manifest.json 必须在根目录"
        assert not any(n.startswith((".workbuddy/", "store/")) for n in names), "包内混入开发目录"
        assert not any(n.endswith((".md", ".py")) for n in names), "包内混入开发文件"

    print(f"输出：{OUT}")
    print(f"文件数：{len(names)}   大小：{os.path.getsize(OUT)} bytes")
    print("--- 包内清单 ---")
    for n in names:
        print("  " + n)
    print("\n[自检通过] manifest.json 在根目录，无开发残留。")


if __name__ == "__main__":
    main()
