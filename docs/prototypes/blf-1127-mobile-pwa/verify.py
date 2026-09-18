"""BLF-1127 手机端 PWA 原型自检。

在无头 Chrome 里真实点一遍交互，确认三件事都成立并留下截图：
  ① 登录页垂直居中（含软键盘抬起）
  ② 底部 Dock 导航（5 位、触控达标、贴底含安全区）
  ③ Dock 选中后的卡片 / 抽屉展开形态（peek ↔ half ↔ full ↔ 关闭）

跑法：python3 docs/prototypes/blf-1127-mobile-pwa/verify.py
依赖：本机已装 Google Chrome（用 channel="chrome"，不依赖 playwright install 的构建）。
"""

from __future__ import annotations

import pathlib
import sys

from playwright.sync_api import FloatRect, Locator, Page, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "index.html").as_uri()
SHOTS = ROOT / "shots"
SHOTS.mkdir(exist_ok=True)

TOL = 1.0  # 亚像素容差

errors: list[str] = []
results: list[str] = []


class Box:
    """bounding_box() 返回 Optional[FloatRect]，包一层让调用处拿到确定存在的盒模型。"""

    def __init__(self, raw: FloatRect | None, *, name: str) -> None:
        self.present = raw is not None
        self.name = name
        self._b: FloatRect = raw or {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}

    def __getitem__(self, k: str) -> float:
        return self._b[k]

    def bottom(self) -> float:
        return self._b["y"] + self._b["height"]

    def right(self) -> float:
        return self._b["x"] + self._b["width"]

    def center_y(self) -> float:
        return self._b["y"] + self._b["height"] / 2


def box_of(loc: Locator, name: str) -> Box:
    return Box(loc.bounding_box(), name=name)


def px(value: str) -> float:
    """把 '98px' 这类计算值转成数字；拿不到就返回 -1，让断言失败而不是抛异常。"""
    try:
        return float(value.removesuffix("px").strip())
    except (AttributeError, ValueError):
        return -1.0


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        errors.append(name)


# --------------------------------------------------------------------------- 原子测量
# 关键：页面会随交互滚动，先 bounding_box() 再比较会拿到过期坐标。
# 这里所有几何都进同一次 evaluate，在同一帧里量完。
GEOM = """() => {
  const r = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.y + b.height, rr: b.x + b.width };
  };
  return {
    screen: r('#screen'),
    statusbar: r('#sb-login'),
    sheet: r('#sheet'),
    scrim: r('#scrim'),
    dock: r('#dock'),
    card: r('.login-card'),
    phone: r('#phone'),
    loginBtn: r('#loginBtn'),
    hint: r('.login-hintline'),
    sheetCard: r('#sheetBody .pcard'),
    tab: r('#dock .tab'),
    scrollPad: getComputedStyle(document.querySelector('#scroll-dashboard')).paddingBottom,
    sheetCls: document.querySelector('#sheet').className,
    scrimCls: document.querySelector('#scrim').className,
    scrimPE: getComputedStyle(document.querySelector('#scrim')).pointerEvents,
    scrollY: window.scrollY,
  };
}"""


def geom(page: Page) -> dict:
    return page.evaluate(GEOM)


def goto_app(page: Page) -> None:
    page.click("#loginBtn")
    page.wait_for_timeout(900)


