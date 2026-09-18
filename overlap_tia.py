"""测量：内容高于视口（.wrap 被内容撑高）时，脱离文档流的版权行与卡片底边是否重叠。"""
from playwright.sync_api import sync_playwright

Q = r"""() => {
  const b = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect();
    return {y: r.y, b: r.bottom, h: r.height}; };
  return {vh: window.innerHeight, scrollH: document.documentElement.scrollHeight,
          brand: b('[data-login="brand"]'), card: b('[data-login="card"]'),
          hint: b('[data-login="hint"]'), submit: b('form button[type="submit"]')};
}"""

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome")
    for w, h in [(390, 844), (390, 500), (390, 470), (390, 440), (740, 360), (360, 568)]:
        ctx = br.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce")
        pg = ctx.new_page()
        pg.goto("http://127.0.0.1:3001/login", wait_until="networkidle")
        pg.wait_for_timeout(900)
        g = pg.evaluate(Q)
        gap_card = g["hint"]["y"] - g["card"]["b"]     # >0 = 版权行在卡片下方
        gap_btn = g["hint"]["y"] - g["submit"]["b"]    # >0 = 不压按钮
        print(f"{w}x{h}: scrollH={g['scrollH']} 视口={g['vh']} "
              f"卡片底={g['card']['b']:.1f} 版权行 top={g['hint']['y']:.1f} "
              f"与卡片底间隙={gap_card:+.1f}px 与按钮间隙={gap_btn:+.1f}px "
              f"{'⚠ 压住卡片' if gap_card < 0 else 'OK'}", flush=True)
        ctx.close()
    br.close()
