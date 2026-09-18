"""时间口径的**唯一入口**（BLF-1138）。

问题
----
库里 31 个时间列都是 `timestamp without time zone`，而写入侧给的是**带时区的 UTC**
（`datetime.now(timezone.utc)`）。PostgreSQL 在执行 `timestamptz → timestamp` 隐式转换时
按**会话时区**折算，于是落库值 = 「UTC 瞬时在会话时区下的墙钟时间」：

  · 会话时区是 `Asia/Shanghai` 时，落库的是北京时间墙钟 —— 看起来「正好对」，纯属巧合；
  · 换库 / 改 `TZ` / 新环境默认 UTC 时，同一份代码、同一份数据写入的是另一个瞬时，
    全站时间整体偏 8 小时，**且不会报任何错**。

读取侧又把库里的 naive 值贴回 UTC 标签（`dt.replace(tzinfo=timezone.utc)`），于是
「配置 15 分钟的登录锁定」实际生效 8 小时 15 分（`routers/auth.py`），停滞天数、
通知节流同样偏移。

约定
----
1. **列约定**：所有 `DateTime` 列存 **`Asia/Shanghai` 的 naive 墙钟值**。
   naive 入 naive 列，PG 不做任何时区折算 → 结果与会话时区、进程 `TZ` 全部无关。
   存量数据本来就是「北京时间墙钟」，与新约定天然一致，**不需要数据迁移**。
2. **写入**（以及所有 SQL 过滤值）：`app_now()` / `to_db(x)`，一律 naive 北京时间。
3. **计算**：离开 DB 边界立刻用 `as_app(x)` 变 aware（`+08:00`），"现在"用
   `app_now_aware()`；同一段算术里不要混用 naive 与 aware（混用会 `TypeError`）。
4. **对外**：`iso(x)` 输出**带偏移**的 ISO8601（`2026-09-18T17:32:28.184848+08:00`）。
   前端 `fmtDateTime` 是纯字符串裁剪，显示不变。
5. **业务日**：`app_today()`，不依赖进程 `TZ`（容器 `TZ` 变了也不会把「今天」算错一天）。
6. **epoch 换算**：`from_timestamp()`。

JWT 是唯一的例外：`exp` 是 epoch 语义，必须继续用 **aware UTC**
（`core/security.py`），不要改成这里的时间。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import overload
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

APP_TZ_NAME = "Asia/Shanghai"

try:
    APP_TZ: tzinfo = ZoneInfo(APP_TZ_NAME)
except ZoneInfoNotFoundError:  # pragma: no cover - 容器缺 IANA 数据时的兜底
    # 中国自 1991 年起无夏令时，固定 +08:00 与 IANA 数据等价。
    # requirements.txt 里带 `tzdata`，正常都能走上面的 ZoneInfo 分支。
    APP_TZ = timezone(timedelta(hours=8), APP_TZ_NAME)


def app_now() -> datetime:
    """当前时刻的**北京时间 naive 值**：写入 DB 与 SQL 过滤值一律用它。"""
    return datetime.now(APP_TZ).replace(tzinfo=None)


def app_now_aware() -> datetime:
    """当前时刻的北京时间 aware 值（`+08:00`）：只用于计算与比较。"""
    return datetime.now(APP_TZ)


def app_today() -> date:
    """业务日（北京时间的今天）：逾期判定、报表月份等一律用它。"""
    return datetime.now(APP_TZ).date()


@overload
def as_app(value: datetime) -> datetime: ...


@overload
def as_app(value: None) -> None: ...


def as_app(value: datetime | None) -> datetime | None:
    """DB 读出的 naive 值 → aware 北京时间；已 aware 的按瞬时折算到北京时间。

    `None` 原样返回，方便直接套在可空列上。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=APP_TZ)
    return value.astimezone(APP_TZ)


@overload
def to_db(value: datetime) -> datetime: ...


@overload
def to_db(value: None) -> None: ...


def to_db(value: datetime | None) -> datetime | None:
    """任意来源的时刻 → 入库约定值（naive 北京时间）。

    · naive 输入按「已经是北京时间墙钟」处理（请求体里不带偏移的时间就是本地时间）；
    · aware 输入（含 `Z` / `+00:00`）按瞬时折算成北京时间墙钟，
      避免 PG 用会话时区做第二次折算。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(APP_TZ).replace(tzinfo=None)


def from_timestamp(ts: float) -> datetime:
    """epoch 秒 → 入库约定值（naive 北京时间）。JWT `exp` 换算黑名单到期时间用这个。"""
    return datetime.fromtimestamp(ts, APP_TZ).replace(tzinfo=None)


def iso(value: datetime | date | None) -> str | None:
    """序列化：`datetime` → 带偏移的 ISO8601；`date` 原样；`None` → `None`。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        aware = as_app(value)
        return aware.isoformat() if aware else None
    return value.isoformat()
