"""Tia 抽验：BLF-1130 / PR #29 登录页手机端（不依赖后端，只验几何与计算样式）。"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3001"
TOL = 1.0
results = []


def rec(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


GEOM = r"""() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return {x:r.x, y:r.y, w:r.width, h:r.height, b:r.bottom, rr:r.right}; };
  const css = (s, p) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : null; };
  const txt = (s) => ((document.querySelector(s)||{}).innerText||'').replace(/\s+/g,' ').trim();
  const texEl = document.querySelector('[data-login="brand"] > [aria-hidden]'); // .storyGrid（不读哈希类名）
  const tex = texEl && (() => { const c = getComputedStyle(texEl), r = texEl.getBoundingClientRect();
    return {w: Math.round(r.width), h: Math.round(r.height), size: c.backgroundSize,
            pos: c.position, z: c.zIndex, op: c.opacity}; })();
  const inFlowHint = (() => { // 横向越界元素（不含绝对定位的版权行）
    const vw = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('main *')).filter((e) => {
      const c = getComputedStyle(e), r = e.getBoundingClientRect();
      if (c.display === 'none' || c.visibility === 'hidden' || r.width <= 0) return false;
      return r.left < -0.5 || r.right > vw + 0.5; })
      .map((e) => `${e.tagName}.${(e.className||'').toString().slice(0,20)}`).slice(0, 4); })();
  return {
    vw: document.documentElement.clientWidth, vh: window.innerHeight,
    wrapDisplay: css('main','display'), wrapColor: css('main','backgroundColor'),
    brand: box('[data-login="brand"]'), card: box('[data-login="card"]'),
    hint: box('[data-login="hint"]'), submit: box('form button[type="submit"]'),
    phone: box('#login-phone'),
    hintPosition: css('[data-login="hint"]','position'),
    inputFont: parseFloat(css('#login-phone','fontSize')),
    inputFontPwd: parseFloat(css('#login-password','fontSize')),
    cardRadius: parseFloat(css('[data-login="card"]','borderTopLeftRadius')),
    cardPadTop: parseFloat(css('[data-login="card"]','paddingTop')),
    submitH: parseFloat(css('form button[type="submit"]','height')),
    storyBg: css('[data-login="brand"]','backgroundColor'),
    h1Visible: Array.from(document.querySelectorAll('main h1'))
      .filter((e) => getComputedStyle(e).display !== 'none').length,
    brandText: txt('[data-login="brand"]'), cardText: txt('[data-login="card"]'),
    pageText: txt('body'),
    texture: tex,
    inFlowHint: inFlowHint,
    scrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    scrollH: document.documentElement.scrollHeight,
    bodyOverflowX: css('body','overflowX'),
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")

    def geom(page):
        return page.evaluate(GEOM)

    # ---------- 390×844：核心交付 ----------
    ctx = browser.new_context(viewport={"width": 390, "height": 844},
                              reduced_motion="reduce")
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"{BASE}/login", wait_until="networkidle")
    pg.wait_for_timeout(900)
    g = geom(pg)

    off = (g["brand"]["y"] + g["card"]["b"]) / 2 - g["vh"] / 2
    rec("390×844 整组（品牌块+卡片）中点 = 视口中心", abs(off) <= TOL,
        f"整组中点={(g['brand']['y']+g['card']['b'])/2:.1f} 视口中心={g['vh']/2:.1f} 偏差={off:+.1f}px")
    rec("版权行脱离文档流 (absolute)", g["hintPosition"] == "absolute",
        f"position={g['hintPosition']}")
    rec("版权行在卡片之下、不压住卡片", g["hint"]["y"] >= g["card"]["b"] - TOL,
        f"版权行 top={g['hint']['y']:.1f} vs 卡片 bottom={g['card']['b']:.1f}")
    rec("版权行不压住主按钮", g["hint"]["y"] >= g["submit"]["b"] - TOL,
        f"版权行 top={g['hint']['y']:.1f} vs 按钮 bottom={g['submit']['b']:.1f}")
    rec("无任何可见元素横向越界（逐元素 right ≤ 视口宽）", len(g["inFlowHint"]) == 0,
        "越界: " + ", ".join(g["inFlowHint"]) if g["inFlowHint"] else "0 个元素越界")
    rec("输入框高 ≥44px", min(g["phone"]["h"], g["phone"]["h"]) >= 44, f"{g['phone']['h']:.1f}px")
    rec("输入框字号 = 16px（iOS 聚焦不放大）",
        g["inputFont"] >= 16 and g["inputFontPwd"] >= 16,
        f"手机号 {g['inputFont']}px / 密码 {g['inputFontPwd']}px")
    rec("首屏无纵向滚动 / 无横向溢出",
        g["scrollH"] <= g["vh"] + TOL and g["scrollW"] <= TOL,
        f"scrollHeight={g['scrollH']} 视口={g['vh']} 横向溢出={g['scrollW']}")
    rec("品牌资产保留：深色底 + 纹理铺满整页（46px）+ SHZK + 字标 + slogan",
        g["wrapColor"] == "rgb(13, 43, 78)" and bool(g["texture"])
        and "46px" in g["texture"]["size"] and g["texture"]["h"] >= g["vh"] * 0.6
        and g["texture"]["w"] >= g["vw"] * 0.95 and "SHZK" in g["cardText"]
        and "数科云办公" in g["brandText"] and "复杂有章" in g["brandText"],
        f"底色={g['wrapColor']} 纹理={g['texture']} 品牌块=「{g['brandText']}」")
    rec("桌面大标题 / 01-02-03 卖点行在手机端已删",
        g["h1Visible"] == 0 and "统一台账" not in g["pageText"] and "支出归集" not in g["pageText"],
        f"可见 h1={g['h1Visible']}")
    rec("无功能性 JS 异常", len(errs) == 0, "; ".join(errs[:2]))
    pg.screenshot(path="/tmp/tia-s2-390.png")

    # ---------- 软键盘（可视高压到 500px）----------
    pg.set_viewport_size({"width": 390, "height": 500})
    pg.wait_for_timeout(500)
    kb = geom(pg)
    rec("软键盘态(500px)：品牌块顶不越界 + 主按钮仍在可视区",
        kb["brand"]["y"] >= -TOL and kb["submit"]["b"] <= kb["vh"] + TOL,
        f"品牌块 top={kb['brand']['y']:.1f} 按钮底={kb['submit']['b']:.1f} 可视高={kb['vh']}")
    rec("软键盘态：版权行不与主按钮重叠",
        kb["hint"]["y"] >= kb["submit"]["b"] - TOL,
        f"版权行 top={kb['hint']['y']:.1f} vs 按钮底={kb['submit']['b']:.1f}")

    # ---------- 独立边界：内容高于视口时顶部必须可达（auto margin 的核心作用）----------
    pg.set_viewport_size({"width": 390, "height": 844})
    pg.goto(f"{BASE}/login", wait_until="networkidle")
    pg.set_viewport_size({"width": 740, "height": 360})   # 横屏小高度：内容 > 视口
    pg.wait_for_timeout(600)
    short = geom(pg)
    rec("内容高于视口时（740×360）顶部不被裁掉、可滚到底（auto margin 退化）",
        short["brand"]["y"] >= -TOL and short["scrollH"] > short["vh"]
        and short["brand"]["y"] - short["vh"] < short["vh"] * 0.2,
        f"品牌块 top={short['brand']['y']:.1f} scrollHeight={short['scrollH']} 视口={short['vh']}")

    # ---------- 360 窄屏 ----------
    pg.set_viewport_size({"width": 360, "height": 780})
    pg.wait_for_timeout(600)
    g360 = geom(pg)
    off360 = (g360["brand"]["y"] + g360["card"]["b"]) / 2 - g360["vh"] / 2
    rec("360×780 仍居中且无横向溢出", abs(off360) <= TOL and g360["scrollW"] <= TOL,
        f"偏差={off360:+.1f}px 横向溢出={g360['scrollW']}px")

    # ---------- 断点两侧 ----------
    pg.set_viewport_size({"width": 767, "height": 900})
    pg.wait_for_timeout(500)
    g767 = geom(pg)
    rec("767px 走手机分支", g767["inputFont"] >= 16 and g767["hintPosition"] == "absolute"
        and g767["h1Visible"] == 0 and g767["wrapDisplay"] == "flex",
        f"输入框={g767['inputFont']}px 版权行={g767['hintPosition']} h1={g767['h1Visible']} display={g767['wrapDisplay']}")
    pg.set_viewport_size({"width": 768, "height": 900})
    pg.wait_for_timeout(500)
    g768 = geom(pg)
    rec("768px 回桌面两栏、手机分支不泄漏",
        g768["inputFont"] <= 15.5 and g768["hintPosition"] == "static"
        and g768["h1Visible"] == 1 and g768["wrapDisplay"] == "grid",
        f"输入框={g768['inputFont']}px 版权行={g768['hintPosition']} h1={g768['h1Visible']} display={g768['wrapDisplay']}")

    # ---------- 桌面 ≥768px：与改动前源码常量逐项对账 ----------
    pg.set_viewport_size({"width": 1440, "height": 900})
    pg.wait_for_timeout(600)
    gd = geom(pg)
    src_expected = {
        "main.display": (gd["wrapDisplay"], "grid"),
        "卡片宽(源码 min(100%,430px))": (round(gd["card"]["w"], 1), 430.0),
        "卡片圆角(8px)": (gd["cardRadius"], 8.0),
        "卡片上内边距(34px)": (gd["cardPadTop"], 34.0),
        "输入框字号(15px)": (gd["inputFont"], 15.0),
        "输入框高(46px)": (round(gd["phone"]["h"], 1), 46.0),
        "主按钮高(46px)": (gd["submitH"], 46.0),
        "版权行 position(static)": (gd["hintPosition"], "static"),
        "可见 h1 数(1)": (float(gd["h1Visible"]), 1.0),
        "品牌栏底色(#0D2B4E)": (gd["storyBg"], "rgb(13, 43, 78)"),
        "品牌栏占比(1.15/2)": (round(gd["brand"]["w"] / gd["vw"], 4), 0.575),
    }
    bad = [f"{k}: 实测 {v[0]} / 期望 {v[1]}" for k, v in src_expected.items()
           if (v[0] != v[1] if isinstance(v[1], str) else abs(v[0] - v[1]) > TOL)]
    rec("1440px 桌面 11 项与改动前源码契约常量一致", not bad, "；".join(bad) or "11/11 一致")
    rec("1440px 卖点行与大标题文案仍在", "统一台账" in gd["pageText"] and gd["h1Visible"] == 1,
        f"可见 h1={gd['h1Visible']}")
    rec("1440px 网格纹理仍是 52px 且铺在品牌栏（手机 46px 未泄漏）",
        bool(gd["texture"]) and "52px" in gd["texture"]["size"],
        f"纹理={gd['texture']}")

    ctx.close()
    browser.close()

print(f"\n== {sum(results)} passed / {len(results) - sum(results)} failed ==")
sys.exit(0 if all(results) else 1)
