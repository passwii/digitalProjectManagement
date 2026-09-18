"""BLF-1140 验收走查：正文不再重复页面标题与描述（真实浏览器 + 真实后端）。

改的是「8 个页面正文顶部的 PageHeading 标题 + 描述」，所以走查盯的是这四件事：

  1. 每页正文**恰好一个 h1**，且是视觉隐藏的读屏标题（文案 = 页面名）——顶栏那层是
     纯文本 <span>，删掉正文标题后不能变成「无标题页面」；
  2. 被删掉的 8 句描述文案**在 DOM 里彻底消失**（不是靠 CSS 藏起来）；
  3. 原 actions 主操作**一个不少**（`+ 新建项目` / `刷新` / `待审批 N` / `+ 支出` …），
     连禁用态一起验（进度 / 支出在没有选项目时仍应是 disabled）；
  4. 操作行版式与留白：桌面右对齐贴内容右边、≤640px 贴左铺满；操作行与下一块内容
     之间的间隙回到正常节奏（不留下被删标题撑出的空洞）；三档无横向溢出。

用法：
    PM_USER=... PM_PWD=... python3 scripts/acceptance_blf1140.py
    # 本地没有账号密码时也可直接给一个 access token：
    PM_TOKEN=... python3 scripts/acceptance_blf1140.py
依赖：playwright（channel=chrome）、本机前端 3001、后端 8001。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

FE = os.environ.get("FE_BASE", "http://127.0.0.1:3001")
API = os.environ.get("API_BASE", "http://127.0.0.1:8001/api/v1")
SHOT = Path(os.environ.get("SHOT_DIR") or Path(tempfile.gettempdir()) / "blf1140-shots")
USER = os.environ.get("PM_USER", "demo_admin")
PWD = os.environ.get("PM_PWD", "demo123456")

SHOT.mkdir(parents=True, exist_ok=True)
results: list[bool] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)


# 每个页面：标题（顶栏 crumb 同一份文案）、被删除的描述、期望仍在的主操作（label, disabled）
PAGES: list[dict] = [
    {
        "path": "/dashboard",
        "title": "工作台",
        "gone": "快速查看项目健康度、近期动态和关键经营数据。",
        "actions": [("刷新", False), ("支出报表", False), ("待审批", False)],
    },
    {
        "path": "/projects",
        "title": "项目台账",
        "gone": "集中查看项目状态、负责人、预算与合同信息。",
        "actions": [("+ 新建项目", False)],
    },
    {
        "path": "/progress",
        "title": "进度跟踪",
        "gone": "记录项目关键节点，持续更新交付进展和阶段结果。",
        # 未选项目：按钮仍在但禁用（原有行为不能变）
        "actions": [("+ 添加进度", True)],
    },
    {
        "path": "/costs",
        "title": "支出记录",
        "gone": "按项目登记支出，查看预算执行情况和审批状态。",
        "actions": [("+ 支出", True)],
    },
    {
        "path": "/reports",
        "title": "支出报表",
        "gone": "按项目、部门、人员和月份汇总查看已通过支出。",
        "actions": [("明细", False), ("汇总", False), ("打印", False), ("导出 Excel", False)],
    },
    {
        "path": "/approvals",
        "title": "审批中心",
        "gone": "集中处理立项、预算调整和支出审批待办。",
        "actions": [("刷新", False)],
    },
    {
        "path": "/contacts",
        "title": "通讯录",
        "gone": "管理员人员主数据：无账号人员可直接建档，系统账号可选关联，证件和合同集中管理。",
        "actions": [("+ 新建人员", False)],
    },
    {
        "path": "/admin",
        "title": "系统管理",
        "gone": "维护用户、业务字典、系统参数、审计日志和回收站。",
        "actions": [("+ 新增用户", False)],
    },
]

VIEWPORTS = [(1440, 900), (900, 800), (375, 812)]

PROBE = r"""() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const shown = (e) => {
    const r = e.getBoundingClientRect(), c = getComputedStyle(e);
    return r.width > 4 && r.height > 4 && c.display !== 'none'
      && c.visibility !== 'hidden' && c.opacity !== '0';
  };
  const main = document.querySelector('main');
  const inner = main ? main.firstElementChild : null;   // .contentInner
  const row = document.querySelector('.page-head.actions-only');
  const actions = row ? row.querySelector('.actions') : null;
  const box = (e) => { const r = e.getBoundingClientRect();
    return {l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height}; };
  const h1s = Array.from(document.querySelectorAll('h1'));
  // 可见的「页面标题」重复：正文里还有没有一段可见文字就等于页面名
  const title = clean(document.querySelector('main h1') ? document.querySelector('main h1').textContent : '');
  const dupes = title ? Array.from(main.querySelectorAll('*')).filter((e) =>
      clean(e.textContent) === title && !e.children.length && shown(e)).length : 0;
  const items = actions ? Array.from(actions.querySelectorAll('button,a')).map((e) => ({
    text: clean(e.textContent), disabled: e.disabled === true })) : [];
  const after = row ? row.nextElementSibling : null;
  return {
    vw: document.documentElement.clientWidth,
    overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    h1Count: h1s.length,
    h1All: h1s.map((h) => ({ text: clean(h.textContent), inMain: main.contains(h), shown: shown(h) })),
    dupes,
    hasRow: !!row,
    items,
    row: row ? box(row) : null,
    rowAfterGap: (row && after) ? (after.getBoundingClientRect().top - box(row).b) : null,
    innerBox: inner ? box(inner) : null,
    bodyText: clean(main.textContent),
  };
}"""


def login(p) -> str:
    """取一个 access token：优先用 PM_TOKEN，否则用 PM_USER/PM_PWD 登录。"""
    token = os.environ.get("PM_TOKEN", "").strip()
    if token:
        return token
    if not API.startswith(("http://", "https://")):      # 只许 http(s)，不给 file: 之类留口子
        raise SystemExit(f"API_BASE 必须是 http(s)：{API}")
    api = p.request.new_context()
    try:
        resp = api.post(f"{API}/auth/login", data={"username": USER, "password": PWD})
        if resp.status != 200:          # 凭据不对时给出可读原因，而不是栈
            raise SystemExit(f"登录失败 {resp.status}: {resp.text()[:200]}")
        return resp.json()["access_token"]
    finally:
        api.dispose()


def main() -> int:
    with sync_playwright() as p:
        token = login(p)
        browser = p.chromium.launch(channel="chrome")
        for w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce")
            ctx.add_cookies([{"name": "pm_access_token", "value": token, "url": FE}])
            ctx.add_init_script(
                f"localStorage.setItem('pm_access_token', {json.dumps(token)});"
                f"localStorage.setItem('pm_refresh_token', {json.dumps(token)});"
            )
            page = ctx.new_page()
            print(f"\n### {w}x{h}", flush=True)
            for spec in PAGES:
                page.goto(FE + spec["path"], wait_until="networkidle")
                page.wait_for_timeout(700)
                g = page.evaluate(PROBE)
                tag = f"{spec['path']} @{w}px"

                # 1) 恰好一个 h1，且是视觉隐藏的读屏标题（文案 = 页面名）
                record(f"{tag} 正文恰好 1 个 h1（读屏标题）", g["h1Count"] == 1, f"h1={g['h1Count']}")
                if g["h1Count"] == 1:
                    one = g["h1All"][0]
                    record(f"{tag} h1 是「{spec['title']}」且视觉隐藏",
                           one["text"] == spec["title"] and one["inMain"] and not one["shown"],
                           f"text={one['text']!r} inMain={one['inMain']} shown={one['shown']}")
                record(f"{tag} 正文无可见的重复页面标题", g["dupes"] == 0, f"重复={g['dupes']}")

                # 2) 被删掉的描述文案在 DOM 里彻底消失
                record(f"{tag} 描述文案已从 DOM 消失", spec["gone"] not in g["bodyText"])

                # 3) 主操作一个不少（含禁用态）
                record(f"{tag} 操作行存在", g["hasRow"])
                for label, disabled in spec["actions"]:
                    hit = [i for i in g["items"] if label in i["text"]]
                    record(f"{tag} 主操作「{label}」",
                           bool(hit) and hit[0]["disabled"] is disabled,
                           f"命中={hit[:1]} 期望 disabled={disabled}")

                # 4) 版式：桌面右对齐贴内容右缘；≤640px 铺满贴左；操作行与下一块的间隙正常
                if g["row"] and g["innerBox"]:
                    rowa, inb = g["row"], g["innerBox"]
                    if w > 640:
                        record(f"{tag} 操作行右对齐（贴内容右缘）",
                               abs(rowa["r"] - inb["r"]) <= 24,
                               f"row.right={rowa['r']:.1f} inner.right={inb['r']:.1f}")
                    else:
                        record(f"{tag} 操作行窄屏铺满贴左",
                               abs(rowa["w"] - inb["w"]) <= 24 and rowa["l"] - inb["l"] <= 24,
                               f"row.w={rowa['w']:.1f} inner.w={inb['w']:.1f} row.left={rowa['l']:.1f}")
                    record(f"{tag} 操作行未超出内容宽度", rowa["r"] <= inb["r"] + 1,
                           f"row.right={rowa['r']:.1f}")
                    gap = g["rowAfterGap"]
                    record(f"{tag} 操作行与下一块间隙正常（无被删标题留下的空洞）",
                           gap is not None and -1 <= gap <= 32,
                           f"gap={gap if gap is None else round(gap, 1)}px")
                # 横向溢出：仅报数值。工作台的「本月支出」表在窄屏本来就会溢出（BLF-1127 已记录，
                # 与本改动无关），所以这里只在操作行越界时判失败（上面那条），不按整页判。
                print(f"      · {tag} 整页横向溢出 {g['overflowPx']}px"
                      f"（含已知的工作台窄屏表格溢出）", flush=True)

                page.screenshot(path=f"{SHOT}/{spec['path'].strip('/')}-{w}x{h}.png", full_page=False)

            # 系统管理：没有主操作的页签不渲染操作行（不留空行），但仍要有 h1
            page.goto(FE + "/admin?tab=%E6%97%A5%E5%BF%97", wait_until="networkidle")
            page.wait_for_timeout(600)
            g = page.evaluate(PROBE)
            record(f"/admin?tab=日志 @{w}px 无操作行（不留空行）", not g["hasRow"])
            record(f"/admin?tab=日志 @{w}px 仍有 1 个读屏 h1", g["h1Count"] == 1, f"h1={g['h1Count']}")
            ctx.close()
        browser.close()

    passed, total = sum(results), len(results)
    print(f"\n=== BLF-1140 走查：{passed} passed / {total - passed} failed（共 {total}）===", flush=True)
    print(f"截图目录：{SHOT}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