with sync_playwright() as p:
    # 用系统 Chrome：playwright 自带构建未安装时 channel="chrome" 仍可跑
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1360, "height": 1100}, device_scale_factor=2)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on(
        "console",
        lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.goto(URL)
    page.wait_for_timeout(600)

    # ======================================================== ① 登录页
    g = geom(page)
    check("登录卡片在手机框内", g["card"]["x"] >= g["screen"]["x"] - TOL
          and g["card"]["rr"] <= g["screen"]["rr"] + TOL)
    check("登录卡片左右留白对称",
          abs((g["card"]["x"] - g["screen"]["x"])
              - (g["screen"]["rr"] - g["card"]["rr"])) < 2)

    # 居中基准是「品牌块 + 表单卡」这组的中点。
    # 手机框顶部 42px 是模拟状态栏，不属于可布局区：拿整屏中心去比天生会差半个
    # 状态栏（实测 +20.5px），所以基准取「状态栏以下可用区」的中心。
    brand_top = page.evaluate("() => document.querySelector('.login-brand-block').getBoundingClientRect().top")
    group_center = (brand_top + g["card"]["b"]) / 2
    avail_center = (g["statusbar"]["b"] + g["screen"]["b"]) / 2  # 状态栏底边 = 可用区顶边
    check("登录「品牌块+表单卡」垂直居中于状态栏以下可用区",
          abs(group_center - avail_center) < TOL,
          f"group_center={group_center:.1f} avail_center={avail_center:.1f} dev={group_center - avail_center:+.1f}px")
    check("手机号输入框高度 >= 44px（触控达标）", g["phone"]["h"] >= 44, f"{g['phone']['h']:.0f}px")
    check("输入框字号 >= 16px（避免 iOS 聚焦自动放大）",
          page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('#phone')).fontSize)") >= 16)
    check("登录页首屏无滚动", page.evaluate(
        "() => document.querySelector('#view-login').scrollHeight <= window.innerHeight + 1"))
    check("提示行不参与居中（脱离文档流）",
          page.evaluate("() => getComputedStyle(document.querySelector('.login-hintline')).position") == "absolute")
    page.screenshot(path=str(SHOTS / "1-login.png"))

    page.click("#btnKeyboard")
    page.wait_for_timeout(450)
    gk = geom(page)
    check("键盘抬起后主按钮仍可见", gk["loginBtn"]["b"] <= gk["screen"]["b"] + TOL,
          f"btn_bottom={gk['loginBtn']['b']:.0f} screen_bottom={gk['screen']['b']:.0f}")
    check("键盘抬起后表单顶部不越过屏幕", gk["phone"]["y"] >= gk["screen"]["y"] - TOL)
    page.screenshot(path=str(SHOTS / "2-login-keyboard.png"))
    page.click("#btnKeyboard")
    page.wait_for_timeout(300)

    # 校验：错误手机号应被拦下，不进入 App
    page.fill("#phone", "123")
    page.click("#loginBtn")
    page.wait_for_timeout(200)
    check("非法手机号被拦下（不进入 App）", page.locator("#view-app").is_hidden())
    page.fill("#phone", "13800000001")

    # ======================================================== ② Dock
    goto_app(page)
    g = geom(page)
    check("登录后进入 App", page.locator("#view-app").is_visible())
    check("Dock 为 5 位", page.locator("#dock .tab").count() == 5,
          f"{page.locator('#dock .tab').count()} 位")
    check("Dock 标签为 工作台/项目/进度/支出/我的",
          page.locator("#dock .tab .lbl").all_inner_texts() == ["工作台", "项目", "进度", "支出", "我的"],
          str(page.locator("#dock .tab .lbl").all_inner_texts()))
    check("Dock 贴底", abs(g["dock"]["b"] - g["screen"]["b"]) < TOL,
          f"{g['dock']['b']:.1f} vs {g['screen']['b']:.1f}")
    check("Dock 满宽", abs(g["dock"]["w"] - g["screen"]["w"]) < TOL)
    check("Dock 高度 = 58 + 22 安全区", abs(g["dock"]["h"] - 80) < 0.6, f"{g['dock']['h']:.1f}px")
    check("Dock 触控高度 >= 44px", g["tab"]["h"] >= 44, f"{g['tab']['h']:.1f}px")
    check("Dock 触控宽度 >= 44px", g["tab"]["w"] >= 44, f"{g['tab']['w']:.1f}px")
    check("内容区底部留白 >= Dock 高度", px(g["scrollPad"]) >= 80, g["scrollPad"])
    check("工作台默认高亮",
          page.locator("#dock .tab[aria-current='true'] .lbl").inner_text().strip() == "工作台")
    check("App 视图无横向溢出元素", page.evaluate("""() => {
      const bad = [];
      document.querySelectorAll('#view-app *').forEach(e => {
        const ox = getComputedStyle(e).overflowX;
        if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2 && ox !== 'auto' && ox !== 'scroll')
          bad.push(String(e.className) + ' ' + e.scrollWidth + '>' + e.clientWidth);
      });
      return bad;
    }""") == [], "")
    page.screenshot(path=str(SHOTS / "3-dashboard.png"))

    # ======================================================== ③ 抽屉三态
    page.click("#dock .tab[data-tab='projects']")
    page.wait_for_timeout(500)
    g = geom(page)
    peek_h = g["sheet"]["h"]
    check("点 Dock 后抽屉打开（peek）", "peek" in g["sheetCls"] and peek_h > 100, f"h={peek_h:.0f}")
    check("peek 高度 <= 240（不抢内容）", peek_h <= 240, f"{peek_h:.0f}")
    check("peek 态无遮罩", "on" not in g["scrimCls"] and g["scrimPE"] == "none",
          f"{g['scrimCls']} / {g['scrimPE']}")
    check("peek 抽屉内首张卡片完整可见",
          g["sheetCard"] is not None
          and g["sheetCard"]["y"] >= g["sheet"]["y"] - TOL
          and g["sheetCard"]["b"] <= g["sheet"]["b"] + TOL,
          f"card_bottom={0 if not g['sheetCard'] else g['sheetCard']['b']:.0f} sheet_bottom={g['sheet']['b']:.0f}")
    check("抽屉内含卡片", page.locator("#sheetBody .pv, #sheetBody .pcard").count() >= 2,
          f"{page.locator('#sheetBody .pv, #sheetBody .pcard').count()} 张")
    check("项目 Dock 高亮", page.locator("#dock .tab[data-tab='projects']").get_attribute("aria-current") == "true")
    page.screenshot(path=str(SHOTS / "4-projects-sheet-peek.png"))

    # 上拖升档
    head = box_of(page.locator("#sheetHead"), "sheetHead")
    hx, hy = head["x"] + head["width"] / 2, head["y"] + head["height"] / 2
    page.mouse.move(hx, hy)
    page.mouse.down()
    page.mouse.move(hx, hy - 420, steps=12)
    page.mouse.up()
    page.wait_for_timeout(500)
    g = geom(page)
    check("上拖后抽屉升档", g["sheet"]["h"] > peek_h, f"{peek_h:.0f} → {g['sheet']['h']:.0f}")
    check("升档后有遮罩", "on" in g["scrimCls"])
    check("遮罩可接收点击（pointer-events 已恢复）", g["scrimPE"] != "none", g["scrimPE"])
    page.screenshot(path=str(SHOTS / "5-projects-sheet-full.png"))

    # 再点当前 Dock → 降回 peek
    page.click("#dock .tab[data-tab='projects']")
    page.wait_for_timeout(450)
    g = geom(page)
    check("再点当前 Dock 降回 peek", "peek" in g["sheetCls"], g["sheetCls"])
    check("降回 peek 后遮罩关闭", "on" not in g["scrimCls"], g["scrimCls"])

    # 点遮罩关闭（peek 态点遮罩区域）
    page.click("#dock .tab[data-tab='projects']")
    page.wait_for_timeout(450)
    g = geom(page)
    page.mouse.click(g["screen"]["x"] + g["screen"]["w"] / 2, g["screen"]["y"] + 60)
    page.wait_for_timeout(650)
    g = geom(page)
    check("点当前 Dock 关闭抽屉（peek → 收起）", "closed" in g["sheetCls"], g["sheetCls"])

    # 全屏档：几何必须整帧量
    page.click("#dock .tab[data-tab='projects']")
    page.wait_for_timeout(450)
    page.click("[data-jump='full']")
    page.wait_for_timeout(700)
    g = geom(page)
    check("全屏抽屉贴底", abs(g["sheet"]["b"] - g["screen"]["b"]) < TOL,
          f"{g['sheet']['b']:.1f} vs {g['screen']['b']:.1f}")
    check("全屏抽屉不遮状态栏", g["sheet"]["y"] - g["screen"]["y"] >= 40,
          f"顶部留白 {g['sheet']['y'] - g['screen']['y']:.0f}px")
    check("全屏抽屉几乎占满屏幕", g["sheet"]["h"] >= g["screen"]["h"] - 60, f"h={g['sheet']['h']:.0f}")
    page.screenshot(path=str(SHOTS / "6-projects-sheet-fullscreen.png"))

    # ======================================================== 详情（第二层）
    page.click("#dock .tab[data-tab='projects']")
    page.wait_for_timeout(450)
    page.locator("#sheetBody .pcard").first.click()
    page.wait_for_timeout(500)
    check("点卡片进入详情并隐藏 Dock", page.locator("#dock").is_hidden())
    check("详情有底部操作条", page.locator("#detailActions").is_visible())
    page.screenshot(path=str(SHOTS / "7-detail.png"))
    page.click("#btnDetailBack")
    page.wait_for_timeout(350)
    check("详情返回后 Dock 恢复", page.locator("#dock").is_visible())

    # ======================================================== 「我的」与权限
    page.click("#dock .tab[data-tab='mine']")
    page.wait_for_timeout(550)
    g = geom(page)
    check("「我的」默认半屏抽屉", g["sheet"]["h"] > peek_h, f"h={g['sheet']['h']:.0f}")
    check("普通用户看不到管理与审批入口", "审批中心" not in page.locator("#sheetBody").inner_text())
    page.screenshot(path=str(SHOTS / "8-mine-user.png"))

    page.click("#btnAdmin")
    page.wait_for_timeout(650)
    check("管理员视角出现审批中心", "审批中心" in page.locator("#sheetBody").inner_text())
    check("管理员视角出现系统管理", "系统管理" in page.locator("#sheetBody").inner_text())
    check("管理员 Dock 出现待办红点", page.locator("#dock .badge-dot").count() >= 1)
    page.screenshot(path=str(SHOTS / "9-mine-admin.png"))

    # ======================================================== 支出抽屉
    page.click("#dock .tab[data-tab='costs']")
    page.wait_for_timeout(550)
    costs_text = page.locator("#sheetBody").inner_text()
    check("支出抽屉含「支出记录」与「支出报表」", "支出记录" in costs_text and "支出报表" in costs_text)
    check("支出抽屉含支出/成本口径说明", "特批通过" in costs_text)
    page.screenshot(path=str(SHOTS / "10-costs-sheet.png"))

    # ======================================================== 窄屏 360
    page.click("#btnWidth")
    page.wait_for_timeout(550)
    check("360px 下 Dock 标签不溢出", page.evaluate("""() => {
      return [...document.querySelectorAll('#dock .tab .lbl')].every(e => e.scrollWidth <= e.clientWidth + 1);
    }"""))
    check("360px 下无横向溢出", page.evaluate(
        "() => document.documentElement.scrollWidth <= window.innerWidth + 1"))
    g = geom(page)
    check("360px 下抽屉重新贴合底部", abs(g["sheet"]["b"] - g["screen"]["b"]) < TOL)
    page.screenshot(path=str(SHOTS / "11-narrow-360.png"))

    # ======================================================== 字号下限 / 无 JS 报错
    # 两组分开采样：正文与标签下限是 10px；`.dot` / `.badge-dot` 是两位数字的小角标
    # （圆角胶囊内 9.5px），设计上本就小于正文标签，不与正文用同一阈值。
    sizes = page.evaluate("""() => {
    const minOf = (sel) => {
      const vals = [...document.querySelectorAll(sel)].map(e => parseFloat(getComputedStyle(e).fontSize));
      return vals.length ? Math.min(...vals) : null;
    };
    return {
      text: minOf('#dock .lbl, .badge, .kpi .k, .pv-k, .pcard .code, .fchip'),
      badge: minOf('.dot, .badge-dot'),
    };
  }""")
    text_min, badge_min = sizes["text"], sizes["badge"]
    check("正文/标签字号 >= 10px，数字角标 >= 9.5px",
          (text_min or 0) >= 10 and (badge_min is None or badge_min >= 9.5),
          f"text_min={text_min}px badge_min={badge_min}px")

    browser.close()

print("\n".join(results))
print()
if errors:
    print("!! 失败项：")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print(f"全部 {len(results)} 项通过，截图 {len(list(SHOTS.glob('*.png')))} 张 → {SHOTS}")
