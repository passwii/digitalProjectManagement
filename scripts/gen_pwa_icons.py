"""生成 PWA 光栅图标（BLF-1127/S6）。

源设计：web/app/icon.svg（深海军蓝底 + SHZK 印章）。
产物：web/public/icons/icon-192.png / icon-512.png（purpose any，圆角透明底）
     + icon-512-maskable.png（purpose maskable，全 bleed 底 + 中央安全区作画）
     + apple-touch-icon.png（iOS 主屏幕图标，180×180）。

maskable 安全区：Android 自适应图标使用圆形遮罩，圆形安全区直径约为图标的 80%。
SHZK 与中文副标按原比例放大，并完整留在圆形安全区内；四周保留纯色 bleed 底。

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

# 分隔线与中文名的颜色（**不透明**）。
#
# 为什么不能带 alpha：Pillow 的 ImageDraw 画颜色时是**直接写像素**，
# 不是 alpha 混合 —— fill=(104,174,255,165) 会把那几个像素的 alpha 写成
# 165，而不是在底色上叠一层 65% 不透明的线。
#
# 后果对 maskable 图标是致命的：它的底本该**全 bleed 不透明**（Android
# 自适应图标会拿它裁形状），却在画面中间留出一片半透明的“洞”，
# alpha=165 的洞有 611 个像素、alpha=230 的 334 个（实测）。
# Android 补洞的颜色不可控，部分 Chrome 版本还会因此判定图标不合格，
# 把 PWA 装机降级成带 Chrome 徽标的快捷方式。
#
# 所以这里改成**先算好混合结果**（见 blend_on），再用不透明色作画。
LINE = (104, 174, 255, 255)  # 分隔线
LABEL = (214, 228, 249, 255)  # 中文品牌名


def blend_on(base: tuple[int, int, int, int], top: tuple[int, int, int, int]):
    """把带 alpha 的前景色合成到不透明底色上，返回**不透明**的结果。

    公式就是标准 source-over 混合（底色不透明时 alpha 恒为 255）：

        out = round(base * (1 - a) + top * a)

    为什么要手工算：Pillow 的 ImageDraw 不做 alpha 混合（见上面 LINE 的
    注释）。想要“半透明线叠在深蓝底上”的观感，就得自己算混合值。
    """
    alpha = top[3] / 255
    return tuple(
        round(base[index] * (1 - alpha) + top[index] * alpha) for index in range(3)
    ) + (255,)

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


def draw_mark(
    draw: ImageDraw.ImageDraw,
    box: int,
    *,
    base: tuple[int, int, int, int] = NAVY,
) -> None:
    """画 SHZK 字标、分隔线与中文品牌名，保留各自原字形比例。

    两个字号以 maskable 原布局（0.72）为基准：Latin 放大 1.60 倍，中文
    与分隔线放大 2.80 倍。垂直位置与选定预览一致，整组内容留在圆形安全区。

    `base` 是作画区底色：分隔线与中文名的半透明观感靠**预先混合**得到
    （见 blend_on），画上去的像素一律不透明 —— 底图不该出现 alpha 洞。
    """
    cx = box / 2
    latin_scale = 0.72 * 1.60
    detail_scale = 0.72 * 2.80
    draw.text(
        (cx, box * (218 / 512)),
        "SHZK",
        font=load_font(_px(round(box * 0.20 * latin_scale))),
        fill=ICE,
        anchor="mm",
    )
    # 元素分隔线
    lw = box * 0.24 * detail_scale
    lh = max(2, _px(round(box * 0.018 * detail_scale)))
    line_y = box * (292 / 512)
    draw.rounded_rectangle(
        [cx - lw / 2, line_y - lh / 2, cx + lw / 2, line_y + lh / 2],
        radius=lh // 2,
        fill=blend_on(base, (104, 174, 255, 165)),
    )
    # 中文品牌名置于分隔线下方，并完整落在 maskable 圆形安全区内。
    draw.text(
        (cx, box * (350 / 512)),
        "数科云办公",
        font=load_cjk_font(_px(round(box * 0.060 * detail_scale))),
        fill=blend_on(base, (214, 228, 249, 230)),
        anchor="mm",
    )


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
        [m, m, size - m, size - m],
        radius=r - m,
        # 描边同样预先混合：Pillow 不做 alpha 混合，直接写 alpha=90 会
        # 在圆角底上留出一条半透明的圈（与 maskable 的 alpha 洞同源问题）。
        outline=blend_on(NAVY, RING),
        width=max(2, size // 128),
    )
    draw_mark(draw, size, base=NAVY)
    return img


def make_maskable(size: int) -> Image.Image:
    """purpose maskable：全 bleed 方底，文字与分隔线留在中央圆形安全区内。

    底与作画都是**完全不透明**的：maskable 图标会被 Android 自适应图标
    直接裁形状，任何 alpha 洞都会被系统用自选颜色补上（颜色不可控），
    部分 Chrome 版本还会因此把装机降级成带 Chrome 徽标的快捷方式。
    """
    img = Image.new("RGBA", (size, size), NAVY)
    draw = ImageDraw.Draw(img)
    draw_mark(draw, size, base=NAVY)
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
