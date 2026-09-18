#!/usr/bin/env python3
"""把存量本地附件回填到 Cloudflare R2（影子迁移的「全量回填」一步）。

背景
----
`attachments` 表里接入 R2 之前的行是本地磁盘坐标（`storage_backend='local'`、
`object_key=''`、`path=<磁盘路径>`）。切换 `STORAGE_BACKEND=r2` 之后，新上传走 R2，
但**老行的正文仍在磁盘上**——本脚本负责把正文搬到 R2 并改写元数据，
使下载路径不再依赖旧卷。

设计要点
--------
· **默认 dry-run**：不加 `--apply` 只打印将要做什么，不写库、不上传。
· **幂等**：已经有 `object_key` 的行直接跳过，可反复执行。
· **先传后改**：正文先成功落 R2，再更新该行元数据；上传失败的行走错误清单，
  元数据保持不动（仍可用旧磁盘路径下载），不会造成「元数据说在 R2、其实没传上去」。
· **可选校验**：`--verify` 上传后回读比对字节，适合一次性正式迁移。
· **可选清理**：`--delete-local` 在**上传并校验成功后**才删本地文件（默认保留）。
· **不吞错**：任何上传失败都以非 0 退出码结束，便于放进发布流程做闸门。

用法
----
    # 1) 先看清单（不改任何东西）
    python scripts/migrate_attachments_to_r2.py

    # 2) 正式迁移（上传 + 校验 + 改库，保留本地文件）
    STORAGE_BACKEND=r2 python scripts/migrate_attachments_to_r2.py --apply --verify

    # 3) 确认无误后回收本地文件（可选）
    STORAGE_BACKEND=r2 python scripts/migrate_attachments_to_r2.py --apply --verify --delete-local

注意：需先把 `STORAGE_BACKEND` 设为 `r2`（或 `R2_*` 配齐且用 `auto`），
否则本脚本会拒绝执行——避免「以为在回填 R2、其实又写了一遍本地盘」。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.orm import Session

from api.core.database import SessionLocal
from api.core.r2 import R2ObjectMissing, R2Unavailable
from api.core.storage import (
    BACKEND_R2,
    build_object_key,
    get_backend,
    resolve_backend_name,
)
from api.models import Attachment


def _text(value) -> str:
    """把 ORM 列值收敛成 `str`。

    本仓库模型是 legacy `= Column(...)` 风格，静态检查会把列值推断为 `Column[str]`，
    直接参与 `or` / 比较会报警。所有列值先经本函数收敛，代码保持可读且类型干净。
    """
    return "" if value is None else str(value)


def _ident(value) -> int:
    """把 ORM 主键收敛成 `int`（legacy Column 风格下列值静态类型是 `Column[int]`）。

    只用于日志与失败清单；无法解析时给 0，不让报表逻辑把整批回填打断。
    """
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _domain_for(row: Attachment) -> str:
    """按归属推断对象键的 domain 段（与三个上传入口的命名保持一致）。"""
    ref = _text(row.ref_type)
    if ref == "expense":
        return "expense"
    if ref == "contact":
        return "contact"
    if ref == "contract":
        return "contract"
    return "project"


def _pending(db: Session) -> list[Attachment]:
    """待回填 = 还没有 object_key 的行（本地坐标）。"""
    return (
        db.query(Attachment)
        .filter((Attachment.object_key.is_(None)) | (Attachment.object_key == ""))
        .order_by(Attachment.id)
        .all()
    )


def _read_local(row: Attachment) -> bytes | None:
    path = _text(row.path).strip()
    if not path or path.startswith(("http://", "https://")):
        return None
    fp = Path(path)
    if not fp.exists():
        return None
    return fp.read_bytes()


def migrate(*, apply: bool, verify: bool, delete_local: bool) -> int:
    backend_name = resolve_backend_name()
    if backend_name != BACKEND_R2:
        print(
            f"[abort] 当前 STORAGE_BACKEND 解析为 {backend_name!r}，不是 'r2'。\n"
            "        请设置 STORAGE_BACKEND=r2（并配齐 R2_*）后重跑，"
            "避免把正文又写回本地盘。",
            file=sys.stderr,
        )
        return 2

    backend = get_backend()
    db = SessionLocal()
    failures: list[tuple[int, str]] = []
    migrated = skipped_missing = 0
    try:
        rows = _pending(db)
        total = len(rows)
        print(f"待回填 {total} 条（模式：{'APPLY' if apply else 'DRY-RUN'}）")
        if not total:
            print("没有需要回填的附件。")
            return 0

        for row in rows:
            data = _read_local(row)
            if data is None:
                # 本地文件已不在：无法回填，列出待人工处理（不阻断其他行）
                skipped_missing += 1
                print(f"  [skip] id={row.id} 本地正文缺失：{row.path}")
                failures.append((_ident(row.id), "local file missing"))
                continue

            key = build_object_key(
                _domain_for(row), _text(row.filename) or "attachment"
            )
            print(f"  [plan] id={row.id} {row.filename!r} -> {key} ({len(data)} bytes)")
            if not apply:
                continue

            try:
                stored = backend.put(data, key, Path("unused"), _text(row.content_type))
                if verify:
                    chunks, _length = backend.stream(stored.object_key, "")
                    if b"".join(chunks) != data:
                        raise R2Unavailable("回读校验不一致")

                # 先传成功、再改元数据：失败的行仍指向可用的旧磁盘路径。
                # 用 setattr 写入：legacy Column 风格下直接赋值会被静态检查当成改类属性。
                local_before = _text(row.path)
                setattr(row, "storage_backend", BACKEND_R2)  # noqa: B010
                setattr(row, "object_key", stored.object_key)  # noqa: B010
                setattr(row, "path", stored.path)  # noqa: B010
                setattr(row, "etag", stored.etag)  # noqa: B010
                setattr(row, "size", stored.size)  # noqa: B010
                db.commit()
                migrated += 1

                if delete_local:
                    Path(local_before).unlink(missing_ok=True)
            except (R2Unavailable, R2ObjectMissing) as exc:
                db.rollback()
                failures.append((_ident(row.id), str(exc)))
                print(f"  [fail] id={row.id}: {exc}", file=sys.stderr)

        print(
            f"完成：回填 {migrated}，跳过(本地缺失) {skipped_missing}，失败 {len(failures)}"
        )
        if failures:
            print("失败明细：", file=sys.stderr)
            for aid, why in failures:
                print(f"  - id={aid}: {why}", file=sys.stderr)
            return 1
        return 0
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="回填存量本地附件到 Cloudflare R2")
    parser.add_argument(
        "--apply", action="store_true", help="真正执行（默认只打印计划）"
    )
    parser.add_argument("--verify", action="store_true", help="上传后回读比对字节")
    parser.add_argument(
        "--delete-local", action="store_true", help="校验成功后删除本地文件（默认保留）"
    )
    args = parser.parse_args()
    return migrate(apply=args.apply, verify=args.verify, delete_local=args.delete_local)


if __name__ == "__main__":
    raise SystemExit(main())
