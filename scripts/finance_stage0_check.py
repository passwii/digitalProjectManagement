#!/usr/bin/env python3
"""Stage 0 标准测试账套余额核对脚本（BLF-1154）。

只依赖标准库；金额用 Decimal 解析（禁止 float）。
检查项：
  1. 凭证借贷平衡（逐张）+ 分录借贷必居其一
  2. 凭证号在（账套+期间）内唯一、无断号
  3. 期初借贷平衡
  4. 逐期试算平衡（累计借方 == 累计贷方）
  5. 资产负债表恒等：资产借方净额 == 负债贷方净额 + 权益贷方净额 + 损益贷方净额
  6. 现金流勾稽：现金类科目净变动 == 现金流项目流入 - 流出

用法：
  python scripts/finance_stage0_check.py --fixtures docs/finance/stage0/fixtures/standard_book_3months.json --check all
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

CASH_ACCOUNTS = ("1001", "1002", "1012")


def D(s: str) -> Decimal:  # noqa: N802
    return Decimal(str(s))


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"无法读取账套文件 {path}: {exc}") from exc


def check(book: dict) -> list[str]:
    errors: list[str] = []
    accounts = {a["code"]: a for a in book["accounts"]}
    vouchers = book["vouchers"]

    # 1. 凭证借贷平衡 + 分录单边
    for v in vouchers:
        td = sum((D(li["debit"]) for li in v["lines"]), Decimal("0"))
        tc = sum((D(li["credit"]) for li in v["lines"]), Decimal("0"))
        if td != tc or td <= 0:
            errors.append(f"凭证不平 {v['period']} {v['no']}: 借={td} 贷={tc}")
        for i, li in enumerate(v["lines"], 1):
            d, c = D(li["debit"]), D(li["credit"])
            if (d > 0) == (c > 0):
                errors.append(f"分录非单边 {v['period']} {v['no']} 行{i}: 借={d} 贷={c}")
            if li["account"] not in accounts:
                errors.append(f"未知科目 {v['period']} {v['no']} 行{i}: {li['account']}")
            acct = accounts.get(li["account"], {})
            flags = acct.get("aux_flags", {})
            for dim in ("customer", "vendor", "dept", "employee", "project"):
                if flags.get(dim) and not (li.get("aux") or {}).get(dim):
                    errors.append(f"辅助核算缺失 {v['period']} {v['no']} 行{i}: 缺{dim}")

    # 2. 凭证号唯一 + 断号
    seen: dict[tuple[str, str], int] = defaultdict(int)
    for v in vouchers:
        seen[(v["period"], v["no"])] += 1
    for (p, no), n in seen.items():
        if n > 1:
            errors.append(f"凭证号重复 {p} {no} x{n}")
    for p in book["periods"]:
        try:
            nums = sorted(int(v["no"].split("-")[1]) for v in vouchers if v["period"] == p)
        except (ValueError, IndexError) as exc:
            errors.append(f"凭证号格式错误 {p}: {exc}")
            continue
        if nums and nums != list(range(1, max(nums) + 1)):
            errors.append(f"凭证断号 {p}: {nums}")

    # 3. 期初平衡
    od = sum((D(b["debit"]) for b in book["opening_balances"]), Decimal("0"))
    oc = sum((D(b["credit"]) for b in book["opening_balances"]), Decimal("0"))
    if od != oc:
        errors.append(f"期初不平: 借={od} 贷={oc}")

    # 余额累计（方向净额：借方科目为正借，贷方科目为正贷）
    net: dict[str, Decimal] = defaultdict(Decimal)  # code -> 借正/贷负统一符号：借+贷-
    for b in book["opening_balances"]:
        net[b["account"]] += D(b["debit"]) - D(b["credit"])

    # 4/5/6. 逐期检查
    for p in book["periods"]:
        for v in [x for x in vouchers if x["period"] == p and x["status"] == "posted"]:
            for li in v["lines"]:
                net[li["account"]] += D(li["debit"]) - D(li["credit"])
        td = sum((x for c, x in net.items() if x > 0), Decimal("0"))
        tc = sum((-x for c, x in net.items() if x < 0), Decimal("0"))
        if td != tc:
            errors.append(f"试算不平 {p}: 借={td} 贷={tc}")
        # BS 恒等：资产借净 == 负债贷净 + 权益贷净 + 损益贷净
        A = sum((x for c, x in net.items() if accounts[c]["category"] == "资产"), Decimal("0"))
        L = sum((-x for c, x in net.items() if accounts[c]["category"] == "负债"), Decimal("0"))
        E = sum((-x for c, x in net.items() if accounts[c]["category"] == "权益"), Decimal("0"))
        P = sum((-x for c, x in net.items() if accounts[c]["category"] == "损益"), Decimal("0"))
        if A != L + E + P:
            errors.append(f"资产负债表不恒等 {p}: 资产={A} 负债={L} 权益={E} 损益净={P}")
        # 现金流勾稽
        inflow = outflow = Decimal("0")
        for v in [x for x in vouchers if x["period"] <= p and x["status"] == "posted"]:
            for li in v["lines"]:
                if any(li["account"].startswith(c) for c in CASH_ACCOUNTS) and li.get("cashflow"):
                    inflow += D(li["debit"])
                    outflow += D(li["credit"])
        cash_net = sum((x for c, x in net.items() if c[:4] in CASH_ACCOUNTS or any(c.startswith(k) for k in CASH_ACCOUNTS)), Decimal("0"))
        cash_open = sum((D(b["debit"]) - D(b["credit"]) for b in book["opening_balances"] if any(b["account"].startswith(k) for k in CASH_ACCOUNTS)), Decimal("0"))
        if cash_net - cash_open != inflow - outflow:
            errors.append(f"现金流勾稽不等 {p}: 净变动={cash_net - cash_open} 流入-流出={inflow - outflow}")
        print(f"{p}: 试算借={td} 贷={tc} ｜ 资产={A} 负债={L} 权益={E} 损益净={P} ｜ 现金净变动={cash_net - cash_open}")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--check", default="all", choices=["all"])
    args = ap.parse_args()
    book = load(Path(args.fixtures))
    errors = check(book)
    if errors:
        print("FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("PASSED: 标准账套 3 个月核对全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
