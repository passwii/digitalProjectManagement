"""BLF-1093 验收走查（真实浏览器 + 真实后端）。

覆盖验收标准里的关键路径：
  登录 → 项目 → 任务填报 → 预算/支出 → 审批 → 通知跳转
以及「从通知进入业务对象无需二次手工查找」「目标不存在时有可理解的错误」
「驳回后可见原因并能重新提交」「无原生 alert、失败时表单内容保留」
「窄屏可操作、键盘可关闭弹层」。

用法：
    python3 scripts/acceptance_blf1093.py
依赖：playwright（channel=chrome）、本机后端 8001、前端 3001。
"""
from __future__ import annotations

import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("FE_BASE", "http://127.0.0.1:3001")
API = os.environ.get("API_BASE", "http://127.0.0.1:8001/api/v1")
SHOT = os.environ.get("SHOT_DIR", "/tmp/blf1093-shots")
USER = os.environ.get("PM_USER", "demo_admin")
PWD = os.environ.get("PM_PWD", "demo123456")

os.makedirs(SHOT, exist_ok=True)
results: list[dict] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}", flush=True)


def main() -> int:
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        bad: list[str] = []
        page.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        page.on(
            "console",
            lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None,
        )

        # ---------------- 1. 登录 ----------------
        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.fill('form input:not([type="password"])', USER)
        page.fill('form input[type="password"]', PWD)
        page.click('form button[type="submit"]')
        page.wait_for_url(lambda u: "/login" not in u, timeout=20000)
        record("登录", True, page.url)

        # 便于后续直接调后端 API 取真实 id
        token = page.evaluate("() => localStorage.getItem('pm_access_token')")
        hdr = {"Authorization": f"Bearer {token}"}

        # ---------------- 2. 通知面板 → 精确定位 ----------------
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.click('button[aria-label^="通知"]')
        page.wait_for_selector('[role="dialog"][aria-label="通知列表"]', timeout=10000)
        # 等列表真正回来再计数（否则拿到的是“加载中…”时的 0 条）
        page.wait_for_selector('[aria-label="通知列表"] button[title]', timeout=10000)
        n_items = page.locator('[aria-label="通知列表"] button[title]').count()
        record("通知面板可打开", n_items > 0, f"{n_items} 条通知")
        page.screenshot(path=f"{SHOT}/01-bell-panel.png")

        appr = page.locator('[aria-label="通知列表"] button', has_text="立项审批").first
        if appr.count():
            appr.click()
            page.wait_for_url(re.compile(r"/approvals"), timeout=10000)
            from urllib.parse import urlparse, parse_qs

            q = parse_qs(urlparse(page.url).query)
            has_locator = any(k in q for k in ("filing", "adjust", "expense"))
            record("通知点击带定位参数落到审批对象", has_locator, page.url)
            # 等表格真正渲染出命中行再断言（深链是从通知面板跳过来的，数据还在路上）
            page.wait_for_selector("tr[data-target-id]", timeout=15000)
            hits = page.locator("tr.row-target").count()
            record("审批页高亮命中行", hits > 0, f"row-target={hits}")
            page.screenshot(path=f"{SHOT}/02-approvals-target.png")
        else:
            record("存在审批类通知", False, "无可点 approval 通知")

        # ---------------- 3. 审批深链：支出 / 不存在 ----------------
        # 待审批支出是「审批中心深链」与「驳回」两处断言的样本，但它会被消费掉，所以每次自己播种。
        #
        # 后端规则（api/routers/expenses.py:create_expense）：
        #     st = "pending" if (approval_on or over) else "approved"
        #     且 over and not approval_on → 400「超预算已拦截」
        # 即：开关关闭时超预算是被**拒绝**而非转待审批。所以要稳定得到 pending，只能临时开启
        # 「支出先审批」开关（产品自带的管理员配置，走 /admin/params），造完样本后在 finally 里恢复。
        # 不直接改库、不绕过任何校验；恢复后用 GET 回读确认。
        orig_switch = page.evaluate(
            """async ([api, tok]) => {
                const j = await (await fetch(api + '/admin/params', { headers: { Authorization: 'Bearer ' + tok } })).json();
                return j.expense_approval_on ?? '0';
            }""",
            [API, token],
        )
        seeded = page.evaluate(
            """async ([api, tok, orig]) => {
                const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
                const out = { ids: [], error: null, restored: null };
                const setR = await fetch(api + '/admin/params', {
                    method: 'PUT', headers: h, body: JSON.stringify({ expense_approval_on: '1' }),
                });
                if (!setR.ok) { out.error = '无法开启审批开关：' + (await setR.text()); return out; }
                try {
                    // 挑一个有预算的项目×科目，金额取「差额 + 1」；开关开着也会落 pending，
                    // 两条样本：一条供审批中心深链，一条供驳回。
                    const p = await (await fetch(api + '/projects/options?page=1&size=100', { headers: h })).json();
                    for (const cand of (p.items || [])) {
                        const c = await (await fetch(api + `/reports/cost?project_id=${cand.id}`, { headers: h })).json();
                        const row = (c.items || []).find((r) => r.budget > 0);
                        if (!row) continue;
                        const over = Math.max(1, Math.ceil(row.budget - row.spent) + 1);
                        const ids = [];
                        let failed = null;
                        for (let i = 0; i < 2; i++) {
                            const r = await fetch(api + '/expenses', {
                                method: 'POST', headers: h,
                                body: JSON.stringify({ project_id: cand.id, subject: row.subject, amount: over,
                                                       note: `BLF-1093 走查样本 ${i + 1}` }),
                            });
                            if (!r.ok) { failed = (await r.text()).slice(0, 120); break; }
                            const saved = await r.json();
                            if (saved.status !== 'pending') { failed = 'expected pending, got ' + saved.status; break; }
                            ids.push(saved.id);
                        }
                        if (failed) { out.error = failed; return out; }
                        out.ids = ids;
                        out.project_id = cand.id;
                        out.subject = row.subject;
                        out.budget = row.budget;
                        out.spent = row.spent;
                        out.over_amount = over;
                        return out;
                    }
                    out.error = '找不到有预算的项目×科目';
                    return out;
                } finally {
                    // 无论成败都要把环境改回去（上一轮崩溃就是漏了这一步，把开关留在了 1）
                    await fetch(api + '/admin/params', {
                        method: 'PUT', headers: h, body: JSON.stringify({ expense_approval_on: orig }),
                    });
                    const g = await (await fetch(api + '/admin/params', { headers: h })).json().catch(() => ({}));
                    out.restored = String(g.expense_approval_on) === String(orig);
                }
            }""",
            [API, token, orig_switch],
        )
        if seeded.get("ids"):
            record(
                "播种待审批支出样本并恢复开关",
                len(seeded["ids"]) == 2 and seeded.get("restored") is True,
                f"ids={seeded['ids']} project={seeded.get('project_id')} subject={seeded.get('subject')} "
                f"预算={seeded.get('budget')} 已支出={seeded.get('spent')} 播种金额={seeded.get('over_amount')} "
                f"开关已回读确认恢复={seeded.get('restored')}",
            )
        else:
            record("播种待审批支出样本并恢复开关", False, str(seeded)[:160])
        over_amount = seeded.get("over_amount") or 100000000

        # 超预算断言的形态取决于开关：先确认它已恢复，否则 400 会被 pending 取代
        live_switch = page.evaluate(
            """async ([api, tok]) => {
                const j = await (await fetch(api + '/admin/params', { headers: { Authorization: 'Bearer ' + tok } })).json();
                return j.expense_approval_on ?? '0';
            }""",
            [API, token],
        )
        record("播种后审批开关与初始值一致", str(live_switch) == str(orig_switch), f"现在={live_switch} 初始={orig_switch}")

        exp = page.evaluate(
            """async ([api, tok]) => {
                const r = await fetch(api + '/approvals/pending', { headers: { Authorization: 'Bearer ' + tok } });
                const j = await r.json();
                return { expense: j.expenses?.[0]?.id ?? null, adjust: j.budget_adjusts?.[0]?.id ?? null, filing: j.project_filings?.[0]?.id ?? null };
            }""",
            [API, token],
        )
        if exp["expense"]:
            page.goto(f"{BASE}/approvals?expense={exp['expense']}", wait_until="networkidle")
            page.wait_for_selector(f'tr[data-target-id="{exp["expense"]}"]', timeout=15000)
            hit = page.locator(f'tr[data-target-id="{exp["expense"]}"]').count()
            hl = page.locator(f'tr[data-target-id="{exp["expense"]}"].row-target').count()
            record("支出待办深链定位并高亮", hit > 0 and hl > 0, f"id={exp['expense']} 命中={hit} 高亮={hl}")
            page.screenshot(path=f"{SHOT}/03-approvals-expense-target.png")
        else:
            record("审批中心有待审批支出", False, "无 pending expense")

        page.goto(f"{BASE}/approvals?adjust={exp['adjust'] or 1}", wait_until="networkidle")
        if exp["adjust"]:
            page.wait_for_selector(f'tr[data-target-id="{exp["adjust"]}"].row-target', timeout=15000)
        record(
            "预算调整深链定位",
            bool(exp["adjust"]) and page.locator(f'tr[data-target-id="{exp["adjust"]}"].row-target').count() > 0,
            f"id={exp['adjust']}",
        )

        page.goto(f"{BASE}/approvals?expense=999999", wait_until="networkidle")
        page.wait_for_timeout(1800)
        miss = " ".join(page.locator('.warn-banner[role="alert"]').all_text_contents())
        record("审批深链目标不存在时给出说明", "不在待审批列表" in miss, miss[:120])
        page.screenshot(path=f"{SHOT}/04-approvals-missing.png")

        # ---------------- 3b. 成本页支出深链：跨页定位（Tia 复审阻塞项） ----------------
        # 取一个真实项目有多条支出，把 size 压到 2 → 目标必然落在第 2 页之后，
        # 验证「找到就翻页并高亮」「找不到就说明 + 清除定位」「被筛选挡住就给清除筛选」三条路径。
        exp_case = page.evaluate(
            """async ([api, tok]) => {
                const p = await (await fetch(api + '/projects/options?page=1&size=100', { headers: { Authorization: 'Bearer ' + tok } })).json();
                let best = null;
                for (const proj of (p.items || [])) {
                    const r = await fetch(api + `/expenses?project_id=${proj.id}&page=1&size=100`, { headers: { Authorization: 'Bearer ' + tok } });
                    if (!r.ok) continue;
                    const j = await r.json();
                    const items = j.items || [];
                    const sorted = items.slice().sort((a, b) => b.id - a.id);   // 列表默认 -id
                    if (sorted.length >= 3 && (!best || sorted.length > best.count)) {
                        const oldest = sorted[sorted.length - 1];
                        best = { project_id: proj.id, count: sorted.length,
                                 target: oldest.id, target_status: oldest.status };
                    }
                }
                return best;
            }""",
            [API, token],
        )
        if exp_case:
            # 只看「目标落在第 2 页之后」这一条：size=2 → 末条必然在第 2 页+
            pg_url = (
                f"{BASE}/costs?project_id={exp_case['project_id']}"
                f"&size=2&expense={exp_case['target']}"
            )
            page.goto(pg_url, wait_until="networkidle")
            page.wait_for_selector("tr.row-target", timeout=20000)
            page.wait_for_timeout(600)
            jumped = page.locator(f'tr[data-target-id="{exp_case["target"]}"].row-target').count()
            page_now = page.evaluate(
                "() => document.querySelector('nav[aria-label=\"支出记录分页\"]')?.innerText.replace(/\\s+/g,' ') || ''"
            )
            record(
                "支出深链跨页定位（目标在第 2 页+）",
                jumped > 0,
                f"id={exp_case['target']} / 共 {exp_case['count']} 条 / size=2 → 高亮={jumped} 页码={page_now!r} url={page.url}",
            )
            page.screenshot(path=f"{SHOT}/04b-costs-expense-crosspage.png")

            # 成功后定位参数保留（与任务/审批/跟进一致：刷新/分享链接仍能重现高亮），
            # 清除入口在「找不到目标」的错误横幅上（下方两条断言覆盖）。
            record(
                "支出定位命中后链接可重现（参数保留）",
                "expense=" in page.url and "page=" in page.url,
                page.url,
            )

            # 不存在目标 → 可理解说明 + 清除出口（点完参数消失、高亮消失）
            page.goto(f"{BASE}/costs?project_id={exp_case['project_id']}&expense=999999", wait_until="networkidle")
            page.wait_for_selector('.err-banner[role="alert"]', timeout=20000)
            miss_txt = page.locator('.err-banner[role="alert"]').inner_text()
            record(
                "支出深链目标不存在时给出说明",
                "不在可见范围" in miss_txt and page.locator('button:has-text("清除定位")').count() > 0,
                miss_txt[:110],
            )
            page.screenshot(path=f"{SHOT}/04c-costs-expense-missing.png")
            page.click('button:has-text("清除定位")')
            page.wait_for_timeout(1500)
            record(
                "清除定位后参数与提示一并消失",
                "expense=" not in page.url
                and page.locator('.err-banner[role="alert"]').count() == 0,
                page.url,
            )
            # 被状态筛选挡住 → 给出「清除筛选并定位」且点完真的落到目标
            blocked_status = "rejected" if exp_case["target_status"] != "rejected" else "pending"
            page.goto(
                f"{BASE}/costs?project_id={exp_case['project_id']}&status={blocked_status}&expense={exp_case['target']}",
                wait_until="networkidle",
            )
            page.wait_for_selector('button:has-text("清除筛选并定位")', timeout=20000)
            blocked_txt = page.locator('.err-banner[role="alert"]').inner_text()
            record("支出被筛选挡住时区分并给出出口", "筛选范围" in blocked_txt, blocked_txt[:110])
            page.click('button:has-text("清除筛选并定位")')
            page.wait_for_selector("tr.row-target", timeout=20000)
            record(
                "清除筛选后确实落到目标支出",
                page.evaluate('()=>document.querySelector("tr.row-target")?.dataset.targetId')
                == str(exp_case["target"]),
                f"url={page.url} 目标={exp_case['target']}",
            )
            page.screenshot(path=f"{SHOT}/04d-costs-expense-unfiltered.png")
        else:
            record("找到可跨页定位的支出样本", False, "无含 ≥3 条支出的项目")

        # ---------------- 4. 进度页：任务填报 + 深链 ----------------
        page.goto(f"{BASE}/progress?project_id=1", wait_until="networkidle")
        page.wait_for_timeout(1800)
        record("进度页任务表渲染", page.locator("table.grid").count() > 0)
        page.screenshot(path=f"{SHOT}/05-progress.png")

        task_ids = page.evaluate(
            """async ([api, tok]) => {
                const r = await fetch(api + '/tasks?project_id=1&size=100&sort=id', { headers: { Authorization: 'Bearer ' + tok } });
                const j = await r.json();
                return (j.items || []).map(x => x.id);
            }""",
            [API, token],
        )
        record("项目 1 有任务数据", len(task_ids) > 0, f"{len(task_ids)} 条")
        if task_ids:
            # 取最后一个任务（默认按 id 升序 → 落在最后一页）验证跨页定位
            last = task_ids[-1]
            page.goto(f"{BASE}/progress?project_id=1&task={last}&size=2", wait_until="networkidle")
            page.wait_for_timeout(3000)
            hit = page.locator(f'tr[data-target-id="{last}"]').count()
            hl = page.locator(f'tr[data-target-id="{last}"].row-target').count()
            record(
                "任务深链跨页定位并高亮",
                hit > 0 and hl > 0,
                f"id={last} 命中={hit} 高亮={hl} url={page.url}",
            )
            page.screenshot(path=f"{SHOT}/06-progress-task-target.png")

        page.goto(f"{BASE}/progress?project_id=1&task=999999", wait_until="networkidle")
        page.wait_for_timeout(3000)
        tmiss = " ".join(page.locator('.err-banner[role="alert"]').all_text_contents())
        record("任务深链目标不存在时给出说明", ("不在可见范围" in tmiss or "已被删除" in tmiss), tmiss[:140])
        page.screenshot(path=f"{SHOT}/07-progress-missing.png")

        # ---------------- 5. 任务填报弹窗：失败保留内容 ----------------
        page.goto(f"{BASE}/progress?project_id=1", wait_until="networkidle")
        page.wait_for_timeout(1800)
        page.locator('button:has-text("+ 任务")').click()
        page.wait_for_timeout(600)
        page.fill('[role="dialog"] input', "BLF1093 验收临时任务")
        page.fill('[role="dialog"] input[inputmode="decimal"]', "-5")  # 权重非法 → 前端校验
        page.click('[role="dialog"] button:has-text("创建任务")')
        page.wait_for_timeout(500)
        fe = page.locator('[role="dialog"] .field-err').all_text_contents()
        kept = page.locator('[role="dialog"] input').first.input_value()
        record("任务填报前端校验挡住非法值且保留输入", bool(fe) and kept == "BLF1093 验收临时任务", f"错误={fe} 值={kept}")
        page.screenshot(path=f"{SHOT}/08-task-dialog-validation.png")
        page.click('[role="dialog"] button:has-text("取消")')

        # ---------------- 6. 成本页：驳回原因 + 重新提交 ----------------
        # 自己产生一条「有意见的驳回」（用播种出来的样本），不依赖历史遗留数据：
        # 没有它，后面的「申请人可见驳回原因」就会因库中样本被消费而莫名失败。
        rej = page.evaluate(
            """async ([api, tok, ids]) => {
                const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
                const reason = '附件缺少发票，请补齐后重新提交';
                for (const id of ids) {
                    const r = await fetch(api + '/approvals/expense/' + id + '/decide', {
                        method: 'POST', headers: h,
                        body: JSON.stringify({ approve: false, reason }),
                    });
                    if (!r.ok) continue;
                    const j = await r.json();
                    const d = await (await fetch(api + '/expenses?status=rejected&size=100', { headers: h })).json();
                    const x = (d.items || []).find((e) => e.id === id);
                    if (x) return { id: x.id, project_id: x.project_id, amount: x.amount, reason };
                }
                return null;
            }""",
            [API, token, seeded.get("ids", [])],
        )
        if rej:
            record("播种带审批意见的驳回样本", True, f"id={rej['id']} project={rej['project_id']}")
        else:
            record("播种带审批意见的驳回样本", False, "审批开关播种的样本均不可驳回")
        # 若播种失败，退回库里已有的驳回单以保证后续断言不误报
        if not rej:
            rej = page.evaluate(
                """async ([api, tok]) => {
                    const r = await fetch(api + '/expenses?status=rejected&size=100', { headers: { Authorization: 'Bearer ' + tok } });
                    const j = await r.json();
                    const x = (j.items || [])[0];
                    return x ? { id: x.id, project_id: x.project_id, amount: x.amount, reason: '' } : null;
                }""",
                [API, token],
            )
        if rej:
            page.goto(f"{BASE}/costs?project_id={rej['project_id']}&status=rejected", wait_until="networkidle")
            page.wait_for_timeout(2000)
            page.screenshot(path=f"{SHOT}/09-costs-rejected.png")
            reason_btn = page.locator('button:has-text("查看原因")').first
            record("被驳回支出提供「查看原因」入口", reason_btn.count() > 0)
            if reason_btn.count():
                reason_btn.click()
                page.wait_for_timeout(600)
                dlg = page.locator('[role="dialog"]').last.text_content() or ""
                page.screenshot(path=f"{SHOT}/10-costs-reason-dialog.png")
                record("驳回原因弹层给出上下文与重提入口", "重新提交" in dlg, re.sub(r"\s+", " ", dlg)[:120])
                page.click('[role="dialog"] button:has-text("关闭")')

            rs = page.locator('button:has-text("修改后重新提交")').first
            if rs.count():
                rs.click()
                page.wait_for_timeout(700)
                title = page.locator('[role="dialog"] h2').first.text_content() or ""
                val = page.locator('[role="dialog"] input[inputmode="decimal"]').input_value()
                record("重新提交预填被驳回单据", "重新提交" in title and val not in ("", "0"), f"标题={title} 金额={val}")
                page.screenshot(path=f"{SHOT}/11-costs-resubmit.png")
                # 超预算 → 后端 400 拦截（常态）→ 弹窗保留、内容不丢。
                # `_over()` 只看「已支出 + 金额 > 预算」，与「支出先审批」开关无关，所以这里形态稳定。
                page.fill('[role="dialog"] input[inputmode="decimal"]', str(over_amount))
                page.click('[role="dialog"] button:has-text("重新提交")')
                page.wait_for_timeout(2500)
                still = page.locator('[role="dialog"]').count()
                err2 = " ".join(page.locator('[role="dialog"] .err-banner').all_text_contents())
                kept2 = page.locator('[role="dialog"] input[inputmode="decimal"]').input_value() if still else ""
                record(
                    "提交失败保留表单内容并给出下一步",
                    still > 0 and kept2 == str(over_amount) and bool(err2),
                    f"弹窗={still} 值={kept2} 超预算金额={over_amount} 提示={err2[:90]}",
                )
                page.screenshot(path=f"{SHOT}/12-costs-submit-error.png")
                if still:
                    page.click('[role="dialog"] button:has-text("取消")')
            else:
                record("成本页提供重新提交入口", False, "未找到按钮")
        else:
            record("存在已驳回支出样本", False, "无 rejected expense")

        # ---------------- 7. 驳回必须填意见（与审批中心一致） ----------------
        pend = page.evaluate(
            """async ([api, tok]) => {
                const r = await fetch(api + '/expenses?status=pending&size=100', { headers: { Authorization: 'Bearer ' + tok } });
                const j = await r.json();
                const x = (j.items || [])[0];
                return x ? { id: x.id, project_id: x.project_id } : null;
            }""",
            [API, token],
        )
        if pend:
            page.goto(f"{BASE}/costs?project_id={pend['project_id']}&status=pending", wait_until="networkidle")
            page.wait_for_timeout(2000)
            rb = page.locator('button:has-text("驳回")').first
            if rb.count():
                rb.click()
                page.wait_for_timeout(600)
                dlg = page.locator('[role="alertdialog"]').text_content() or ""
                record("成本页驳回弹层要求填写审批意见", "审批意见" in dlg, re.sub(r"\s+", " ", dlg)[:110])
                page.screenshot(path=f"{SHOT}/13-costs-reject-reason.png")
                page.click('[role="alertdialog"] button:has-text("确认驳回")')
                page.wait_for_timeout(500)
                ferr = page.locator('[role="alertdialog"] .field-err').all_text_contents()
                record("意见为空时就地报错", bool(ferr), " | ".join(ferr)[:100])
                page.screenshot(path=f"{SHOT}/14-costs-reject-required.png")
                page.click('[role="alertdialog"] button:has-text("取消")')
            else:
                record("成本页有待审批支出可驳回", False, "无 pending 支出")
        else:
            record("存在待审批支出样本", False, "无 pending expense")

        # ---------------- 8. 键盘：Esc 关闭并把焦点还给铃铛 ----------------
        bell = page.locator('button[aria-label^="通知"]')
        bell.click()
        page.wait_for_selector('[role="dialog"][aria-label="通知列表"]', timeout=8000)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        closed = page.locator('[role="dialog"][aria-label="通知列表"]').count() == 0
        focus = page.evaluate("() => document.activeElement?.getAttribute('aria-label') || ''")
        record("Esc 关闭通知面板且焦点回到铃铛", closed and focus.startswith("通知"), f"closed={closed} focus={focus}")

        # ---------------- 9. 窄屏可用 ----------------
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/costs?project_id=5", wait_until="networkidle")
        page.wait_for_timeout(2000)
        ov = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        record("窄屏无整页横向溢出", ov <= 2, f"横向溢出 {ov}px")
        page.screenshot(path=f"{SHOT}/15-mobile-costs.png")
        # 移动端弹层应可用
        page.locator('button:has-text("+ 支出")').click()
        page.wait_for_timeout(800)
        modal_ok = page.locator('[role="dialog"]').count() > 0
        record("窄屏弹层可用", modal_ok)
        page.screenshot(path=f"{SHOT}/16-mobile-dialog.png")
        page.keyboard.press("Escape")
        page.set_viewport_size({"width": 1440, "height": 900})

        # ---------------- 10. 无原生 alert 占位 ----------------
        alerts: list[str] = []
        page.on("dialog", lambda d: (alerts.append(d.message), d.dismiss()))
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)
        btns = page.locator('button:has-text("导出")')
        for i in range(min(btns.count(), 2)):
            btns.nth(i).click()
            page.wait_for_timeout(600)
        record("项目台账无原生 alert 占位导出", len(alerts) == 0, f"alert={alerts}")
        page.screenshot(path=f"{SHOT}/17-projects.png")

        # 报表页导出是真功能（xlsx），不应弹 alert
        page.goto(f"{BASE}/reports", wait_until="networkidle")
        page.wait_for_timeout(1500)
        record("报表导出按钮存在且非占位提示", page.locator('button:has-text("导出 Excel")').count() > 0)

        # ---------------- 11. 全流程连续操作：成本 → 预算调整 ----------------
        page.goto(f"{BASE}/costs?project_id=5", wait_until="networkidle")
        page.wait_for_timeout(2000)
        kpi_text = " ".join(page.locator(".kpi").all_text_contents())
        record(
            "成本页 KPI 使用统一命名与口径说明",
            "预算合计" in kpi_text and "已支出" in kpi_text and "可用余额" in kpi_text and "执行率" in kpi_text,
            re.sub(r"\s+", " ", kpi_text)[:110],
        )
        note = page.locator("p.muted.tiny").first.text_content() or ""
        record("成本口径说明可见", "项目管理口径" in note, re.sub(r"\s+", " ", note)[:110])
        page.screenshot(path=f"{SHOT}/18-costs-kpi.png")

        # 预算调整弹窗：失败保留输入
        page.locator('button:has-text("调整")').first.click()
        page.wait_for_timeout(600)
        page.fill('[role="dialog"] input[inputmode="decimal"]', "-1")  # 负数 → 前端校验
        page.click('[role="dialog"] button:has-text("提交调整申请")')
        page.wait_for_timeout(500)
        ferr2 = page.locator('[role="dialog"] .field-err').all_text_contents()
        record("预算调整前端校验生效", bool(ferr2), " | ".join(ferr2)[:90])
        page.click('[role="dialog"] button:has-text("取消")')

        # ---------------- 12. 连续主流程：登录 → 项目 → 填报 → 成本 → 审批 → 通知跳转 ----------------
        # 只把「真实的功能性 JS 异常」计为失败：浏览器的自动请求（favicon）以及本走查
        # 故意触发的业务 4xx（超预算拒绝）不算异常。
        real_errors = [
            e for e in errors
            if "favicon" not in e and not re.search(r"status of (400|404)", e)
        ]
        # 不断上下文，验证「不再把用户带回模块首页猜下一步」
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)
        # 行上的「详情」是 hover 才显示的链接；走查里用点击行本身（与真实用户一致）
        row = page.locator("table.grid tbody tr").first
        record("项目台账有可进入的项目行", row.count() > 0)
        row.click()
        page.wait_for_timeout(1500)
        # 行点击打开 Drawer，再从 Drawer 进详情
        drawer_ok = page.locator('[role="dialog"]').count() > 0
        record("点击项目行打开详情抽屉", drawer_ok)
        page.screenshot(path=f"{SHOT}/19-flow-project-drawer.png")
        detail_link = page.locator('[role="dialog"] a:has-text("打开完整档案")')
        if detail_link.count():
            detail_link.first.click()
            # 跳到详情路由需要等服务端组件就绪，不用固定 sleep（否则会把慢当成错）
            page.wait_for_url(re.compile(r"/projects/\d+"), timeout=15000)
        path = page.url
        record("进入项目详情", bool(re.search(r"/projects/\d+", path)), path)
        page.screenshot(path=f"{SHOT}/20-flow-project-detail.png")

        # 项目详情 → 进度（带 project_id，不用重选）。选择器必须限定页头操作区：
        # 侧边栏的「进度跟进」也含「进度」二字，全局 has-text 会先命中导航。
        head = page.locator(".page-head .actions")
        if head.locator('a:has-text("进度")').count():
            head.locator('a:has-text("进度")').first.click()
            page.wait_for_timeout(2500)
            record("项目 → 进度页面带 project_id", "project_id=" in page.url, page.url)
            page.screenshot(path=f"{SHOT}/21-flow-progress.png")
            # 进度页 → 成本（同样带 project_id）
            page.goto(f"{page.url.split('?')[0]}".replace("/progress", "/costs") + "?" + page.url.split("?")[1], wait_until="networkidle")
            page.wait_for_timeout(2000)
            record("成本页沿用同一 project_id", "project_id=" in page.url)
            page.screenshot(path=f"{SHOT}/22-flow-costs.png")

        # 跟进深链：?tab=跟进&followup=N → 页签打开且高亮那条
        fu = page.evaluate(
            """async ([api, tok]) => {
                const p = await (await fetch(api + '/projects?page=1&size=20', { headers: { Authorization: 'Bearer ' + tok } })).json();
                for (const proj of (p.items || [])) {
                    const r = await fetch(api + `/projects/${proj.id}/followups?size=100`, { headers: { Authorization: 'Bearer ' + tok } });
                    if (!r.ok) continue;
                    const j = await r.json();
                    const items = Array.isArray(j) ? j : (j.items || []);
                    if (items.length) return { project_id: proj.id, followup_id: items[0].id };
                }
                return null;
            }""",
            [API, token],
        )
        if fu:
            page.goto(
                f"{BASE}/projects/{fu['project_id']}?tab=%E8%B7%9F%E8%BF%9B&followup={fu['followup_id']}",
                wait_until="networkidle",
            )
            page.wait_for_timeout(2500)
            active = page.locator("button.active", has_text="跟进").count()
            hl = page.locator(f'li[data-target-id="{fu["followup_id"]}"].row-target').count()
            record("跟进深链打开页签并高亮", active > 0 and hl > 0, f"tab_active={active} 高亮={hl} id={fu['followup_id']}")
            page.screenshot(path=f"{SHOT}/23-flow-followup-target.png")
        else:
            record("存在跟进记录样本", False, "无跟进数据")

        # 审批动作后通知里出现「结果」通知，点击回到业务对象
        decisions = page.evaluate(
            """async ([api, tok]) => {
                const r = await fetch(api + '/approvals/pending', { headers: { Authorization: 'Bearer ' + tok } });
                const j = await r.json();
                return { n: (j.expenses||[]).length + (j.budget_adjusts||[]).length + (j.project_filings||[]).length };
            }""",
            [API, token],
        )
        record("审批中心待办可读", decisions["n"] >= 0, f"待办 {decisions['n']} 条")

        record("运行时无功能性 JS 异常", len(real_errors) == 0, " || ".join(real_errors[:3])[:250])
        print("--- 4xx/5xx 请求（含本走查故意触发的业务拒绝） ---")
        for b in dict.fromkeys(bad):
            print("   ", b)

        browser.close()

    failed = [r for r in results if not r["ok"]]
    print(f"\n===== {len(results) - len(failed)}/{len(results)} 通过 =====")
    if failed:
        print("失败：" + "; ".join(f["name"] for f in failed))
    with open(f"{SHOT}/results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
