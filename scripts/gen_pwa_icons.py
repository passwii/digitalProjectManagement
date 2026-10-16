"""生成 PWA 光栅图标（BLF-1127/S6）。

源设计：web/app/icon.svg（深海军蓝底 + SHZK 印章）。
产物：web/public/icons/icon-192.png / icon-512.png（purpose any，圆角透明底）
     + icon-512-maskable.png（purpose maskable，全 bleed 底 + 中央安全区作画）
     + apple-touch-icon.png（iOS 主屏幕图标，180×180）。

maskable 安全区：Android 自适应图标遮罩最多裁掉四周各约 18%（圆形遮罩），
所以字母主体只占中央 ~64%，四周留纯色底——系统怎么裁都不会裁掉字母。

用法：python3 scripts/gen_pwa_icons.py（依赖 Pillow）
"""

from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "web", "public", "icons")

NAVY = (15, 39, 66, 255)  # #0F2742，与 manifest theme_color 同值
ICE = (140, 188, 255, 255)  # #8CBCFF
RING = (104, 174, 255, 90)  # 描边光晕，低透明度

# SHZK 使用 Verdana Bold。中文副标需要真实 CJK 字体：不能回退到 Pillow
# 内置位图字体（不含中文，会把品牌名渲染成缺字框）。
CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
    "/System/Library/Fonts/Verdana Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
CJK_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
]


class IconBuildError(Exception):
    """图标生成失败（字体缺失 / 作画异常 / 落盘失败）：main 里收敛成非零退出码。"""


def _px(value: float) -> int:
    """几何浮点数 → 像素整数。输入恒为内部常量算式（不可能出现非数字字符串），
    这里的 try 是静态规则的要求（unchecked-throwing-call-python），不是预期会抛。"""
    try:
        return int(value)
    except (ValueError, OverflowError) as e:
        raise IconBuildError(f"像素换算失败 {value!r}：{e}") from e


def load_font(size: int):
    for path in CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def load_cjk_font(size: int):
    for path in CJK_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise IconBuildError("未找到可用的中文字体（macOS STHeiti / Windows 微软雅黑 / Linux Noto Sans CJK）")


def draw_mark(draw: ImageDraw.ImageDraw, box: int, scale: float) -> None:
    """画 SHZK 字标、分隔线与中文品牌名（scale 缩放作画区）。"""
    cx = box / 2
    font = load_font(_px(box * 0.20 * scale))
    text = "SHZK"
    # 顶部基线：字母中心落在 44% 高度
    draw.text((cx, box * 0.43), text, font=font, fill=ICE, anchor="mm")
    # 元素分隔线
    lw, lh = box * 0.24 * scale, max(2, _px(box * 0.018 * scale))
    draw.rounded_rectangle(
        [cx - lw / 2, box * 0.60 - lh / 2, cx + lw / 2, box * 0.60 + lh / 2],
        radius=lh // 2,
        fill=(104, 174, 255, 165),
    )
    # 中文品牌名置于分隔线下方；maskable 版本也位于中心安全区内。
    label = "数科云办公"
    label_font = load_cjk_font(_px(box * 0.060 * scale))
    draw.text((cx, box * 0.72), label, font=label_font, fill=(214, 228, 249, 230), anchor="mm")


def make_any(size: int, *, transparent_corners: bool = True) -> Image.Image:
    """purpose any：圆角 navy 底；可选透明圆角外（manifest 主屏幕图标）。"""
    background = (0, 0, 0, 0) if transparent_corners else NAVY
    img = Image.new("RGBA", (size, size), background)
    draw = ImageDraw.Draw(img)
    r = _px(size * 0.22)
    draw.rounded_rectangle([0, 0, size, size], radius=r, fill=NAVY)
    # 内圈细线（与 icon.svg 的描边呼应）
    m = _px(size * 0.055)
    draw.rounded_rectangle(
        [m, m, size - m, size - m], radius=r - m, outline=RING, width=max(2, size // 128)
    )
    draw_mark(draw, size, 1.0)
    return img


def make_maskable(size: int) -> Image.Image:
    """purpose maskable：全 bleed 方底，作画只占中央 64%（安全区）。"""
    img = Image.new("RGBA", (size, size), NAVY)
    draw = ImageDraw.Draw(img)
    draw_mark(draw, size, 0.72)
    return img


def main() -> None:
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
    except OSError as e:
        print(f"建目录 {OUT_DIR} 失败：{e}", file=sys.stderr)
        sys.exit(1)
    targets = [
        ("icon-192.png", lambda: make_any(192)),
        ("icon-512.png", lambda: make_any(512)),
        ("icon-512-maskable.png", lambda: make_maskable(512)),
        ("apple-touch-icon.png", lambda: make_any(180, transparent_corners=False)),
    ]
    failed = False
    for name, build in targets:
        try:
            img = build()
        except (OSError, IconBuildError) as e:
            # 作画与落盘的 IO / 字体失败都在这里收敛：报出哪一个产物，
            # 以非零退出码结束（调用方与 CI 靠退出码判定，不靠 traceback 翻页）。
            print(f"生成 {name} 失败：{e}", file=sys.stderr)
            failed = True
            continue
        try:
            path = os.path.join(OUT_DIR, name)
            img.save(path, "PNG")
        except OSError as e:
            print(f"写入 {name} 失败：{e}", file=sys.stderr)
            failed = True
            continue
        print(f"wrote {path} ({img.size[0]}x{img.size[1]})")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
