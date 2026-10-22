#!/usr/bin/env python3
"""BLF-1429 图集体积收口：把整页截图裁到高度上限并转 256 色 PNG。

为什么需要这一步：本 Stage 的验收矩阵是 6 页 × 5 宽度 × 2 主题 × before/after
= 120 张整页图。改造前的 `/event` 会把全部事件一次渲染出来，1440 宽就有
10495px 高、1280 宽 13959px（高度记在 `catalog-before.json` 里），单张 2.7MB ——
直接入库会同时踩两条硬约束：单张 ≤ 800KB、总量 ≤ 20MB。

口径：
  · 只裁 `before`（--crop-suffix），`after` 保留整页 —— 后者才是本 Stage 的交付物；
  · 裁剪只截**顶部**、不缩放：before/after 的页头、KPI、表格头仍在同一比例下可直接对照，
    被截掉的是改造前那条「所有事件一次铺开」的超长列表；
  · 真实页高不丢：`catalog-before.json` 的 `pageHeight` 与 `shrink-report.json` 的
    `originalHeight` 都记着，评论里引用的也是这两个数；
  · 量化用中位切分 + Floyd–Steinberg 抖动，UI 截图（大面积平色 + 细文字）在 256 色下
    肉眼无差，体积约降到 1/3。

用法：
  python3 scripts/av-artifact-shrink.py artifacts/blf1422 \
      --crop-suffix before --crop-max-height 3000

依赖 Pillow（本机 python3 已装；只用于验收产物，不进 CI）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="整页截图裁剪 + 256 色量化")
    parser.add_argument("directory", type=Path, help="截图目录（如 artifacts/blf1422）")
    parser.add_argument("--crop-suffix", default="", help="只裁这个后缀（before / after），空 = 都不裁")
    parser.add_argument("--crop-max-height", type=int, default=0, help="裁剪后的最大高度（px），0 = 不限")
    parser.add_argument("--colors", type=int, default=256, help="量化色数（默认 256）")
    parser.add_argument("--min-bytes", type=int, default=60 * 1024, help="小于这个体积的图跳过量化")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.directory.is_dir():
        raise SystemExit(f"目录不存在：{args.directory}")
    if args.crop_suffix not in ("", "before", "after"):
        raise SystemExit("--crop-suffix 只能是 before / after / 空")

    report = []
    for path in sorted(args.directory.glob("*.png")):
        original_bytes = path.stat().st_size
        with Image.open(path) as opened:
            image = opened.convert("RGB")
        original_size = image.size
        cropped = False
        if (
            args.crop_suffix
            and path.name.endswith(f"-{args.crop_suffix}.png")
            and args.crop_max_height > 0
            and image.height > args.crop_max_height
        ):
            image = image.crop((0, 0, image.width, args.crop_max_height))
            cropped = True

        changed = cropped
        if original_bytes >= args.min_bytes:
            image = image.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
            changed = True
        if changed:
            image.save(path, optimize=True)

        final_bytes = path.stat().st_size
        report.append(
            {
                "file": path.name,
                "originalWidth": original_size[0],
                "originalHeight": original_size[1],
                "cropped": cropped,
                "finalWidth": image.width,
                "finalHeight": image.height,
                "originalBytes": original_bytes,
                "finalBytes": final_bytes,
            }
        )
        if cropped:
            print(f"{path.name}: {original_size[1]}px → {image.height}px, {original_bytes // 1024}KB → {final_bytes // 1024}KB")
        else:
            print(f"{path.name}: {original_bytes // 1024}KB → {final_bytes // 1024}KB")

    total = sum(item["finalBytes"] for item in report)
    biggest = max(report, key=lambda item: item["finalBytes"], default=None)
    report_path = args.directory / "shrink-report.json"
    report_path.write_text(
        json.dumps(
            {
                "count": len(report),
                "totalBytes": total,
                "totalMB": round(total / 1e6, 2),
                "maxBytes": biggest["finalBytes"] if biggest else 0,
                "maxFile": biggest["file"] if biggest else None,
                "files": report,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n{len(report)} 张，合计 {total / 1e6:.2f}MB，最大 {biggest['finalBytes'] // 1024}KB（{biggest['file']}）")
    print(f"报告：{report_path}")
    return 0 if total <= 20_000_000 and (biggest is None or biggest["finalBytes"] <= 800 * 1024) else 1


if __name__ == "__main__":
    raise SystemExit(main())
