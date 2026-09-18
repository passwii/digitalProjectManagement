#!/usr/bin/env python3
"""把 R2 上的对象键迁移到「业务目录」规范（方案 A）。

背景
----
接入 R2 时对象键是 `tenant/default/{domain}/{yyyy}/{mm}/{uuid}.{ext}`：层级深、文件名
不可读，控制台里几乎只能靠猜（用户 2026-09-18 反馈「找文件难度太大」）。方案 A 改为：

    合同/2026/2026-024-xx采购合同-534万__a1b2c3d4.pdf
    项目/2026/开票-设备费-60%__5e6f7a8b.png
    凭证/2026/2026-09-差旅-发票__9c0d1e2f_20260918120000.pdf
    档案/张爱杰-身份证__3b4c5d6e.pdf          （人员档案量小，不分年）

一级 = 业务域，二级 = 年份，文件名 = 可读原名 + 8 位随机后缀。**最多两级目录**。

做法（每一步都可中断、可重跑）
------------------------------
对每一行：同桶**服务端复制**旧键 → 新键（字节不经本机）→ 校验 → 改库。旧对象先**留着**，
确认新键到位后再用 `--sweep-legacy` 回收（它只删 `tenant/default/` 下**已无任何行引用**
的对象）—— 分两步是为了随时可以回头比对，而不是靠一条命令的运气。

· **默认 dry-run**：不加 `--apply` 只打印「旧键 → 新键」对照清单，不写库、不动桶。
· **确定性新键（重跑是真无操作）**：新键只由**行自身**算 —— 8 位后缀优先沿用键里已有的，
  其次取旧键里的 uuid；年份不取当前时间，而是「已是新键的行沿用键里的年份、旧键取该行
  `uploaded_at` 的年份」；凭证键尾的上传标记（`__{后缀}_{时间戳}`）原样带过去。因此同一行
  反复执行得到同一个键，已在新键上的行直接跳过，**跨年后重跑也不会把整批行算成新年的键**
  （否则旧键会静默变成桶内孤儿）。
· **先复制、后改库**：任一步失败都保留旧键与库内坐标，不会出现「库指向一个不存在的对象」；
  校验不过的复制品会被当场删掉，不在桶里留半成品。
· **--verify**：把新旧对象**都完整读回来**比较 sha256 与字节数（不是只看 ETag），
  确认复制真的字节级一致。305MB 量级在一分钟内。
· **--sweep-legacy**：回收旧命名空间里已无人引用的对象；仍被行引用的旧键**永不删**。
  它按「无引用」判定，所以不管你是先改键后回收、还是上一次忘了回收，都能收干净——
  不会出现「跑第二遍才发现什么都不删」的空操作。
· **不吞错**：任何失败都以非 0 退出码结束。

用法
----
    # 1) 看对照清单（不改任何东西）
    python scripts/rekey_r2_objects.py

    # 2) 正式迁移（复制 + 整读校验 + 改库；旧键仍在桶里，可随时对照）
    python scripts/rekey_r2_objects.py --apply --verify

    # 3) 回收旧键（只删已无行引用的 `tenant/default/...` 对象）
    python scripts/rekey_r2_objects.py --apply --sweep-legacy

读取永远按行内 `object_key`，不解析路径，所以「新旧键并存」期间线上不受影响：
迁移中、迁移后都不需要停服，也不会出现 404。
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.core.database import SessionLocal
from api.core.r2 import (
    R2ObjectMissing,
    R2Settings,
    R2Unavailable,
    copy_object,
    delete_object,
    iter_objects,
    object_head,
    object_stream,
    public_url,
)
from api.core.storage import (
    build_object_key,
    object_key_ext,
    r2_settings_complete,
    r2_settings_from_env,
    try_delete_object_quietly,
)
from api.models import Attachment
from scripts._attachment_rows import domain_for, int_of, text_of

#: 旧键末段里的 uuid（32 位十六进制），用于取确定性的新键后缀
_UUID_RE = re.compile(r"[0-9a-f]{32}")
#: 新键末段：`{可读原名}__{后缀}[_{上传标记}]`（标记是凭证的上传时间戳）。后缀长度写成
#: `{8,}`：既认现在线上产出的 8 位，也不至于将来改成 12 位时把标记误当成后缀。
_TAG_RE = re.compile(r"__([0-9A-Za-z]{8,})(?:_([0-9A-Za-z]+))?$")
#: 新键里的年份目录段（`{业务域}/{yyyy}/`），旧键两级都是数字但取第二个
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")

#: 方案 A 之前的命名空间前缀（回收只针对它，绝不碰新键）
LEGACY_PREFIX = "tenant/default/"


@dataclass(frozen=True)
class RekeyPlan:
    """一行的改键计划（`aid` / 旧键 / 新键 / 库内指纹）。"""

    aid: int
    filename: str
    old_key: str
    new_key: str
    size: int
    etag: str


@dataclass
class RekeyReport:
    """一次迁移的结果汇总（dry-run 时只有 `plans`）。"""

    plans: list[RekeyPlan] = field(default_factory=list)
    up_to_date: int = 0
    rekeyed: int = 0
    failures: list[tuple[int, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def tag_and_marker(old_key: str) -> tuple[str, str]:
    """拆当前键末段的 `(后缀, 上传标记)`；不是新键形态时返回 `("", "")`。

    新键末段是 `{可读原名}__{后缀}[_{上传标记}]{ext}`，凭证的上传时间戳就是那个标记
    （`api/routers/expenses.py` 传的 `suffix`）。重算目标键时必须把它原样带回去，否则
    `凭证/…__tag_marker.pdf` 会被算成 `凭证/…__tag.pdf`：与当前键不等 → 重跑再复制一份，
    把带标记的旧键留在桶里 —— 而 `--sweep-legacy` 只扫 `tenant/default/`，永远收不到它。
    """
    tail = text_of(old_key).rsplit("/", 1)[-1]
    ext = object_key_ext(tail)
    stem = tail[: -len(ext)] if ext else tail
    match = _TAG_RE.search(stem)
    if match is None:
        return "", ""
    return match.group(1).lower(), match.group(2) or ""


def stable_tag(old_key: str) -> str:
    """从旧键里取稳定的 8 位后缀：优先沿用新键已有的后缀，其次 uuid，最后按旧键摘要。

    确定性是幂等的前提：同一行反复执行必须算出同一个新键，否则会复制出第二份对象。
    三种来源的顺序也保证了「改过的行不会再被改一次」：已是新键的行直接沿用原后缀，
    算出的目标键与当前键相等，即视为无需迁移。
    """
    tag, _marker = tag_and_marker(old_key)
    if tag:
        return tag
    tail = text_of(old_key).rsplit("/", 1)[-1]
    match = _UUID_RE.search(tail)
    if match:
        return match.group(0)[:8]
    return hashlib.sha256(text_of(old_key).encode("utf-8")).hexdigest()[:8]


def _year_from_key(old_key: str) -> int | None:
    """取新键里的年份目录段（`{业务域}/{yyyy}/…`）；没有年份层（如档案）返回 `None`。"""
    parts = [part for part in text_of(old_key).split("/") if part]
    if len(parts) < 3 or not _YEAR_RE.match(parts[1]):
        return None
    try:
        return int(parts[1])
    except (TypeError, ValueError):  # 正则已挡过，这里只是不让异常变成一次崩溃
        return None


def _year_for(row, old_key: str) -> int | None:
    """目标键的年份：已是新键的行沿用当前键里的年份，其它行取该行的上传年份。

    年份必须来自「行」，绝不能取 `datetime.now()`：否则 2027 年再跑一次，2026 年迁好的
    行会被整批算成 `2027/…`，旧键立刻变成没人引用的孤儿（`--sweep-legacy` 只认
    `tenant/default/`，收不到它），而脚本仍会打印「失败 0」并以 0 退出。
    取 `uploaded_at` 的年份顺带修掉「去年上传的文件被迁进今年目录」这个更老的偏差。
    """
    if tag_and_marker(old_key)[0]:
        year = _year_from_key(old_key)
        if year is not None:
            return year
    # 列值经 `getattr` 收敛：legacy `Column(...)` 风格下静态类型不是 datetime
    year = getattr(getattr(row, "uploaded_at", None), "year", None)
    return year if isinstance(year, int) else None


def target_key(row) -> str:
    """按方案 A 计算某一行应有的对象键（业务域 + 年份 + 可读名 + 稳定后缀 + 上传标记）。

    只用**行自身**的数据（当前键、文件名、`uploaded_at`），不读时钟：
    · 已在新键上的行算出的目标键 == 当前键 → 重跑是真的无操作（含凭证的时间戳标记）；
    · 跨年后重跑也不会把旧年份的键算成新年的键，不会平白造出桶内孤儿。
    """
    old_key = text_of(getattr(row, "object_key", ""))
    tag, marker = tag_and_marker(old_key)
    return build_object_key(
        domain_for(row),
        text_of(getattr(row, "filename", "")) or "attachment",
        suffix=marker,
        disambiguator=tag or stable_tag(old_key),
        year=_year_for(row, old_key),
    )


def _r2_rows(db: Session) -> list[Attachment]:
    """已在 R2 的行（有 `object_key`），按主键顺序。

    用 `select()` 构造器、**内联**传给 `Session.execute()`：参数绑定不拼字符串，
    静态安全扫描也能看出这是构造器语句（先绑到变量再 execute 会被判为可疑动态 SQL）。
    """
    return list(
        db.execute(
            select(Attachment)
            .where(Attachment.object_key.isnot(None))
            .where(Attachment.object_key != "")
            .order_by(Attachment.id)
        )
        .scalars()
        .all()
    )


def _digest_of(settings: R2Settings, key: str) -> tuple[str, int]:
    """完整读回一个对象，返回 `(sha256, 字节数)`。"""
    chunks, _length, _etag = object_stream(settings, key)
    digest = hashlib.sha256()
    total = 0
    for chunk in chunks:
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def _verify_copy(settings: R2Settings, old_key: str, new_key: str, plan: RekeyPlan) -> str:
    """校验新对象与旧对象一致；返回错误说明，`""` 表示通过。

    三道关：目标存在 → 字节数（新 vs 旧对象，不是只看库内值）→ 可选整读比对 sha256。
    ETag 顺带核对：单次 PUT 的对象 ETag 就是内容 MD5，复制后应保持不变。
    """
    old_head = object_head(settings, old_key)
    new_head = object_head(settings, new_key)
    if new_head is None:
        return "复制后目标对象不存在"
    if old_head is None:
        return "复制后旧对象不见了（复制过程异常）"
    if new_head["size"] != old_head["size"]:
        return f"字节数不一致：新 {new_head['size']} ≠ 旧 {old_head['size']}"
    if plan.size and new_head["size"] != plan.size:
        return f"字节数与库内记录不一致：新 {new_head['size']} ≠ 库 {plan.size}"
    if old_head["etag"] and new_head["etag"] and new_head["etag"] != old_head["etag"]:
        return f"ETag 不一致：新 {new_head['etag']} ≠ 旧 {old_head['etag']}"
    if plan.etag and new_head["etag"] and new_head["etag"] != plan.etag:
        return f"ETag 与库内记录不一致：新 {new_head['etag']} ≠ 库 {plan.etag}"
    return ""


def rekey(
    db: Session,
    settings: R2Settings,
    *,
    apply: bool = False,
    verify: bool = False,
    echo=print,
) -> RekeyReport:
    """执行（或演练）改键迁移，返回结构化结果。

    `apply=False` 只算清单；`verify=True` 额外整读新旧对象比对 sha256。
    旧对象**不在本步骤删除**，由 `sweep_legacy()` 在确认后回收。
    """
    report = RekeyReport()
    planned: dict[str, int] = {}

    for row in _r2_rows(db):
        aid = int_of(row.id)
        old_key = text_of(row.object_key)
        new_key = target_key(row)
        if new_key == old_key:
            report.up_to_date += 1
            continue
        if new_key in planned:
            # 两行算到同一个新键：绝不能继续，否则一行会覆盖另一行的正文
            report.failures.append(
                (aid, f"新键与附件 id={planned[new_key]} 冲突：{new_key}")
            )
            continue
        planned[new_key] = aid
        report.plans.append(
            RekeyPlan(
                aid=aid,
                filename=text_of(row.filename),
                old_key=old_key,
                new_key=new_key,
                size=int_of(row.size),
                etag=text_of(row.etag),
            )
        )

    mode = "APPLY" if apply else "DRY-RUN"
    echo(
        f"已在 R2 的行 {report.up_to_date + len(report.plans)} 条"
        f"（需改键 {len(report.plans)}，已是新键 {report.up_to_date}）；模式：{mode}"
    )
    for plan in report.plans:
        echo(f"  [plan] id={plan.aid} {plan.filename!r}")
        echo(f"         {plan.old_key}")
        echo(f"      -> {plan.new_key}")
    if not apply:
        echo("dry-run 结束：未复制、未改库、未删除。加 --apply 执行。")
        return report

    for plan in report.plans:
        try:
            if object_head(settings, plan.new_key) is not None:
                report.failures.append((plan.aid, f"目标键已存在，跳过：{plan.new_key}"))
                continue
            copy_object(settings, plan.old_key, plan.new_key)
            problem = _verify_copy(settings, plan.old_key, plan.new_key, plan)
            if problem:
                # 复制出来的对象不可信：删掉它，别把库改过去（也避免留半成品在桶里）
                try_delete_object_quietly(plan.new_key)
                report.failures.append((plan.aid, problem))
                continue
            if verify:
                old_digest, old_size = _digest_of(settings, plan.old_key)
                new_digest, new_size = _digest_of(settings, plan.new_key)
                if old_digest != new_digest or old_size != new_size:
                    try_delete_object_quietly(plan.new_key)
                    report.failures.append(
                        (plan.aid, f"整读比对不一致：sha256 新 {new_digest} 旧 {old_digest}")
                    )
                    continue
        except (R2Unavailable, R2ObjectMissing) as exc:
            try_delete_object_quietly(plan.new_key)
            report.failures.append((plan.aid, f"复制/校验失败：{exc}"))
            continue

        # 复制并校验成功 → 改库（只在新对象确实存在时才改，库不会指向空中楼阁）
        row = _row(db, plan.aid)
        # 用 setattr 写入：legacy Column 风格下直接赋值会被静态检查当成改类属性
        setattr(row, "object_key", plan.new_key)  # noqa: B010
        setattr(row, "storage_backend", "r2")  # noqa: B010
        setattr(row, "path", public_url(settings, plan.new_key))  # noqa: B010
        head = object_head(settings, plan.new_key)
        if head and head["etag"]:
            setattr(row, "etag", head["etag"])  # noqa: B010
        db.commit()
        report.rekeyed += 1
        echo(f"  [done] id={plan.aid} -> {plan.new_key}")

    echo(
        f"完成：改键 {report.rekeyed}，已是新键 {report.up_to_date}，失败 {len(report.failures)}"
    )
    if report.failures:
        echo("失败明细：", file=sys.stderr)
        for aid, why in report.failures:
            print(f"  - id={aid}: {why}", file=sys.stderr)
    return report


def sweep_legacy(db: Session, settings: R2Settings, *, apply: bool = False, echo=print) -> dict:
    """回收旧命名空间（`tenant/default/...`）下**已无任何行引用**的对象。

    按「无引用」而不是按「刚改过键」判定，所以先迁移后回收、上一次忘了回收、
    单行重跑几种情形都能收干净。仍被行引用的旧键（例如还没迁移的行）**永不删**。
    """
    referenced = {text_of(row.object_key) for row in _r2_rows(db)}
    legacy = [
        item["key"]
        for item in iter_objects(settings)
        if item["key"].startswith(LEGACY_PREFIX)
    ]
    stale = sorted(key for key in legacy if key not in referenced)
    kept = sorted(key for key in legacy if key in referenced)
    mode = "APPLY" if apply else "DRY-RUN"
    echo(
        f"旧命名空间对象 {len(legacy)} 个（仍被引用 {len(kept)}，无引用可回收 {len(stale)}）；"
        f"模式：{mode}"
    )
    for key in kept:
        echo(f"  [keep ] 仍被某行引用，不删：{key}")
    for key in stale:
        echo(f"  [sweep] {key}")
    failures: list[tuple[str, str]] = []
    if apply:
        for key in stale:
            try:
                delete_object(settings, key)
            except R2Unavailable as exc:
                failures.append((key, str(exc)))
        echo(f"回收完成：删除 {len(stale) - len(failures)}，失败 {len(failures)}")
        for key, why in failures:
            print(f"  - {key}: {why}", file=sys.stderr)
    else:
        echo("dry-run 结束：未删除。加 --apply --sweep-legacy 回收。")
    return {"legacy": len(legacy), "kept": kept, "swept": stale, "failures": failures}


def _row(db: Session, aid: int) -> Attachment:
    """按主键取行（迁移过程中逐行提交，重新取一次拿到最新会话状态）。"""
    row = db.execute(select(Attachment).where(Attachment.id == aid)).scalars().first()
    if row is None:  # pragma: no cover - 迁移期间被并发删除
        raise RuntimeError(f"附件 id={aid} 在迁移过程中消失")
    return row


def reconcile(db: Session, settings: R2Settings, echo=print) -> dict:
    """桶 ↔ 数据库双向对账（只读）：找出「库里有、桶里没有」与桶内孤儿。"""
    db_keys = {text_of(row.object_key) for row in _r2_rows(db)}
    bucket = {item["key"]: item for item in iter_objects(settings)}
    missing = sorted(db_keys - set(bucket))
    orphan = sorted(set(bucket) - db_keys)
    echo(
        f"对账：库内 R2 行 {len(db_keys)}，桶内对象 {len(bucket)}，"
        f"桶内缺对象 {len(missing)}，桶内孤儿 {len(orphan)}"
    )
    for key in missing:
        echo(f"  [missing] 库内有行但桶里没有：{key}")
    for key in orphan:
        echo(f"  [orphan ] 桶里有对象但库内无行：{key}")
    return {"db_rows": len(db_keys), "bucket_objects": len(bucket), "missing": missing, "orphan": orphan}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 R2 对象键迁移到业务目录规范（方案 A）"
    )
    parser.add_argument("--apply", action="store_true", help="真正执行（默认只打印计划）")
    parser.add_argument(
        "--verify", action="store_true", help="改键时整读新旧对象比对 sha256"
    )
    parser.add_argument(
        "--delete-old",
        action="store_true",
        help=argparse.SUPPRESS,  # 已由 --sweep-legacy 取代（按「无引用」判定，不会空操作）
        dest="delete_old_removed",
    )
    parser.add_argument(
        "--sweep-legacy",
        action="store_true",
        help="回收旧命名空间下已无行引用的对象（与 --apply 一起才真删）",
    )
    parser.add_argument(
        "--no-reconcile", action="store_true", help="跳过桶 ↔ 数据库对账"
    )
    args = parser.parse_args()

    settings = r2_settings_from_env()
    if not r2_settings_complete(settings):
        print(
            "[abort] R2 配置不完整（需要 R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / "
            "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）",
            file=sys.stderr,
        )
        return 2

    db = SessionLocal()
    try:
        if args.delete_old_removed:
            print(
                "[abort] --delete-old 已移除：请分开跑两步（--apply --verify 然后 "
                "--apply --sweep-legacy），回收按「桶内对象已无行引用」判定。",
                file=sys.stderr,
            )
            return 2
        report = rekey(
            db, settings, apply=args.apply, verify=args.verify
        )
        sweep_failures = 0
        if args.sweep_legacy:
            sweep = sweep_legacy(db, settings, apply=args.apply)
            sweep_failures = len(sweep["failures"])
        if not args.no_reconcile:
            reconcile(db, settings)
        return 0 if (report.ok and not sweep_failures) else 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
