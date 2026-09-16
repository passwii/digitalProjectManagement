"""数值 / 日期入参校验（Stage 4A）。

目标：**每一个非法请求都在产生任何数据库副作用之前返回明确 4xx**。
原先各 router 各自零散判断，容易出现「先改内存对象、再 assert」的顺序错误 ——
校验函数全部是纯函数，只在赋值/落库前调用。

约定：
  · 金额、权重、进度等数值一律要求有限（拒绝 NaN / Infinity —— JSON 里 `NaN` 能被解析成 float('nan')，
    若直接落库会让后续所有比较静默为 False，是最隐蔽的一类脏数据）；
  · 数值上下界检查与业务语义分开命名，便于在 router 里一眼看出被拒原因；
  · 日期区间检查统一为 `check_date_range(start, end, ...)`。
"""
import math
from datetime import date

from fastapi import HTTPException


def as_number(value, *, field: str, required: bool = True) -> float | None:
    """把入参转成有限 float；None/空视为缺省。非法值 → 400。"""
    if value is None or value == "":
        if required:
            raise HTTPException(400, f"{field}必填")
        return None
    if isinstance(value, bool):   # bool 是 int 子类，显式拒绝避免 True 被当成 1
        raise HTTPException(400, f"{field}须为数字")
    if isinstance(value, (int, float)):
        num = float(value)
        if not math.isfinite(num):
            raise HTTPException(400, f"{field}须为有效数字")
        return num
    try:
        num = float(str(value).strip())
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field}须为数字，收到 {value!r}")
    if not math.isfinite(num):
        raise HTTPException(400, f"{field}须为有效数字")
    return num


def check_range(value: float, *, field: str, minimum: float | None = None,
                maximum: float | None = None, exclusive_min: bool = False) -> float:
    """上下界检查。`exclusive_min=True` 表示必须严格大于 minimum。"""
    if minimum is not None:
        if exclusive_min and value <= minimum:
            raise HTTPException(400, f"{field}须大于 {minimum:g}")
        if not exclusive_min and value < minimum:
            raise HTTPException(400, f"{field}不能小于 {minimum:g}")
    if maximum is not None and value > maximum:
        raise HTTPException(400, f"{field}不能大于 {maximum:g}")
    return value


def check_progress(value, *, field: str = "进度") -> float:
    """进度必须是 0-100 的有限数字（含边界）。"""
    num = as_number(value, field=field)
    return check_range(num, field=field, minimum=0, maximum=100)


def check_weight(value, *, field: str = "权重") -> float:
    """权重必须严格大于 0（0 权重会让加权进度分母失真、并让加权平均退化为除零保护）。"""
    num = as_number(value, field=field)
    return check_range(num, field=field, minimum=0, exclusive_min=True)


def check_amount(value, *, field: str = "金额", allow_zero: bool = False,
                 allow_negative: bool = False) -> float:
    """金额校验：默认必须严格大于 0；`allow_zero` 允许 0（预算），`allow_negative` 允许负（暂未使用）。"""
    num = as_number(value, field=field)
    if allow_negative:
        return num
    if allow_zero:
        return check_range(num, field=field, minimum=0)
    return check_range(num, field=field, minimum=0, exclusive_min=True)


def check_date_range(start: date | None, end: date | None, *,
                     start_field: str = "开始日期", end_field: str = "结束日期") -> None:
    """开始不得晚于结束（任一端为空则跳过）。"""
    if start and end and start > end:
        raise HTTPException(400, f"{end_field}不能早于{start_field}")


def check_choice(value: str, allowed, *, field: str) -> str:
    """枚举白名单校验（错误信息回显可选值，便于前端自查）。"""
    if value not in allowed:
        raise HTTPException(400, f"{field}须为 {sorted(allowed)} 之一，收到 {value!r}")
    return value
