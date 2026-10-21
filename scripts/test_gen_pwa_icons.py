import unittest

from PIL import Image

from scripts.gen_pwa_icons import make_any, make_maskable


class PwaIconLocalizationTest(unittest.TestCase):
    @staticmethod
    def _localized_label_pixels(image: Image.Image, top: float, bottom: float):
        width, height = image.size
        pixels = image.convert("RGBA")
        label_top = int(height * top)
        label_bottom = int(height * bottom)
        region = pixels.crop((0, label_top, width, label_bottom))
        label_pixels = region.tobytes()
        return [
            (offset // 4 % region.width, label_top + offset // 4 // region.width)
            for offset in range(0, len(label_pixels), 4)
            if label_pixels[offset] > 190
            and label_pixels[offset + 1] > 200
            and label_pixels[offset + 2] > 230
            and label_pixels[offset + 3] > 0
        ]

    def test_regular_icons_render_the_chinese_name_at_each_size(self):
        for size in (180, 192, 512):
            with self.subTest(size=size):
                self.assertTrue(self._localized_label_pixels(make_any(size), 0.70, 0.82))

    def test_maskable_icon_keeps_the_chinese_name_in_its_safe_area(self):
        icon = make_maskable(512)
        label_pixels = self._localized_label_pixels(icon, 0.64, 0.80)
        self.assertTrue(label_pixels)
        self.assertGreaterEqual(min(x for x, _ in label_pixels), int(icon.width * 0.18))
        self.assertLess(max(x for x, _ in label_pixels), int(icon.width * 0.82))
        self.assertGreaterEqual(min(y for _, y in label_pixels), int(icon.height * 0.18))
        self.assertLess(max(y for _, y in label_pixels), int(icon.height * 0.82))

    def test_apple_touch_icon_has_opaque_background_and_ios_size(self):
        icon = make_any(180, transparent_corners=False)
        self.assertEqual(icon.size, (180, 180))
        self.assertEqual(icon.getpixel((0, 0)), (15, 39, 66, 255))

    def test_maskable_icon_is_fully_opaque(self):
        """maskable 图标必须**每个像素都不透明**（BLF-1400）。

        曾经的坑：分隔线用 fill=(104,174,255,165)、中文名用 alpha=230，
        而 Pillow 的 ImageDraw 是**直接写像素**、不做 alpha 混合 ——
        于是这些像素的 alpha 变成 165/230，在全 bleed 底图中间留出一片
        “洞”（实测 611 + 334 个像素）。

        后果：maskable 图标会被 Android 自适应图标直接裁形状，alpha 洞
        会被系统用**自选颜色**补上（颜色不可控）；部分 Chrome 版本还会
        因此判定图标不合格，把 PWA 装机降级成带 Chrome 徽标的快捷方式。
        """
        alpha = make_maskable(512).getchannel("A")
        self.assertEqual(alpha.getextrema(), (255, 255))

    def test_any_icon_has_no_intermediate_alpha(self):
        """purpose any 的图标只允许「全透明」与「全不透明」两种像素。

        圆角外透明是对的（交给系统裁形状），但**中间值**说明作画时直接
        写了带 alpha 的颜色 —— Pillow 不做 alpha 混合，会在底上留洞。
        """
        for size in (192, 512):
            with self.subTest(size=size):
                alpha = make_any(size).getchannel("A")
                values = set(alpha.get_flattened_data())
                self.assertTrue(
                    values <= {0, 255},
                    f"any 图标出现了中间 alpha 值 {sorted(values - {0, 255})}",
                )


if __name__ == "__main__":
    unittest.main()
