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


if __name__ == "__main__":
    unittest.main()
