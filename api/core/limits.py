"""附件上传体积上限与配套文案（全站单一来源）。

三个上传入口共用这里的一份真相：

  · 项目 / 合同附件   `routers/projects.py`
  · 人员档案附件      `routers/contacts.py`
  · 支出凭证          `routers/expenses.py`

改限制时只改 `MAX_ATTACHMENT_SIZE`：错误文案里的数字由它推导，杜绝
「常量改了、提示还写着旧数字」的漂移。前端对应的单一来源是 `web/lib/uploadLimits.ts`。

读取约定
--------
`read_within_limit()` 统一用 `read(limit + 1)` 再比长度：超限立刻 400，
**不会把无界数据整体读进内存**，也不会先落盘再判断（三个入口原先写法不一致，
这里收敛为同一种有界读法）。
"""
from fastapi import HTTPException

__all__ = [
    "MAX_ATTACHMENT_SIZE",
    "UNIT_MB",
    "attachment_size_label",
    "attachment_size_message",
    "read_within_limit",
]

#: 单个附件体积上限（字节）——全站唯一真相。
MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

UNIT_MB = 1024 * 1024


def attachment_size_label(limit: int = MAX_ATTACHMENT_SIZE) -> str:
    """把字节上限渲染成展示单位，例如 `100MB`。"""
    return f"{limit // UNIT_MB}MB"


def attachment_size_message(limit: int = MAX_ATTACHMENT_SIZE) -> str:
    """超限时的 400 文案，数字完全由上限推导。"""
    return f"单文件最大 {attachment_size_label(limit)}"


def read_within_limit(file, limit: int = MAX_ATTACHMENT_SIZE) -> bytes:
    """有界读取上传内容；超过 `limit` 抛 400（文案数字来自 `limit`）。

    调用方只需关心「拿到的一定是合法体积的内容」，无需再比长度。
    """
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(400, attachment_size_message(limit))
    return data
