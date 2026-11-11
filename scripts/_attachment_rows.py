"""迁移/回填脚本共用的「附件行」工具。

本模块不依赖 Web / ORM 框架：调用方传 psycopg `dict_row` 的结果（也兼容属性
风格的行对象），统一经这里收敛，脚本代码保持可读。

两个调用方：

  · `migrate_attachments_to_r2.py` —— 把存量本地附件回填到 R2；
  · `rekey_r2_objects.py` —— 把 R2 上的对象键迁到新的业务目录规范。

业务域推断（`domain_for`）只有这一处实现：它决定对象键的一级目录，
两个脚本与线上写入必须给出同一个答案，否则迁移后会出现「同一类附件落在两个目录」。
"""

from __future__ import annotations

from collections.abc import Mapping

__all__ = ["domain_for", "int_of", "text_of"]


def text_of(value) -> str:
    """把行字段收敛成 `str`（`None` → `""`）。"""
    return "" if value is None else str(value)


def int_of(value) -> int:
    """把主键收敛成 `int`。

    只用于日志与失败清单；无法解析时给 0，不让报表逻辑把整批迁移打断。
    """
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _field(row, name: str):
    """兼容 ORM 行对象与 `dict_row` 结果：取字段值，缺失按 `None`。"""
    if isinstance(row, Mapping):
        return row.get(name)
    return getattr(row, name, None)


def domain_for(row) -> str:
    """按归属推断对象键的业务域（与三个上传入口的 domain 取值保持一致）。"""
    ref = text_of(_field(row, "ref_type") or "")
    if ref == "expense":
        return "expense"
    if ref == "contact":
        return "contact"
    if ref == "contract":
        return "contract"
    return "project"
