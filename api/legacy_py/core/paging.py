"""列表接口统一分页 / 排序 / 查询边界（Stage 3A 契约，2026-09-16 定稿）。

所有「列表」接口共用本模块，前端与回归测试可以直接依赖以下约定：

请求参数
  · `page`  整数，≥ 1，默认 1
  · `size`  整数，1..`MAX_PAGE_SIZE`（100），默认 `DEFAULT_PAGE_SIZE`（20）
  · `sort`  白名单字段，逗号分隔（最多 3 个），前缀 `-` 表示倒序，如 `sort=-amount,id`
  · 非法 `page` / `size` / `sort` 一律 `400`，带中文原因（不做静默截断，避免前后端理解不一致）

响应信封
  `{"total": int, "page": int, "size": int, "items": [...]}`
  · `total` = 当前筛选 + 权限 + 软删除条件下的全量条数（与 `items` 同一查询条件）
  · 越过末页（`page` 超过最后一页）→ `items` 为空数组，不抛异常、不重复上一页数据
  · 省略分页参数 = `page=1&size=20`，**不会**返回无界数据
  · 排序稳定性：请求的 `sort` 之后自动追加主键 `id` 升序兜底，保证连续翻页不重不漏

安全边界
  · `sort` 只做「字段名 → ORM 列对象」的白名单查表，用户输入永远不会被拼进 SQL 字符串。
"""
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from fastapi import HTTPException

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
MAX_SORT_KEYS = 3


def validate_page(page: int) -> int:
    """page 必须是 ≥1 的整数。"""
    if page is None or page < 1:
        raise HTTPException(400, f"page 须为 ≥1 的整数，收到 {page!r}")
    return page


def validate_size(size: int, maximum: int = MAX_PAGE_SIZE) -> int:
    """size 必须在 1..maximum 之间（服务端上限，防止一次拉全量）。"""
    if size is None or size < 1 or size > maximum:
        raise HTTPException(400, f"size 须为 1-{maximum} 的整数，收到 {size!r}")
    return size


def build_order_by(sort: str, allowed: Mapping[str, Any], default: str = "-id") -> list:
    """把 `sort` 解析为 SQLAlchemy order_by 子句列表（白名单校验，绝不拼接 SQL）。

    · 空值 → 默认排序
    · 前缀 `-` → 倒序
    · 白名单外字段 → 400，并回显可选字段，便于前端自查
    · 未显式包含 `id` 时自动追加 `id` 升序，作为翻页稳定性的兜底
    """
    raw = (sort or "").strip() or default
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        keys = [default]
    if len(keys) > MAX_SORT_KEYS:
        raise HTTPException(400, f"sort 最多支持 {MAX_SORT_KEYS} 个字段")

    clauses: list = []
    seen: set[str] = set()
    for key in keys:
        desc = key.startswith("-")
        name = key[1:] if desc else key
        if name not in allowed:
            raise HTTPException(
                400, f"不支持的排序字段：{name!r}（可选：{sorted(allowed)}）")
        column = allowed[name]
        clauses.append(column.desc() if desc else column.asc())
        seen.add(name)
    if "id" not in seen and "id" in allowed:
        clauses.append(allowed["id"].asc())
    return clauses


def paged(items: Sequence[Any], total: int, page: int, size: int) -> dict:
    """统一响应信封。"""
    return {"total": int(total), "page": page, "size": size, "items": [*items]}


def paginate(query, *, page: int, size: int, allowed: Mapping[str, Any],
             default_sort: str = "-id", map_row: Callable[[Any], Any] | None = None,
             max_size: int = MAX_PAGE_SIZE, sort: str = "") -> dict:
    """执行「计数 + 取当页」并返回统一信封。

    `query` 需已带上全部筛选（含权限与软删除过滤）；排序与 limit/offset 由本函数施加。
    `map_row` 缺省返回 ORM 行本身。
    """
    page = validate_page(page)
    size = validate_size(size, max_size)
    order_by = build_order_by(sort, allowed, default_sort)
    total = query.order_by(None).count()
    rows = query.order_by(*order_by).offset((page - 1) * size).limit(size).all()
    items = [map_row(r) for r in rows] if map_row else rows
    return paged(items, total, page, size)
