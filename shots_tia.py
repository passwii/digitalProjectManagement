"""同一环境下按视口截图 /login（reduced_motion=reduce，动画静帧）。"""
import sys
from playwright.sync_api import sync_playwright

TAG = sys.argv[1]
VIEWPORTS = [(1440, 900), (768, 900), (390, 844)]

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    for w, h in VIEWPORTS:
        ctx = b.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce")
        pg = ctx.new_page()
        pg.goto("http://127.0.0.1:3001/login", wait_until="networkidle")
        pg.wait_for_timeout(1200)
        pg.screenshot(path=f"/tmp/tia-{TAG}-{w}x{h}.png")
        print(f"shot {TAG} {w}x{h}", flush=True)
        ctx.close()
    b.close()
